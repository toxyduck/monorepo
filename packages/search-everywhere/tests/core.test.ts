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
  for (const row of card.entries) assert.deepEqual(row.style.fg, BRAND_PALETTE.demoted);
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

test("closed sessions defer only owned namespaces until matching window and authority return", async () => {
  const {readFileSync} = await import('node:fs');
  const {stripTypeScriptTypes} = await import('node:module');
  const {runInNewContext} = await import('node:vm');
  const source = readFileSync(new URL('../search_everywhere.ts', import.meta.url), 'utf8');
  const section = (from: string, to: string) => source.slice(source.indexOf(from), source.indexOf(to));
  let windowId = 2, authority = 'local';
  let windows = [{id: 1, root: '/root'}, {id: 2, root: '/other'}];
  const calls: unknown[] = [], intervals = new Map<number, string>();
  const buffers = new Map([[17, {window_id: 1}], [18, {window_id: 2}]]);
  const editor = {
    activeWindow: () => windowId, getAuthorityLabel: () => authority, listWindows: () => windows,
    getBufferInfo: (id: number) => { calls.push(['info', id]); return buffers.get(id); },
    clearNamespace: (id: number, ns: string) => calls.push([id, ns]),
    setInterval: (_ms: number, name: string) => { intervals.set(1, name); return 1; },
    clearInterval: (id: number) => intervals.delete(id),
  };
  const code = section('let session:', 'function valid(') +
    section('function clearDecorations(', 'async function decorate') +
    section('function stopLoading(', 'function draw(') +
    section('function invalidate(', 'function dirty(') + `
    const s = {windowId:1,root:'/root',authority:'local',namespace:'old',decorated:new Set([17,99]),
      state:{generation:0},cancel:[],jobs:new Set(),previewToken:0,mounted:false,loadingTimer:null};
    session=s; close();
    globalThis.fixture={s,retryDecorations,pendingDecorations,getSession:()=>session};`;
  const context: any = {editor};
  runInNewContext(stripTypeScriptTypes(code), context);
  const f = context.fixture;
  assert.equal(f.getSession(), null); assert.equal(f.pendingDecorations.size, 1);
  assert.deepEqual(calls, []); assert.equal(intervals.size, 1);
  windowId = 1; authority = 'remote'; windows = [];
  f.retryDecorations(); assert.deepEqual(calls, []); assert.equal(f.pendingDecorations.size, 1);
  authority = 'local'; windows = [{id: 1, root: '/root'}];
  f.retryDecorations();
  assert.deepEqual(calls, [['info',17],[17,'old:row'],[17,'old:match'],['info',99]]);
  assert.equal(f.pendingDecorations.size, 0); assert.equal(intervals.size, 0);
  // A live ID belonging to another window cannot be cleared; absence is proved only in the same authority.
  f.s.decorated.add(18); context.fixture.s.namespace = 'next';
  runInNewContext('clearDecorations(fixture.s)', context);
  assert.equal(f.pendingDecorations.size, 1);
  assert(!calls.some(c => Array.isArray(c) && c[0] === 18));
  windows = []; f.retryDecorations();
  assert.equal(f.pendingDecorations.size, 0); assert.equal(intervals.size, 0);
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

test("shared loading frames wrap in one scalar; footer keeps safety before active loader", () => {
  assert.equal(LOADING_STEP_MS,150);
  assert.deepEqual(LOADING_FRAMES,['◜','◝','◞','◟']);
  for (const phase of [-5,-1,0,1,3,4,9]) {
    assert.equal([...loadingFrame(phase)].length,1);
    assert.equal(loadingFrame(phase),loadingFrame(phase+4));
  }
  const s=initial();s.pending=1;s.errors=['Refused'];s.warnings=['partial'];
  const footer=(phase:number)=>(spec(s,[],[],'','/root',18,phase) as any).children.filter((c:any)=>c.kind==='raw').at(-1).entries[0];
  const a=footer(0),b=footer(1);
  assert.equal([...a.text].length,[...b.text].length);
  assert(a.text.startsWith('Refused · Incomplete: partial'));
  assert(a.text.endsWith('◜ Searching'));assert(b.text.endsWith('◝ Searching'));
  assert.deepEqual(a.inlineOverlays.at(-1).style,{fg:BRAND_PALETTE.loadingAccent});
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
  assert.deepEqual(rows[0].style.fg,BRAND_PALETTE.text);assert.equal(rows[0].style.bold,true);
  assert.deepEqual(rows[1].style.fg,BRAND_PALETTE.secondary);
  assert.deepEqual(rows[0].inlineOverlays[0],{start:12,end:18,style:{bold:true,bg:BRAND_PALETTE.matchBg},unit:'byte'});
  assert.deepEqual(rows[2].inlineOverlays[0],{start:10,end:16,style:{bold:true,bg:BRAND_PALETTE.matchBg},unit:'byte'});
  s.selected=key(s.results[1]);s.query='n.*e';rows=cards()[1].entries;
  for(const row of rows) {assert.deepEqual(row.style.bg,BRAND_PALETTE.selectedBg);assert.deepEqual(row.style.fg,BRAND_PALETTE.demoted);}
  assert.deepEqual(rows[2].inlineOverlays[0],{start:10,end:16,style:{bold:true,bg:BRAND_PALETTE.matchBg},unit:'byte'});
  assert.deepEqual(rows[2].inlineOverlays.at(-1).style,{fg:BRAND_PALETTE.accent});
});

test("loader owns pending generation, resets deadlines and never dispatches search or preview", async () => {
  const {readFileSync}=await import('node:fs');const {stripTypeScriptTypes}=await import('node:module');
  const {runInNewContext}=await import('node:vm');
  const source=readFileSync(new URL('../search_everywhere.ts',import.meta.url),'utf8');
  const code=source.slice(source.indexOf('function stopLoading('),source.indexOf('function draw('));
  let now=1000,id=0,draws=0;const active=new Map<number,string>();
  const context:any={LOADING_STEP_MS,Date:{now:()=>now},valid:(s:any)=>context.session===s,
    draw:()=>draws++,editor:{setInterval:(ms:number,name:string)=>{assert.equal(ms,150);active.set(++id,name);return id;},clearInterval:(id:number)=>active.delete(id)}};
  runInNewContext(stripTypeScriptTypes(code),context);
  const s={mounted:true,state:{pending:1,generation:1},loadingTimer:null,loadingGeneration:0,loadingFrame:0,loadingNextAt:0};
  context.session=s;context.syncLoading(s);context.syncLoading(s);assert.equal(active.size,1);
  context.loadingTick();assert.equal(draws,0);now=1150;context.loadingTick();assert.equal(s.loadingFrame,1);assert.equal(draws,1);
  context.loadingTick();assert.equal(draws,1);
  context.stopLoading(s);s.state.generation++;now=1200;context.syncLoading(s);
  assert.equal(s.loadingFrame,0);context.loadingTick();assert.equal(draws,1);assert.equal(s.loadingNextAt,1350);
  now=1350;context.loadingTick();assert.equal(draws,2);
  s.state.pending=0;context.syncLoading(s);assert.equal(active.size,0);context.loadingTick();assert.equal(draws,2);
  s.state.pending=1;context.syncLoading(s);context.stopLoading(s);context.session=null;now=2000;context.loadingTick();assert.equal(draws,2);
  const next={...s,state:{pending:1,generation:3},loadingTimer:null};context.session=next;context.syncLoading(next);
  context.loadingTick();assert.equal(draws,2);assert.equal(next.loadingFrame,0);assert.equal(active.size,1);
});
