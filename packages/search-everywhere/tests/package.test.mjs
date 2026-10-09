import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm, lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {runInNewContext} from 'node:vm';
import {build, files, inputs, manifest} from '../scripts/build-package.mjs';

const committed = fileURLToPath(new URL('../dist/', import.meta.url));
test('four-file native package is reproducible, import-free and inactive on startup', async () => {
  assert(process.env.ESBUILD_PREFIX, 'Set ESBUILD_PREFIX to isolated esbuild 0.25.12');
  const temp = await mkdtemp(path.join(tmpdir(), 'search-package-test-'));
  try {
    for (const n of ['one', 'two']) {
      const meta = await build(process.env.ESBUILD_PREFIX, path.join(temp, n), path.join(temp, n + '-release'));
      assert.deepEqual(Object.keys(meta.inputs).sort(), inputs);
      assert.deepEqual((await readdir(path.join(temp, n))).sort(), [...files].sort());
    }
    assert.deepEqual((await readdir(committed)).sort(), [...files].sort());
    for (const file of files) {
      const bytes = await readFile(path.join(temp, 'one', file));
      assert.deepEqual(bytes, await readFile(path.join(temp, 'two', file)));
      assert.deepEqual(bytes, await readFile(path.join(committed, file)), `Stale own ${file}`);
      const info = await lstat(path.join(committed, file));
      assert(info.isFile() && !info.isSymbolicLink());
      assert.equal(info.mode & 0o777, 0o644);
    }
    assert.deepEqual(JSON.parse(await readFile(path.join(committed, 'package.json'))), manifest);
    const name = 'search-everywhere-' + manifest.version;
    const archive = name + '.tar.gz';
    assert.deepEqual(await readFile(path.join(temp, 'one-release', archive)), await readFile(path.join(temp, 'two-release', archive)));
    const release = path.join(temp, 'one-release');
    execFileSync('sha256sum', ['-c', 'SHA256SUMS'], {cwd: release});
    assert.deepEqual(execFileSync('tar', ['-tzf', path.join(release, archive)], {encoding: 'utf8'}).trim().split('\n'), files.map(f => name + '/' + f));
    assert(execFileSync('tar', ['-tvzf', path.join(release, archive)], {encoding: 'utf8'}).trim().split('\n').every(l => l.startsWith('-rw-r--r--')));
    execFileSync('tar', ['-xzf', path.join(release, archive), '-C', release]);
    for (const file of files) assert.deepEqual(await readFile(path.join(release, name, file)), await readFile(path.join(committed, file)));
    const bundle = await readFile(path.join(committed, manifest.fresh.entry), 'utf8');
    assert(!/\b(?:import\s*(?:[({*]|["'])|export\s|require\s*\()|node_modules|\/home\/|node:/.test(bundle));
    assert(!/sendLspRequest|registerProvider|Builtin rg|toggle_grep|symbolLanguage/.test(bundle));
    const handlers = new Map(), apis = new Map(), commands = [];
    const allowed = new Set(['on', 'defineMode', 'defineConfigEnum', 'registerCommand', 'exportPluginApi']);
    const editor = new Proxy({
      on() {}, defineMode() {}, defineConfigEnum() {}, registerCommand(...args) { commands.push(args); },
      exportPluginApi(name, api) { apis.set(name, api); }
    }, {get(target, property) { assert(allowed.has(property), 'Startup backend/IO/timer call: ' + String(property)); return target[property]; }});
    runInNewContext(bundle, {getEditor: () => editor, registerHandler: (name, fn) => handlers.set(name, fn)});
    assert.equal(commands.length, 1);
    assert.equal(commands[0][0], 'Search Everywhere');
    assert.deepEqual(Object.keys(apis.get('search-everywhere')), ['configure', 'status']);
    assert.equal(typeof handlers.get('search_everywhere_query'), 'function');
  } finally { await rm(temp, {recursive: true, force: true}); }
});
