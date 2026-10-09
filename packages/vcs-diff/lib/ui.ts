import {BRAND_PALETTE as palette, loadingFrame} from '../../_shared/runtime_brand.ts';
import {fileIcon,statusIcon} from '../../_shared/runtime_icons.ts';
import {MAX_TEXT,bytes,type Diff,type Hunk} from './model.ts';
export interface Stream {old: string; next: string; hunks: Hunk[]; anchors: Map<string,[number,number]>; unified: {text:string;style?:{fg:string}}[]; rows: [number|null,number|null][]; offsets: number[]}
export function fileHeader(f:Diff['files'][number]):string {
  const displayPath=(f.newPath||f.oldPath!).replace(/[\r\n]/g,'↵');
  return `FILE ${displayPath} · ${statusIcon[f.status]} +${f.added??'?'} −${f.deleted??'?'}${f.binary?' · binary':''}`+'\n'+(f.metadata||[]).join(' · ')+'\n';
}
// One coherent budget includes both snapshots, headers and newline padding.
export async function snapshots(diff:Diff,load:(ref:NonNullable<Diff['files'][number]['before']>)=>Promise<string>):Promise<Map<string,[string,string]>> {
  const contents=new Map<string,[string,string]>();let used=0;
  const reserve=(n:number)=>{used+=n;if(used>MAX_TEXT*2)throw new Error('Viewer total content limit exceeded');};
  for(const f of diff.files)reserve(2*bytes(fileHeader(f)));
  for(const f of diff.files){const pair:[string,string]=['',''];if(!f.binary)for(const [i,ref] of [f.before,f.after].entries())if(ref){const text=await load(ref);reserve(bytes(text)+(text&&!text.endsWith('\n')?1:0));pair[i]=text;}contents.set(f.id,pair);}
  return contents;
}
export function changedRows(h:Hunk):{line:number;kind:'added'|'modified'|'deleted'}[] {
  const result:{line:number;kind:'added'|'modified'|'deleted'}[]=[];let row=h.newStart;
  for(const block of h.ops.match(/ +|[+-]+/g)||[]){if(block[0]===' '){row+=block.length;continue;}const plus=block.includes('+'),minus=block.includes('-');if(minus&&!plus)result.push({line:row,kind:'deleted'});for(const op of block)if(op==='+')result.push({line:row++,kind:minus?'modified':'added'});}
  return result;
}
export function compose(diff: Diff, contents: Map<string,[string,string]>): Stream {
  let old='',next='',oldLine=0,newLine=0;const hunks:Hunk[]=[],anchors=new Map<string,[number,number]>();
  for(const f of diff.files) {
    const header=fileHeader(f),title=header.split('\n')[0];old+=header;next+=header;oldLine+=2;newLine+=2;anchors.set(f.id,[oldLine-2,newLine-2]);
    if(f.binary)continue;
    const [a,b]=contents.get(f.id)||['',''];
    const lines=(s:string)=>s?s.split('\n').length-(s.endsWith('\n')?1:0):0;
    for(const h of f.hunks){if(h.oldStart+h.oldCount>lines(a)||h.newStart+h.newCount>lines(b))throw new Error('Hunk exceeds snapshot: '+title);hunks.push({...h,oldStart:oldLine+h.oldStart,newStart:newLine+h.newStart});}
    old+=a+(a&&!a.endsWith('\n')?'\n':'');next+=b+(b&&!b.endsWith('\n')?'\n':'');oldLine+=lines(a);newLine+=lines(b);
  }
  const a=old.split('\n'),b=next.split('\n');a.pop();b.pop();
  const unified:Stream['unified']=[],rows:Stream['rows']=[],offsets:number[]=[];let x=0,y=0,offset=0;
  function emit(op:string,left:number|null,right:number|null){const text=op+' '+(right===null?a[left!]:b[right])+'\n';offsets.push(offset);offset+=bytes(text);rows.push([left,right]);unified.push({text,style:{fg:op==='+'?palette.accent:op==='-'?palette.secondary:palette.text}});}
  for(const h of hunks){while(y<h.newStart)emit(' ',x++,y++);for(const op of h.ops){if(op==='-')emit('-',x++,null);else if(op==='+')emit('+',null,y++);else emit(' ',x++,y++);}}
  while(y<b.length)emit(' ',x++,y++);
  return {old,next,hunks,anchors,unified,rows,offsets};
}
export function tree(diff: Diff|null, selected: string|null, pending: string, phase: number, expanded: string[]|null): unknown {
  const nodes:unknown[]=[],keys:string[]=[],directories=new Set<string>();
  interface Branch {children:Map<string,Branch>;files:Diff['files']}
  const root:Branch={children:new Map(),files:[]};
  for(const f of diff?.files||[]){const parts=(f.newPath||f.oldPath!).split('/');let branch=root;for(const part of parts.slice(0,-1)){if(!branch.children.has(part))branch.children.set(part,{children:new Map(),files:[]});branch=branch.children.get(part)!;}branch.files.push(f);}
  function visit(branch:Branch,dir:string,depth:number){
    for(const [name,child] of branch.children){const p=dir?dir+'/'+name:name;directories.add(p);keys.push('dir:'+p);nodes.push({text:{text:name,style:{fg:palette.secondary}},depth,hasChildren:true});visit(child,p,depth+1);}
    for(const f of branch.files){const p=f.newPath||f.oldPath!;keys.push(f.id);nodes.push({text:{text:`${fileIcon(p)} ${p.split('/').pop()!.replace(/[\r\n]/g,'↵')} ${statusIcon[f.status]} +${f.added??'?'} −${f.deleted??'?'}`,style:{fg:palette.text}},depth,hasChildren:false});}
  }visit(root,'',0);
  return {kind:'col',children:[{kind:'raw',entries:[{text:pending?pending+' '+loadingFrame(phase):'Changed files · '+(diff?.files.length||0),style:{fg:palette.accent}}]},
    {kind:'tree',key:'files',nodes,itemKeys:keys,selectedIndex:Math.max(0,keys.indexOf(selected||'')),expandedKeys:expanded??[...directories].map(p=>'dir:'+p),indentCols:2,toggleOnClick:true},
    {kind:'button',key:'layout',label:'Unified ⇄ Side by side'}, {kind:'button',key:'close',label:'Close · Esc'}]};
}
export function picker(title:string,items:{key:string;label:string;disabled?:boolean}[],selected:number,pending:string,phase:number):unknown {
  return {kind:'col',children:[{kind:'raw',entries:[{text:pending?pending+' '+loadingFrame(phase):title,style:{fg:palette.accent}}]},
    {kind:'list',key:'choices',items:items.map(i=>({text:i.label+(i.disabled?' · unavailable':''),style:{fg:i.disabled?palette.secondary:palette.text}})),itemKeys:items.map(i=>i.key),selectedIndex:selected,visibleRows:12,focused:true},
    {kind:'hintBar',entries:[{keys:'Enter',label:'select'},{keys:'Esc',label:pending?'cancel':'close'}]}]};
}
