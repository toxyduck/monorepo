import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

async function fixture({height=30,mount=true,dirty=false,stale=false,root='/project',canonical=root,
  focusAt='',sameBuffer=false,replyPath='needle.txt'}={}) {
  const bundle=await readFile(new URL('../dist/search-everywhere.ts',import.meta.url),'utf8');
  const handlers=new Map(), timers=new Map(), calls=[];
  let now=1000, active=1, activeSplit=1, next=0, current=1, opened=false, changedFocus=false, validations=0;
  let config={backend:'rg',arcBackend:'remote'};
  const buffers=[{id:1,path:root+'/original',window_id:1,modified:false,splits:[1]},
    {id:2,path:root+'/needle.txt',window_id:1,modified:dirty,splits:[],is_preview:false},
    {id:3,path:root+'/other.txt',window_id:1,modified:false,splits:[2]}];
  const activeBuffer=()=>activeSplit===1?current:(sameBuffer?2:3);
  const changeAt=phase=>{
    if(opened && !changedFocus && focusAt===phase){activeSplit=2;changedFocus=true;calls.push(['focus-changed',phase]);}
  };
  const editor={activeWindow:()=>active,getAuthorityLabel:()=>'',listWindows:()=>[{id:1,root,project_path:canonical}],
    getScreenSize:()=>({width:100,height}),dockOpen:()=>false,dockCols:()=>0,getActiveSplitId:()=>activeSplit,
    listSplits:()=>[{splitId:1,bufferId:current,viewport:{topByte:0}},
      {splitId:2,bufferId:sameBuffer?2:3,viewport:{topByte:0}}],listBuffers:()=>buffers,getBufferInfo:id=>buffers.find(b=>b.id===id),
    getPrimaryCursor:()=>({position:0}),mountFloatingWidget:()=>mount,unmountFloatingWidget:()=>calls.push(['unmount']),
    updateFloatingWidget:()=>{},floatingPanelControl:()=>{},getPanelFocusKey:()=> 'query',
    setInterval:(ms,name)=>{timers.set(++next,name);return next;},clearInterval:id=>timers.delete(id),
    clearNamespace:()=>{},addOverlay:()=>{},dismissPreview:()=>{},flush:async()=>{changeAt('flush');},
    getActiveBufferId:activeBuffer,
    getLineStartPosition:async()=>{
      const value=activeSplit===1?3:20;calls.push(['line-start',activeSplit,value]);changeAt('start');return value;
    },
    getLineEndPosition:async()=>{
      const value=activeSplit===1?9:26;calls.push(['line-end',activeSplit,value]);changeAt('end');return value;
    },
    getBufferText:async(id,start,end)=>{
      calls.push(['text',id,start,end]);changeAt('text');
      // Reviewer repro: wrong active-buffer offsets find needle on selected file's third line.
      if(focusAt)return Buffer.from('first\nchanged\n123456needle\n').subarray(start,end).toString();
      return stale?'changed':'needle';
    },
    setSplitBuffer:(_split,id)=>current=id,setBufferCursor:(id,pos)=>calls.push(['cursor',id,pos]),setSplitScroll:()=>{},
    focusSplit:id=>{calls.push(['focus',id]);activeSplit=id;},
    previewFileInSplit:(_split,path,line,col)=>{calls.push(['preview',path,line,col]);current=2;buffers[1].is_preview=true;},
    openFileInSplit:(_split,path)=>{calls.push(['open',path]);current=2;buffers[1].is_preview=false;opened=true;},
    setStatus:text=>calls.push(['status',text]),getPluginDir:()=>'/plugin',getPluginConfig:()=>config,
    spawnProcess:(_bin,argv)=>{
      calls.push(['spawn',argv[1],argv]);
      const body=argv[1]==='query'?{state:'ok',root,identity:'i',source:'trunk',warnings:[],results:[{kind:'content',path:replyPath,name:'needle.txt',line:2,snippet:'needle'}]}:{state:'ok',identity:'i',valid:true};
      const p=Promise.resolve().then(()=>{
        if(opened && argv[1]==='validate')changeAt(++validations===1?'post-open-validation':'final-validation');
        return {exit_code:0,stderr:'',stdout:JSON.stringify(body)};
      });p.kill=async()=>{};return p;
    },defineConfigEnum:()=>{},on:()=>{},defineMode:()=>{},registerCommand:()=>{},exportPluginApi:()=>{}};
  runInNewContext(bundle,{getEditor:()=>editor,registerHandler:(name,fn)=>handlers.set(name,fn),Date:class extends Date {static now(){return now;}}});
  const settle=()=>new Promise(r=>setImmediate(r));
  const search=async()=>{handlers.get('search_everywhere_open')();handlers.get('search_everywhere_event')({panel_id:73621,window_id:1,widget_key:'query',event_type:'change',payload:{value:'needle'}});now+=300;handlers.get('search_everywhere_query')();await settle();};
  return {handlers,calls,timers,search,settle,switch:()=>active=2,setConfig:()=>config={backend:'remote',arcBackend:'rg'}};
}
test('tiny/refused/empty popup has no helper or maintenance; config change closes source',async()=>{
  for(const options of [{height:5},{mount:false},{}]){
    const f=await fixture(options);f.handlers.get('search_everywhere_open')();await f.settle();
    assert(!f.calls.some(c=>c[0]==='spawn'));assert.equal(f.timers.size,0);
    assert(!f.handlers.has('search_everywhere_save'));f.handlers.get('search_everywhere_config')();assert.equal(f.timers.size,0);
  }
});
test('native preview starts at beginning; validated local text computes offset; stale opens beginning',async()=>{
  for(const stale of [false,true]){
    const f=await fixture({stale});await f.search();
    assert.deepEqual(f.calls.find(c=>c[0]==='preview'),['preview','/project/needle.txt',1,1]);
    f.handlers.get('search_everywhere_enter')();await f.settle();
    assert(f.calls.some(c=>c[0]==='open'));
    assert(f.calls.some(c=>c[0]==='cursor'&&c[1]===2&&c[2]===(stale?0:3)),JSON.stringify(f.calls));
    if(stale)assert(f.calls.some(c=>c[0]==='status'&&c[1].includes('differs')));
    assert.equal(f.timers.size,0);
  }
});
test('dirty buffer remains unpreviewed and retains cursor; old window cannot open',async()=>{
  const f=await fixture({dirty:true});await f.search();assert(!f.calls.some(c=>c[0]==='preview'));
  f.handlers.get('search_everywhere_enter')();await f.settle();assert(!f.calls.some(c=>c[0]==='cursor'&&c[1]===2));
  const g=await fixture();await g.search();g.switch();g.handlers.get('search_everywhere_enter')();await g.settle();assert(!g.calls.some(c=>c[0]==='open'));
});
test('R1 active checkout root authorizes helper and selected paths, never canonical grouping root',async()=>{
  const f=await fixture({root:'/active-worktree',canonical:'/canonical-project'});await f.search();
  f.handlers.get('search_everywhere_enter')();await f.settle();
  for(const call of f.calls.filter(c=>c[0]==='spawn'))assert.equal(call[2][call[2].indexOf('--root')+1],'/active-worktree');
  assert(f.calls.some(c=>c[0]==='preview'&&c[1]==='/active-worktree/needle.txt'));
  assert(f.calls.some(c=>c[0]==='open'&&c[1]==='/active-worktree/needle.txt'));
  assert(!f.calls.some(c=>['preview','open'].includes(c[0])&&c[1].startsWith('/canonical-project/')));
  const bad=await fixture({root:'/active-worktree',canonical:'/canonical-project',replyPath:'/canonical-project/needle.txt'});
  await bad.search();bad.handlers.get('search_everywhere_enter')();await bad.settle();
  assert(!bad.calls.some(c=>['preview','open'].includes(c[0])));
});
test('R2 focus changes across each navigation await abort without any selected cursor jump',async()=>{
  for(const sameBuffer of [false,true])for(const focusAt of ['flush','post-open-validation','start','end','text','final-validation']){
    const f=await fixture({focusAt,sameBuffer});await f.search();const before=f.calls.length;
    f.handlers.get('search_everywhere_enter')();await f.settle();const navigation=f.calls.slice(before);
    assert(navigation.some(c=>c[0]==='focus-changed'),focusAt);
    assert(!navigation.some(c=>c[0]==='cursor'),JSON.stringify({focusAt,sameBuffer,navigation}));
    assert(navigation.some(c=>c[0]==='status'&&c[1].includes('no search cursor applied')));
    assert(!navigation.some(c=>c[0]==='unmount'));
    f.handlers.get('search_everywhere_close')();await f.settle();
  }
});
test('R2 stable selected buffer shared by two splits still navigates in selected split',async()=>{
  const f=await fixture({sameBuffer:true});await f.search();f.handlers.get('search_everywhere_enter')();await f.settle();
  assert(f.calls.some(c=>c[0]==='focus'&&c[1]===1));
  assert(f.calls.some(c=>c[0]==='cursor'&&c[1]===2&&c[2]===3));
});
