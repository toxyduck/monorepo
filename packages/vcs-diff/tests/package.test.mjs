import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {runInNewContext} from 'node:vm';
import {build,inputs} from '../scripts/build-package.mjs';
test('package is reproducible, self-contained, exact-input and preset-independent',async()=>{
  assert(process.env.ESBUILD_PREFIX,'Set ESBUILD_PREFIX to isolated esbuild 0.25.12');
  const temp=await mkdtemp(path.join(tmpdir(),'vcs-package-'));
  try {
    for(const name of ['one','two']) {
      const meta=await build(process.env.ESBUILD_PREFIX,path.join(temp,name));
      assert.deepEqual(Object.keys(meta.inputs).sort(),inputs);
      assert.deepEqual((await readdir(path.join(temp,name))).sort(),['README.md','package.json','presets','vcs_diff.ts']);
      assert.deepEqual((await readdir(path.join(temp,name,'presets'))).sort(),['arc.js','git.js','patch.js']);
    }
    for(const file of ['README.md','package.json','vcs_diff.ts','presets/git.js','presets/arc.js','presets/patch.js']) assert.deepEqual(await readFile(path.join(temp,'one',file)),await readFile(path.join(temp,'two',file)));
    const bundle=await readFile(path.join(temp,'one/vcs_diff.ts'),'utf8');
    assert(!/\b(?:import\s*(?:[({*]|["'])|export\s|require\s*\()|node_modules|\/home\/|node:/.test(bundle));
    assert(!/command:\s*["'](?:git|arc)["']/.test(bundle),'VCS-specific commands must not be bundled');
    const handlers=new Map(),commands=[],events=[];
    runInNewContext(bundle,{getEditor:()=>({on:(...v)=>events.push(v),defineMode(){},registerCommand:(...v)=>commands.push(v),setStatus:(v)=>assert.fail(v)}),registerHandler:(name,fn)=>handlers.set(name,fn)});
    assert.deepEqual(commands.map(c=>c[0]),['VCS Diff','VCS Inline Blame']);
    for(const c of commands)assert.equal(typeof handlers.get(c[2]),'function');
    assert(!events.some(e=>e[0]==='mouse_click'),'No VCS gutter click/preview handler');
  }finally {await rm(temp,{recursive:true,force:true});}
});
