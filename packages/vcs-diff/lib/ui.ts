import {BRAND_PALETTE as palette, loadingFrame} from '../../_shared/runtime_brand.ts';
import {fileIcon,statusIcon} from '../../_shared/runtime_icons.ts';
import {MAX_TEXT,bytes,type Diff,type Hunk} from './model.ts';
export type RowKind='context'|'deletion'|'addition'|'fileheader'|'metadata';
export interface Row {kind:RowKind;file:string;language:string;stream:number;old:number|null;next:number|null;text:string}
export interface Stream {rows:Row[];anchors:Map<string,number>}
export interface Anchor {file:string;side:0|1;line:number|null}
export interface Presentation {
 entries:{text:string;style?:{fg?:string;bg?:string;bold?:boolean}}[];
 rows:{start:number;end:number;right:number;before:Row|null;after:Row|null}[];
 headers:Map<string,number>;
 regions:{start:number;end:number;language:string;prefix:number;streams:number[]}[];
 backgrounds:{start:number;end:number;bg:string;full:boolean}[];
}
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
// Local source coordinates never include presentation headers or other files.
export function compose(diff:Diff,contents:Map<string,[string,string]>):Stream {
 const rows:Row[]=[],anchors=new Map<string,number>();
 diff.files.forEach((f,index)=>{
  const language=f.newPath||f.oldPath!,base={file:f.id,language,stream:index*2};
  anchors.set(f.id,rows.length);
  rows.push({...base,kind:'fileheader',old:null,next:null,text:fileHeader(f).split('\n')[0].replace(/^FILE /,'')});
  for(const text of f.metadata||[])rows.push({...base,kind:'metadata',old:null,next:null,text});
  if(f.binary)return;
  const lines=(s:string)=>s?s.replace(/\n$/,'').split('\n'):[];
  const [a,b]=(contents.get(f.id)||['','']).map(lines);let x=0,y=0;
  function emit(kind:RowKind){const old=kind==='addition'?null:x++,next=kind==='deletion'?null:y++;rows.push({...base,kind,old,next,text:next===null?a[old!]:b[next]});}
  for(const h of f.hunks){if(h.oldStart+h.oldCount>a.length||h.newStart+h.newCount>b.length)throw new Error('Hunk exceeds snapshot: '+language);
   while(y<h.newStart)emit('context');
   for(const op of h.ops)emit(op==='-'?'deletion':op==='+'?'addition':'context');
  }
  while(y<b.length)emit('context');
 });return {rows,anchors};
}
export function sourceAnchor(p:Presentation,pos:number):Anchor|null {
 let i=0;while(i+1<p.rows.length&&p.rows[i+1].start<=pos)i++;
 const row=p.rows[i];if(!row)return null;
 const side:0|1=pos<row.right?0:1;
 const r=(side===0?row.before:row.after)||(side===0?row.after:row.before);
 if(!r)return null;
 const actual:0|1=r.old===null?1:r.next===null?0:side;
 return {file:r.file,side:actual,line:actual===0?r.old:r.next};
}
export function anchorOffset(p:Presentation,a:Anchor):number {
 if(a.line===null)return p.headers.get(a.file)||0;
 for(const row of p.rows){const r=a.side===0?row.before:row.after;if(r?.file===a.file&&(a.side===0?r.old:r.next)===a.line)return a.side===0?row.start:row.right;}
 return p.headers.get(a.file)||0;
}
// Tabs are expanded in code coordinates; cell clipping counts terminal cells, not UTF-16.
export function codeText(text:string,width:(text:string)=>number):string {
 let result='',col=0;for(const ch of text){if(ch==='\t'){const n=4-col%4;result+=' '.repeat(n);col+=n;}else{result+=ch;col+=width(ch);}}return result;
}
export function fitCell(text:string,cols:number,width:(text:string)=>number):string {
 if(width(text)<=cols)return text+' '.repeat(cols-width(text));
 let result='',used=0;for(const ch of text){const n=width(ch);if(used+n>cols-1)break;result+=ch;used+=n;}
 return result+'…'+' '.repeat(Math.max(0,cols-used-1));
}
export function present(stream:Stream,layout:'unified'|'side-by-side',cols:number,width:(text:string)=>number,comparison:string):Presentation {
 const p:Presentation={entries:[],rows:[],headers:new Map(),regions:[],backgrounds:[]};let offset=0;
 const side=layout==='side-by-side',cell=Math.max(8,Math.floor((cols-3)/2));
 const digits=stream.rows.reduce((n,r)=>Math.max(n,String(Math.max((r.old??-1)+1,(r.next??-1)+1)).length),2);
 const num=(n:number|null)=>n===null?' '.repeat(digits):String(n+1).padStart(digits);
 function span(text:string,style?:Presentation['entries'][number]['style']){const start=offset;offset+=bytes(text);if(offset>MAX_TEXT*4)throw new Error('Viewer rendered text limit exceeded');p.entries.push({text,style});return start;}
 span(comparison+' · '+(side?'Side by side':'Unified')+' · read-only\n',{fg:palette.accent,bg:palette.toolbarBg,bold:true});
 p.backgrounds.push({start:0,end:offset,bg:palette.toolbarBg,full:true});
 for(let i=0;i<stream.rows.length;i++){
  const r=stream.rows[i],start=offset;
  if(r.kind==='fileheader'||r.kind==='metadata'){
   if(r.kind==='fileheader')p.headers.set(r.file,start);
   span((r.kind==='fileheader'?fileIcon(r.language)+' ':'  ')+r.text+'\n',{fg:r.kind==='fileheader'?palette.text:palette.secondary,bg:palette.fileHeaderBg,bold:r.kind==='fileheader'});
   p.backgrounds.push({start,end:offset,bg:palette.fileHeaderBg,full:true});
   p.rows.push({start,end:offset,right:offset,before:r,after:r});
   if(r.kind==='fileheader')span(side?fitCell('BEFORE',cell,width)+' │ '+fitCell('AFTER',cell,width)+'\n':' '+num(null)+' '+num(null)+'   │ CODE\n',{fg:palette.secondary});
   continue;
  }
  let before:Row|null=r.kind==='addition'?null:r,after:Row|null=r.kind==='deletion'?null:r;
  // Pair replacement blocks without independent scrolling or invented counterpart lines.
  if(side&&r.kind==='deletion'){
   let minus=i;while(minus<stream.rows.length&&stream.rows[minus].file===r.file&&stream.rows[minus].kind==='deletion')minus++;
   let plus=minus;while(plus<stream.rows.length&&stream.rows[plus].file===r.file&&stream.rows[plus].kind==='addition')plus++;
   if(plus>minus){
    const count=Math.max(minus-i,plus-minus);
    for(let j=0;j<count;j++)render(stream.rows[i+j]?.kind==='deletion'&&i+j<minus?stream.rows[i+j]:null,j+minus<plus?stream.rows[j+minus]:null);
    i=plus-1;continue;
   }
  }
  render(before,after);
 }
 function render(before:Row|null,after:Row|null){
  const start=offset,r=after||before!;
  const bg=(r:Row|null)=>r?.kind==='deletion'?palette.removeBg:r?.kind==='addition'?palette.addBg:r===null?palette.fillerBg:undefined;
  if(!side){
   const prefix=num(before?.old??null)+' '+num(after?.next??null)+' '+(r.kind==='addition'?'+':r.kind==='deletion'?'−':' ')+' │ ';
   span(prefix,{fg:palette.secondary});span(codeText(r.text,width)+'\n');
   const color=bg(r);if(color)p.backgrounds.push({start,end:offset,bg:color,full:true});
   p.regions.push({start,end:offset,language:r.language,prefix:bytes(prefix),streams:r.kind==='context'?[r.stream,r.stream+1]:[r.stream+(r.kind==='addition'?1:0)]});
   p.rows.push({start,end:offset,right:start+bytes(num(before?.old??null)+' '),before,after});
  }else{
   function code(r:Row|null,n:number|null,op:string){const prefix=num(n)+' '+op+' │ ',text=fitCell(prefix+codeText(r?.text||'',width),cell,width),at=offset;span(text.slice(0,prefix.length),{fg:palette.secondary});span(text.slice(prefix.length),{fg:palette.code});const color=bg(r);if(color)p.backgrounds.push({start:at,end:offset,bg:color,full:false});}
   code(before,before?.old??null,before?.kind==='deletion'?'−':' ');
   span(' │ ',{fg:palette.divider});const right=offset;
   code(after,after?.next??null,after?.kind==='addition'?'+':' ');span('\n');
   p.rows.push({start,end:offset,right,before,after});
  }
 }
 return p;
}
export function tree(diff: Diff|null, selected: string|null, pending: string, phase: number, expanded: string[]|null, comparison=''): unknown {
  const nodes:unknown[]=[],keys:string[]=[],directories=new Set<string>();
  interface Branch {children:Map<string,Branch>;files:Diff['files']}
  const root:Branch={children:new Map(),files:[]};
  for(const f of diff?.files||[]){const parts=(f.newPath||f.oldPath!).split('/');let branch=root;for(const part of parts.slice(0,-1)){if(!branch.children.has(part))branch.children.set(part,{children:new Map(),files:[]});branch=branch.children.get(part)!;}branch.files.push(f);}
  function visit(branch:Branch,dir:string,depth:number){
    for(const [name,child] of branch.children){const p=dir?dir+'/'+name:name;directories.add(p);keys.push('dir:'+p);nodes.push({text:{text:name,style:{fg:palette.secondary}},depth,hasChildren:true});visit(child,p,depth+1);}
    for(const f of branch.files){const p=f.newPath||f.oldPath!;keys.push(f.id);nodes.push({text:{text:`${fileIcon(p)} ${p.split('/').pop()!.replace(/[\r\n]/g,'↵')} ${statusIcon[f.status]} +${f.added??'?'} −${f.deleted??'?'}`,style:{fg:palette.text}},depth,hasChildren:false});}
  }visit(root,'',0);
  return {kind:'col',children:[...(comparison?[{kind:'raw',entries:[{text:comparison+' · read-only',style:{fg:palette.secondary}}]}]:[]),{kind:'raw',entries:[{text:pending?pending+' '+loadingFrame(phase):'Changed files · '+(diff?.files.length||0),style:{fg:palette.accent}}]},
    {kind:'tree',key:'files',nodes,itemKeys:keys,selectedIndex:Math.max(0,keys.indexOf(selected||'')),expandedKeys:expanded??[...directories].map(p=>'dir:'+p),indentCols:2,toggleOnClick:true},
    {kind:'button',key:'layout',label:'Unified ⇄ Side by side'}, {kind:'button',key:'close',label:'Close · Esc'}]};
}
export function picker(title:string,items:{key:string;label:string;disabled?:boolean}[],selected:number,pending:string,phase:number):unknown {
  return {kind:'col',children:[{kind:'raw',entries:[{text:pending?pending+' '+loadingFrame(phase):title,style:{fg:palette.accent}}]},
    {kind:'list',key:'choices',items:items.map(i=>({text:i.label+(i.disabled?' · unavailable':''),style:{fg:i.disabled?palette.secondary:palette.text}})),itemKeys:items.map(i=>i.key),selectedIndex:selected,visibleRows:12,focused:true},
    {kind:'hintBar',entries:[{keys:'Enter',label:'select'},{keys:'Esc',label:pending?'cancel':'close'}]}]};
}
