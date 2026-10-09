"""Native config-layer proof in disposable HOME/XDG. No user session or Arc query."""
import json
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
import fcntl

from check import isolated_env

base = Path(tempfile.mkdtemp(prefix='fresh-remote-native-', dir='/tmp'))
env = isolated_env(base)
env['TERM'] = 'xterm-256color'
root = base / 'project'
root.mkdir()
(root / 'example.txt').write_text('fixture only\n')
config = base / 'config/fresh'
config.mkdir()
package = config / 'plugins/packages/search-everywhere'
package.mkdir(parents=True)
source = Path(__file__).resolve().parent.parent / 'dist'
for name in ('package.json', 'search-everywhere.ts', 'search_backend.py', 'README.md'):
    shutil.copyfile(source / name, package / name)
(config / 'config.json').write_text(json.dumps({'version': 2, 'check_for_updates': False,
    'self_update': False, 'orchestrator_mode': False, 'lsp': {}, 'editor': {'restore_previous_session': False},
    'plugins': {'search-everywhere': {'settings': {'backend': 'remote', 'arcBackend': 'rg'}}}}))
(config / 'config_linux.json').write_text(json.dumps({'plugins': {'search-everywhere': {
    'settings': {'backend': 'rg', 'arcBackend': 'remote'}}}}))
# A separate fixture plugin declares the same native fields, so getPluginConfig belongs to it.
probe = config / 'plugins/packages/config-probe'
probe.mkdir(parents=True)
(probe / 'package.json').write_text(json.dumps({'name': 'config-probe', 'version': '1.0.0', 'type': 'plugin',
    'fresh': {'entry': 'config-probe.ts', 'min_version': '0.5.2'}}))
for file in ('config.json', 'config_linux.json'):
    values = json.loads((config / file).read_text())
    values['plugins']['config-probe'] = values['plugins']['search-everywhere']
    (config / file).write_text(json.dumps(values))
(probe / 'config-probe.ts').write_text('''const e=getEditor();
e.defineConfigEnum('backend',{values:['rg','remote'],default:'remote'});
e.defineConfigEnum('arcBackend',{values:['rg','remote'],default:'rg'});
let timer;
registerHandler('probe_ready',()=>{const api=e.getPluginApi('search-everywhere');if(!api)return;
e.replaceFile(e.localPath(PROOF),JSON.stringify({probe:e.getPluginConfig(),native:api.status()}));e.clearInterval(timer);});
timer=e.setInterval(40,'probe_ready');
'''.replace('PROOF', json.dumps(str(base / 'config-proof.json'))))
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 110, 0, 0))
p = subprocess.Popen([sys.argv[1], '--no-upgrade-check', '--no-restore', str(root / 'example.txt')],
    cwd=root, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
try:
    end = time.monotonic() + 15
    capture = bytearray()
    while time.monotonic() < end and not (base / 'config-proof.json').exists():
        if select.select([master], [], [], .05)[0]:
            data = os.read(master, 65536)
            capture.extend(data)
            if b'\x1b[6n' in data: os.write(master, b'\x1b[1;1R')
        if p.poll() is not None: break
    (base / 'terminal.bin').write_bytes(capture)
    proof = json.loads((base / 'config-proof.json').read_text())
    assert proof['probe']['backend'] == 'rg' and proof['probe']['arcBackend'] == 'remote', proof
    assert proof['native']['settings'] == {'backend': 'rg', 'arcBackend': 'remote'}, proof
    assert not proof['native']['activated'], proof
    print('PASS native config_linux overrides config.json:', base)
finally:
    os.killpg(p.pid, signal.SIGTERM) if p.poll() is None else None
    try: p.wait(timeout=2)
    except subprocess.TimeoutExpired:
        os.killpg(p.pid, signal.SIGKILL); p.wait()
    os.close(master); os.close(slave)
