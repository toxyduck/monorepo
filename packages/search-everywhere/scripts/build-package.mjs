import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {mkdir, readFile, writeFile, mkdtemp, copyFile, rm, lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const pkg = 'packages/search-everywhere';
export const files = ['package.json', 'search_everywhere.ts', 'README.md'];
export const inputs = [ `${pkg}/search_everywhere.ts`, ...['config', 'model', 'providers', 'rank', 'search', 'ui'].map(n => `${pkg}/lib/${n}.ts`), 'packages/_shared/runtime_brand.ts' ].sort();
export const manifest = {
  name: 'search-everywhere', version: '0.1.0', type: 'plugin',
  description: 'Files provider, workspace symbols, and disk grep',
  author: 'toxyduck', license: 'UNLICENSED', repository: 'https://github.com/toxyduck/monorepo',
  fresh: {entry: 'search_everywhere.ts', min_version: '0.5.2'}
};

// Build-only tools live in an isolated npm prefix; never resolve a repo/global dependency.
export async function build(toolDir, dest, releaseDir) {
  const esbuild = createRequire(path.join(path.resolve(toolDir), 'package.json'))('esbuild');
  assert.equal(esbuild.version, '0.25.12');
  const result = await esbuild.build({absWorkingDir: root, entryPoints: [`${pkg}/search_everywhere.ts`],
    bundle: true, platform: 'browser', format: 'iife', target: 'es2020', minify: false,
    sourcemap: false, metafile: true, write: false});
  assert.deepEqual(Object.keys(result.metafile.inputs).sort(), inputs);
  for (const item of [...Object.values(result.metafile.inputs), ...Object.values(result.metafile.outputs)])
    assert(!item.imports.some(i => i.external), 'External runtime import');
  await mkdir(dest, {recursive: true});
  await writeFile(path.join(dest, files[0]), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(path.join(dest, files[1]), result.outputFiles[0].contents);
  const readme = await readFile(path.join(root, pkg, 'README.md'), 'utf8');
  await writeFile(path.join(dest, files[2]), readme.replaceAll('assets/demo.gif', 'https://raw.githubusercontent.com/toxyduck/monorepo/main/packages/search-everywhere/assets/demo.gif')
    .replaceAll('assets/demo.mp4', 'https://github.com/toxyduck/monorepo/blob/main/packages/search-everywhere/assets/demo.mp4'));
  if (releaseDir) {
    await mkdir(releaseDir, {recursive: true});
    await writeFile(path.join(releaseDir, 'metafile.json'), JSON.stringify(result.metafile, null, 2) + '\n');
    const stage = await mkdtemp(path.join(tmpdir(), 'search-everywhere-archive-'));
    const name = `search-everywhere-${manifest.version}`;
    const archive = `${name}.tar.gz`;
    try {
      await mkdir(path.join(stage, name));
      for (const file of files) {
        assert((await lstat(path.join(dest, file))).isFile(), 'Only regular files may be archived');
        await copyFile(path.join(dest, file), path.join(stage, name, file));
      }
      // GNU tar is build-only. Explicit files, fixed metadata and gzip -n make reproducible assets.
      const tar = execFileSync('tar', ['--format=ustar', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '--mode=0644', '-cf', '-', '-C', stage, ...files.map(f => `${name}/${f}`)]);
      const bytes = execFileSync('gzip', ['-n', '-c'], {input: tar});
      await writeFile(path.join(releaseDir, archive), bytes);
      await writeFile(path.join(releaseDir, 'SHA256SUMS'), `${createHash('sha256').update(bytes).digest('hex')}  ${archive}\n`);
    } finally { await rm(stage, {recursive: true, force: true}); }
  }
  return result.metafile;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [toolDir, releaseDir] = process.argv.slice(2);
  assert(toolDir && releaseDir, 'Usage: node scripts/build-package.mjs TEMP_NPM_PREFIX RELEASE_OUTPUT');
  await build(toolDir, path.join(root, pkg, 'dist'), path.resolve(releaseDir));
}
