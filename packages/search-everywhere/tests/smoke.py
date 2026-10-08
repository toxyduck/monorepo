"""Real Fresh PTY; only a disposable HOME and this known tiny fixture.
Run: python3 tests/smoke.py /path/to/fresh
No user's plugin installation/configuration is touched.
"""
import hashlib, os, pathlib, tempfile, subprocess, pty, select, time, fcntl, termios, struct, signal, json, sys
source = pathlib.Path(__file__).resolve().parent.parent
binary = sys.argv[1]
base = pathlib.Path(tempfile.mkdtemp(prefix='fresh-search-smoke-'))
root = base/'fixture'; root.mkdir(); (root/'build').mkdir()
(root/'Foo.kt').write_text('class Foo { fun findUser() = "needle" }\n')
(root/'Bar.kt').write_text('class Bar { val needle = 1 }\n')
(root/'Slow.py').write_text('pass\n')
(root/'Error.json').write_text('{}\n')
(root/'build'/'Foo.kt').write_text('class Foo { val needle = 2 }\n')
(root/'Long.kt').write_text(('x'*1023+'\n')*70+'class Foo {}\n')
env = os.environ.copy()
for k, d in [('HOME','home'),('XDG_CONFIG_HOME','config'),('XDG_DATA_HOME','data'),('XDG_STATE_HOME','state'),('XDG_CACHE_HOME','cache'),('XDG_RUNTIME_DIR','runtime'),('TMPDIR','tmp')]:
    (base/d).mkdir(); env[k] = str(base/d)
for k in list(env):
    if k.startswith('FRESH_') or k in ('NODE_OPTIONS','NODE_PATH','PYTHONSTARTUP','PYTHONPATH','BASH_ENV','ENV','ZDOTDIR','LD_PRELOAD','LD_LIBRARY_PATH'): del env[k]
env['TERM'] = 'xterm-256color'
env['COLORTERM'] = 'truecolor'
c = base/'config'/'fresh'; plugins = c/'plugins'; (plugins/'lib').mkdir(parents=True)
# Every disposable instrumentation anchor must match the approved source contract.
def instrument(content, old, new):
    assert old in content, ("Missing native instrumentation anchor", old)
    return content.replace(old, new)
# Explicit files only: no repository/home/project traversal.
production_files = ['search_everywhere.ts', 'lib/config.ts', 'lib/model.ts', 'lib/providers.ts', 'lib/rank.ts', 'lib/search.ts', 'lib/ui.ts']
for name in production_files:
    content=(source/name).read_text()
    if name=='search_everywhere.ts':
        # Only context getters are controlled: namespaces/buffers/flush remain actual native APIs.
        content=instrument(content, 'const editor = getEditor();', 'const editor = getEditor(); const nativeWindow=editor.activeWindow.bind(editor), nativeAuthority=editor.getAuthorityLabel.bind(editor); let testContext="same"; editor.activeWindow=()=>testContext==="window"?nativeWindow()+10000:nativeWindow(); editor.getAuthorityLabel=()=>testContext==="authority"?"fixture-other-authority":nativeAuthority();')
        content += '\nfor (const mode of ["window","authority","same"]) { const h="smoke_context_"+mode; registerHandler(h,()=>{testContext=mode;}); editor.registerCommand("Smoke Context "+mode,"",h); }\nregisterHandler("smoke_cleanup_state",()=>editor.replaceFile(editor.localPath('+json.dumps(str(base/'cleanup.json'))+'),JSON.stringify({session:session!==null,pending:pendingDecorations.size,timer:cleanupTimer}))); editor.registerCommand("Smoke Cleanup State","","smoke_cleanup_state");\n'
        # Controlled scheduler interleaving in the disposable copy, not native API stubs.
        marker=json.dumps(str(base/'close-after-dispatch'))
        race=json.dumps(str(base/'race.json'))
        target='    await editor.flush();\n    const created ='
        assert target in content
        content=instrument(content, target, '    await editor.flush();\n    if (r.path.endsWith("/build/Foo.kt") && editor.readFile(editor.localPath('+marker+')) === "armed") {\n      editor.replaceFile(editor.localPath('+marker+'), "done"); close(); await editor.flush();\n      editor.replaceFile(editor.localPath('+race+'), JSON.stringify({buffers:editor.listBuffers(),panes:editor.listSplits()}));\n    }\n    const created =')
        content=instrument(content, '    editor.setStatus("Search Everywhere needs a free dock; existing panel preserved"); return;',
            '    editor.replaceFile(editor.localPath('+json.dumps(str(base/'refusal.json'))+'),JSON.stringify({status:"Search Everywhere needs a free dock; existing panel preserved"})); editor.setStatus("Search Everywhere needs a free dock; existing panel preserved"); return;')
        content=instrument(content, 'registerHandler("search_everywhere_close", () => close());', 'registerHandler("search_everywhere_close", () => close()); editor.registerCommand("Smoke No Session Close","","search_everywhere_close");')
        # Observation only in the disposable copy: same native methods/controller, no mocked routes.
        content=instrument(content, '  editor.updateFloatingWidget(PANEL, spec(s.state, config.demotePaths, s.preview, notice, s.root, height(), s.loadingFrame));',
            '  const tree=spec(s.state, config.demotePaths, s.preview, notice, s.root, height(), s.loadingFrame); editor.replaceFile(editor.localPath('+json.dumps(str(base/'ui.json'))+'),JSON.stringify({state:s.state,tree})); editor.updateFloatingWidget(PANEL,tree);')
        content=instrument(content, '  const s = session;\n  if (!s || ev.panel_id',
            '  editor.replaceFile(editor.localPath('+json.dumps(str(base/'last-widget.json'))+'),JSON.stringify(ev)); const s = session;\n  if (!s || ev.panel_id')
        content=instrument(content, '  const line = text.replace', '  editor.replaceFile(editor.localPath('+json.dumps(str(base/'decoration.json'))+'),JSON.stringify({start,end,text,snippet:r.snippet,safe:safe()})); const line = text.replace')
        content=instrument(content, 'const editor = getEditor();', 'const editor = getEditor(); const originalSpawn=editor.spawnProcess.bind(editor); editor.spawnProcess=(...args)=>{editor.replaceFile(editor.localPath('+json.dumps(str(base/'spawn.json'))+'),JSON.stringify(args));return originalSpawn(...args);};')
        content=instrument(content, 's.mounted = false; editor.unmountFloatingWidget(PANEL);','s.mounted = false; editor.unmountFloatingWidget(PANEL); editor.replaceFile(editor.localPath('+json.dumps(str(base/'lifecycle.json'))+'),JSON.stringify({open:session!==null,queued:queued.size,busy:[...busy]}));')
    (plugins/name).write_text(content)
# ui.ts resolves ../../_shared from config/fresh/plugins/lib.
shared = c/'_shared'/'runtime_brand.ts'; shared.parent.mkdir()
shared.write_bytes((source.parent/'_shared'/'runtime_brand.ts').read_bytes())
native_sources = {
    'packages/search-everywhere/' + name: dict(source_sha256=hashlib.sha256((source/name).read_bytes()).hexdigest(), copy_sha256=hashlib.sha256((plugins/name).read_bytes()).hexdigest(), instrumented=name == 'search_everywhere.ts')
    for name in production_files}
native_sources['packages/_shared/runtime_brand.ts'] = dict(source_sha256=hashlib.sha256((source.parent/'_shared'/'runtime_brand.ts').read_bytes()).hexdigest(), copy_sha256=hashlib.sha256(shared.read_bytes()).hexdigest(), instrumented=False)
(base/'native-source-manifest.json').write_text(json.dumps(native_sources, indent=2)+'\n')
fake = base/'fake_lsp.py'
fake.write_text((source/'tests'/'fake_lsp.py').read_text())
(c/'config.json').write_text(json.dumps({'version':2, 'check_for_updates':False, 'self_update':False,
    'orchestrator_mode':False, 'keybindings':[{'key':'s','modifiers':['alt'],'action':'search_everywhere_open'}], 'lsp': {'kotlin':[{'command':'python3','args':[str(fake),str(root),str(base/'lsp.jsonl')],
    'enabled':True,'auto_start':True,'root_markers':[]}],
    'python':[{'command':'python3','args':[str(fake),str(root),str(base/'slow-lsp.jsonl'),'slow'],
        'enabled':True,'auto_start':True,'root_markers':[]}],
    'json':[{'command':'python3','args':[str(fake),str(root),str(base/'error-lsp.jsonl'),'error'],
        'enabled':True,'auto_start':True,'root_markers':[]}]}, 'editor': {'restore_previous_session':False}}))
init = '''(async function(){const editor=getEditor(); const dest=DEST; const events=[];
function record(v){events.push(v);editor.replaceFile(editor.localPath(dest),JSON.stringify(events));}
const request=REQUEST, response=RESPONSE;const previous=editor.readFile(editor.localPath(request));let last=previous?JSON.parse(previous).id:0;
registerHandler("smoke_bridge",async()=>{try{const raw=editor.readFile(editor.localPath(request));if(!raw)return;const r=JSON.parse(raw);if(r.id===last)return;last=r.id;await editor.runCommand(r.name);editor.replaceFile(editor.localPath(response),JSON.stringify({id:r.id}));}catch(e){record({bridgeError:String(e)});}});editor.setInterval(50,"smoke_bridge");
try {
record({freshSession:editor.getEnv("FRESH_SESSION"),grammars:editor.listGrammars().filter(g=>g.name.toLowerCase().includes("kotlin"))});const api=editor.getPluginApi("search-everywhere"); if(!api)throw new Error("API absent");
record({stage:"configure",apiKeys:Object.keys(api)});api.configure({symbolLanguages:["kotlin"],timeoutMs:2000});
api.registerProvider({name:"fixture-files",kind:"files",async search(q,ctx){record({files:q});
if(q==="slow") await editor.delay(700);
if(q==="readerror")return [{kind:"file",path:ctx.root+"/Missing.kt",name:"Missing"}];
if(q==="long")return [{kind:"symbol",path:ctx.root+"/Long.kt",name:"Foo",line:71,col:7}];
if(q==="manyfoo")return Array.from({length:20},(_,i)=>({kind:"file",path:ctx.root+"/Foo.kt",name:"Foo"+i}));
if(!q.toLowerCase().includes("foo"))return [];
return [{kind:"file",path:ctx.root+"/Foo.kt",name:"Foo"},{kind:"file",path:ctx.root+"/build/Foo.kt",name:"Foo"}];}});
record({stage:"files registered"});registerHandler("smoke_events",ev=>record(ev));editor.on("widget_event","smoke_events");
let remove=null;
registerHandler("smoke_override",()=>{remove=api.registerProvider({name:"fixture-grep",kind:"grep",async search(q,ctx){record({override:q});return [{kind:"content",path:ctx.root+"/Bar.kt",name:"CUSTOM",line:1,col:17,snippet:'class Bar { val needle = 1 }',matches:{snippet:[[16,22]]}},{kind:"content",path:ctx.root+"/Foo.kt",name:"CUSTOM",line:1,col:31,snippet:'class Foo { fun findUser() = "needle" }',matches:{snippet:[[30,36]]}}];}});});
editor.registerCommand("Smoke Override","","smoke_override");
registerHandler("smoke_remove",()=>{if(remove)remove();});editor.registerCommand("Smoke Remove","","smoke_remove");
registerHandler("smoke_reload",()=>editor.reloadInit());editor.registerCommand("Smoke Reload","","smoke_reload");
registerHandler("smoke_foreign_overlay",()=>editor.addOverlay(editor.findBufferByPath(ROOT+"/Foo.kt"),"foreign-fixture",10,11,{bg:[200,0,180]}));editor.registerCommand("Smoke Foreign Overlay","","smoke_foreign_overlay");
registerHandler("smoke_snapshot",async()=>{await editor.flush();record({buffers:editor.listBuffers(),panes:editor.listSplits(),dockOpen:editor.dockOpen(),fixtureFocus:editor.getPanelFocusKey(73621),syntax:await editor.getHighlights(editor.getActiveBufferId(),0,40),active:editor.getActiveBufferId(),cursor:editor.getPrimaryCursor(),handlers:editor.getHandlers("widget_event")});});
editor.registerCommand("Smoke Snapshot","","smoke_snapshot");
registerHandler("smoke_dirty",()=>editor.insertText(editor.findBufferByPath(ROOT+"/Foo.kt"),0,"// unsaved\\n"));editor.registerCommand("Smoke Dirty","","smoke_dirty");
registerHandler("smoke_clean",()=>{const id=editor.findBufferByPath(ROOT+"/Foo.kt");editor.deleteRange(id,0,11);editor.saveBufferToPath(id,ROOT+"/Foo.kt");});editor.registerCommand("Smoke Clean","","smoke_clean");
registerHandler("smoke_foreign",()=>editor.previewFileInSplit(editor.getActiveSplitId(),ROOT+"/build/Foo.kt",1,1));editor.registerCommand("Smoke Foreign","","smoke_foreign");
registerHandler("smoke_dismiss",()=>editor.dismissPreview());editor.registerCommand("Smoke Dismiss","","smoke_dismiss");
registerHandler("smoke_split",async()=>{await editor.splitWindow({direction:"vertical",place:"before",ratio:.3,keepFocus:true});});editor.registerCommand("Smoke Split","","smoke_split");
registerHandler("smoke_occupied",()=>editor.mountFloatingWidget(73621,{kind:"text",key:"fixture",label:"Fixture dock preserved",value:"native content",focused:true},30,100,true,false,"Owned fixture",true,false));editor.registerCommand("Smoke Occupied Dock","","smoke_occupied");
registerHandler("smoke_free",()=>editor.unmountFloatingWidget(73621));editor.registerCommand("Smoke Free Dock","","smoke_free");
registerHandler("smoke_parallel",()=>api.configure({symbolLanguages:["kotlin","python","json","kotlin"],timeoutMs:1200}));editor.registerCommand("Smoke Parallel","","smoke_parallel");
registerHandler("smoke_symbols_override",()=>{remove=api.registerProvider({name:"fixture-symbols",kind:"symbols",async search(q,ctx){record({symbolOverride:q});return [{kind:"symbol",path:ctx.root+"/Foo.kt",name:"Foo",line:1,col:7}];}});});editor.registerCommand("Smoke Symbols Override","","smoke_symbols_override");
record({stage:"await auto-start LSP"});await editor.delay(800);
for(const file of ["Slow.py","Error.json","Foo.kt"]){editor.openFileInSplit(editor.getActiveSplitId(),ROOT+"/"+file);await editor.flush();await editor.delay(300);}
try{record({lsp:await editor.sendLspRequest("kotlin","workspace/symbol",{query:"Foo"})});}catch(e){record({lspError:String(e)});}
record({nativeSyntax:await editor.getHighlights(editor.getActiveBufferId(),0,40)});
record({initialPanes:editor.listSplits(),dockCols:editor.dockCols()});record({ready:true});if(last)editor.replaceFile(editor.localPath(response),JSON.stringify({id:last}));
}catch(e){record({error:String(e)});}
})().catch(e=>getEditor().setStatus(String(e)));'''.replace('ROOT',json.dumps(str(root))).replace('DEST',json.dumps(str(base/'events.json'))).replace('REQUEST',json.dumps(str(base/'request.json'))).replace('RESPONSE',json.dumps(str(base/'response.json')))
(c/'init.ts').write_text(init)
m,s = pty.openpty(); fcntl.ioctl(s,termios.TIOCSWINSZ,struct.pack('HHHH',36,130,0,0))
p = None; data = bytearray(); phases = []; known_children = {}
clock = time.monotonic(); recording = []
def record(kind, **fields):
    recording.append(dict(type=kind, time=time.monotonic()-clock, offset=len(data), **fields))
record('resize', rows=36, columns=130)
def typed(text, wait=1):
    for char in text: keys(char.encode(), .15)
    pump(wait)
def child_tree(pid):
    try:
        children=pathlib.Path('/proc/'+str(pid)+'/task/'+str(pid)+'/children').read_text().split()
    except (FileNotFoundError, ProcessLookupError):return
    for child in children:
        try:
            fields=pathlib.Path('/proc/'+child+'/stat').read_text().rsplit(')',1)[1].split()
            known_children[int(child)]=fields[19]
            child_tree(int(child))
        except (FileNotFoundError, ProcessLookupError):pass
def live_children():
    live=[]
    for pid,start in known_children.items():
        try:
            fields=pathlib.Path('/proc/'+str(pid)+'/stat').read_text().rsplit(')',1)[1].split()
            if fields[19]==start and fields[0]!='Z':live.append(pid)
        except (FileNotFoundError, ProcessLookupError):pass
    return live
def pump(t):
    end = time.monotonic()+t
    while time.monotonic()<end:
        if p and p.poll() is None:child_tree(p.pid)
        if select.select([m],[],[],.04)[0]:
            try: b=os.read(m,65536)
            except OSError: break
            start=len(data); data.extend(b)
            assert len(data)<=16*1024*1024, 'ANSI recording cap exceeded'
            record('chunk', start=start)
            if b'\x1b[6n' in b: os.write(m,b'\x1b[1;1R')
            if b'\x1b[c' in b: os.write(m,b'\x1b[?1;2c')
def keys(b, wait=.4): os.write(m,b);pump(wait)
request_id=0
def command(name):
    global request_id
    request_id+=1
    (base/'request.json').write_text(json.dumps({'id':request_id,'name':name}))
    end=time.monotonic()+3
    while time.monotonic()<end:
        pump(.05)
        if (base/'response.json').exists() and json.loads((base/'response.json').read_text()).get('id')==request_id:
            pump(.2);return
    raise AssertionError((name,'test bridge did not respond',events()))
def node(tree, key):
    if tree.get('key') == key: return tree
    for child in tree.get('children', []) + ([tree['child']] if 'child' in tree else []):
        result = node(child, key)
        if result is not None: return result
    return None
def events(): return json.loads((base/'events.json').read_text())
def mark(name):
    command('Smoke Snapshot'); record('phase', name=name); phases.append({'phase':name,'events':events(),'ansiBytes':len(data),
        'ui':json.loads((base/'ui.json').read_text()),'widget':json.loads((base/'last-widget.json').read_text()) if (base/'last-widget.json').exists() else None})
def interrupted(signum, frame):
    raise RuntimeError('Smoke interrupted; cleaning owned processes')
signal.signal(signal.SIGTERM, interrupted)
try:
    p=subprocess.Popen([binary,'--no-upgrade-check','--locale','en',str(root/'Foo.kt')],cwd=root,env=env,stdin=s,stdout=s,stderr=s,start_new_session=True)
    os.close(s);pump(3)
    ready_deadline=time.monotonic()+4
    while not any(e.get('ready') for e in events()) and time.monotonic()<ready_deadline: pump(.1)
    assert any(e.get('ready') for e in events()),events()
    def snapshot():
        command('Smoke Snapshot');return next(e for e in reversed(events()) if 'buffers' in e)
    def chrome_bytes():
        path=base/'data'/'fresh'/'chrome.json';return path.read_bytes() if path.exists() else None
    occupied=snapshot();chrome_before=chrome_bytes()
    assert occupied['dockOpen'] and occupied['panes'][0]['x']==36,occupied
    keys(b'\x1bs');after=snapshot()
    assert after==occupied and chrome_bytes()==chrome_before,(occupied,after)
    assert not any('files' in e or 'override' in e for e in events())
    assert not (base/'ui.json').exists()
    assert json.loads((base/'refusal.json').read_text())['status']=='Search Everywhere needs a free dock; existing panel preserved'
    phases.append({'phase':'occupied initial native dock refused unchanged','before':occupied,'after':after,'chromeUnchanged':True})
    # Only test setup closes the fixture's bundled dock through its known native handler.
    command('Orchestrator: Toggle Dock');assert not snapshot()['dockOpen']
    command('Smoke Occupied Dock');occupied=snapshot();chrome_before=chrome_bytes()
    assert occupied['fixtureFocus']=='fixture',occupied
    keys(b'\x1bs');command('Smoke No Session Close');after=snapshot()
    assert after==occupied and chrome_bytes()==chrome_before,(occupied,after)
    assert not any('files' in e for e in events())
    phases.append({'phase':'foreign same-id fixture dock/content preserved on refused open and no-session close','before':occupied,'after':after,'chromeUnchanged':True})
    command('Smoke Free Dock');free=snapshot();assert not free['dockOpen']
    command('Smoke Foreign Overlay');command('Smoke Snapshot');phases.append({'phase':'native baseline foreign overlay','ansiBytes':len(data)})
    record('phase', name='demo-foo-start')
    (base/'demo-lsp-delay').write_text('0.9')
    keys(b'\x1bs');keys(b'Foo',.28)
    assert json.loads((base/'ui.json').read_text())['state']['pending'] > 0
    record('phase', name='demo-spinner-a')
    pump(.19);record('phase', name='demo-spinner-b')
    pump(1);(base/'demo-lsp-delay').unlink()
    mark('native bind; live files and fake LSP')
    keys(b'\x1b[B');mark('demo-foo-arrow');keys(b'\x1b[A');mark('demo-foo-end')
    state=phases[-1]['ui']['state'];assert not state['pending'] and not state['errors'],state
    assert [r['kind'] for r in state['results']]==['file','symbol','file'],state
    tree=phases[-1]['ui']['tree'];cards=node(tree, 'results')['itemSpecs']
    assert cards[2]['entries'][0]['text']=='   Foo.kt:1'
    assert cards[2]['entries'][1]['text']=='  file · build/Foo.kt:1:1'
    for row in cards[2]['entries']:assert row['style']['fg']==[164,172,185]
    snap=next(e for e in reversed(phases[-1]['events']) if 'buffers' in e)
    assert snap['panes'][0]['x']==next(e['dockCols'] for e in events() if 'initialPanes' in e) and snap['panes'][0]['width']>65,snap
    assert snap['syntax'], 'Actual native Kotlin buffer has no syntax spans'
    assert not any('syntax preview unavailable' in str(c) for c in tree['children'])
    provider_calls=sum('files' in e for e in events())
    for rows in [18,6,36]:
        record('resize', rows=rows, columns=130)
        fcntl.ioctl(m,termios.TIOCSWINSZ,struct.pack('HHHH',rows,130,0,0));os.kill(p.pid,signal.SIGWINCH);pump(.5);mark('resize '+str(rows))
        assert sum('files' in e for e in events())==provider_calls,'resize re-queried provider'
    keys(b'\x1b');keys(b'\x1bs');keys(b'manyfoo',1);mark('many cards')
    for _ in range(18):keys(b'\x1b[B',.03)
    mark('many cards scrolled')
    assert phases[-1]['ui']['state']['selected']!=phases[-2]['ui']['state']['selected']
    keys(b'\x1b');keys(b'\x1bs');keys(b'Foo',1)
    keys(b'\x1b[B');keys(b'\x1b[B');mark('native transient build preview')
    snap=next(e for e in reversed(phases[-1]['events']) if 'buffers' in e)
    assert sum(b['is_preview'] for b in snap['buffers'])==1 and snap['syntax'],snap
    assert snap['panes'][0]['bufferId']!=1 and snap['panes'][0]['viewport']['topLine']==0,snap
    keys(b'\x1b');command('Smoke Snapshot')
    restored=next(e for e in reversed(events()) if 'buffers' in e)
    assert restored['active']==1 and restored['cursor']['position']==0 and restored['panes'][0]['x']==0,restored
    assert not any(b['is_preview'] for b in restored['buffers'])
    assert restored['panes']==free['panes'],(free,restored)
    phases.append({'phase':'permitted first-open exact pane geometry restored', 'before':free,'after':restored,'ansiBytes':len(data)})
    (base/'close-after-dispatch').write_text('armed')
    keys(b'\x1bs');keys(b'Foo',1);keys(b'\x1b[B');keys(b'\x1b[B',1);command('Smoke Snapshot')
    race=json.loads((base/'race.json').read_text())
    assert any(b['is_preview'] and not b['splits'] for b in race['buffers']),race
    cleaned=next(e for e in reversed(events()) if 'buffers' in e)
    assert not any(b['is_preview'] for b in cleaned['buffers']),cleaned
    assert not json.loads((base/'lifecycle.json').read_text())['open']
    phases.append({'phase':'close after native dispatch before ownership; orphan removed','interleaving':race,'after':cleaned})
    keys(b'\x1bs');keys(b'Foo',1);keys(b'\x1b[B');keys(b'\x1b[B');mark('reopen after raced close; browse works')
    assert 'Existing preview preserved' not in str(phases[-1]['ui']['tree'])
    assert sum(b['is_preview'] for b in next(e for e in reversed(events()) if 'buffers' in e)['buffers'])==1
    keys(b'\x1b')
    keys(b'\x1bs');keys(b'Foo',1);keys(b'\x1b[B');keys(b'\r');mark('native symbol position')
    snap=next(e for e in reversed(phases[-1]['events']) if 'buffers' in e)
    assert next(b for b in snap['buffers'] if b['id']==snap['active'])['path']==str(root/'Foo.kt')
    assert snap['cursor']['position']==6,snap
    assert not json.loads((base/'lifecycle.json').read_text())['open']
    keys(b'\x1bs');keys(b'slow',.1);keys(b'\x1b');keys(b'\x1bs');keys(b'Foo',1.3);mark('close reopen stale query')
    assert phases[-1]['ui']['state']['query']=='Foo' and len(phases[-1]['ui']['state']['results'])==3
    keys(b'\x1b');keys(b'\x1bs');keys(b'readerror',1);mark('disk read failure')
    assert phases[-1]['ui']['state']['errors'] and not phases[-1]['ui']['state']['results']
    keys(b'\r');assert json.loads((base/'ui.json').read_text())['state']['mode']=='everywhere'
    keys(b'\x1b');keys(b'\x1bs');keys(b'long',1);mark('prefix ceiling incomplete')
    assert any('64 KiB' in w for w in phases[-1]['ui']['state']['warnings'])
    keys(b'\r');assert json.loads((base/'ui.json').read_text())['state']['mode']=='everywhere'
    keys(b'\x1b');keys(b'\x1bs');keys(b'needle',.8);keys(b'\r',.5);mark('bounded capture gate')
    assert any('bounded process output' in e for e in phases[-1]['ui']['state']['errors'])
    assert not (base/'spawn.json').exists(), 'unsafe whole-output process spawned'
    keys(b'\x1b');command('Smoke Override');command('Smoke Override');record('phase', name='demo-regex-start');keys(b'\x1bs');typed('n.*e',.8)
    keys(b'\t');keys(b' ',.3);mark('toggle without Enter')
    assert phases[-1]['widget']['event_type']=='toggle'
    assert phases[-1]['ui']['state']['mode']=='grep' and not phases[-1]['ui']['state']['results']
    assert not any('override' in e for e in events()), 'grep ran before Enter'
    keys(b'\r',1);mark('full nonliteral callback override')
    assert len(phases[-1]['ui']['state']['results'])==2 and not phases[-1]['ui']['state']['errors']
    assert sum('override' in e for e in events())==1, 'same-name registration duplicated'
    cards=node(phases[-1]['ui']['tree'], 'results')['itemSpecs']
    assert cards[0]['entries'][0]['text']=='>  Bar.kt:1' and 'CUSTOM' not in str(cards)
    keys(b'\x1b[Z');keys(b'\x1b[B');keys(b'\x1b[A');keys(b'\r');mark('grep native open')
    snap=next(e for e in reversed(phases[-1]['events']) if 'buffers' in e)
    assert next(b for b in snap['buffers'] if b['id']==snap['active'])['path']==str(root/'Bar.kt'),snap
    assert snap['cursor']['position']==16,snap
    record('phase', name='demo-regex-end')
    command('Smoke Dirty');keys(b'\x1bs');keys(b'Foo',1);mark('dirty file warning')
    assert 'Unsaved edits' in str(phases[-1]['ui']['tree'])
    keys(b'\x1b');command('Smoke Snapshot')
    dirtysnap=next(e for e in reversed(events()) if 'buffers' in e)
    assert any(b['modified'] for b in dirtysnap['buffers'])
    command('Smoke Clean')
    command('Smoke Foreign');command('Smoke Snapshot')
    foreign=next(e for e in reversed(events()) if 'buffers' in e)
    keys(b'\x1bs');keys(b'Foo',1);mark('foreign transient preserved')
    assert any(b['is_preview'] for b in foreign['buffers']),foreign
    keys(b'\x1b');command('Smoke Snapshot')
    after=next(e for e in reversed(events()) if 'buffers' in e)
    assert [(b['id'],b['is_preview']) for b in foreign['buffers']]==[(b['id'],b['is_preview']) for b in after['buffers']]
    command('Smoke Dismiss');command('Smoke Split');command('Smoke Snapshot')
    before=next(e for e in reversed(events()) if 'buffers' in e)
    keys(b'\x1bs');keys(b'Foo',1);keys(b'\x1b');command('Smoke Snapshot')
    after=next(e for e in reversed(events()) if 'buffers' in e)
    assert after['panes']==before['panes'],(before,after)
    command('Smoke Remove');command('Smoke Reload');keys(b'\x1b');keys(b'\x1bs')
    keys(b'\x1b[200~FooX\x1b[201~');keys(b'\x7f',1);mark('init reload; paste backspace')
    assert phases[-1]['ui']['state']['query']=='Foo'
    snap=next(e for e in reversed(phases[-1]['events']) if 'buffers' in e)
    assert snap['handlers'].count('search_everywhere_event')==1 and snap['handlers'].count('smoke_events')==1,snap
    assert not any(b['name'].startswith('search-everywhere-preview') for b in snap['buffers'])
    keys(b'\x1b',.8);assert not json.loads((base/'lifecycle.json').read_text())['open']
    assert not json.loads((base/'lifecycle.json').read_text())['queued']
    # Native requests to separate configured languages; no runtime eligibility inference.
    command('Smoke Parallel')
    def lsp_rows(name):
        path=base/name
        return [json.loads(row) for row in path.read_text().splitlines()] if path.exists() else []
    def ui(): return json.loads((base/'ui.json').read_text())['state']
    def wait_for(predicate):
        end=time.monotonic()+3
        while not predicate():
            assert time.monotonic()<end, (ui(),lsp_rows('slow-lsp.jsonl'))
            pump(.05)
    def paste(q): keys(b'\x1b[200~'+q.encode()+b'\x1b[201~',.1)
    def release(q): (base/('release-'+q)).write_text('go')
    keys(b'\x1bs');paste('hold')
    wait_for(lambda: any(r['name']=='Foo' for r in ui()['results']) and any('Independent fixture failure' in e for e in ui()['errors']))
    wait_for(lambda: any(r.get('event')=='begin' and r.get('query')=='hold' for r in lsp_rows('slow-lsp.jsonl')))
    assert ui()['pending']==1 and not any(r.get('event')=='end' and r.get('query')=='hold' for r in lsp_rows('slow-lsp.jsonl'))
    selected=ui()['selected'];mark('parallel fast result and error while slow gate unfinished')
    release('hold');wait_for(lambda: ui()['pending']==0)
    assert {r['name'] for r in ui()['results']}=={'Foo','Bar'} and ui()['selected']==selected
    mark('parallel slow completion preserves fast selection and partial error')
    keys(b'\x1b');keys(b'\x1bs');paste('old')
    wait_for(lambda: any(r.get('event')=='begin' and r.get('query')=='old' for r in lsp_rows('slow-lsp.jsonl')))
    wait_for(lambda: any('python: timeout' in e for e in ui()['errors']))
    assert any(r['name']=='Foo' for r in ui()['results'])
    mark('individual slow timeout preserves fast result')
    # Backspace changes use the actual native query widget, not injected events.
    keys(b'\x7f'*3,.05);paste('middle');keys(b'\x7f'*6,.05);paste('latest')
    wait_for(lambda: ui()['query']=='latest' and any(r['name']=='Foo' for r in ui()['results']))
    assert not any(r.get('event')=='begin' and r.get('query') in ('middle','latest') for r in lsp_rows('slow-lsp.jsonl'))
    mark('latest queued behind actually unfinished timed-out request')
    release('old')
    wait_for(lambda: any(r.get('event')=='begin' and r.get('query')=='latest' for r in lsp_rows('slow-lsp.jsonl')))
    assert not any(r.get('event')=='begin' and r.get('query')=='middle' for r in lsp_rows('slow-lsp.jsonl'))
    assert ui()['query']=='latest' and not any(r['name']=='Bar' for r in ui()['results'])
    # Enter may open fast saved symbol despite the slow job still being pending.
    keys(b'\r');assert not json.loads((base/'lifecycle.json').read_text())['open']
    command('Smoke Snapshot');snap=next(e for e in reversed(events()) if 'buffers' in e)
    assert snap['cursor']['position']==6
    keys(b'\x1bs');paste('reopen');wait_for(lambda: ui()['query']=='reopen' and any(r['name']=='Foo' for r in ui()['results']))
    release('latest')
    wait_for(lambda: any(r.get('event')=='begin' and r.get('query')=='reopen' for r in lsp_rows('slow-lsp.jsonl')))
    assert not any(r['name']=='Bar' for r in ui()['results'])
    release('reopen');wait_for(lambda: ui()['pending']==0)
    assert {r['name'] for r in ui()['results']}=={'Foo','Bar'}
    mark('late closed-generation result ignored; latest reopen queued safely')
    keys(b'\x1b');command('Smoke Symbols Override')
    counts={name:len(lsp_rows(name)) for name in ['lsp.jsonl','slow-lsp.jsonl','error-lsp.jsonl']}
    keys(b'\x1bs');paste('Foo');wait_for(lambda: ui()['pending']==0 and any(e.get('symbolOverride')=='Foo' for e in events()))
    assert counts=={name:len(lsp_rows(name)) for name in counts}, 'custom symbols did not replace entire builtin'
    mark('full custom symbols override bypasses all builtin languages')
    keys(b'\x1b');command('Smoke Remove')
    for name in ['lsp.jsonl','slow-lsp.jsonl','error-lsp.jsonl']:
        active=set()
        for row in lsp_rows(name):
            if row.get('event')=='begin':
                active.add(row['id']);assert len(active)==1,(name,row,active)
            elif row.get('event')=='end': active.remove(row['id'])
        assert not active,(name,active)
    keys(b'\x1bs');paste('Foo');wait_for(lambda: ui()['pending']==0)
    command('Smoke Foreign Overlay')
    command('Smoke Context window');pump(.3);command('Smoke Cleanup State')
    deferred=json.loads((base/'cleanup.json').read_text())
    assert deferred['session'] is False and deferred['pending']==1 and deferred['timer'] is not None,deferred
    command('Smoke Snapshot');phases.append({'phase':'deferred local context native BG retained','ansiBytes':len(data)})
    command('Smoke Context authority');pump(.3);command('Smoke Cleanup State')
    assert json.loads((base/'cleanup.json').read_text())['pending']==1
    command('Smoke Context same');pump(.3);command('Smoke Cleanup State')
    cleared=json.loads((base/'cleanup.json').read_text())
    assert cleared['pending']==0 and cleared['timer'] is None,cleared
    command('Smoke Snapshot');phases.append({'phase':'deferred return native own BG cleared foreign FG BG retained','ansiBytes':len(data)})
    # Old dock lifecycle is outside this fix; release it only in fixture setup.
    command('Smoke Free Dock')
    keys(b'\x11',1)
    assert any(e.get('lsp') for e in events()), 'fake LSP route did not resolve'
    assert b'class Foo' in data or b'findUser' in data
    assert p.wait(timeout=3)==0, 'Fresh did not exit cleanly'
    chrome=base/'data'/'fresh'/'chrome.json'
    if chrome.exists():assert json.loads(chrome.read_text()).get('dock',{}).get('width',36)==36,chrome.read_text()
    # Success is printed only after finally has verified child cleanup.
finally:
    # A second TERM must not interrupt cleanup after the runner timeout.
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    if p and p.poll() is None:
        # Unreaped owned leader keeps its process-group identity; no broad cleanup.
        try: os.killpg(p.pid,signal.SIGTERM)
        except ProcessLookupError: pass
        try:p.wait(timeout=2)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid,signal.SIGKILL);p.wait(timeout=2)
    for pid in live_children():
        try:os.kill(pid,signal.SIGTERM)
        except ProcessLookupError:pass
    deadline=time.monotonic()+1
    while live_children() and time.monotonic()<deadline:time.sleep(.05)
    for pid in live_children():
        try:os.kill(pid,signal.SIGKILL)
        except ProcessLookupError:pass
    deadline=time.monotonic()+1
    while live_children() and time.monotonic()<deadline:time.sleep(.05)
    (base/'process-cleanup.json').write_text(json.dumps({'known':list(known_children),'live':live_children()}))
    assert not live_children(),'owned test children survived cleanup'
    os.close(m);(base/'terminal.ansi').write_bytes(data)
    (base/'phases.json').write_text(json.dumps(phases,indent=2))
    (base/'recording.jsonl').write_text(''.join(json.dumps(row)+'\n' for row in recording))
    print('Evidence:',base)
print('PASS native dock/viewer smoke (default-rg gate explicit):',base,'exit:',p.returncode)
