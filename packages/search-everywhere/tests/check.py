#!/usr/bin/env python3
"""Disposable foreground-search fixture checks; no publication or user-project scan."""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time

SOURCE = Path(__file__).resolve().parent.parent
REPO = SOURCE.parent.parent
SHARED = Path('packages/_shared/runtime_brand.ts')
FRESH = Path.home()/'.local/opt/fresh/fresh'
FILES = ['search_everywhere.ts', 'search_backend.py', 'README.md',
         *['lib/' + n + '.ts' for n in ('config', 'query', 'model', 'rank', 'search', 'ui')],
         'scripts/build-package.mjs', 'tests/core.test.ts', 'tests/smoke.py', 'tests/package.test.mjs', 'tests/entry.test.mjs',
         *['dist/' + n for n in ('package.json', 'search-everywhere.ts', 'search_backend.py', 'README.md')],
         'tests/index_backend_test.py', 'tests/check.py', 'tests/test_checker.py']


def isolated_env(base):
    env = os.environ.copy()
    for key in list(env):
        if key.startswith('FRESH_') or key in ('NODE_OPTIONS', 'NODE_PATH', 'PYTHONSTARTUP', 'PYTHONPATH',
                'BASH_ENV', 'ENV', 'ZDOTDIR', 'LD_PRELOAD', 'LD_LIBRARY_PATH'):
            del env[key]
    for key, name in [('HOME', 'home'), ('XDG_CONFIG_HOME', 'config'), ('XDG_DATA_HOME', 'data'),
                      ('XDG_STATE_HOME', 'state'), ('XDG_CACHE_HOME', 'cache'), ('XDG_RUNTIME_DIR', 'runtime'), ('TMPDIR', 'tmp')]:
        path = base / name
        path.mkdir(mode=0o700)
        env[key] = str(path)
    return env


def tool(candidate):
    path = Path(candidate) if candidate else None
    return str(path) if path and path.is_file() and os.access(path, os.X_OK) else None


def fresh_tool(explicit):
    return tool(explicit) if explicit else tool(FRESH) or tool(shutil.which('fresh'))


def classification(checks, smoke_only):
    selected = [c for c in checks if not smoke_only or c['scope'] == 'smoke']
    status = ('FAIL' if any(c['status'] == 'FAIL' for c in selected) else
              'BLOCKED' if any(c['status'] == 'BLOCKED' for c in selected) else 'PASS')
    return status, {'PASS': 0, 'FAIL': 1, 'BLOCKED': 2}[status]


def identity(pid):
    try:
        return Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[19]
    except (FileNotFoundError, ProcessLookupError):
        return None


def run(command, cwd, env, log, timeout):
    """TERM permits smoke's finally; KILL only the still-owned process group."""
    with log.open('wb') as output:
        p = subprocess.Popen(command, cwd=cwd, env=env, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        start = identity(p.pid)
        timed_out = False
        try:
            deadline = time.monotonic() + timeout
            while os.waitid(os.P_PID, p.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is None:
                if time.monotonic() >= deadline:
                    timed_out = True; break
                time.sleep(.02)
        finally:
            if start is not None and identity(p.pid) == start:
                try:
                    os.killpg(p.pid, signal.SIGTERM)
                    time.sleep(8)
                    if identity(p.pid) == start: os.killpg(p.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            p.wait(timeout=3)
        return p.returncode, timed_out


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fresh', help='read-only Fresh executable')
    parser.add_argument('--node', help='read-only Node executable with strip-types')
    args = parser.parse_args()
    base = Path(tempfile.mkdtemp(prefix='fresh-remote-automation-', dir='/tmp'))
    env = isolated_env(base)
    fixture_repo = base / 'repo'
    fixture = fixture_repo / 'packages/search-everywhere'
    fixture.mkdir(parents=True)
    for name in FILES:
        dest = fixture / name; dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(SOURCE / name, dest)
    shared = fixture_repo / SHARED; shared.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(REPO / SHARED, shared)
    checks = []
    for name, command, deadline in [
            ('checker-policy', [sys.executable, 'tests/test_checker.py'], 90),
            ('helper', [sys.executable, 'tests/index_backend_test.py'], 90),
            ('core', [tool(args.node) if args.node else tool(shutil.which('node')), '--experimental-strip-types', '--test', 'tests/core.test.ts'], 60),
            ('package-entry', [tool(args.node) if args.node else tool(shutil.which('node')), '--test', 'tests/package.test.mjs', 'tests/entry.test.mjs'], 60),
            ('native-config', [sys.executable, 'tests/smoke.py', fresh_tool(args.fresh)], 120)]:
        if any(item is None for item in command):
            checks.append(dict(name=name, status='BLOCKED', scope='acceptance', detail='Executable missing; no installation attempted.')); continue
        log = base / (name + '.log')
        code, expired = run(command, fixture, env, log, deadline)
        checks.append(dict(name=name, status='PASS' if code == 0 and not expired else 'FAIL', scope='acceptance',
                           exit=code, timeout=expired, log=str(log)))
    status, code = classification(checks, False)
    (base / 'report.json').write_text(json.dumps({'status': status, 'checks': checks,
        'limits': ['Disposable LOCAL Linux fixtures only; not real Arc corpus performance/coverage.',
                   'Environment isolation, not an OS filesystem/network sandbox.', 'Reviewer and package checks remain separate.']}, indent=2))
    print(status, base)
    return code


if __name__ == '__main__':
    sys.exit(main())
