import {test} from "node:test";
import assert from "node:assert/strict";
import {byteToUtf16, utf16ToByte, utf8Length, canonicalPath, normalize, savedLocation, key, validatedRanges, previewMatches} from "../lib/model.ts";
import {rank, demoted, defaultDemotePaths} from "../lib/rank.ts";
import {parseRg, parseSymbols, symbolLanguage, grep, diskResults} from "../lib/providers.ts";
import {initial, replaceResults, enterAction, cancellation, isCurrent} from "../lib/search.ts";
import {rich, spec} from "../lib/ui.ts";
import {BRAND_PALETTE, LOADING_FRAMES, LOADING_STEP_MS, loadingFrame} from "../../_shared/runtime_brand.ts";
import {configure, defaults, validateProvider} from "../lib/config.ts";
const file = {kind: "file" as const, path: "/root/Foo.kt", name: "Foo"};
test("ordinary band precedes demoted without exclusion; file above equal symbol", () => {
  const symbol = {...file, kind: "symbol" as const, line: 1, col: 1};
  const generated = {...file, path: "/root/build/Foo.kt"};
  const result = rank([generated, symbol, file], "Foo", defaultDemotePaths, 80);
  assert.deepEqual(result.map(r => r.path + ':' + r.kind), ['/root/Foo.kt:file', '/root/Foo.kt:symbol', '/root/build/Foo.kt:file']);
  assert(demoted('/root/generated/Foo.kt', defaultDemotePaths));
  assert(demoted('/root/.gradle/Foo.kt', defaultDemotePaths));
  assert(!demoted('/root/notbuild/Foo.kt', defaultDemotePaths));
});
test("byte/UTF-16 boundaries include non-BMP; reject half character", () => {
  assert.equal(byteToUtf16('é😀x', 6), 3); assert.equal(utf16ToByte('é😀x', 3), 6);
  assert.equal(byteToUtf16('é😀x', 3), null); assert.equal(utf16ToByte('é😀x', 2), null);
  assert.equal(byteToUtf16('x', 3), null);
  assert.equal(rich('é😀x', [[1, 3]]).inlineOverlays![0].end, 6);
});
test("UTF-8 length handles empty, ASCII, BMP and non-BMP text", () => {
  assert.equal(utf8Length(''), 0);
  assert.equal(utf8Length('ASCII'), 5);
  assert.equal(utf8Length('é中'), 5);
  assert.equal(utf8Length('😀'), 4);
  assert.equal(utf8Length('é😀x'), 7);
});
test("URI/root/path/location trust boundaries", () => {
  assert.equal(canonicalPath('/root', 'file:///root/a%20b.kt'), '/root/a b.kt');
  for (const path of ['../evil', '/root2/a', 'file://remote/root/a', 'https://x/a', 'a\u0000b', 'file:///root/a%00']) assert.equal(canonicalPath('/root', path), null);
  assert.equal(normalize({...file, line: 1}, '/root'), null);
  assert.equal(normalize({...file, kind: 'symbol'}, '/root'), null);
  assert.equal(normalize({...file, line: -1, col: 1}, '/root'), null);
});
test("LSP names require saved identifier at exact position", () => {
  const symbol = {...file, kind: 'symbol' as const, line: 1, col: 7};
  assert.equal(savedLocation(symbol, 'class Foo {}')?.snippet, 'class Foo {}');
  assert.equal(savedLocation(symbol, 'class Foobar {}'), null);
  assert.equal(savedLocation({...symbol, name: 'Unsaved'}, 'class Foo {}'), null);
  assert.equal(savedLocation({...symbol, line: 90}, 'class Foo {}'), null);
  assert.equal(parseSymbols([{name: 'Foo', location: {uri: 'file:///root/Foo.kt', range: {start: {line: 0, character: 6}}}}], '/root', 80)[0].col, 7);
  assert.deepEqual(parseSymbols([{name: 'Foo', location: {uri: 'file:///root/Foo.kt'}}], '/root', 80), []);
  assert.throws(() => parseSymbols({}, '/root', 80));
});
test("explicit single-language transport preserves failures and cancellation; default stays Kotlin", async () => {
  assert.deepEqual(defaults().symbolLanguages, ['kotlin']);
  const ctx = cancellation('/root', 1, 'Foo', 80);
  const calls: string[] = [];
  const editor = {sendLspRequest: async (language: string) => {
    calls.push(language); throw new Error('unsupported language');
  }} as unknown as EditorAPI;
  await assert.rejects(symbolLanguage(editor, 'Foo', ctx.ctx, 'missing'), /unsupported language/);
  ctx.cancel(); assert.deepEqual(await symbolLanguage(editor, 'Foo', ctx.ctx, 'kotlin'), []);
  assert.deepEqual(calls, ['missing']);
});
test("rg parsing literal UTF-8 match, malformed byte data rejected", () => {
  const row = JSON.stringify({type: 'match', data: {path: {text: 'Foo.kt'}, lines: {text: 'é😀Foo\n'}, line_number: 1, submatches: [{start: 6, end: 9}]}});
  const r = parseRg(row, '/root', 80)[0]; assert.equal(r.col, 4); assert.deepEqual(r.matches?.snippet, [[3, 6]]);
  assert.throws(() => parseRg('{', '/root', 80));
  assert.throws(() => parseRg(row.replace('"start":6', '"start":3'), '/root', 80));
});
test("selection follows stable key, pending/error never fallback, grep must arm", () => {
  const s = initial(); s.query = 'Foo';
  assert.equal(enterAction(s), 'grep'); s.pending = 1; assert.equal(enterAction(s), 'wait');
  s.pending = 0; s.errors = ['LSP failed']; assert.equal(enterAction(s), 'wait');
  const other = {...file, path: '/root/Other.kt', name: 'Other'};
  replaceResults(s, [file, other]); s.selected = key(other); replaceResults(s, [other, file]); assert.equal(s.selected, key(other));
  s.pending = 1; assert.equal(enterAction(s), 'open'); s.pending = 0; s.mode = 'grep'; assert.equal(enterAction(s), 'grep'); s.armed = true; assert.equal(enterAction(s), 'open');
});
test("stale response and preview generation invalidation; cancel called once", () => {
  const s = initial(), c = cancellation('/root', 1, 'x', 80); let killed = 0;
  c.ctx.onCancel(() => killed++); assert(isCurrent(s, 0, c.ctx)); s.generation++; assert(!isCurrent(s, 0, c.ctx));
  c.cancel(); c.cancel(); assert.equal(killed, 1); assert(c.ctx.cancelled);
});
test("unsafe builtin rg is an explicit error, never a whole-output spawn", async () => {
  let spawned = 0;
  const editor = {spawnProcess: () => {spawned++;}} as unknown as EditorAPI;
  await assert.rejects(grep(editor, 'needle', cancellation('/root', 1, 'needle', 80).ctx), /bounded process output/);
  assert.equal(spawned, 0);
});
test("disk adapter drops dirty symbols and ignores provider snippets", async () => {
  const ctx = cancellation('/root', 1, 'Foo', 80).ctx;
  const symbol = {...file, kind: 'symbol', line: 1, col: 7, snippet: 'UNSAVED'};
  const editor = {listBuffers: () => [], openMachine: async () => ({readFilePrefixes: async () => [{path: file.path, text: 'class Foo {}'}], close: async () => true})} as unknown as EditorAPI;
  assert.equal((await diskResults(editor, [symbol], ctx)).results[0].snippet, 'class Foo {}');
  editor.listBuffers = () => [{window_id: 1, path: file.path, modified: true}] as BufferInfo[];
  const dirty = await diskResults(editor, [symbol], ctx);
  assert.deepEqual(dirty.results, []); assert(dirty.warnings[0].includes('dirty-file'));
});
test("custom nonliteral semantics, partial reads and prefix ceiling do not become genuine empty", async () => {
  const ctx = cancellation('/root', 1, 'n.*e', 8).ctx;
  const editor = {listBuffers: () => [], openMachine: async () => ({readFilePrefixes: async () => [
    {path:'/root/ok.kt',text:'val needle = 1'}, {path:'/root/denied.kt',error:'Permission denied'},
    {path:'/root/long.kt',text:('x'.repeat(1023)+'\n').repeat(64)}], close: async () => true})} as unknown as EditorAPI;
  const candidate = {kind:'content', name:'needle', line:1, col:5};
  const disk = await diskResults(editor, [{...candidate,path:'/root/ok.kt'}, {...candidate,path:'/root/denied.kt'},
    {...candidate,path:'/root/long.kt',line:100}],ctx);
  assert.equal(disk.results.length,1); assert.equal(disk.results[0].snippet,'val needle = 1');
  assert(disk.errors[0].includes('Permission denied')); assert(disk.warnings.some(w => w.includes('64 KiB')));
  const s=initial();s.query='n.*e';s.errors=disk.errors;s.warnings=disk.warnings;assert.equal(enterAction(s),'wait');
});
test("candidate cap is explicit; display cap applies after available candidate ranking", async () => {
  const ctx = cancellation('/root',1,'Foo',2).ctx;
  const editor={listBuffers:()=>[],openMachine:async()=>({readFilePrefixes:async()=>[{path:'/root/a',text:'Foo'},{path:'/root/b',text:'Foo'}],close:async()=>true})} as unknown as EditorAPI;
  const disk=await diskResults(editor,[{...file,path:'/root/a'},{...file,path:'/root/b'},{...file,path:'/root/c'}],ctx);
  assert.equal(disk.results.length,2);assert(disk.warnings[0].includes('Candidate cap'));
  assert.equal(rank([{...file,path:'/root/build/Foo.kt'},file],'Foo',defaultDemotePaths,1)[0].path,file.path);
});
test("filename headlines and whole demoted cards, validated configuration", () => {
  const s = initial(); replaceResults(s, [{...file, path: '/root/build/Foo.kt', snippet: 'class Foo {}'}]);
  const tree = spec(s, defaultDemotePaths, [], 'file provider not configured', '/root') as any;
  const card = tree.children.find((c:any)=>c.kind==='labeledSection').child.itemSpecs[0];
  assert.equal(card.entries.length, 3);
  for (const row of card.entries) assert.equal(row.style.fg, BRAND_PALETTE.selectedFg);
  s.selected = null;
  const demotedCard = (spec(s, defaultDemotePaths, [], "", "/root") as any).children.find((c:any) => c.kind === "labeledSection").child.itemSpecs[0];
  for (const row of demotedCard.entries) assert.equal(row.style.fg, BRAND_PALETTE.demoted);
  assert.equal(card.entries[0].text, '>  Foo.kt:1');
  assert.equal(card.entries[1].text, '│ file · build/Foo.kt:1:1');
  assert(card.entries[0].text.startsWith('> '));
  assert.throws(() => configure(defaults(), {maxResults: 999}));
  assert.throws(() => configure(defaults(), {openShortcut: 'x'} as any));
  assert.throws(() => validateProvider({name: 'x', kind: 'files', search: 'bad'} as any));
});

test("native match metadata: exact saved CRLF line, UTF8, clipping and no invented regex", () => {
  const text = 'val é😀needle = 1';
  const r = normalize({kind:'content',path:'/root/Foo.kt',name:'Foo',line:1,col:8,snippet:text,matches:{snippet:[[7,13],[6,8],[0,999]]}}, '/root')!;
  const saved = savedLocation(r, text+'\r\n')!;
  assert.deepEqual(previewMatches(saved,'n.*e'), [[7,13]]);
  assert.equal(utf16ToByte(text,7),10);
  assert.deepEqual(previewMatches({...saved,kind:'file'},'needle'), [[7,13]]);
  assert.deepEqual(savedLocation({...r,snippet:'invented'},text)?.matches?.snippet, []);
  assert.deepEqual(validatedRanges('x'.repeat(600), [[599,601]]), []);
  assert.deepEqual(validatedRanges('a\ud800b', [[1,2]]), []);
  assert.deepEqual(previewMatches(savedLocation({kind:'symbol',path:'/root/Foo.kt',name:'Foo',line:1,col:7},'class Foo {}')!, 'Foo'), [[6,9]]);
});
test("height budget shrinks and restores without changing result selection", () => {
  const s=initial();replaceResults(s,[file]);const selected=s.selected;
  for(const height of [36,18,6,36]) {
    const tree=spec(s,[],[],"","/root",height) as any;
    const list=tree.children.find((c:any)=>c.kind==='labeledSection').child;
    assert.equal(list.visibleRows,Math.max(1,height-(height<9?5:7)));
    assert.equal(s.selected,selected);
    assert.equal(tree.children.some((c:any)=>c.kind==='hintBar'),height>=9);
  }
});



test("literal saved snippet display shares ranges; every kind has filename:line headline", () => {
  const snippet = 'İ 😀Foo foo F.o';
  const r = savedLocation({...file, snippet}, snippet+'\r\n')!;
  assert.deepEqual(previewMatches(r,'fOo'), [[4,7],[8,11]]);
  assert.deepEqual(previewMatches(r,'F.o'), [[12,15]]);
  assert.deepEqual(previewMatches(r,'missing'), []);
  assert.deepEqual(previewMatches(r,'Ffo'), []); // no fuzzy code highlighting
  assert.deepEqual(previewMatches({...r,kind:'content',matches:undefined},'Foo'), []);
  const s=initial();s.query='Foo';
  replaceResults(s,[savedLocation(file,'class Foo {}')!,
    savedLocation({...file,kind:'symbol',line:1,col:7},'class Foo {}')!,
    savedLocation({...file,kind:'content',name:'CUSTOM',line:1,col:7,snippet:'class Foo {}',matches:{snippet:[[6,9]]}},'class Foo {}')!]);
  const selected=s.selected;
  const cards=(spec(s,[],[],'','/root') as any).children.find((c:any)=>c.kind==='labeledSection').child.itemSpecs;
  assert.deepEqual(cards.map((c:any)=>c.entries[0].text),['>  Foo.kt:1','   Foo.kt:1','   Foo.kt:1']);
  assert.deepEqual(cards.map((c:any)=>c.entries[1].text),['│ file · Foo.kt:1:1','  symbol Foo · Foo.kt:1:7','  text · Foo.kt:1:7']);
  for (const c of cards) assert.deepEqual(c.entries[2].inlineOverlays[0],{start:c.entries[2].text.startsWith('│')?10:8,end:c.entries[2].text.startsWith('│')?13:11,style:{bold:true,bg:BRAND_PALETTE.matchBg},unit:'byte'});
  assert.equal(s.selected,selected);
});

test("shared three-cell pulse stays near Results; footer keeps safety and counts", () => {
  assert.deepEqual(BRAND_PALETTE, {
    accent:'ui.help_key_fg', text:'ui.popup_text_fg', secondary:'ui.popup_text_fg',
    demoted:'editor.line_number_fg', selectedBg:'ui.popup_selection_bg', selectedFg:'ui.popup_selection_fg',
    previewRowBg:'editor.current_line_bg', matchBg:'search.match_bg', loadingAccent:'ui.help_key_fg',
  });
  assert.equal(LOADING_STEP_MS,180);
  assert.deepEqual(LOADING_FRAMES,['•··','·•·','··•','·•·']);
  for (const phase of [-5,-1,0,1,3,4,9]) {
    assert.equal([...loadingFrame(phase)].length,3);
    assert.equal(loadingFrame(phase),loadingFrame(phase+4));
  }
  const s=initial();s.pending=1;s.errors=['Refused'];s.warnings=['partial'];
  const footer=(phase:number)=>(spec(s,[],[],'','/root',18,phase) as any).children.filter((c:any)=>c.kind==='raw').at(-1).entries[0];
  const a=footer(0),b=footer(1);
  assert.equal([...a.text].length,[...b.text].length);
  assert(a.text.startsWith('Refused · Incomplete: partial'));
  assert.equal(a.text, b.text);
  const label = (phase:number) => (spec(s,[],[],'','/root',18,phase) as any).children.find((c:any)=>c.kind==='labeledSection').label;
  assert.equal(label(0), 'Results · •·· Searching');
  assert.equal(label(1), 'Results · ·•· Searching');
  s.pending=0;assert(!footer(2).text.includes('Searching'));assert.equal(footer(2).inlineOverlays.length,0);
});

test("selected three-row palette and literal/regex Unicode offsets use actual prefixes", () => {
  const s=initial();s.query='needle';
  const snippet='é😀needle';
  replaceResults(s,[{...file,path:'/root/é😀needle.kt',snippet},
    {...file,path:'/root/build/é😀needle.kt',kind:'content',snippet,matches:{snippet:[[3,9]]}}]);
  const cards=()=> (spec(s,defaultDemotePaths,[],'','/root') as any).children.find((c:any)=>c.kind==='labeledSection').child.itemSpecs;
  let rows=cards()[0].entries;
  for(const row of rows) assert.deepEqual(row.style.bg,BRAND_PALETTE.selectedBg);
  assert.deepEqual(rows[0].style.fg,BRAND_PALETTE.selectedFg);assert.equal(rows[0].style.bold,true);
  assert.deepEqual(rows[1].style.fg,BRAND_PALETTE.selectedFg);
  assert.deepEqual(rows[0].inlineOverlays[0],{start:12,end:18,style:{bold:true,bg:BRAND_PALETTE.matchBg},unit:'byte'});
  assert.deepEqual(rows[2].inlineOverlays[0],{start:10,end:16,style:{bold:true,bg:BRAND_PALETTE.matchBg},unit:'byte'});
  s.selected=key(s.results[1]);s.query='n.*e';rows=cards()[1].entries;
  for(const row of rows) {assert.deepEqual(row.style.bg,BRAND_PALETTE.selectedBg);assert.deepEqual(row.style.fg,BRAND_PALETTE.selectedFg);}
  assert.deepEqual(rows[2].inlineOverlays[0],{start:10,end:16,style:{bold:true,bg:BRAND_PALETTE.matchBg},unit:'byte'});
  assert.deepEqual(rows[2].inlineOverlays.at(-1).style,{fg:BRAND_PALETTE.selectedFg});
});

// Load the entire entry with its real imported functions and native named handlers.
async function entryFixture() {
  const {readFileSync} = await import('node:fs');
  const {stripTypeScriptTypes} = await import('node:module');
  const {runInNewContext} = await import('node:vm');
  const source = readFileSync(new URL('../search_everywhere.ts', import.meta.url), 'utf8');
  const handlers = new Map<string, (...args:any[]) => any>();
  const intervals = new Map<number, {ms:number; name:string}>();
  const calls:any[] = [];
  let now = 1000, id = 0, windowId = 1, authority = 'local', api:any, widget:any;
  let windows = [{id:1,root:'/root'}, {id:2,root:'/other'}];
  let buffers:any[] = [{id:1,window_id:1,path:'/root/original.kt',modified:false,is_preview:false,splits:[1]}];
  let splits:any[] = [{splitId:1,bufferId:1,y:0,height:18,viewport:{topByte:7}}];
  const editor:any = {
    activeWindow:()=>windowId, getAuthorityLabel:()=>authority, listWindows:()=>windows,
    listBuffers:()=>buffers, listSplits:()=>splits, getActiveSplitId:()=>1,
    getActiveBufferId:()=>splits[0].bufferId, getBufferInfo:(id:number)=>buffers.find(b=>b.id===id),
    getPrimaryCursor:()=>({position:3}), dockOpen:()=>false,
    mountFloatingWidget:(_id:number, tree:any)=>{widget=tree;return true;},
    updateFloatingWidget:(_id:number, tree:any)=>{widget=tree;calls.push(['draw']);},
    unmountFloatingWidget:()=>calls.push(['unmount']),
    setInterval:(ms:number,name:string)=>{intervals.set(++id,{ms,name});return id;},
    clearInterval:(id:number)=>intervals.delete(id), setStatus:(text:string)=>calls.push(['status',text]),
    setSplitBuffer:(_split:number,id:number)=>{splits[0].bufferId=id;calls.push(['restore',id]);},
    setBufferCursor:()=>{},setSplitScroll:()=>{},dismissPreview:()=>{},
    clearNamespace:(id:number,ns:string)=>calls.push(['clear',id,ns]),
    flush:async()=>{},
    previewFileInSplit:(_split:number,path:string)=>{
      buffers.push({id:17,window_id:1,path,modified:false,is_preview:true,splits:[1]});splits[0].bufferId=17;
    },
    getLineStartPosition:async()=>0,getLineEndPosition:async()=>12,getBufferText:async()=> 'class Foo {}',
    addOverlay:(...args:any[])=>calls.push(['overlay',...args]),
    openMachine:async()=>({readFilePrefixes:async()=>[{path:file.path,text:'class Foo {}'}],close:async()=>true}),
    on:()=>{},defineMode:()=>{},registerCommand:()=>{},exportPluginApi:(_name:string,value:any)=>{api=value;},
  };
  const context = {getEditor:()=>editor,registerHandler:(name:string,fn:any)=>handlers.set(name,fn),
    configure,defaults,validateProvider,canonicalPath,key,previewMatches,utf16ToByte,diskResults,grep,symbolLanguage,
    rank,cancellation,enterAction,initial,isCurrent,replaceResults,spec,BRAND_PALETTE,LOADING_STEP_MS,
    Date:{now:()=>now}};
  // Imports alone are replaced by the exact modules above; no function-order slices.
  runInNewContext(stripTypeScriptTypes(source.replace(/^import .*;\n/gm,'')),context);
  const invoke=(name:string,...args:any[])=>{assert(handlers.has(name));return handlers.get(name)!(...args);};
  const change=(value:string)=>invoke('search_everywhere_event',{panel_id:73621,window_id:1,widget_key:'query',event_type:'change',payload:{value}});
  const settle=async()=>{for(let i=0;i<30;i++) await Promise.resolve();};
  return {api,editor,calls,intervals,invoke,change,settle,get widget(){return widget;},
    setNow:(value:number)=>{now=value;},setWindow:(value:number)=>{windowId=value;},
    setAuthority:(value:string)=>{authority=value;},setWindows:(value:any[])=>{windows=value;}};
}

test("closed sessions defer only owned namespaces until matching window and authority return", async () => {
  const f=await entryFixture();f.api.configure({symbolLanguages:[]});
  f.api.registerProvider({name:'files',kind:'files',search:async()=>[file]});
  f.invoke('search_everywhere_open');f.change('Foo');await f.settle();
  const overlays=f.calls.filter(c=>c[0]==='overlay');assert(overlays.length>=2);
  const namespace=overlays[0][2].replace(/:row$/,'');
  assert.equal(overlays[0].at(-1).bg,BRAND_PALETTE.previewRowBg);
  assert.equal(overlays[0].at(-1).extendToLineEnd,true);
  assert(!('fg' in overlays[0].at(-1)));
  for (const overlay of overlays.slice(1)) {
    assert.equal(overlay.at(-1).bg,BRAND_PALETTE.matchBg);
    assert(!('fg' in overlay.at(-1))); // Native syntax foreground is never repainted.
  }
  f.setWindow(2);f.invoke('search_everywhere_close');
  assert(!f.calls.some(c=>c[0]==='clear'));assert.equal(f.intervals.size,1);
  f.setWindow(1);f.setAuthority('remote');f.setWindows([]);f.invoke('search_everywhere_cleanup');
  assert(!f.calls.some(c=>c[0]==='clear'));
  f.setAuthority('local');f.setWindows([{id:1,root:'/root'}]);f.invoke('search_everywhere_cleanup');
  assert.deepEqual(f.calls.filter(c=>c[0]==='clear'),[['clear',17,namespace+':row'],['clear',17,namespace+':match']]);
  assert.equal(f.intervals.size,0);
});

test("loader owns pending generation, resets deadlines and never dispatches search or preview", async () => {
  const f=await entryFixture();f.api.configure({symbolLanguages:[]});let searches=0;
  let resolve!:(value:any[])=>void;
  f.api.registerProvider({name:'files',kind:'files',search:()=>{searches++;return new Promise(r=>{resolve=r;});}});
  f.invoke('search_everywhere_open');f.change('Foo');await f.settle();
  const label=()=>f.widget.children.find((c:any)=>c.kind==='labeledSection').label;
  const loading=()=>[...f.intervals.values()].filter(i=>i.name==='search_everywhere_loading');
  assert.equal(loading().length,1);assert.equal(loading()[0].ms,180);
  assert.equal(label(),'Results · •·· Searching');f.invoke('search_everywhere_loading');assert.equal(label(),'Results · •·· Searching');
  f.setNow(1180);f.invoke('search_everywhere_loading');assert.equal(label(),'Results · ·•· Searching');
  f.setNow(1200);f.change('Other');assert.equal(label(),'Results · •·· Searching');assert.equal(loading().length,1);
  f.invoke('search_everywhere_loading');assert.equal(label(),'Results · •·· Searching');
  f.setNow(1380);f.invoke('search_everywhere_loading');assert.equal(label(),'Results · ·•· Searching');
  assert.equal(searches,1);assert(!f.calls.some(c=>c[0]==='overlay'));
  resolve([]);await f.settle();assert.equal(searches,2);resolve([]);await f.settle();
  assert.equal(loading().length,0);assert.equal(label(),'Results');
  f.change('Again');await f.settle();f.invoke('search_everywhere_close');assert.equal(f.intervals.size,0);
  f.setNow(2000);f.invoke('search_everywhere_loading');assert.equal(f.intervals.size,0);
  f.invoke('search_everywhere_open');f.change('Next');assert.equal(label(),'Results · •·· Searching');
  f.invoke('search_everywhere_loading');assert.equal(label(),'Results · •·· Searching');
  f.invoke('search_everywhere_close');
});

test("cancellation isolates failures, clears callbacks once and safely handles late registration", () => {
  const errors:unknown[]=[];let second=0;
  const c=cancellation('/root',1,'Foo',80,()=>{},error=>errors.push(error));
  c.ctx.onCancel(()=>{throw new Error('first');});c.ctx.onCancel(()=>second++);
  c.cancel();c.cancel();assert.equal(second,1);assert.equal(errors.length,1);
  c.ctx.onCancel(()=>{throw new Error('late');});assert.equal(errors.length,2);
  const badReporter=cancellation('/root',1,'Foo',80,()=>{},()=>{throw new Error('observer');});
  badReporter.ctx.onCancel(()=>{throw new Error('callback');});assert.doesNotThrow(badReporter.cancel);
});

test("throwing provider cancellation cannot prevent Escape cleanup or timeout logical finish", async () => {
  const f=await entryFixture();f.api.configure({symbolLanguages:[],timeoutMs:200});
  let reject!:(error:Error)=>void, runs=0, cancelled=0;
  f.api.registerProvider({name:'files',kind:'files',search:(_q:string,ctx:any)=>{
    runs++;ctx.onCancel(()=>{throw new Error('cancel failed');});ctx.onCancel(()=>cancelled++);
    return new Promise((_resolve,r)=>{reject=r;});
  }});
  f.invoke('search_everywhere_open');f.change('Foo');await f.settle();
  f.setNow(1200);f.invoke('search_everywhere_tick');
  const footer=f.widget.children.filter((c:any)=>c.kind==='raw').at(-1).entries[0].text;
  assert(footer.includes('timeout'));assert(!footer.includes('Incomplete'));
  assert.equal(cancelled,1);assert.equal(f.intervals.size,1);
  f.change('Other');assert.equal(runs,1);reject(new Error('stale rejection'));await f.settle();assert.equal(runs,2);
  f.invoke('search_everywhere_close');assert.equal(cancelled,2);assert.equal(f.intervals.size,0);
  assert(f.calls.some(c=>c[0]==='unmount'));assert(f.calls.some(c=>c[0]==='restore'&&c[1]===1));
  assert.equal(f.calls.filter(c=>c[0]==='status'&&c[1].includes('cancellation callback failed')).length,2);
  reject(new Error('closed rejection'));await f.settle();assert.equal(f.intervals.size,0);
});
