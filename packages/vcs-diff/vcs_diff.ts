import {loadConfig} from './lib/config.ts';
import {job,type Job} from './lib/run.ts';
import {compose,picker,tree,snapshots,changedRows,present,sourceAnchor,anchorOffset,type Presentation,type Anchor,type Stream} from './lib/ui.ts';
import {MAX_TEXT,bytes,path,type Adapter,type Diff,type Source} from './lib/model.ts';
import {BRAND_PALETTE as palette,LOADING_STEP_MS,loadingFrame,MARKER_RGB} from '../_shared/runtime_brand.ts';
import {changedLineIcon} from '../_shared/runtime_icons.ts';
(async function(){
const editor=getEditor(),PICKER=84621,TREE=84622,MODE='vcs-diff';
interface Session {window:number;authority:string;cwd:string;original:number;right:number;job:Job;adapters:Adapter[];adapter:Adapter|null;items:{key:string;label:string;disabled?:boolean}[];selected:number;title:string;pending:string;phase:number;timer:number|null;floating:boolean;buffers:Set<number>;treeSplit:number|null;treeBuffer:number|null;viewer:number|null;diff:Diff|null;stream:Stream|null;presentation:Presentation|null;viewerAnchor:Anchor|null;presenting:boolean;source:Source|null;revision:string|null;layout:'unified'|'side-by-side';file:string|null;expanded:string[]|null;blameBuffer:number|null;namespace:string}
let session:Session|null=null;
const deferred=new Set<Session>();
const markerNamespace='vcs-diff:static-markers';
const marked=new Set<number>();
async function markers(s:Session,contents:Map<string,[string,string]>){
  for(const b of editor.listBuffers())if(b.window_id===s.window&&marked.has(b.id)){editor.clearLineIndicators(b.id,markerNamespace);marked.delete(b.id);}
  for(const b of editor.listBuffers()){if(b.window_id!==s.window||b.modified||!b.path.startsWith(s.cwd+'/'))continue;const f=s.diff?.files.find(f=>f.newPath===b.path.slice(s.cwd.length+1));if(!f||f.binary)continue;const saved=contents.get(f.id)?.[1];if(saved===undefined||b.length>MAX_TEXT)continue;const text=await editor.getBufferText(b.id);if(!valid(s)||editor.getBufferInfo(b.id)?.modified||text!==saved)continue;editor.clearLineIndicators(b.id,markerNamespace);marked.add(b.id);const lines=text.split('\n').length;
    for(const h of f.hunks)for(const mark of changedRows(h))editor.setLineIndicator(b.id,Math.min(mark.line,lines-1),markerNamespace,changedLineIcon[mark.kind],...MARKER_RGB,99);
  }
}
function valid(s:Session){return session===s&&editor.activeWindow()===s.window&&editor.getAuthorityLabel()===s.authority&&!s.job.cancelled;}
function draw(s:Session){if(!valid(s))return;if(s.floating)editor.updateFloatingWidget(PICKER,picker(s.title,s.items,s.selected,s.pending,s.phase));if(s.treeBuffer!==null)editor.updateWidgetPanel(TREE,tree(s.diff,s.file,s.pending,s.phase,s.expanded,s.adapter?comparison(s):''));if(s.pending&&s.viewer!==null&&!s.stream)editor.setVirtualBufferContent(s.viewer,[{text:s.pending+' '+loadingFrame(s.phase)+'\n',style:{fg:palette.accent}}]);if(s.blameBuffer!==null&&s.pending)editor.addVirtualTextStyled(s.blameBuffer,s.namespace+'pending',0,'  '+s.pending+' '+loadingFrame(s.phase),{fg:palette.loadingAccent},false);}
function pending(s:Session,message:string){s.pending=message;if(message&&s.timer===null)s.timer=editor.setInterval(LOADING_STEP_MS,'vcs_diff_loading');if(!message&&s.timer!==null){editor.clearInterval(s.timer);s.timer=null;}if(!message&&s.blameBuffer!==null)editor.removeVirtualText(s.blameBuffer,s.namespace+'pending');draw(s);}
async function cleanup(){for(const s of deferred){
  if(!editor.listWindows().some(w=>w.id===s.window)){deferred.delete(s);continue;}
  if(editor.activeWindow()!==s.window||editor.getAuthorityLabel()!==s.authority)continue;
  if(s.floating)editor.unmountFloatingWidget(PICKER);
  if(s.treeBuffer!==null&&editor.getBufferInfo(s.treeBuffer)?.window_id===s.window)editor.unmountWidgetPanel(TREE);
  if(s.blameBuffer!==null)editor.removeVirtualTextsByPrefix(s.blameBuffer,s.namespace);
  if(s.treeSplit!==null&&editor.listSplits().some(p=>p.splitId===s.treeSplit&&p.bufferId===s.treeBuffer))editor.closeSplit(s.treeSplit);
  if(s.viewer!==null&&editor.listSplits().some(p=>p.splitId===s.right&&p.bufferId===s.viewer)){editor.focusSplit(s.right);editor.showBuffer(s.original);}
  for(const id of s.buffers)if(editor.getBufferInfo(id)?.window_id===s.window)editor.closeBuffer(id,true);
  deferred.delete(s);await editor.flush();
}}
async function close(){const s=session;if(s){session=null;s.job.cancel();if(s.timer!==null){editor.clearInterval(s.timer);s.timer=null;}deferred.add(s);}await cleanup();}

function fail(s:Session,e:unknown){if(!valid(s))return;pending(s,'');if(s.viewer!==null&&!s.stream)editor.setVirtualBufferContent(s.viewer,[{text:'Error: '+String(e)+'\n'}]);editor.setStatus('VCS Diff: '+String(e));if(s.floating){s.title='Error: '+String(e);s.items=[{key:'back',label:'Back to sources'}];draw(s);}}
async function begin(blame=false){await close();const adapters=loadConfig(editor);const s:Session={window:editor.activeWindow(),authority:editor.getAuthorityLabel(),cwd:editor.getCwd(),original:editor.getActiveBufferId(),right:editor.getActiveSplitId(),job:job(editor,15000,(editor.getPluginConfig() as {timeoutCommand?:string}).timeoutCommand),adapters,adapter:null,items:[],selected:0,title:'Choose adapter',pending:'',phase:0,timer:null,floating:false,buffers:new Set(),treeSplit:null,treeBuffer:null,viewer:null,diff:null,stream:null,presentation:null,viewerAnchor:null,presenting:false,source:null,revision:null,layout:'unified',file:null,expanded:null,blameBuffer:blame?editor.getActiveBufferId():null,namespace:'vcs-diff:'+Date.now()+':'};session=s;
  if(adapters.length===1){s.adapter=adapters[0];if(blame){await blameLoad(s);return;}sources(s);}else s.items=adapters.map((a,i)=>({key:'adapter:'+i,label:a.name}));
  s.floating=editor.mountFloatingWidget(PICKER,picker(s.title,s.items,0,'',0),65,60,false,false,'VCS Diff',true,false,MODE);if(!s.floating)throw new Error('Cannot mount VCS picker');draw(s);
}
function sources(s:Session){s.title=s.adapter!.name+' · Diff source';s.selected=0;s.items=([{key:'unstaged',label:'Unstaged · index → disk'},{key:'staged',label:'Staged · HEAD → index'},{key:'commit',label:'Enter commit · first parent'},{key:'history',label:'Choose history · first parent'}]).map(i=>({...i,disabled:i.key==='history'?!s.adapter!.capabilities.history:!s.adapter!.capabilities.sources.includes(i.key as Source)}));draw(s);}
async function choose(){const s=session;if(!s||!valid(s)||s.pending)return;const item=s.items[s.selected];if(!item||item.disabled){editor.setStatus('Operation unavailable in this adapter');return;}
  try{
    if(item.key.startsWith('adapter:')){s.adapter=s.adapters[Number(item.key.slice(8))];if(s.blameBuffer!==null){editor.unmountFloatingWidget(PICKER);s.floating=false;await blameLoad(s);}else sources(s);return;}
    if(item.key==='back'){sources(s);return;}
    if(item.key==='history'){pending(s,'Loading history');const commits=await s.job.run('history',()=>s.adapter!.history!({cwd:s.cwd,limit:100}),s.cwd);if(!valid(s))return;pending(s,'');s.title='History · first parent';s.items=commits.map(c=>({key:'revision:'+c.revision,label:c.label}));s.selected=0;if(!s.items.length)s.title='No commits';draw(s);return;}
    let source=item.key as Source,revision:string|null=null;
    if(item.key.startsWith('revision:')){source='commit';revision=item.key.slice(9);}else if(source==='commit'){revision=await editor.prompt('Commit revision','');if(!valid(s)||revision===null)return;}
    await showDiff(s,source,revision);
  }catch(e){fail(s,e);}
}
async function own(s:Session,options:CreateVirtualBufferOptions){const r=await editor.createVirtualBuffer({...options,readOnly:true,editingDisabled:true,mode:MODE});s.buffers.add(r.bufferId);if(!valid(s)){editor.closeBuffer(r.bufferId,true);throw new Error('Cancelled');}return r.bufferId;}
async function showDiff(s:Session,source:Source,revision:string|null){
  s.source=source;s.revision=revision;pending(s,'Loading diff');
  // Keep picker visible until native placeholder/tree exist, then it no longer owns focus.
  editor.focusSplit(s.right);s.viewer=await own(s,{name:'VCS Diff',entries:[{text:'Loading diff '+loadingFrame(0)+'\n'}],showLineNumbers:false,highlightCurrentLine:false});
  if(!valid(s))return;
  const left=await editor.createVirtualBufferInSplit({name:'VCS changed files',mode:MODE,direction:'vertical',before:true,ratio:.25,readOnly:true,editingDisabled:true,scrollable:false});s.buffers.add(left.bufferId);s.treeBuffer=left.bufferId;s.treeSplit=left.splitId;
  if(!valid(s)){editor.closeSplit(left.splitId);editor.closeBuffer(left.bufferId,true);return;}
  editor.mountWidgetPanel(TREE,left.bufferId,tree(null,null,s.pending,s.phase,[]));editor.unmountFloatingWidget(PICKER);s.floating=false;draw(s);
  const diff=await s.job.run('diff',()=>s.adapter!.diff({cwd:s.cwd,source,revision}),s.cwd);if(!valid(s))return;s.diff=diff;s.file=diff.files[0]?.id||null;
  if(!diff.files.length){pending(s,'');editor.setVirtualBufferContent(s.viewer!,[{text:'No changes\n'}]);draw(s);return;}
  if(!s.adapter!.capabilities.content&&diff.files.some(f=>!f.binary))throw new Error('Adapter cannot provide content snapshots');
  const contents=await snapshots(diff,async ref=>{pending(s,'Loading '+ref.path);const c=await s.job.run('content',()=>s.adapter!.content!({cwd:s.cwd,...ref}),s.cwd);if(!valid(s))throw new Error('Cancelled');return c.text;});
  if(source==='unstaged')await markers(s,contents);if(!valid(s))return;s.stream=compose(diff,contents);await layout(s,{file:s.file!,side:1,line:null});pending(s,'');
}
function comparison(s:Session){return s.adapter!.name+' · '+s.source+(s.revision?' · '+s.revision:'');}
async function navigate(s:Session,anchor:Anchor){if(s.viewer===null||!s.presentation)return;editor.setBufferCursor(s.viewer,anchorOffset(s.presentation,anchor));await editor.flush();s.viewerAnchor=anchor;}
async function layout(s:Session,anchor:Anchor,display=true){if(!s.stream||!valid(s))return;
 const cols=editor.listSplits().find(p=>p.splitId===s.right)?.width||80;
 // Presentation budget is checked before allocating any native viewer buffer.
 const view=present(s.stream,s.layout,Math.max(19,cols-2),text=>editor.stringWidth(text),comparison(s));
 s.presenting=true;
 try{
 // Reuse the owned buffer: closing a displayed virtual buffer resets native cursor state.
 const id=s.viewer!;editor.clearNamespace(id,s.namespace+'row');
 editor.setVirtualBufferContent(id,view.entries);s.presentation=view;
 editor.setLineWrap(id,s.right,false);editor.setSyntaxRegions(id,view.regions);
 // debt: native regions cannot isolate two code cells on one physical row in Fresh 0.5.2.
 // Explicit semantic foregrounds also suppress stale unified syntax when reusing the buffer.
 if(s.layout==='side-by-side'){let at=0;for(const e of view.entries){const end=at+bytes(e.text);if(e.style?.fg)editor.addOverlay(id,s.namespace+'row',at,end,{fg:e.style.fg});at=end;}}
 for(const b of view.backgrounds)editor.addOverlay(id,s.namespace+'row',b.start,b.end,{bg:b.bg,extendToLineEnd:b.full});
 if(display){editor.focusSplit(s.right);editor.showBuffer(id);}await editor.flush();if(!valid(s))return;await navigate(s,anchor);editor.setStatus(comparison(s)+' · '+s.layout+' · read-only · Tab: layout · Esc: close');draw(s);
 }finally{s.presenting=false;}
}
async function toggle(){const s=session;if(!s||s.pending||!s.stream||!s.presentation)return;try{
 editor.focusSplit(s.right);await editor.flush();const anchor=(editor.getActiveBufferId()===s.viewer?sourceAnchor(s.presentation,editor.getCursorPosition()):s.viewerAnchor)||{file:s.file!,side:1 as const,line:null};
 if(!valid(s))return;s.layout=s.layout==='unified'?'side-by-side':'unified';await layout(s,anchor);
}catch(e){fail(s,e);}}
async function blameLoad(s:Session){const id=s.blameBuffer!;const info=editor.getBufferInfo(id);if(!s.adapter!.capabilities.blame)throw new Error('Blame unavailable');if(!info?.path||info.modified||info.length>MAX_TEXT)throw new Error('Blame requires a saved local buffer below 4 MiB');const prefix=s.cwd.endsWith('/')?s.cwd:s.cwd+'/';if(!info.path.startsWith(prefix))throw new Error('Buffer outside cwd');const relative=info.path.slice(prefix.length);path(relative);pending(s,'Loading blame');
  try{const blame=await s.job.run('blame',()=>s.adapter!.blame!({cwd:s.cwd,path:relative}),s.cwd);if(!valid(s)||editor.getBufferInfo(id)?.modified)return;const text=await editor.getBufferText(id);if(!valid(s)||editor.getBufferInfo(id)?.modified)return;let offset=0;const lines=text.split('\n'),starts:number[]=[];for(const line of lines){starts.push(offset);offset+=unescape(encodeURIComponent(line+'\n')).length;}
    for(const r of blame.ranges) {if(r.endLine>lines.length)throw new Error('Blame exceeds buffer lines');for(let i=r.startLine;i<r.endLine;i++)editor.addVirtualTextStyled(id,s.namespace+i,starts[i]+unescape(encodeURIComponent(lines[i])).length,'  '+r.label,{fg:palette.secondary},false);}
    editor.setStatus('Inline blame · '+s.adapter!.name+' · edit removes stale labels');
  }finally{if(valid(s))pending(s,'');}
}
registerHandler('vcs_diff_open',()=>begin().catch(e=>editor.setStatus('VCS Diff: '+String(e))));
registerHandler('vcs_diff_blame',()=>begin(true).catch(e=>{const s=session;if(s)fail(s,e);else editor.setStatus('VCS Diff: '+String(e));}));
registerHandler('vcs_diff_enter',()=>choose());registerHandler('vcs_diff_close',()=>close());registerHandler('vcs_diff_layout',()=>toggle());
registerHandler('vcs_diff_loading',()=>{const s=session;if(!s)return;if(!valid(s)){close();return;}if(s.pending){s.phase++;draw(s);}else pending(s,'');});
registerHandler('vcs_diff_event',async(ev:WidgetEvent)=>{const s=session;if(!s||![PICKER,TREE].includes(ev.panel_id))return;if(ev.event_type==='cancel'){await close();return;}if(!valid(s))return;
 if(ev.panel_id===PICKER&&ev.widget_key==='choices'&&['select','activate'].includes(ev.event_type)){s.selected=Number(ev.payload.index);if(ev.event_type==='activate')await choose();}
 if(ev.panel_id===TREE&&ev.widget_key==='files'){
  if(ev.event_type==='expand'){const dirs=new Set<string>();for(const f of s.diff?.files||[]){const parts=(f.newPath||f.oldPath!).split('/');for(let i=1;i<parts.length;i++)dirs.add('dir:'+parts.slice(0,i).join('/'));}const keys=new Set(s.expanded??[...dirs]);const key=String(ev.payload.key);if(ev.payload.expanded)keys.add(key);else keys.delete(key);s.expanded=[...keys];return;}
  const key=String(ev.payload.key);if(['select','activate'].includes(ev.event_type)&&s.stream?.anchors.has(key)){s.file=key;editor.focusSplit(s.right);editor.showBuffer(s.viewer!);await editor.flush();if(valid(s)&&s.viewer!==null){await navigate(s,{file:key,side:1,line:null});}}
 }if(ev.panel_id===TREE&&['click','activate'].includes(ev.event_type)){if(ev.widget_key==='layout')await toggle();if(ev.widget_key==='close')await close();}
});editor.on('widget_event','vcs_diff_event');
registerHandler('vcs_diff_changed',(ev:{buffer_id:number})=>{if(marked.has(ev.buffer_id)){editor.clearLineIndicators(ev.buffer_id,markerNamespace);marked.delete(ev.buffer_id);}const s=session;if(s?.blameBuffer===ev.buffer_id){s.job.cancel();editor.removeVirtualTextsByPrefix(ev.buffer_id,s.namespace);if(s.timer!==null)editor.clearInterval(s.timer);s.timer=null;s.pending='';editor.setStatus('Inline blame removed: unsaved edits');}});editor.on('after_insert','vcs_diff_changed');editor.on('after_delete','vcs_diff_changed');
registerHandler('vcs_diff_context',async()=>{const s=session;if(s&&!valid(s))await close();else await cleanup();});editor.on('authority_changed','vcs_diff_context');editor.on('active_window_changed','vcs_diff_context');
// Fresh 0.5.2 exposes only the active cursor getter; retain the viewer's own moves.
registerHandler('vcs_diff_cursor',(ev:{buffer_id:number;new_position:number})=>{const s=session;if(s?.presentation&&ev.buffer_id===s.viewer&&!s.presenting)s.viewerAnchor=sourceAnchor(s.presentation,ev.new_position);});editor.on('cursor_moved','vcs_diff_cursor');
registerHandler('vcs_diff_resize',async()=>{const s=session;if(!s)return;draw(s);if(s.stream&&s.presentation&&!s.pending){const anchor=(editor.getActiveBufferId()===s.viewer?sourceAnchor(s.presentation,editor.getCursorPosition()):s.viewerAnchor)||{file:s.file!,side:1 as const,line:null};try{await layout(s,anchor,false);}catch(e){fail(s,e);}}});editor.on('resize','vcs_diff_resize');
editor.defineMode(MODE,[['Enter','vcs_diff_enter','shortcut'],['Escape','vcs_diff_close','shortcut'],['Tab','vcs_diff_layout','shortcut']],true,true,false);
editor.registerCommand('VCS Diff','Read-only diff picker','vcs_diff_open');editor.registerCommand('VCS Inline Blame','Adapter labels on saved lines','vcs_diff_blame');
})().catch(e=>getEditor().setStatus('VCS Diff: '+String(e)));
