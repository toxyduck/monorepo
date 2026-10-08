"""Video trust-boundary regressions; temporary local fixtures only."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import demo


class DemoTests(unittest.TestCase):
    def test_recording_resize_and_chunks(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp); raw = b'\x1b[38;2;125;85;10mFoo'
            (base/'terminal.ansi').write_bytes(raw)
            rows = [dict(type='resize',time=0,offset=0,rows=36,columns=130),
                    dict(type='chunk',time=.1,start=0,offset=len(raw)),
                    dict(type='phase',time=.2,offset=len(raw),name='done')]
            def save(): (base/'recording.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in rows))
            save(); self.assertEqual(demo.recording(base), (raw,rows))
            rows[1]['start']=1; save()
            with self.assertRaises(ValueError): demo.recording(base)
            rows[1]['start']=0; rows[2]['time']=.05; save()
            with self.assertRaises(ValueError): demo.recording(base)
            with patch.object(demo,'MAX_ANSI',1):
                with self.assertRaises(ValueError): demo.recording(base)

    def test_missing_dependencies_blocked(self):
        import builtins
        real = builtins.__import__
        def missing(name,*args,**kwargs):
            if name == 'pyte': raise ImportError('test')
            return real(name,*args,**kwargs)
        with patch('builtins.__import__',side_effect=missing):
            with self.assertRaises(demo.Blocked): demo.dependencies()

    def test_gif_format_duration_and_caps(self):
        try: from PIL import Image
        except ImportError: self.skipTest('Pillow is required for GIF verification')
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'demo.gif'
            frames=[Image.new('RGB',(990,598),color) for color in ('red','green','blue')]
            frames[0].save(path,save_all=True,append_images=frames[1:],duration=125,loop=0)
            proof=demo.verify_gif(path,.375)
            self.assertEqual(proof['frames'],3)
            with patch.object(demo,'MAX_GIF',1):
                with self.assertRaisesRegex(ValueError,'size cap'): demo.verify_gif(path,.375)
            with self.assertRaisesRegex(ValueError,'duration'): demo.verify_gif(path,2)
            frames[0].save(path)
            with self.assertRaises(ValueError): demo.verify_gif(path,.375)

    def test_dense_dot_area_is_not_hash_noise(self):
        try: renderer=demo.Renderer()
        except demo.Blocked as error: self.skipTest(str(error))
        screen=renderer.pyte.Screen(130,36);stream=renderer.pyte.ByteStream(screen)
        for phase,chars in enumerate(('•··','·•·','··•')):
            stream.feed(('\x1b[H'+chars).encode())
            native=renderer.image(screen).crop((0,0,33,24))
            self.assertEqual(demo.dot_position(native)[0],phase)
            self.assertEqual(demo.dot_position(native.resize((23,16)))[0],phase)
        with self.assertRaisesRegex(ValueError,'not distinguishable'):
            demo.dot_position(renderer.Image.new('RGB',(23,16),'black'))

    def test_readme_preserved_on_errors_and_concurrency(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'README.md'
            original=('outside\n'+demo.START+'\nold\n'+demo.END+'\nafter\n').encode()
            path.write_bytes(original)
            path.write_bytes(original+b'concurrent')
            with self.assertRaises(ValueError): demo.replace_readme(path,original)
            self.assertEqual(path.read_bytes(),original+b'concurrent')
            path.write_bytes(original); demo.replace_readme(path,original)
            self.assertTrue(path.read_bytes().startswith(b'outside\n'+demo.START.encode()))
            self.assertTrue(path.read_bytes().endswith(demo.END.encode()+b'\nafter\n'))
            self.assertIn(b'[![Plugin demo](assets/demo.gif)](assets/demo.mp4)',path.read_bytes())
            self.assertEqual(path.read_bytes(), b'outside\n'+demo.START.encode()+b'\n[![Plugin demo](assets/demo.gif)](assets/demo.mp4)\n'+demo.END.encode()+b'\nafter\n')
            link=Path(temp)/'link'; link.symlink_to(path)
            with self.assertRaises(ValueError): demo.readme_snapshot(link)

    def test_local_publication_integrity_and_rollback(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp); base=root/'evidence'; base.mkdir(); package=root/'package'; package.mkdir()
            readme=package/'README.md'; original=(demo.START+'\nold\n'+demo.END).encode(); readme.write_bytes(original)
            for name,data in [('demo.gif',b'gif bytes'),('demo.mp4',b'video bytes')]: (base/name).write_bytes(data)
            manifest={suffix+'_sha256':demo.sha(base/('demo.'+suffix)) for suffix in ('gif','mp4')}
            (base/'demo-manifest.json').write_text(json.dumps(manifest))
            manifest['source_hashes'] = {'source.ts': 'stale'}
            (base/'demo-manifest.json').write_text(json.dumps(manifest))
            (package/'source.ts').write_text('new')
            with self.assertRaisesRegex(ValueError,'Source changed'):
                demo.publish(base,readme,original,package,['source.ts'])
            assets=package/'assets'; assets.mkdir()
            (assets/'demo.gif').write_bytes(b'old gif'); (assets/'demo.mp4').write_bytes(b'old video')
            (assets/'unrelated.txt').write_text('preserve')
            real=demo.os.replace
            def fail_second(source,path):
                if path.name=='demo.mp4' and Path(source).read_bytes()==b'video bytes': raise OSError('asset write failed')
                return real(source,path)
            with patch.object(demo.os,'replace',side_effect=fail_second):
                with self.assertRaisesRegex(OSError,'asset write failed'): demo.publish(base,readme,original)
            self.assertEqual(readme.read_bytes(),original)
            self.assertEqual((assets/'demo.gif').read_bytes(),b'old gif')
            self.assertEqual((assets/'demo.mp4').read_bytes(),b'old video')
            with patch.object(demo,'replace_readme',side_effect=ValueError('concurrent')):
                with self.assertRaises(ValueError): demo.publish(base,readme,original)
            self.assertEqual((assets/'demo.gif').read_bytes(),b'old gif')
            manifest['gif_sha256']='bad'; (base/'demo-manifest.json').write_text(json.dumps(manifest))
            with self.assertRaises(ValueError): demo.publish(base,readme,original)
            self.assertEqual(readme.read_bytes(),original)
            manifest['gif_sha256']=demo.sha(base/'demo.gif'); (base/'demo-manifest.json').write_text(json.dumps(manifest))
            (assets/'demo.gif').unlink(); (assets/'demo.gif').symlink_to(base/'demo.gif')
            with self.assertRaises(ValueError): demo.publish(base,readme,original)
            (assets/'demo.gif').unlink(); (assets/'demo.gif').write_bytes(b'old gif')
            self.assertEqual(demo.publish(base,readme,original),'assets/demo.gif + assets/demo.mp4')
            self.assertEqual((assets/'demo.gif').read_bytes(),(base/'demo.gif').read_bytes())
            self.assertEqual((assets/'demo.mp4').read_bytes(),(base/'demo.mp4').read_bytes())
            self.assertEqual((assets/'unrelated.txt').read_text(),'preserve')
            self.assertIn(b'[![',readme.read_bytes())

    def test_frame_cap_before_encoding(self):
        with tempfile.TemporaryDirectory() as temp:
            base=Path(temp)
            events=[dict(type='phase',name=name,time=t) for name,t in
                    [('demo-foo-start',0),('demo-foo-end',29),('demo-regex-start',30),('demo-regex-end',59)]]
            with patch.object(demo,'recording',return_value=(b'',events)), patch.object(demo,'Renderer'):
                with self.assertRaisesRegex(ValueError,'cap exceeded'): demo.make(base,base,[])

    def test_encode_failure(self):
        import subprocess
        failed=subprocess.CompletedProcess(['ffmpeg'],1,b'',b'encoding failed')
        with patch('subprocess.run',return_value=failed):
            with self.assertRaisesRegex(RuntimeError,'encoding failed'): demo.invoke(['ffmpeg'])

    def test_truecolor_reverse_bold_underline_wide_and_pua(self):
        try: renderer=demo.Renderer()
        except demo.Blocked as error: self.skipTest(str(error))
        screen=renderer.pyte.Screen(130,36); stream=renderer.pyte.ByteStream(screen)
        stream.feed('\x1b[38;2;125;85;10;1;4mA\x1b[7mB\x1b[0m界\ue634'.encode())
        self.assertEqual(screen.buffer[0][0].fg,'7d550a')
        self.assertTrue(screen.buffer[0][0].bold and screen.buffer[0][0].underscore)
        image=renderer.image(screen)
        self.assertEqual(image.size,(1430,864))
        self.assertEqual(image.getpixel((11,0)),(125,85,10))
        self.assertIn('U+E634',renderer.proof)
        with self.assertRaises(ValueError): renderer.icon(chr(0x10ffff))
        screen.resize(lines=18,columns=130)
        self.assertEqual(renderer.image(screen).size,(1430,864))


if __name__ == '__main__': unittest.main()
