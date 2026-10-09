"""Foreground search only. No index, cache, inventory persistence or buffer snapshots."""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import signal
import stat
import subprocess
import sys
import time

MAX_OUTPUT = 1024 * 1024
MAX_STDERR = 16384
MAX_PATHS = 20000
MAX_RECORD = 16384
FOLD = str.maketrans('ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')
ACTIVE = None
DEADLINE = 0


class BackendError(Exception):
    pass


def fold(text):
    return text.translate(FOLD)


def literal(text):
    return ''.join('[' + c.lower() + c.upper() + ']' if c.isascii() and c.isalpha()
                   else re.escape(c) for c in text)


def within(path, root):
    return path == root or path.startswith(root.rstrip('/') + '/')


def relative(path):
    return (isinstance(path, str) and 0 < len(path.encode('utf-8')) <= 4096
            and not path.startswith('/') and not re.match(r'^[\w+.-]+:', path)
            and not any(c in {'', '.', '..'} for c in path.split('/'))
            and not re.search(r'[\x00-\x1f\x7f\\:]', path))


class OwnedCommand:
    """Tiny Linux supervisor: parent death kills the owned group, including grandchildren."""
    def __init__(self, argv, root):
        out_r, out_w = os.pipe()
        err_r, err_w = os.pipe()
        status_r, status_w = os.pipe()
        self.pid = os.fork()
        if self.pid == 0:
            os.close(out_r); os.close(err_r); os.close(status_r)
            os.setsid()
            child = None
            def stop(_sig=None, _frame=None):
                signal.signal(signal.SIGTERM, signal.SIG_IGN)
                signal.setitimer(signal.ITIMER_REAL, 0)
                if child is not None:
                    for sig in (signal.SIGTERM, signal.SIGKILL):
                        try: os.killpg(child.pid, sig)
                        except ProcessLookupError: pass
                        if sig == signal.SIGTERM: time.sleep(.05)
                    child.wait()
                    # Subreaper adopts group descendants when the native leader exits.
                    while True:
                        try: os.waitpid(-child.pid, 0)
                        except ChildProcessError: break
                os._exit(0)
            # Unwind Popen.wait's lock before cleanup; cleanup inside its signal handler can deadlock.
            signal.signal(signal.SIGTERM, interrupted)
            signal.signal(signal.SIGINT, interrupted)
            signal.signal(signal.SIGALRM, interrupted)
            try:
                if ctypes.CDLL(None).prctl(36, 1, 0, 0, 0):
                    raise BackendError('Cannot establish descendant reaping')
                parent_death()
                signal.setitimer(signal.ITIMER_REAL, max(.01, DEADLINE - time.monotonic()))
                blocked = {signal.SIGTERM, signal.SIGINT, signal.SIGALRM}
                previous = signal.pthread_sigmask(signal.SIG_BLOCK, blocked)
                try:
                    child = subprocess.Popen(argv, cwd=root, stdout=out_w, stderr=err_w, start_new_session=True,
                                             preexec_fn=lambda: signal.pthread_sigmask(signal.SIG_SETMASK, previous))
                finally:
                    signal.pthread_sigmask(signal.SIG_SETMASK, previous)
                code = child.wait()
                os.write(status_w, str(code).encode())
            except BaseException:
                os.write(status_w, b'127')
            finally:
                stop()
        os.close(out_w); os.close(err_w); os.close(status_w)
        self.stdout = os.fdopen(out_r, 'rb', buffering=0)
        self.stderr = os.fdopen(err_r, 'rb', buffering=0)
        self.status = os.fdopen(status_r, 'rb', buffering=0)
        self.reaped = False
    def wait(self):
        if not self.reaped:
            os.waitpid(self.pid, 0)
            self.reaped = True
        code = self.status.read(16)
        self.status.close()
        return int(code) if code else 127


def cleanup(child):
    # The supervisor settles its native group before exit; never signal a reaped/reusable PID.
    if child.reaped:
        return
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(child.pid, sig)
        except ProcessLookupError:
            pass
        if sig == signal.SIGTERM:
            time.sleep(.2)
    if not child.reaped:
        child.wait()


def interrupted(_sig, _frame):
    raise BackendError('Search cancelled or deadline exceeded')


def parent_death():
    parent = os.getppid()
    if parent == 1:
        raise BackendError('Search owner exited')
    # TERM runs cleanup in the helper, or kills the entire supervised command group.
    if ctypes.CDLL(None).prctl(1, signal.SIGTERM, 0, 0, 0):
        raise BackendError('Cannot establish parent-death cleanup')
    if os.getppid() != parent:
        raise BackendError('Search owner exited')


def command(argv, root, cap=MAX_OUTPUT, accepted=(0,), record_separator=b'\n'):
    global ACTIVE
    if time.monotonic() >= DEADLINE:
        raise BackendError('Search deadline exceeded')
    child = OwnedCommand(argv, root)
    ACTIVE = child
    out, err = bytearray(), bytearray()
    tail = 0
    sel = selectors.DefaultSelector()
    sel.register(child.stdout, selectors.EVENT_READ, out)
    sel.register(child.stderr, selectors.EVENT_READ, err)
    try:
        while sel.get_map():
            if time.monotonic() >= DEADLINE:
                raise BackendError('Search deadline exceeded')
            for event, _ in sel.select(.05):
                chunk = os.read(event.fileobj.fileno(), 8192)
                if not chunk:
                    sel.unregister(event.fileobj)
                    continue
                event.data.extend(chunk)
                if len(out) > cap or len(err) > MAX_STDERR:
                    raise BackendError('Search output limit reached (PARTIAL); narrow query')
                if event.data is out:
                    parts = chunk.split(record_separator)
                    if len(parts[0]) + tail > MAX_RECORD or any(len(p) > MAX_RECORD for p in parts):
                        raise BackendError('Search record limit reached (PARTIAL); narrow query')
                    tail = tail + len(chunk) if len(parts) == 1 else len(parts[-1])
        code = child.wait()
        if code not in accepted:
            raise BackendError('Native command failed (exit %s); check tool/auth/network configuration' % code)
        return bytes(out).decode('utf-8', 'strict'), bytes(err).decode('utf-8', 'strict'), code
    except (UnicodeError, subprocess.TimeoutExpired) as error:
        raise BackendError('Invalid UTF-8 or command deadline exceeded') from error
    finally:
        sel.close()
        cleanup(child)
        child.stdout.close()
        child.stderr.close()
        ACTIVE = None


def mounts():
    def unescape(s):
        return re.sub(r'\\([0-7]{3})', lambda m: chr(int(m[1], 8)), s)
    rows = []
    with open('/proc/self/mountinfo', encoding='utf-8') as source:
        for line in source:
            a, b = line.rstrip('\n').split(' - ', 1)
            fields = a.split()
            rows.append((unescape(fields[4]), fields[0], fields[2], unescape(fields[3]), b.split()[0]))
    if not rows:
        raise BackendError('Cannot verify filesystem mounts')
    return rows


def guard(root, authority, run=command, table=mounts):
    if sys.platform != 'linux' or authority:
        raise BackendError('Search requires a LOCAL Linux project')
    if not os.path.isabs(root) or os.path.normpath(root) != root or os.path.realpath(root) != root:
        raise BackendError('Project must be a physical absolute directory')
    home = os.path.realpath(os.path.expanduser('~'))
    if root in {'/', '/codenv', home, home + '/arc-wt'} or within(home, root):
        raise BackendError('HOME, roots and Arc worktree parents are forbidden')
    for p in [Path(root), *Path(root).parents]:
        if stat.S_ISLNK(os.lstat(p).st_mode):
            raise BackendError('Symlink project roots are forbidden')
    info = os.stat(root)
    if not stat.S_ISDIR(info.st_mode):
        raise BackendError('Project is not a directory')
    rows = table()
    if any(point != '/' and within(point, root) for point, *_ in rows):
        raise BackendError('Mount root/ancestor/nested mount scope is forbidden')
    owner = max((m for m in rows if within(root, m[0])), key=lambda m: len(m[0]))
    # CLI failure is not proof of non-Arc. Only the observed exact non-Arc diagnostic is accepted.
    listing, _, _ = run(['arc', 'mount', '--list', '--json'], root)
    try:
        listed = json.loads(listing)
    except ValueError as error:
        raise BackendError('Invalid Arc mount metadata') from error
    if not isinstance(listed, list) or any(not isinstance(m, dict) or not isinstance(m.get('mount'), str)
                                         or not isinstance(m.get('status'), str) for m in listed):
        raise BackendError('Unknown Arc mount schema')
    for m in listed:
        if not os.path.isabs(m['mount']) or os.path.normpath(m['mount']) != m['mount']:
            raise BackendError('Invalid Arc mount path')
        if within(m['mount'], root):
            raise BackendError('Arc root/ancestor/nested mount is forbidden')
    matched = [m for m in listed if m['status'] == 'mounted' and within(root, m['mount'])]
    output, stderr, code = run(['arc', 'root', '--from-cwd'], root, accepted=(0, 1, 2))
    arc = None
    if matched:
        if len(matched) != 1 or code or not output.strip():
            raise BackendError('Arc root identity is uncertain')
        m = matched[0]
        resolved = os.path.normpath(os.path.join(root, output.strip()))
        if resolved != m['mount'] or owner[0] != resolved or not owner[4].startswith('fuse'):
            raise BackendError('Arc CLI and physical mount disagree')
        if not isinstance(m.get('pid'), int) or not isinstance(m.get('store'), str):
            raise BackendError('Arc mount ownership metadata missing')
        arc = {k: m.get(k) for k in ('mount', 'pid', 'store', 'object-store', 'tenant')}
    else:
        diagnostic = (output + stderr).strip()
        if not code or diagnostic != 'Not a mounted arc repository. Did you forget to mount arcadia?':
            raise BackendError('Non-Arc scope not positively verified')
        if owner[4] not in {'ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'tmpfs', 'overlay'} or owner[3] != '/':
            raise BackendError('Unknown FUSE/bind filesystem; no local search')
        for p in [Path(root), *Path(root).parents]:
            if (p / '.arc').exists() or (p / '.arcignore').exists():
                raise BackendError('Unverified Arc markers; no local search')
    identity = {'root': root, 'dev': info.st_dev, 'ino': info.st_ino, 'mount': owner, 'arc': arc}
    return {'root': root, 'identity': hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest(),
            'arc': arc, 'prefix': os.path.relpath(root, arc['mount']) if arc else None,
            '_physical': [info.st_dev, info.st_ino, rows]}


def recheck(scope):
    # CLI authorization lives only for this invocation; detect root/mount replacement before each child.
    info = os.stat(scope['root'])
    if os.path.realpath(scope['root']) != scope['root'] or [info.st_dev, info.st_ino, mounts()] != scope['_physical']:
        raise BackendError('Project/mount identity changed')
    arc = scope['arc']
    if arc and not os.path.exists('/proc/' + str(arc['pid'])):
        raise BackendError('Arc mount owner exited')
    return scope


def public_scope(scope):
    return {k: scope[k] for k in ('root', 'identity')}


def provider(scope, backend, arc_backend):
    selected = arc_backend if scope['arc'] else backend
    if selected not in {'rg', 'remote'} or (selected == 'remote') != bool(scope['arc']):
        raise BackendError('Configuration error: use arcBackend=remote in Arc and backend=rg outside Arc')
    return selected


def remote_path(path, prefix):
    if not relative(path) or not path.startswith(prefix + '/'):
        raise BackendError('Unsafe or out-of-scope remote path')
    return path[len(prefix) + 1:]


def parse_remote(text, prefix, content):
    rows = []
    for record in text.split('\n'):
        if not record:
            continue
        if content:
            m = re.fullmatch(r'([^:]+):([1-9][0-9]*):(.*)', record)
            if not m or len(re.findall(r'(?=:[1-9][0-9]*:)', record)) != 1 or len(m[3].encode()) > 8192:
                raise BackendError('Unexpected remote content record')
            path = remote_path(m[1], prefix)
            line = int(m[2])
            if line > 2147483647:
                raise BackendError('Remote line exceeds navigation bounds')
            rows.append({'kind': 'content', 'path': path, 'line': line, 'snippet': m[3]})
        else:
            rows.append({'kind': 'file', 'path': remote_path(record, prefix)})
        if len(rows) > 800:
            raise BackendError('Remote record cap exceeded (PARTIAL)')
    return rows


def parse_rg(text, query):
    rows = []
    count = 0
    for record in text.split('\n'):
        if not record:
            continue
        count += 1
        if count > MAX_PATHS:
            raise BackendError('Local record cap reached (PARTIAL)')
        try:
            item = json.loads(record)
            if item['type'] not in {'begin', 'match', 'end', 'summary'}:
                raise ValueError()
            if item['type'] != 'match':
                continue
            d = item['data']
            path = d['path']['text'].removeprefix('./')
            snippet = d['lines']['text'].removesuffix('\n').removesuffix('\r')
            if not relative(path) or not isinstance(d['line_number'], int) or d['line_number'] < 1:
                raise ValueError()
            if len(snippet.encode()) > 8192 or fold(query) not in fold(snippet):
                raise ValueError()
            rows.append({'kind': 'content', 'path': path, 'line': d['line_number'], 'snippet': snippet})
        except (KeyError, TypeError, ValueError) as error:
            raise BackendError('Unexpected rg JSON record') from error
    return rows


def selected(scope, path):
    if not relative(path):
        raise BackendError('Invalid selected path')
    current = scope['root']
    device = os.stat(current).st_dev
    for component in path.split('/'):
        current = os.path.join(current, component)
        value = os.lstat(current)
        if stat.S_ISLNK(value.st_mode) or value.st_dev != device:
            raise BackendError('Selected path crosses symlink/mount boundary')
    if not stat.S_ISREG(value.st_mode):
        raise BackendError('Selected source is not a regular file')
    return current


def query(scope, args, run=command, verify=recheck):
    selected_provider = provider(scope, args.backend, args.arc_backend)
    q = args.query
    if not q or len(q.encode('utf-16-le')) // 2 > 512 or re.search(r'[\x00\r\n\ud800-\udfff]', q):
        raise BackendError('Query must be a valid single-line literal, up to 512 UTF-16 units')
    results = []
    warnings = []
    for content in (False, True):
        current = verify(scope)
        if current['identity'] != scope['identity']:
            raise BackendError('Project/mount identity changed')
        if selected_provider == 'remote':
            prefix = '^' + re.escape(scope['prefix']) + '/'
            argv = ['ya', 'grep', '--remote', '-R', '--no-colors', '-f', prefix + ('.*' if content else '.*' + literal(q) + '.*'), '-m', '800']
            if content:
                # A leading dash is escaped by literal() and cannot become a CLI option.
                argv.append(literal(q))
            output, err, _ = run(argv, args.root)
            rows = parse_remote(output, scope['prefix'], content)
            total = re.search(r'^Total: ([0-9]+)(\+?) \(revision: r[0-9]+\)$', err, re.MULTILINE)
            if not total or int(total[1]) != len(rows):
                raise BackendError('Unexpected remote summary; check source/tool errors')
            if total[2]:
                warnings.append('Server cap reached (PARTIAL)')
        else:
            argv = ['rg', '--no-config', '--no-follow', '--one-file-system']
            argv += ['--json', '--encoding', 'none', '--', literal(q), '.'] if content else ['--files', '--null', '--', '.']
            output, _, _ = run(argv, args.root, accepted=(0, 1), record_separator=b'\n' if content else b'\0')
            if content:
                rows = parse_rg(output, q)
            else:
                paths = output.split('\0')
                if paths[-1] != '' and output:
                    raise BackendError('Unterminated rg filename record')
                if len(paths) > MAX_PATHS:
                    raise BackendError('Filename examination cap reached (PARTIAL)')
                rows = []
                for path in paths[:-1]:
                    path = path.removeprefix('./')
                    if not relative(path):
                        raise BackendError('Unsafe rg filename')
                    if fold(q) in fold(path):
                        rows.append({'kind': 'file', 'path': path})
        results.extend(rows)
    current = verify(scope)
    if current['identity'] != scope['identity']:
        raise BackendError('Project/mount identity changed')
    by_path = {}
    for row in results:
        path = row['path']
        old = by_path.get(path)
        if old is None or row['kind'] == 'content' and (old['kind'] == 'file' or row['line'] < old['line']):
            row['filenameMatch'] = fold(q) in fold(path)
            row['name'] = path.split('/')[-1]
            by_path[path] = row
    if len(by_path) > 800:
        warnings.append('Unique candidate cap reached (PARTIAL)')
    return {'state': 'ok', **public_scope(scope), 'source': 'trunk' if selected_provider == 'remote' else 'local',
            'results': list(by_path.values())[:800], 'warnings': warnings}


def main():
    global DEADLINE
    p = argparse.ArgumentParser()
    p.add_argument('operation', choices=['query', 'validate'])
    p.add_argument('--root', required=True)
    p.add_argument('--authority', default='')
    p.add_argument('--backend', required=True)
    p.add_argument('--arc-backend', required=True)
    p.add_argument('--work-ms', type=int, default=15000)
    p.add_argument('--query', default='')
    p.add_argument('--path', default='')
    p.add_argument('--identity', default='')
    args = p.parse_args()
    if not 100 <= args.work_ms <= 30000:
        raise BackendError('Invalid total work budget')
    # Guard and collection share a finite additional 8s; search operations share work-ms.
    total_end = time.monotonic() + args.work_ms / 1000 + 8
    DEADLINE = time.monotonic() + 8
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGALRM, interrupted)
    parent_death()
    signal.setitimer(signal.ITIMER_REAL, args.work_ms / 1000 + 8)
    scope = guard(args.root, args.authority)
    provider(scope, args.backend, args.arc_backend)
    DEADLINE = min(total_end, time.monotonic() + args.work_ms / 1000)
    if args.operation == 'query':
        return query(scope, args)
    if scope['identity'] != args.identity:
        raise BackendError('Selected source scope changed')
    path = selected(scope, args.path)
    current = recheck(scope)
    if current['identity'] != scope['identity']:
        raise BackendError('Selected source scope changed')
    return {'state': 'ok', 'valid': True, 'path': path, 'identity': scope['identity']}


if __name__ == '__main__':
    try:
        reply = main()
    except (BackendError, OSError, ValueError) as error:
        reply = {'state': 'error', 'error': str(error)[:1000]}
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        if ACTIVE is not None:
            cleanup(ACTIVE)
    encoded = json.dumps(reply, ensure_ascii=True, separators=(',', ':')).encode()
    if len(encoded) + 1 > MAX_OUTPUT:
        encoded = b'{"state":"error","error":"Helper reply cap exceeded (PARTIAL); narrow query"}'
    sys.stdout.buffer.write(encoded + b'\n')
