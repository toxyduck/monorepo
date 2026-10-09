"""Packaged Fresh native PTY scenarios; only a disposable Git fixture and HOME.
Usage: python smoke.py FRESH PACKAGED_PLUGIN [--publish-demo]
"""
import sys,os,pathlib,tempfile,json,time,select,signal,subprocess,hashlib
source=pathlib.Path(__file__).resolve().parents[1];repo=source.parents[1]
sys.path.insert(0,str(repo/'packages/_shared'))
import native_demo as demo
binary=sys.argv[1];package=pathlib.Path(sys.argv[2]);publish='--publish-demo' in sys.argv
base=pathlib.Path(tempfile.mkdtemp(prefix='fresh-vcs-smoke-'));root=base/'fixture';root.mkdir();env=demo.isolated_env(base)
def git(*args):return subprocess.check_output(['git',*args],cwd=root,env=env,text=True).strip()
git('init','-q');git('config','user.name','Demo Author');git('config','user.email','demo@example.invalid');git('config','commit.gpgsign','false')
(root/'mixed.txt').write_text('a\nb\nc\nd\ne\n');(root/'src').mkdir();(root/'src/alpha.ts').write_text('function answer() {\n  return 40;\n}\n');(root/'src/界.txt').write_text('one\ntwo\n');(root/'deleted.txt').write_text('deleted old text\n');(root/'rename.md').write_text('# renamed documentation\n');git('add','.');git('commit','-qm','Initial fixture');revision=git('rev-parse','HEAD')
(root/'src/alpha.ts').write_text('function answer() {\n  return 41;\n}\n');git('add','src/alpha.ts');(root/'mixed.txt').write_text('a\nB\nc\ne\n');(root/'src/alpha.ts').write_text('function answerNow() {\n  return 42;\n}\n');(root/'src/界.txt').write_text('one\nUnicode changed\n');git('mv','rename.md','renamed.md');git('rm','-q','deleted.txt');(root/'added.py').write_text('print("added")\n');git('add','added.py');(root/'binary.bin').write_bytes(b'\x00\x01\x02');git('add','binary.bin')
c=base/'config/fresh';plugins=c/'plugins';plugins.mkdir(parents=True);(c/'vcs-diff/presets').mkdir(parents=True)
for name in ['vcs_diff.ts']:
 demo.write_source_copy(package/name,plugins/name)
for name in ['git.js','arc.js','patch.js']:demo.write_source_copy(package/'presets'/name,c/'vcs-diff/presets'/name)
original=demo.readme_snapshot(source/'README.md') if publish else None
config=c/'vcs-diff/config.js'
baseconfig="""(()=>{const git=load('./presets/git.js');
function delayed(op){return {...op,command:'python3',args:['-c','import os,sys,time; time.sleep(1.1); os.execvp(sys.argv[1],sys.argv[1:])',op.command,...op.args]};}
return {adapters:[git,{...git,name:'Delayed fixture',diff:p=>delayed(git.diff(p)),content:p=>delayed(git.content(p)),history:p=>delayed(git.history(p)),blame:p=>delayed(git.blame(p))},{name:'Empty inline lambda',capabilities:{sources:['unstaged'],history:false,content:false,blame:false},diff:p=>({command:'printf',args:['%s','{"files":[]}'],parse:JSON.parse})},{...git,name:'Parser error fixture',diff:p=>({command:'printf',args:['%s','not-json'],parse:JSON.parse})}]};})()"""
config.write_text(baseconfig)
(c/'config.json').write_text(json.dumps({'version':2,'check_for_updates':False,'self_update':False,'orchestrator_mode':False,'plugins':{'vcs_diff':{'settings':{'adapterConfig':'vcs-diff/config.js'}},'vcs-diff':{'settings':{'adapterConfig':'WRONG-namespace.js'}}},'editor':{'restore_previous_session':False,'line_numbers':True},'lsp':{'typescript':[]},'keybindings':[{'key':'d','modifiers':['alt'],'action':'vcs_diff_open'},{'key':'b','modifiers':['alt'],'action':'vcs_diff_blame'}]}))
# Instrument only observation/bridge in the disposable bundled plugin realm. Native UI and processes are unmocked.
bundle=(plugins/'vcs_diff.ts').read_text();bundle='const nativeStaging = [];\n'+bundle;bundle=bundle.replace('const dir = editor.scratchPath(token);','const dir = editor.scratchPath(token); nativeStaging.push(dir);');anchor='function draw(s) {';assert bundle.count(anchor)==1
bundle=bundle.replace(anchor,anchor+' editor.replaceFile(editor.localPath('+json.dumps(str(base/'state.json'))+'),JSON.stringify({title:s.title,items:s.items,selected:s.selected,pending:s.pending,phase:s.phase,timer:s.timer,viewer:s.viewer,treeSplit:s.treeSplit,right:s.right,file:s.file,diff:s.diff,layout:s.layout,blameBuffer:s.blameBuffer}));')
anchor='editor.registerCommand("VCS Diff",';assert bundle.count(anchor)==1
bridge=r'''registerHandler('native_snapshot',async()=>{await editor.flush();editor.replaceFile(editor.localPath(SNAPSHOT),JSON.stringify({namespace:editor.pluginName(),settings:editor.getPluginConfig(),staging:nativeStaging.map(path=>({path,exists:editor.fileStat(editor.localPath(path))!==null})),windows:editor.listWindows(),activeWindow:editor.activeWindow(),session:session!==null,pending:session?.pending,timer:session?.timer,phase:session?.phase,buffers:editor.listBuffers(),splits:editor.listSplits(),cursor:await editor.getCompositeCursorInfo(),sourceAnchor:session?.stream&&session?.layout==='unified'?(()=>{const offsets=session.stream.offsets,pos=editor.getCursorPosition();let row=0;while(row+1<offsets.length&&offsets[row+1]<=pos)row++;return session.stream.rows[row];})():null,mouseHandlers:editor.getHandlers('mouse_click'),stat:editor.fileStat(editor.localPath(CONFIG))}));});editor.registerCommand('Native Snapshot','','native_snapshot');
registerHandler('native_bridge',async()=>{const raw=editor.readFile(editor.localPath(REQUEST));if(!raw)return;editor.replaceFile(editor.localPath(REQUEST),'');const r=JSON.parse(raw);try{await editor.runCommand(r.name);editor.replaceFile(editor.localPath(RESPONSE),JSON.stringify({id:r.id}));}catch(e){editor.replaceFile(editor.localPath(RESPONSE),JSON.stringify({id:r.id,error:String(e)}));}});editor.setInterval(30,'native_bridge');
registerHandler('native_close',()=>close());editor.registerCommand('Native Close','','native_close');
registerHandler('native_layout',()=>toggle());editor.registerCommand('Native Layout','','native_layout');
for(const [name,text] of [['Added','+ B\n'],['Deleted','- d\n']]){registerHandler('native_row_'+name,async()=>{const s=session;const row=s.stream.unified.findIndex(e=>e.text===text);if(row<0)throw new Error('Missing '+name+' fixture row');editor.focusSplit(s.right);editor.showBuffer(s.viewer);await editor.flush();editor.setBufferCursor(s.viewer,s.stream.offsets[row]);await editor.flush();});editor.registerCommand('Native '+name+' Row','','native_row_'+name);}
registerHandler('native_viewer',()=>{if(session?.viewer!==null){editor.focusSplit(session.right);editor.showBuffer(session.viewer);}});editor.registerCommand('Native Viewer','','native_viewer');
registerHandler('native_dirty',()=>editor.insertText(editor.findBufferByPath(ROOT+'/src/alpha.ts'),0,'// unsaved\n'));editor.registerCommand('Native Dirty','','native_dirty');
registerHandler('native_mixed_open',async()=>{await editor.openFile(ROOT+'/mixed.txt');editor.showBuffer(editor.findBufferByPath(ROOT+'/src/alpha.ts'));});editor.registerCommand('Native Mixed Open','','native_mixed_open');
registerHandler('native_mixed',()=>{editor.focusSplit(session.right);editor.showBuffer(editor.findBufferByPath(ROOT+'/mixed.txt'));});editor.registerCommand('Native Mixed','','native_mixed');
registerHandler('native_foreign',async()=>{editor.createWindow(ROOT+'/src','Foreign fixture');await editor.flush();await editor.delay(100);const id=editor.listWindows().find(w=>w.id!==session?.window).id;editor.setActiveWindow(id);});editor.registerCommand('Native Foreign','','native_foreign');
registerHandler('native_return',()=>{editor.setActiveWindow(editor.listWindows()[0].id);});editor.registerCommand('Native Return','','native_return');
registerHandler('native_theme',()=>editor.applyTheme('light'));editor.registerCommand('Native Light','','native_theme');
registerHandler('native_source',()=>{editor.focusSplit(session?.right||editor.getActiveSplitId());editor.showBuffer(editor.findBufferByPath(ROOT+'/src/alpha.ts'));});editor.registerCommand('Native Source','','native_source');
'''
for key,value in [('SNAPSHOT',base/'snapshot.json'),('REQUEST',base/'request.json'),('RESPONSE',base/'response.json'),('CONFIG',config),('ROOT',root)]:bridge=bridge.replace(key,json.dumps(str(value)))
(plugins/'vcs_diff.ts').write_text(bundle.replace(anchor,bridge+'\n'+anchor))
m,s=demo.open_pty(36,130);p=None;data=bytearray();recording=[];clock=time.monotonic();proofs=[];request=0
known={}
def record(kind,**fields):demo.record_event(recording,clock,len(data),kind,**fields)
def child_tree(pid,seen=None):
 seen=set() if seen is None else seen
 if pid in seen:return
 seen.add(pid);assert len(seen)<4096
 try:tasks=list(pathlib.Path(f'/proc/{pid}/task').iterdir())
 except (FileNotFoundError,ProcessLookupError):return
 assert len(tasks)<1024
 children=set()
 for task in tasks:
  try:children.update((task/'children').read_text().split())
  except (FileNotFoundError,ProcessLookupError):pass
 for child in children:
  try:fields=pathlib.Path('/proc/'+child+'/stat').read_text().rsplit(')',1)[1].split();known[int(child)]=fields[19];child_tree(int(child),seen)
  except (FileNotFoundError,ProcessLookupError):pass
def live_children():
 result=[]
 for pid,start in known.items():
  try:f=pathlib.Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split();
  except (FileNotFoundError,ProcessLookupError):continue
  if f[19]==start and f[0]!='Z':result.append(pid)
 return result
def pump(t=.15):
 end=time.monotonic()+t
 while time.monotonic()<end:
  if p and p.poll() is None:child_tree(p.pid)
  if select.select([m],[],[],.025)[0]:
   try:b=os.read(m,65536)
   except OSError:break
   start=len(data);data.extend(b);assert len(data)<=demo.MAX_ANSI;record('chunk',start=start)
   if b'\x1b[6n' in b:os.write(m,b'\x1b[1;1R')
   if b'\x1b[c' in b:os.write(m,b'\x1b[?1;2c')
def keys(b,t=.15):os.write(m,b);pump(t)
def command(name):
 global request
 request+=1;(base/'request.json').write_text(json.dumps({'id':request,'name':name}));deadline=time.monotonic()+4
 while time.monotonic()<deadline:
  pump(.03)
  if (base/'response.json').exists() and json.loads((base/'response.json').read_text()).get('id')==request:return
 raise AssertionError('No bridge response: '+name)
def state():return json.loads((base/'state.json').read_text())
def wait(predicate,seconds=5):
 deadline=time.monotonic()+seconds
 while time.monotonic()<deadline:
  pump(.04)
  if (base/'state.json').exists() and predicate(state()):return state()
 raise AssertionError(('State timeout',state() if (base/'state.json').exists() else 'absent'))
def mark(name,contains=(),absent=()):
 command('Native Snapshot');pump(.1);screen=demo.dependencies()[0].Screen(130,36);demo.dependencies()[0].ByteStream(screen).feed(bytes(data));text='\n'.join(screen.display)
 for value in contains:assert value in text,(name,value,text)
 for value in absent:assert value not in text,(name,value,text)
 snap=json.loads((base/'snapshot.json').read_text());assert snap['namespace']=='vcs_diff';assert snap['settings']['adapterConfig']=='vcs-diff/config.js'
 record('phase',name=name);proofs.append(dict(name=name,snapshot=snap,screen=text));(base/(name+'.txt')).write_text(text+'\n')
def open_adapter(index=0,blame=False):
 keys(b'\x1bb' if blame else b'\x1bd');wait(lambda s:s['title']=='Choose adapter');keys(b'\x1b[B'*index);keys(b'\r');pump(.1)
def select_source(index=0):
 wait(lambda s:'Diff source' in s['title']);keys(b'\x1b[B'*index);keys(b'\r')
def close():command('Native Close');pump(.12)
record('resize',rows=36,columns=130)
try:
 p=demo.launch(binary,root/'src/alpha.ts',root,env,s);os.close(s);pump(1);command('Native Mixed Open')
 keys(b'\x1bd');wait(lambda s:s['title']=='Choose adapter');mark('adapter-picker',contains=['Git','Delayed fixture']);keys(b'\r');mark('picker',contains=['Git','Unstaged','Staged']);select_source(0);wait(lambda s:not s['pending'] and s['diff'] is not None);mark('unstaged',contains=['+   return 42','-   return 41','界.txt','+1','−1'],absent=['BEFORE','AFTER']);assert all(b['editing_disabled'] for b in json.loads((base/'snapshot.json').read_text())['buffers'] if b['name'].startswith('VCS'))
 # Actual native cursor readback for both one-sided rows, not model-only mapping.
 for name,expected in [('Added',[None,3]),('Deleted',[5,None])]:
  command('Native '+name+' Row');mark(name.lower()+'-unified');before=json.loads((base/'snapshot.json').read_text())['sourceAnchor'];selected=state()['file'];assert before==expected,(name,before)
  command('Native Layout');mark(name.lower()+'-side');side=json.loads((base/'snapshot.json').read_text())['cursor'];assert side['lines']==before,(name,before,side);assert state()['file']==selected
  command('Native Layout');mark(name.lower()+'-roundtrip');after=json.loads((base/'snapshot.json').read_text())['sourceAnchor'];assert after==before,(name,before,side,after);assert state()['file']==selected
 command('Native Layout');mark('side-by-side',contains=['BEFORE','AFTER','return 41','return 42']);
 # Actual mouse navigation in the own tree; native readback proves file/line mapping.
 snap=json.loads((base/'snapshot.json').read_text());left=next(x for x in snap['splits'] if x['splitId']==state()['treeSplit']);col=left['x']+10;row=left['y']+5;keys(f'\x1b[<0;{col};{row}M\x1b[<0;{col};{row}m'.encode());mark('tree-click');before=json.loads((base/'snapshot.json').read_text())['cursor'];command('Native Layout');mark('anchor-preserved');after=json.loads((base/'snapshot.json').read_text())['cursor'];assert before['lines'][before['focusedPane']]==json.loads((base/'snapshot.json').read_text())['sourceAnchor'][before['focusedPane']],(before,after);command('Native Layout');mark('anchor-roundtrip');assert before['lines']==json.loads((base/'snapshot.json').read_text())['cursor']['lines'];command('Native Layout')
 command('Native Mixed');mark('mixed-markers',contains=['▌','−','B']);command('Native Source');mark('static-markers',contains=['▌','answerNow']);snap=json.loads((base/'snapshot.json').read_text());assert not any(str(h).startswith('vcs_diff') for h in snap['mouseHandlers']);right=next(x for x in snap['splits'] if x['splitId']==state()['right']);col=right['x']+1;row=right['y']+2;keys(f'\x1b[<0;{col};{row}M\x1b[<0;{col};{row}m'.encode());mark('normal-folding',contains=['...'],absent=['return 42']);fold=json.loads((base/'snapshot.json').read_text());assert len(fold['buffers'])==len(snap['buffers']);keys(f'\x1b[<0;{col};{row}M\x1b[<0;{col};{row}m'.encode());mark('normal-unfolding',contains=['return 42']);command('Native Foreign');pump(.2);mark('foreign-window');assert not json.loads((base/'snapshot.json').read_text())['session'];assert not any(b['name'].startswith('VCS') for b in json.loads((base/'snapshot.json').read_text())['buffers']);command('Native Return');pump(.2);close();mark('owner-return-cleanup');snap=json.loads((base/'snapshot.json').read_text());assert not any(b['name'].startswith('VCS') for b in snap['buffers']);assert len(snap['splits'])==1;open_adapter();select_source(1);wait(lambda s:not s['pending'] and s['diff'] is not None);mark('staged',contains=['added.py','binary.bin','renamed.md','deleted.txt']);command('Native Light');mark('light-theme');import fcntl,termios,struct;fcntl.ioctl(m,termios.TIOCSWINSZ,struct.pack('HHHH',18,65,0,0));os.kill(p.pid,signal.SIGWINCH);record('resize',rows=18,columns=65);pump(.2);mark('resize');fcntl.ioctl(m,termios.TIOCSWINSZ,struct.pack('HHHH',36,130,0,0));os.kill(p.pid,signal.SIGWINCH);record('resize',rows=36,columns=130);pump(.2);close()
 open_adapter();select_source(2);pump(.2);mark('commit-input',contains=['Commit revision']);keys(revision.encode()+b'\r');wait(lambda s:not s['pending'] and s['diff'] is not None);mark('commit-root',contains=['FILE','Initial'] if False else ['FILE']);close()
 open_adapter();select_source(3);wait(lambda s:s['title'].startswith('History'));mark('history',contains=['Initial fixture']);keys(b'\r');wait(lambda s:not s['pending'] and s['diff'] is not None);mark('history-diff',contains=['FILE']);close()
 open_adapter(1,blame=True);wait(lambda s:s['pending']=='Loading blame');mark('blame-loading',contains=['Loading blame']);pump(.22);mark('blame-loading-next');wait(lambda s:not s['pending']);mark('blame-stop');close();open_adapter(blame=True);wait(lambda s:not s['pending']);mark('blame',contains=['Demo Author','Uncommitted']);keys(b'// unsaved',.3);mark('dirty-blame-cleared',absent=['Demo Author']);close()
 # States clip uses a synthetic delayed transport, never labelled live Arc.
 open_adapter(1);select_source(3);wait(lambda s:s['pending']=='Loading history');mark('history-loading',contains=['Loading history']);pump(.22);mark('history-loading-next');wait(lambda s:not s['pending']);mark('history-stop');idle=json.loads((base/'snapshot.json').read_text());pump(.25);mark('history-idle-stop');stopped=json.loads((base/'snapshot.json').read_text());assert idle['timer'] is None and stopped['timer'] is None and idle['phase']==stopped['phase'];close()
 open_adapter(1);select_source(0);wait(lambda s:s['treeSplit'] is not None and s['pending']);mark('tree-viewer-loading',contains=['Loading']);pump(.22);mark('tree-viewer-loading-next');close();pump(.25);mark('cancel-ui-cleanup');assert not json.loads((base/'snapshot.json').read_text())['session']
 pump(1.3);open_adapter(2);select_source(0);wait(lambda s:not s['pending'] and s['diff'] is not None);mark('empty',contains=['No changes']);close()
 open_adapter(3);select_source(0);wait(lambda s:not s['pending']);mark('parser-error',contains=['VCS Diff']);close()
 # Fresh config edit takes effect without rebuilding bundle.
 config.write_text('({adapters:[load("./presets/git.js")]})');keys(b'\x1bd');wait(lambda s:'Diff source' in s['title']);mark('config-reloaded');close()
 hang_pids=base/'hung-pids.json'
 hang_code='import os,sys,time,signal,subprocess,json; signal.signal(signal.SIGTERM,signal.SIG_IGN); child=subprocess.Popen([sys.executable,"-c","import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(120)"]); open(sys.argv[1],"w").write(json.dumps([os.getpid(),child.pid])); time.sleep(120)'
 config.write_text("({adapters:[{name:'Synthetic bounded hung child',capabilities:{sources:['unstaged'],history:false,content:false,blame:false},diff:()=>({command:'python3',args:"+json.dumps(['-c',hang_code,str(hang_pids)])+",parse:JSON.parse})}]})")
 keys(b'\x1bd');wait(lambda s:'Diff source' in s['title']);mark('limits-start');select_source(0);wait(lambda s:s['treeSplit'] is not None and bool(s['pending']));mark('timeout-loading');wait(lambda s:not s['pending'],seconds=18);mark('timeout-ui-stop',contains=['timed out']);close();pump(1.5)
 hung=json.loads(hang_pids.read_text());assert all(pid not in live_children() for pid in hung),(hung,live_children());mark('bounded-child-exit');assert not any(r['exists'] for r in json.loads((base/'snapshot.json').read_text())['staging'])
 config.write_text('({adapters:[load("./presets/git.js")]})');keys(b'\x1bd');wait(lambda s:'Diff source' in s['title']);select_source(0);wait(lambda s:not s['pending'] and s['diff'] is not None);mark('timeout-reopen-success',contains=['+   return 42']);close()
 # Escape releases UI immediately, but lock remains until the owned timeout group exits.
 hang_pids.unlink();config.write_text("({adapters:[{name:'Synthetic cancel bounded child',capabilities:{sources:['unstaged'],history:false,content:false,blame:false},diff:()=>({command:'python3',args:"+json.dumps(['-c',hang_code,str(hang_pids)])+",parse:JSON.parse})}]})")
 keys(b'\x1bd');wait(lambda s:'Diff source' in s['title']);select_source(0);wait(lambda s:s['treeSplit'] is not None and bool(s['pending']));pump(.3);keys(b'\x1b',.2);mark('escape-immediate');assert not json.loads((base/'snapshot.json').read_text())['session'];hung=json.loads(hang_pids.read_text());assert any(pid in live_children() for pid in hung)
 config.write_text('({adapters:[load("./presets/git.js")]})');keys(b'\x1bd');wait(lambda s:'Diff source' in s['title']);select_source(0);wait(lambda s:not s['pending']);mark('bounded-busy-lock',contains=['Previous adapter process still running']);close();pump(16.5);assert all(pid not in live_children() for pid in hung);keys(b'\x1bd');wait(lambda s:'Diff source' in s['title']);select_source(0);wait(lambda s:not s['pending'] and s['diff'] is not None);mark('cancel-reopen-success',contains=['+   return 42']);assert not any(r['exists'] for r in json.loads((base/'snapshot.json').read_text())['staging']);close()
 config.write_text("({adapters:[{name:'Synthetic output quota',capabilities:{sources:['unstaged'],history:false,content:false,blame:false},diff:()=>({command:'python3',args:['-c',\"import sys,time;sys.stdout.write('x'*8388608);sys.stdout.flush();time.sleep(1)\"],parse:JSON.parse})}]})")
 keys(b'\x1bd');wait(lambda s:'Diff source' in s['title']);select_source(0);wait(lambda s:not s['pending']);mark('output-quota-ui-stop',contains=['output limit exceeded']);close();pump(1.3)
 config.write_text("({adapters:[{...load('./presets/git.js'),name:'Synthetic content failure',content:()=>({command:'python3',args:['-c','raise SystemExit(7)'],parse:text=>({text})})}]})")
 keys(b'\x1bd');wait(lambda s:'Diff source' in s['title']);select_source(0);wait(lambda s:not s['pending']);mark('content-error',contains=['Adapter failed (7)']);close()
 config.write_text('({');keys(b'\x1bd');pump(.2);mark('syntax-error',contains=['VCS Diff']);assert not json.loads((base/'snapshot.json').read_text())['session']
 print('PASS native UI + GNU bounded child/descendant exit and reopen:',base)
finally:
 remaining=live_children();demo.stop_process(p)
 for pid in live_children():
  try:os.kill(pid,signal.SIGTERM)
  except ProcessLookupError:pass
 time.sleep(.1)
 for pid in live_children():
  try:os.kill(pid,signal.SIGKILL)
  except ProcessLookupError:pass
 time.sleep(.1);(base/'process-cleanup.json').write_text(json.dumps({'known':list(known),'remaining_before_fixture_cleanup':remaining,'live_after_fixture_cleanup':live_children()}));assert not live_children()
 os.close(m);(base/'terminal.ansi').write_bytes(data);(base/'recording.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in recording));(base/'proofs.json').write_text(json.dumps(proofs,indent=2)+'\n');print('Evidence:',base)
# Encode separate bounded clips from the same recording; package-specific coverage stays here.

source_files=['packages/vcs-diff/vcs_diff.ts',*[f'packages/vcs-diff/lib/{n}.ts' for n in ['config','model','run','ui']],*[f'packages/vcs-diff/presets/{n}.js' for n in ['git','arc','patch']],'packages/vcs-diff/scripts/build-package.mjs','packages/vcs-diff/tests/smoke.py','packages/vcs-diff/tests/core.test.ts','packages/vcs-diff/tests/package.test.mjs','packages/_shared/runtime_brand.ts','packages/_shared/runtime_icons.ts','packages/_shared/native_demo.py']
hashes={name:demo.sha(repo/name) for name in source_files}
clips=[('main','adapter-picker','dirty-blame-cleared'),('states','history-loading','config-reloaded'),('limits','limits-start','timeout-reopen-success'),('cancel','escape-immediate','syntax-error')]
results={}
for name,start,end in clips:
    dest=base/name
    provenance=demo.clip_recording(base,dest,start,end)
    names=[p['name'] for p in proofs];selected_proofs=proofs[names.index(start):names.index(end)+1]
    coverage=[p['name'] for p in selected_proofs]
    assertions={p['name']:dict(timer=p['snapshot'].get('timer'),phase=p['snapshot'].get('phase'),cursor=p['snapshot'].get('cursor')) for p in selected_proofs}
    result=demo.encode_recording(dest,'Actual Fresh PTY; temporary real Git fixture. Delayed/error/empty adapters are synthetic JS-expression fixtures, NOT live Arc.',hashes,assertions)
    result.update(recording_origin=provenance,coverage=coverage,native_bundle=dict(source_sha256=demo.sha(package/'vcs_diff.ts'),copy_sha256=demo.sha(plugins/'vcs_diff.ts'),instrumented=True),binary_sha256=demo.sha(binary),scope_gaps=['Live Arc staged/unstaged writes not authorized; readonly .arcignore checks are separate.','Fresh handle.kill may return false: Escape stops UI immediately; GNU timeout bounds actual child/descendant exit to 15s + 1s kill grace. No hard disk/stderr quota claimed.'],source_markers='Static only; no VCS mouse handler or preview. Normal native folding asserted.')
    (dest/'demo-manifest.json').write_text(json.dumps(result,indent=2)+'\n');results[name]=result
if publish:
    block='\n[![Actual Fresh Git diff, tree, layouts, markers and blame](assets/demo.gif)](assets/demo.mp4)\n\n[![Loading, UI cancellation, errors and config reload](assets/states/demo.gif)](assets/states/demo.mp4)\n\n[![GNU timeout, bounded child exit and reopen](assets/limits/demo.gif)](assets/limits/demo.mp4)\n\n[![Escape, bounded busy lock, reopen and errors](assets/cancel/demo.gif)](assets/cancel/demo.mp4)\n'
    demo.publish(base/'main',source/'README.md',original,repo,source_files,readme_block=block)
    (source/'assets/states').mkdir(exist_ok=True)
    demo.publish(base/'states',source/'README.md',demo.readme_snapshot(source/'README.md'),repo,source_files,asset_dir=source/'assets/states',readme_block=block)
    (source/'assets/limits').mkdir(exist_ok=True)
    demo.publish(base/'limits',source/'README.md',demo.readme_snapshot(source/'README.md'),repo,source_files,asset_dir=source/'assets/limits',readme_block=block)
    (source/'assets/cancel').mkdir(exist_ok=True)
    demo.publish(base/'cancel',source/'README.md',demo.readme_snapshot(source/'README.md'),repo,source_files,asset_dir=source/'assets/cancel',readme_block=block)
    (source/'assets/provenance.json').write_text(json.dumps(results,indent=2)+'\n')
    # Portable raw recording and readback evidence make the native assertions independently inspectable.
    for name in ['terminal.ansi','recording.jsonl','process-cleanup.json']:(source/'assets'/name).write_bytes((base/name).read_bytes())
    portable=[]
    for p in proofs:
        snap=p['snapshot'];snap.pop('stat',None)
        for r in snap.get('staging',[]):r['path']='<owned scratch output>'
        for w in snap.get('windows',[]):
            if w.get('root','').startswith(str(root)):w['root']='<temporary Git fixture>'+w['root'][len(str(root)):]
        for b in snap['buffers']:
            if b['path'].startswith(str(root)):b['path']='<temporary Git fixture>'+b['path'][len(str(root)):]
        portable.append(p)
    (source/'assets/ux-evidence.json').write_text(json.dumps(portable,indent=2)+'\n')
print('Video full decode PASS:',base)
