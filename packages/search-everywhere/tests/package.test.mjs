import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {runInNewContext} from 'node:vm';
import {build, files, inputs, manifest} from '../scripts/build-package.mjs';

const committed = fileURLToPath(new URL('../dist/', import.meta.url));
test('native package: reproducible, exact archive, self-contained registered closures', async () => {
  assert(process.env.ESBUILD_PREFIX, 'Set ESBUILD_PREFIX to the isolated esbuild 0.25.12 npm prefix');
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
      assert.deepEqual(bytes, await readFile(path.join(committed, file)), `Stale committed ${file}`);
    }
    assert.deepEqual(JSON.parse(await readFile(path.join(committed, 'package.json'))), manifest);
    const archive = 'search-everywhere-0.1.0.tar.gz';
    assert.deepEqual(await readFile(path.join(temp, 'one-release', archive)), await readFile(path.join(temp, 'two-release', archive)));
    const release = path.join(temp, 'one-release');
    execFileSync('sha256sum', ['-c', 'SHA256SUMS'], {cwd: release});
    const expected = files.map(f => 'search-everywhere-0.1.0/' + f);
    assert.deepEqual(execFileSync('tar', ['-tzf', path.join(release, archive)], {encoding: 'utf8'}).trim().split('\n'), expected);
    const listing = execFileSync('tar', ['-tvzf', path.join(release, archive)], {encoding: 'utf8'}).trim().split('\n');
    assert(listing.every(l => l.startsWith('-')), 'No directories, symlinks or special files');
    execFileSync('tar', ['-xzf', path.join(release, archive), '-C', release]);
    for (const file of files) assert.deepEqual(await readFile(path.join(release, 'search-everywhere-0.1.0', file)), await readFile(path.join(committed, file)));
    const bundle = await readFile(path.join(committed, 'search_everywhere.ts'), 'utf8');
    assert(!/\b(?:import\s*(?:[({*]|["'])|export\s|require\s*\()|node_modules|\/home\/|node:/.test(bundle));
    const handlers = new Map(), commands = [], apis = new Map(), mounted = [];
    const editor = {
      on() {}, defineMode() {}, registerCommand(...a) { commands.push(a); },
      exportPluginApi(name, api) { apis.set(name, api); },
      dockOpen: () => false, activeWindow: () => 1, getAuthorityLabel: () => '',
      listWindows: () => [{id: 1, root: '/fixture'}],
      listSplits: () => [{splitId: 1, bufferId: 1, y: 0, height: 30, viewport: {topByte: 0}}],
      getActiveSplitId: () => 1, getPrimaryCursor: () => ({position: 0}), listBuffers: () => [],
      dockCols: () => 100, mountFloatingWidget: () => { mounted.push('open'); return true; },
      updateFloatingWidget() {}, setInterval: () => 1, clearInterval() {},
      getBufferInfo: () => ({id: 1}), setSplitBuffer() {}, setBufferCursor() {}, setSplitScroll() {},
      unmountFloatingWidget: () => mounted.push('close')
    };
    runInNewContext(bundle, {getEditor: () => editor, registerHandler: (name, fn) => handlers.set(name, fn)});
    assert.equal(commands.length, 1);
    assert.equal(commands[0][0], 'Search Everywhere');
    assert.equal(commands[0][2], 'search_everywhere_open');
    assert.deepEqual(Object.keys(apis.get('search-everywhere')).sort(), ['configure', 'registerProvider']);
    for (const name of ['open', 'enter', 'close', 'cleanup', 'loading', 'tick', 'event', 'authority', 'resize'])
      assert.equal(typeof handlers.get('search_everywhere_' + name), 'function');
    handlers.get('search_everywhere_open')();
    handlers.get('search_everywhere_close')();
    assert.deepEqual(mounted, ['open', 'close']);
  } finally { await rm(temp, {recursive: true, force: true}); }
});
