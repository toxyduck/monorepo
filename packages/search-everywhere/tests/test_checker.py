"""Small stdlib checks for automation policy, not plugin acceptance."""
import json
import os
from pathlib import Path
import signal
import sys
import time
import tempfile
import unittest
from unittest.mock import patch

import check


class CheckerTests(unittest.TestCase):
    def test_status_and_exit_codes(self):
        rows = [dict(scope='smoke', status='PASS'), dict(scope='acceptance', status='BLOCKED')]
        self.assertEqual(check.classification(rows, False), ('BLOCKED', 2))
        self.assertEqual(check.classification(rows, True), ('PASS', 0))
        rows[0]['status'] = 'FAIL'
        self.assertEqual(check.classification(rows, True), ('FAIL', 1))
        rows[0]['status'] = 'BLOCKED'
        self.assertEqual(check.classification(rows, True), ('BLOCKED', 2))

    def test_explicit_shared_fixture_paths(self):
        self.assertEqual(check.SHARED.as_posix(), 'packages/_shared/runtime_brand.ts')
        self.assertEqual(check.REPO, check.SOURCE.parent.parent)
        self.assertTrue(all(not Path(name).is_absolute() and '..' not in Path(name).parts for name in check.FILES))
        self.assertEqual(len([name for name in check.FILES if name.endswith('.ts') and not name.startswith(('tests/', 'dist/'))]) + 1, 8)

    def test_missing_tool(self):
        self.assertIsNone(check.tool('/nonexistent/fresh-search-checker-tool'))
        self.assertIsNone(check.tool(None))
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            native, path_tool, explicit = [base / name for name in ('native', 'path', 'explicit')]
            for executable in (native, path_tool, explicit):
                executable.write_text('#!/bin/sh\nexit 0\n')
                executable.chmod(0o700)
            with patch.object(check, 'FRESH', native), patch.object(check.shutil, 'which', return_value=str(path_tool)):
                self.assertEqual(check.fresh_tool(str(explicit)), str(explicit))
                self.assertIsNone(check.fresh_tool(str(base / 'missing-explicit')))
                self.assertEqual(check.fresh_tool(None), str(native))
                native.unlink()
                self.assertEqual(check.fresh_tool(None), str(path_tool))

    def test_isolation_preserves_path_and_parent(self):
        before = os.environ.copy()
        with tempfile.TemporaryDirectory() as directory:
            env = check.isolated_env(Path(directory))
            self.assertEqual(env.get('PATH'), before.get('PATH'))
            for key in ('HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
                        'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'TMPDIR'):
                self.assertEqual(Path(env[key]).parent, Path(directory))
            self.assertNotIn('NODE_OPTIONS', env)
        self.assertEqual(dict(os.environ), before)

    def test_failure_and_timeout_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            env = check.isolated_env(base)
            log = base / 'child.log'
            code, expired = check.run([sys.executable, '-c', 'raise SystemExit(7)'], base, env, log, 2)
            self.assertEqual((code, expired), (7, False))
        self.cleanup_probe(early_exit=False, ignore_term=False)

    def test_cleanup_after_early_leader_exit(self):
        self.cleanup_probe(early_exit=True, ignore_term=False)

    def test_cleanup_when_child_ignores_term(self):
        self.cleanup_probe(early_exit=False, ignore_term=True)

    def cleanup_probe(self, early_exit, ignore_term):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            env = check.isolated_env(base)
            record = base / 'owned-child.json'
            child = ('import json,os,pathlib,signal,time; '
                     + ('signal.signal(signal.SIGTERM,signal.SIG_IGN); ' if ignore_term else '')
                     + 'pid=os.getpid(); '
                     'start=pathlib.Path(f"/proc/{pid}/stat").read_text().rsplit(")",1)[1].split()[19]; '
                     f'pathlib.Path({str(record)!r}).write_text(json.dumps([pid,start])); '
                     'time.sleep(60)')
            leader = ('import pathlib,subprocess,sys,time\n'
                      f'subprocess.Popen([sys.executable,"-c",{child!r}])\n'
                      f'while not pathlib.Path({str(record)!r}).exists(): time.sleep(.01)\n'
                      + ('raise SystemExit(0)\n' if early_exit else 'time.sleep(60)\n'))

            def working(pid, start):
                try:
                    fields = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
                    return fields[19] == start and fields[0] != 'Z'
                except (FileNotFoundError, ProcessLookupError):
                    return False

            try:
                code, expired = check.run([sys.executable, '-c', leader], base, env,
                                          base / 'child.log', 2)
                pid, start = json.loads(record.read_text())
                self.assertEqual(expired, not early_exit)
                self.assertEqual(code, 0 if early_exit else -signal.SIGTERM)
                deadline = time.monotonic() + 1
                while working(pid, start) and time.monotonic() < deadline:
                    time.sleep(.02)
                self.assertFalse(working(pid, start), 'owned descendant survived run()')
            finally:
                # Even a broken runner/assertion must not leak this fixture's child.
                if record.exists():
                    pid, start = json.loads(record.read_text())
                    if working(pid, start):
                        try:
                            os.kill(pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                    deadline = time.monotonic() + 1
                    while working(pid, start) and time.monotonic() < deadline:
                        time.sleep(.02)


if __name__ == '__main__':
    unittest.main()
