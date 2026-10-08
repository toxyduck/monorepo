"""Tiny JSON-RPC fixture, never a Kotlin implementation.
Optional slow/error roles exercise native per-language scheduling with file gates.
"""
import json, pathlib, sys, threading, time
root = pathlib.Path(sys.argv[1])
log = pathlib.Path(sys.argv[2])
role = sys.argv[3] if len(sys.argv) > 3 else 'normal'
lock = threading.Lock()
workers = []

def record(value):
    with lock:
        with log.open('a') as f:
            f.write(json.dumps(value) + '\n')

def respond(request):
    method = request.get('method')
    result = None
    error = None
    if method == 'initialize':
        result = {'capabilities': {'workspaceSymbolProvider': True, 'textDocumentSync': 1}}
    elif method == 'workspace/symbol':
        q = request.get('params', {}).get('query', '').lower()
        record({'event': 'begin', 'query': q, 'id': request['id']})
        if role == 'slow' and q in ('hold', 'old', 'middle', 'latest', 'reopen'):
            deadline = time.monotonic() + 15
            while not (log.parent / ('release-' + q)).exists():
                if time.monotonic() > deadline:
                    error = {'code': -32000, 'message': 'Fixture gate expired'}
                    break
                time.sleep(.02)
        if role == 'error':
            error = {'code': -32000, 'message': 'Independent fixture failure'}
        name = 'Bar' if role == 'slow' else 'Foo'
        matches = 'foo' in q or q in ('hold', 'old', 'middle', 'latest', 'reopen')
        result = [{'name': name, 'kind': 5, 'location': {'uri': (root/(name+'.kt')).as_uri(),
            'range': {'start': {'line': 0, 'character': 6}, 'end': {'line': 0, 'character': 9}}}}] if matches else []
        record({'event': 'end', 'query': q, 'id': request['id']})
    response = {'jsonrpc': '2.0', 'id': request['id']}
    response.update({'error': error} if error else {'result': result})
    payload = json.dumps(response).encode()
    with lock:
        sys.stdout.buffer.write(('Content-Length: %d\r\n\r\n' % len(payload)).encode() + payload)
        sys.stdout.buffer.flush()

while True:
    headers = {}
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            sys.exit(0)
        if line in (b'\r\n', b'\n'):
            break
        name, value = line.decode().split(':', 1)
        headers[name.lower()] = value.strip()
    request = json.loads(sys.stdin.buffer.read(int(headers['content-length'])))
    record(request)
    if request.get('method') == 'exit':
        break
    if 'id' not in request:
        continue
    # Concurrent workers deliberately expose overlapping requests instead of hiding
    # a broken plugin scheduler behind a serial fake-server reader.
    if role == 'normal':
        respond(request)
    else:
        worker = threading.Thread(target=respond, args=(request,), daemon=True)
        worker.start()
        workers.append(worker)
