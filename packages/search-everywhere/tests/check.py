#!/usr/bin/env python3
"""Offline, disposable-environment checks; not full plugin acceptance."""
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
SHARED_FILES = [SHARED, Path('packages/_shared/runtime_icons.ts'), Path('packages/_shared/native_demo.py')]
FRESH = Path.home()/'.local/opt/fresh/fresh'
NODE = Path.home()/'.local/opt/fresh-node/bin/node'
FILES = ['search_everywhere.ts', *['lib/' + n + '.ts' for n in
         ('config', 'model', 'providers', 'rank', 'search', 'ui')],
         'tests/core.test.ts', 'tests/smoke.py', 'tests/fake_lsp.py',
         'tests/check.py', 'tests/test_checker.py', 'tests/demo.py',
         'tests/test_demo.py', 'tests/requirements-demo.txt']
GATES = {
    'auto-lsp-registry': 'Fresh 0.5.2 exposes no verified project-scoped runtime LSP registry/capabilities; only explicit-language parallel search is covered.',
    'default-filenames': 'No default filename backend; known fixture provider is not project-wide search.',
    'builtin-rg': 'Builtin rg is disabled pending bounded native output capture/cancellation.',
    'arbitrary-line-reads': 'Only first 64 KiB is read; arbitrary-location bounded reads are not implemented.',
    'real-kotlin': 'Fake JSON-RPC LSP is not Kotlin. No real Kotlin execution without proven safe OS isolation.',
    'remote-authority': 'Real remote read/exec/cancel is not checked.',
    'semantic-typecheck': 'Fresh entry script check is not full TypeScript semantic typecheck.',
}


sys.path.insert(0, str(REPO / 'packages/_shared'))
from native_demo import isolated_env

def tool(candidate):
    path = Path(candidate) if candidate else None
    return str(path) if path and path.is_file() and os.access(path, os.X_OK) else None


def fresh_tool(explicit):
    if explicit:
        return tool(explicit)
    # Prefer the known native installation over HOME-relative PATH wrappers.
    return tool(FRESH) or tool(shutil.which('fresh'))


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
        p = subprocess.Popen(command, cwd=cwd, env=env, stdout=output,
                             stderr=subprocess.STDOUT, start_new_session=True)
        start = identity(p.pid)
        timed_out = False
        try:
            deadline = time.monotonic() + timeout
            # WNOWAIT observes exit without releasing the PID/PGID reservation.
            # Never call Popen.poll/wait until both group signals are finished.
            while os.waitid(os.P_PID, p.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is None:
                if time.monotonic() >= deadline:
                    timed_out = True
                    break
                time.sleep(.02)
        finally:
            if start is not None and identity(p.pid) == start:
                try:
                    os.killpg(p.pid, signal.SIGTERM)
                    # A zombie leader does not imply its descendants have exited.
                    # Allow smoke's finally its full grace before the final KILL.
                    time.sleep(8)
                    if identity(p.pid) == start:
                        os.killpg(p.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            p.wait(timeout=3)
        return p.returncode, timed_out


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--smoke-only', action='store_true',
                        help='exit 0 for covered regressions only; acceptance remains BLOCKED')
    parser.add_argument('--publish-demo', action='store_true',
                        help='after successful smoke/video checks, update local GIF/MP4 assets and package README demo markers')
    parser.add_argument('--fresh', help='path to an installed Fresh 0.5.2 executable')
    parser.add_argument('--node', help='path to an installed Node 24 executable')
    args = parser.parse_args()
    import demo
    readme = SOURCE / 'README.md'
    original = demo.readme_snapshot(readme) if args.publish_demo else None
    base = Path(tempfile.mkdtemp(prefix='fresh-search-automation-', dir='/tmp'))
    env = isolated_env(base)
    fixture_repo = base / 'repo'
    fixture = fixture_repo / 'packages/search-everywhere'
    fixture.mkdir(parents=True)
    for name in FILES:
        dest = fixture / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(SOURCE / name, dest)
    for shared in SHARED_FILES:
        shared_dest = fixture_repo / shared
        shared_dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(REPO / shared, shared_dest)
    source_files = ['packages/search-everywhere/' + name for name in FILES] + [str(shared) for shared in SHARED_FILES]
    checks = []
    native_log = None
    evidence = None
    video = None

    def check(name, command, timeout=30, child_env=None):
        log = base / (name + '.log')
        if not command[0]:
            checks.append(dict(name=name, status='BLOCKED', scope='smoke',
                               detail='Required executable is missing; no installation attempted.'))
            return None
        try:
            code, expired = run(command, fixture, child_env or env, log, timeout)
            status = 'FAIL' if expired or code != 0 else 'PASS'
            detail = 'Timeout; owned process cleanup requested.' if expired else f'Exit {code}.'
        except OSError as error:
            status, detail = 'FAIL', f'Launch failed: {type(error).__name__}.'
        checks.append(dict(name=name, status=status, scope='smoke', detail=detail,
                           command=command, log=str(log)))
        return log if status == 'PASS' else None

    check('checker-policy', [sys.executable, 'tests/test_checker.py'], timeout=60)
    demo_env = env.copy()
    # Read-only known fonts remain available despite the disposable HOME.
    for key, default in [('DEMO_FONT_REGULAR', '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'),
                         ('DEMO_FONT_BOLD', '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf'),
                         ('DEMO_FONT_ICONS', str(Path.home()/'.local/share/fonts/NerdFontsSymbolsOnly/SymbolsNerdFontMono-Regular.ttf'))]:
        demo_env[key] = os.environ.get(key, default)
    check('demo-policy', [sys.executable, 'tests/test_demo.py'], timeout=60, child_env=demo_env)
    node = tool(args.node) if args.node else tool(shutil.which('node')) or tool(NODE)
    fresh = fresh_tool(args.fresh)
    check('core', [node, '--experimental-strip-types', '--test', 'tests/core.test.ts'])
    version_log = check('fresh-version', [fresh, '--version'])
    supported = version_log and version_log.read_text().strip() == 'fresh 0.5.2'
    if version_log and not supported:
        checks[-1].update(status='BLOCKED', detail='Requires original Fresh 0.5.2.')
    if supported:
        # The viewport/Unicode/six-theme QA precedes the existing lifecycle cases.
        native_log = check('native-pty', [sys.executable, 'tests/smoke.py', fresh], timeout=240)
        # Fresh writes its API declarations on editor startup. Reuse only the
        # owned smoke config, never the user's existing declaration directory.
        evidence = None
        if native_log:
            for line in native_log.read_text().splitlines():
                if line.startswith('Evidence: '):
                    candidate = Path(line[len('Evidence: '):])
                    if candidate.parent == base / 'tmp' and candidate.is_dir():
                        evidence = candidate
        if evidence:
            entry_env = env.copy()
            for key, name in [('HOME', 'home'), ('XDG_CONFIG_HOME', 'config'),
                              ('XDG_DATA_HOME', 'data'), ('XDG_STATE_HOME', 'state'),
                              ('XDG_CACHE_HOME', 'cache'), ('XDG_RUNTIME_DIR', 'runtime'),
                              ('TMPDIR', 'tmp')]:
                entry_env[key] = str(evidence / name)
            check('entry-script', [fresh, '--cmd', 'script', 'check', 'search_everywhere.ts'], child_env=entry_env)
        else:
            checks.append(dict(name='entry-script', status='BLOCKED', scope='smoke',
                               detail='Owned native startup API declarations unavailable.'))
    else:
        for name in ('entry-script', 'native-pty'):
            checks.append(dict(name=name, status='BLOCKED', scope='smoke', detail='Fresh 0.5.2 unavailable.'))
    if evidence:
        try:
            video = demo.make(evidence, fixture_repo, source_files)
            checks.append(dict(name='demo-video', status='PASS', scope='smoke', detail='Timestamped PTY replay; PNG proof, H264/GIF full decode and caps verified.',
                               gif=str(evidence/'demo.gif'), mp4=str(evidence/'demo.mp4'), manifest=str(evidence/'demo-manifest.json'), recording=str(evidence/'recording.jsonl')))
        except demo.Blocked as error:
            checks.append(dict(name='demo-video', status='BLOCKED', scope='smoke', detail=str(error)))
        except Exception as error:
            checks.append(dict(name='demo-video', status='FAIL', scope='smoke', detail=f'{type(error).__name__}: {error}'))
    else:
        checks.append(dict(name='demo-video', status='BLOCKED', scope='smoke', detail='Successful native recording unavailable.'))
    if args.publish_demo:
        if classification(checks, True)[0] == 'PASS' and video:
            try:
                assets = demo.publish(evidence, readme, original, REPO, source_files)
                checks.append(dict(name='demo-publication', status='PASS', scope='smoke', detail=assets))
            except Exception as error:
                checks.append(dict(name='demo-publication', status='FAIL', scope='smoke', detail=f'{type(error).__name__}: {error}'))
        else:
            checks.append(dict(name='demo-publication', status='BLOCKED', scope='smoke', detail='Smoke/video gates must pass; README untouched.'))
    checks.append(dict(name='syntax-preview', status='PASS' if supported and native_log else 'BLOCKED',
                       scope='acceptance', detail='Actual native Kotlin pane syntax/geometry/visible source asserted in PTY.'
                       if supported and native_log else 'Native pane syntax not verified.'))
    for name, detail in GATES.items():
        checks.append(dict(name=name, status='BLOCKED', scope='acceptance', detail=detail))
    status, code = classification(checks, args.smoke_only)
    acceptance, _ = classification(checks, False)
    report = dict(status=status, exit_code=code, mode='smoke-only' if args.smoke_only else 'acceptance',
                  acceptance=acceptance, isolation={
                      'level': 'environment-only', 'os_sandbox': False,
                      'detail': 'Temporary HOME/XDG/TMPDIR/cwd; copied plugin/config; PATH unchanged. '
                                'No OS filesystem or network guarantee. No real Kotlin/remote execution.'},
                  evidence=str(base), checks=checks)
    (base / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    lines = [f'# Search Everywhere automation — {status}', '',
             f'Mode: **{report["mode"]}**; exit **{code}**; full acceptance: **{acceptance}**.', '',
             'Isolation: **environment-only**, not an OS sandbox. Original Fresh/Node executables are read-only inputs. '
             'Temporary HOME/XDG/TMPDIR and fixture cwd; PATH unchanged. No user config, Kotlin wrapper, '
             'Gradle cache, real project, remote, or Fresh installation was used. Only --publish-demo updates local GIF/MP4 assets and the README.', '',
             f'JSON and logs: `{base}`. Native evidence is under its `tmp/fresh-search-smoke-*`.', '',
             '| Check | Status | Detail |', '|---|---|---|']
    lines += [f'| {c["name"]} | {c["status"]} | {c["detail"]} |' for c in checks]
    lines += ['', 'Passing disabled-backend safety assertions proves the gate, not implementation of that feature.',
              'Fresh entry script check is not semantic TypeScript typechecking.', '']
    markdown = '\n'.join(lines)
    (base / 'report.md').write_text(markdown)
    # Explicit requested /tmp artifact; refuse symlink destinations.
    fd = os.open('/tmp/fresh-search-automation-results.md',
                 os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as stream:
        stream.write(markdown)
    print(f'{status} ({report["mode"]}, exit {code}); full acceptance: {acceptance}')
    for c in checks:
        print(f'  {c["status"]}: {c["name"]} — {c["detail"]}')
    print(f'Report: {base}/report.json\nMarkdown: /tmp/fresh-search-automation-results.md')
    return code


if __name__ == '__main__':
    sys.exit(main())
