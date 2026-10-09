import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Query, readSettings} from '../lib/query.ts';
import {normalize, matchRanges, utf16ToByte, byteToUtf16, utf8Length} from '../lib/model.ts';
import {rank} from '../lib/rank.ts';
import {defaults} from '../lib/config.ts';
import {initial, replaceResults, enterAction} from '../lib/search.ts';
import {spec} from '../lib/ui.ts';

function fixture() {
  let resolve: (value: any) => void = () => {};
  let kills=0, spawns=0, window=1;
  const timers=new Set<number>(); let next=0;
  const editor:any={activeWindow:()=>window,getAuthorityLabel:()=>'',listWindows:()=>[{id:1,root:'/project',project_path:'/project'}],
    setInterval:()=>{timers.add(++next);return next;},clearInterval:(id:number)=>timers.delete(id),getPluginDir:()=>'/plugin',
    spawnProcess:()=>{spawns++; const p:any=new Promise(r=>resolve=r);p.kill=async()=>{kills++;};return p;},
    getPluginConfig:()=>({backend:'rg',arcBackend:'remote'})};
  const q=new Query(editor,1,'/project','','/project',defaults,()=>readSettings(editor));
  return {q,editor,timers,resolve:(value:any)=>resolve(value),counts:()=>({kills,spawns}),switch:()=>window=2};
}
const wait=()=>new Promise(r=>setTimeout(r,260));
const reply={exit_code:0,stderr:'',stdout:JSON.stringify({state:'ok',root:'/project',identity:'i',source:'local',results:[{kind:'content',path:'needle.txt',name:'needle.txt',line:2,snippet:'needle'}]})};

test('literal/UTF-8/CRLF/model admits unknown remote coordinates',()=>{
  assert.equal(utf16ToByte('界😀x',3),7); assert.equal(byteToUtf16('界😀x',7),3);
  assert.equal(utf16ToByte('😀',1),null); assert.equal(byteToUtf16('界',1),null);
  assert.deepEqual(matchRanges('a.b界','A.B界'),[[0,4]]); assert.deepEqual(matchRanges('aXb','ab'),[]);
  const row=normalize({kind:'content',path:'a.ts',name:'a.ts',line:5,snippet:'needle'},'/project')!;
  assert(row); assert.equal(row.byte,undefined); assert.equal(row.col,undefined);
  assert.equal(utf8Length('x\r\n界😀'),10);
  assert.equal(normalize({...row,line:0},'/project'),null);
});
test('rank/state keep single file and distinct same basenames; UI has no fabricated column',()=>{
  const rows=[{kind:'file' as const,path:'/project/a/x',name:'x'}, {kind:'content' as const,path:'/project/a/x',name:'x',line:3,snippet:'needle'},
    {kind:'content' as const,path:'/project/a/x',name:'x',line:2,snippet:'needle'}, {kind:'file' as const,path:'/project/b/x',name:'x'}];
  const out=rank(rows,'needle',[],80); assert.equal(out.length,2); assert.equal(out[0].line,2);
  const s=initial(); replaceResults(s,out); assert.equal(enterAction(s),'open');
  const ui=JSON.stringify(spec(s,[],[],'Source: trunk','/project',20,0,80));
  assert(ui.includes('source line')); assert(!ui.includes(':2:1')); assert(ui.includes('Source: trunk'));
});
test('startup, empty/invalid queries do not spawn; native config invalid values visible',async()=>{
  const f=fixture(); assert.equal(f.counts().spawns,0);
  let error=''; f.q.request('',()=>{}); f.q.request('\ud800',(_r,_w,e)=>error=e||''); assert(error);
  assert.equal(f.counts().spawns,0); assert.equal(f.timers.size,0);
  f.editor.getPluginConfig=()=>({backend:'invalid',arcBackend:'remote'});
  assert.throws(()=>readSettings(f.editor),/Configuration error/);
  f.q.request('needle',(_r,_w,e)=>error=e||'');await wait();f.q.tick();await new Promise(r=>setTimeout(r,0));
  assert.match(error,/Configuration error/);assert.equal(f.counts().spawns,0);assert.equal(f.timers.size,0);
});
test('latest pending only; no replacement until canceled handle settles',async()=>{
  const f=fixture(); let old=0,newest=0;
  f.q.request('old',()=>old++); await wait(); f.q.tick();
  f.q.request('discarded',()=>assert.fail('discarded request delivered'));
  f.q.request('needle',()=>newest++); await wait(); f.q.tick(); assert.equal(f.counts().spawns,1);
  f.resolve(reply); await new Promise(r=>setTimeout(r,0)); assert.equal(old,0);
  f.q.tick(); assert.equal(f.counts().spawns,2); f.resolve(reply); await new Promise(r=>setTimeout(r,0));
  assert.equal(newest,1); assert.equal(f.q.source,'local'); assert.equal(f.timers.size,0); f.q.dispose();
});
test('close/window changes invalidate late callbacks and selected validation',async()=>{
  const f=fixture(); let calls=0;
  f.q.request('needle',()=>calls++); await wait(); f.q.tick(); f.q.dispose(); f.resolve(reply);
  await new Promise(r=>setTimeout(r,0)); assert.equal(calls,0); assert.equal(f.timers.size,0);
  assert.equal(await f.q.validate({kind:'file',path:'/project/a',name:'a'}),false);
  const g=fixture();g.q.request('needle',()=>calls++);await wait();g.q.tick();g.switch();g.resolve(reply);
  await new Promise(r=>setTimeout(r,0));assert.equal(calls,0);
});
test('popup/controller replacement cannot overlap an unsettled old helper',async()=>{
  const old=fixture(); old.q.request('old',()=>assert.fail('closed callback'));await wait();old.q.tick();old.q.dispose();
  const fresh=fixture();let calls=0;fresh.q.request('needle',()=>calls++);await wait();fresh.q.tick();assert.equal(fresh.counts().spawns,0);
  old.resolve(reply);await new Promise(r=>setTimeout(r,0));fresh.q.tick();assert.equal(fresh.counts().spawns,1);
  fresh.resolve(reply);await new Promise(r=>setTimeout(r,0));assert.equal(calls,1);fresh.q.dispose();
});
test('R1 controller owns active root even when canonical project differs',async()=>{
  const f=fixture();f.editor.listWindows=()=>[{id:1,root:'/project',project_path:'/canonical-project'}];
  let resultPath='';f.q.request('needle',rows=>resultPath=rows[0]?.path||'');await wait();f.q.tick();
  assert.equal(f.counts().spawns,1);f.resolve(reply);await new Promise(r=>setTimeout(r,0));
  assert.equal(resultPath,'/project/needle.txt');assert(f.q.alive());f.q.dispose();
});
test('native watchdog ends loading without authorizing replacement while callback stalls',async()=>{
  const f=fixture();let errors=0;f.q.request('needle',(_r,_w,e)=>{if(e)errors++;});await wait();f.q.tick();
  const now=Date.now;Date.now=()=>now()+40000;
  try {f.q.tick();f.q.tick();assert.equal(errors,1);assert.equal(f.counts().spawns,1);}
  finally {Date.now=now;f.resolve(reply);await new Promise(r=>setTimeout(r,0));f.q.dispose();}
});
