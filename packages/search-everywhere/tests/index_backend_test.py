"""Foreground helper contracts; Arc replies injected, real rg only in disposable projects."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('backend', Path(__file__).resolve().parent.parent / 'search_backend.py')
b = importlib.util.module_from_spec(spec); spec.loader.exec_module(b)

class BackendTests(unittest.TestCase):
    def args(self, root, query='needle', backend='rg'):
        return SimpleNamespace(root=root, authority='', backend=backend, arc_backend='remote', query=query)

    def test_literal_and_remote_protocol(self):
        self.assertEqual(b.fold('Ab界'), 'ab界')
        self.assertEqual(b.literal('-a.*界'), r'\-[aA]\.\*界')
        rows = b.parse_remote('dev/project/a.py:2:needle: text\n', 'dev/project', True)
        self.assertEqual(rows[0]['line'], 2)
        self.assertNotIn('byte', rows[0]); self.assertNotIn('col', rows[0])
        self.assertEqual(b.parse_remote('dev/project/a.py\n', 'dev/project', False)[0]['path'], 'a.py')
        for record in ('/dev/project/a', 'dev/project/../a', 'dev/project/a:2:x', 'dev/other/a', 'https://x'):
            with self.assertRaises(b.BackendError): b.parse_remote(record, 'dev/project', False)
        for record in ('dev/project/a:0:x', 'dev/project/a:x:x', 'dev/project/a:1:' + 'x'*8193):
            with self.assertRaises(b.BackendError): b.parse_remote(record, 'dev/project', True)

    def test_remote_query_subtree_and_dedupe(self):
        scope = dict(root='/fixture', identity='i', arc={'mount':'/arc'}, prefix='dev/p.+')
        calls=[]
        def run(argv, root, **kw):
            calls.append(argv)
            if len(calls)==1: return 'dev/p.+/needle.py\n', 'Total: 1 (revision: r1)', 0
            return 'dev/p.+/needle.py:3:needle\ndev/p.+/needle.py:2:needle\n', 'Total: 2+ (revision: r1)', 0
        result=b.query(scope,self.args('/fixture'),run,lambda s:s)
        self.assertEqual(result['source'],'trunk'); self.assertEqual(len(result['results']),1)
        self.assertEqual(result['results'][0]['line'],2); self.assertTrue(result['warnings'])
        self.assertTrue(all(a[0:4]==['ya','grep','--remote','-R'] for a in calls))
        self.assertTrue(all(a[a.index('-f')+1].startswith(r'^dev/p\.\+/') for a in calls))
        self.assertFalse(any('-d' in a for a in calls))
        with self.assertRaises(b.BackendError): b.query(scope,self.args('/fixture'),lambda *a,**kw:('', 'Authentication failed',0),lambda s:s)
        with self.assertRaises(b.BackendError): b.parse_remote('dev/project/a:2:foo:3:text', 'dev/project', True)
        with self.assertRaises(b.BackendError): b.provider(scope,'rg','rg')
        with self.assertRaises(b.BackendError): b.provider({'arc':None},'remote','remote')

    def test_scope_and_selected_paths(self):
        with tempfile.TemporaryDirectory(prefix='remote-scope-') as directory:
            root=str(Path(directory)/'project'); Path(root).mkdir()
            table=lambda:[('/', '1','1','/','ext4')]
            def run(argv,cwd,**kw):
                return ('[]','',0) if 'mount' in argv else ('','Not a mounted arc repository. Did you forget to mount arcadia?\n',1)
            scope=b.guard(root,'',run,table)
            self.assertIsNone(scope['arc'])
            (Path(root)/'ok').write_text('x'); self.assertEqual(b.selected(scope,'ok'),root+'/ok')
            (Path(root)/'link').symlink_to('/etc')
            for name in ('link/passwd','../x','/etc/passwd','missing'):
                with self.assertRaises((b.BackendError,OSError)): b.selected(scope,name)
            with self.assertRaises(b.BackendError): b.guard(root,'ssh',run,table)
            with self.assertRaises(b.BackendError): b.guard(root,'',lambda *a,**k:('garbage','',0),table)
            with self.assertRaises(b.BackendError): b.guard(root,'',run,lambda:[('/', '1','1','/','fuse.unknown')])
            with self.assertRaises(b.BackendError): b.guard(root,'',run,lambda:[('/', '1','1','/','ext4'),(root+'/nested','2','2','/','tmpfs')])
            with patch.object(b,'mounts',table):
                b.recheck(scope)
                Path(root).rename(root+'old'); Path(root).mkdir()
                with self.assertRaises(b.BackendError): b.recheck(scope)

    def test_arc_mapping_and_ancestor(self):
        with tempfile.TemporaryDirectory(prefix='remote-arc-fixture-') as directory:
            mount=directory+'/arc'; root=mount+'/dev/project'; Path(root).mkdir(parents=True)
            table=lambda:[('/', '1','1','/','ext4'),(mount,'2','2','/','fuse.arcfs')]
            listing=[dict(mount=mount,status='mounted',pid=os.getpid(),store='/fixture/store')]
            def run(argv,cwd,**kw): return (json.dumps(listing),'',0) if 'mount' in argv else ('../..\n','',0)
            scope=b.guard(root,'',run,table)
            self.assertEqual(scope['prefix'],'dev/project')
            self.assertEqual(b.provider(scope,'rg','remote'),'remote')
            with self.assertRaises(b.BackendError): b.guard(mount,'',run,table)
            with self.assertRaises(b.BackendError): b.guard(directory,'',run,table)

    def test_real_rg_foreground(self):
        with tempfile.TemporaryDirectory(prefix='remote-rg-') as directory:
            root=Path(directory)/'project'; root.mkdir()
            (root/'needle.txt').write_bytes('first\r\nNEEDLE 😀\r\nneedle\n'.encode())
            (root/'other.txt').write_text('needle界\n')
            (root/'-a.*.txt').write_text('-a.*\n')
            b.DEADLINE=time.monotonic()+10
            scope=b.guard(str(root),'')
            result=b.query(scope,self.args(str(root)))
            self.assertEqual(len(result['results']),2)
            row=next(r for r in result['results'] if r['path']=='needle.txt')
            self.assertEqual(row['line'],2); self.assertEqual(row['snippet'],'NEEDLE 😀')
            b.DEADLINE=time.monotonic()+10
            self.assertEqual(len(b.query(scope,self.args(str(root),'-a.*'))['results']),1)
            b.DEADLINE=time.monotonic()+10
            self.assertEqual(b.query(scope,self.args(str(root),'absent'))['results'],[])

    def test_caps_errors_and_deadline(self):
        with tempfile.TemporaryDirectory() as root:
            for script, cap in [('print("x"*20000)',b.MAX_OUTPUT),('import sys;sys.stderr.write("x"*20000)',b.MAX_OUTPUT),('print("x"*2000)',100)]:
                b.DEADLINE=time.monotonic()+2
                with self.assertRaises(b.BackendError): b.command([sys.executable,'-c',script],root,cap=cap)
            b.DEADLINE=time.monotonic()+.2
            with self.assertRaises(b.BackendError): b.command([sys.executable,'-c','import time; time.sleep(20)'],root)
            b.DEADLINE=time.monotonic()+2
            with self.assertRaises(b.BackendError): b.command([sys.executable,'-c','raise SystemExit(7)'],root)

    def test_leader_exit_descendant_and_parent_death(self):
        with tempfile.TemporaryDirectory() as root:
            record=Path(root)/'pid'
            child=f'import os,pathlib,signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);pathlib.Path({str(record)!r}).write_text(str(os.getpid()));time.sleep(30)'
            leader=f'import subprocess,sys,time,pathlib;subprocess.Popen([sys.executable,"-c",{child!r}]);\nwhile not pathlib.Path({str(record)!r}).exists(): time.sleep(.01)\n'
            b.DEADLINE=time.monotonic()+3
            b.command([sys.executable,'-c',leader],root)
            pid=int(record.read_text())
            def alive(pid):
                try: return Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()[0]!='Z'
                except FileNotFoundError: return False
            self.assertFalse(alive(pid))
            record.unlink()
            runner=f'import importlib.util,time; s=importlib.util.spec_from_file_location("b",{spec.origin!r});b=importlib.util.module_from_spec(s);s.loader.exec_module(b);b.DEADLINE=time.monotonic()+30;b.command([{sys.executable!r},"-c",{leader+'import time;time.sleep(30)'!r}],{root!r})'
            for terminate in (signal.SIGTERM, signal.SIGKILL):
                record.unlink(missing_ok=True)
                p=subprocess.Popen([sys.executable,'-c',runner])
                owned = {}
                def capture(parent):
                    try: children=Path(f'/proc/{parent}/task/{parent}/children').read_text().split()
                    except FileNotFoundError: return
                    for value in children:
                        pid=int(value)
                        try: owned[pid]=Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()[19]
                        except FileNotFoundError: continue
                        capture(pid)
                try:
                    end=time.monotonic()+3
                    while not record.exists() and time.monotonic()<end: time.sleep(.01)
                    pid=int(record.read_text()); capture(p.pid); p.send_signal(terminate); p.wait()
                    end=time.monotonic()+2
                    while Path(f'/proc/{pid}').exists() and time.monotonic()<end: time.sleep(.02)
                    self.assertFalse(alive(pid),'native descendant survived helper termination')
                    self.assertFalse(Path(f'/proc/{pid}').exists(), 'native descendant was not reaped')
                finally:
                    if p.poll() is None: p.kill(); p.wait()
                    if record.exists() and alive(int(record.read_text())): os.kill(int(record.read_text()),signal.SIGKILL)
                    for pid,start in owned.items():
                        try:
                            fields=Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()
                            if fields[19]==start and fields[0]!='Z': os.kill(pid,signal.SIGKILL)
                        except (FileNotFoundError,ProcessLookupError): pass

if __name__=='__main__': unittest.main()
