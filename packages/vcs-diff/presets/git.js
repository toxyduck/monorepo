(() => {
  const patch=load('./patch.js');
  const symlinks=new Set();
  function parsePatch(stdout,before,after){const result=patch(stdout,before,after);if(stdout.trim()&&!result.files.length&&!stdout.includes('* Unmerged path '))throw new Error('Unexpected Git patch output');for(const row of stdout.split('\n'))if(row.startsWith('* Unmerged path ')){const p=row.slice(16);const existing=result.files.find(f=>f.newPath===p);if(existing){existing.status='unmerged';existing.before={path:p,revision:'OURS'};}else result.files.push({id:'unmerged:'+p,oldPath:p,newPath:p,status:'unmerged',added:null,deleted:null,binary:true,before:null,after:null,hunks:[],metadata:['Unmerged index; no stage-0 snapshot']});}for(const f of result.files){if(f.newPath){const mode=f.metadata.find(m=>m.startsWith('new mode')||m.startsWith('new file mode'))||f.metadata.find(m=>m.startsWith('index '))||'';if(mode.endsWith('120000'))symlinks.add(f.newPath);else symlinks.delete(f.newPath);}}return result;}
  const rev=r=>{if(typeof r!=='string'||!r||r.startsWith('-')||/[\0\r\n]/.test(r))throw new Error('Invalid Git revision');return r;};
  return {
    name:'Git',capabilities:{sources:['staged','unstaged','commit'],history:true,content:true,blame:true},
    diff:({source,revision})=>{
      const r=source==='commit'?rev(revision):null;
      const args=['-c','core.quotePath=true','diff','--no-ext-diff','--no-textconv','--no-color','--relative','--find-renames','--src-prefix=a/','--dst-prefix=b/'];
      if(source==='staged')args.push('--cached');if(source==='unstaged')args.push('--ours');
      if(source==='commit')args.splice(2,args.length-2,'show','--format=','--first-parent','-m','--root','--no-ext-diff','--no-textconv','--no-color','--relative','--find-renames','--src-prefix=a/','--dst-prefix=b/',r);
      args.push('--');
      return {command:'git',args,parse:s=>parsePatch(s,source==='unstaged'?'INDEX':source==='staged'?'HEAD':r+'^',source==='unstaged'?'WORKTREE':source==='staged'?'INDEX':r)};
    },
    history:({limit})=>({command:'git',args:['log','--first-parent','-n',String(limit),'--format=%H%x09%h · %s','--'],parse:s=>s.trim()?s.trimEnd().split('\n').map(row=>{const i=row.indexOf('\t');if(i<1)throw new Error('Invalid Git history');return {revision:row.slice(0,i),label:row.slice(i+1)};}):[]}),
    content:({path,revision})=>revision==='WORKTREE'?(symlinks.has(path)?{command:'readlink',args:['--',path],parse:text=>({text:text.replace(/\n$/,'')})}:{command:'cat',args:['--',path],parse:text=>({text})}):{command:'git',args:['show','--no-textconv',revision==='INDEX'?':./'+path:revision==='OURS'?':2:./'+path:rev(revision)+':./'+path],parse:text=>({text})},
    blame:({path})=>({command:'git',args:['blame','--line-porcelain','--',path],parse:s=>{
      const ranges=[];let line=null,sha='',author='',date='';
      for(const row of s.split('\n')){const m=row.match(/^([0-9a-f]{40,64}) \d+ (\d+)(?: \d+)?$/);if(m){sha=m[1];line=Number(m[2])-1;author='';date='';}else if(row.startsWith('author '))author=row.slice(7);else if(row.startsWith('author-time '))date=new Date(Number(row.slice(12))*1000).toISOString().slice(0,10);else if(row.startsWith('\t')){if(line===null)throw new Error('Invalid Git blame');ranges.push({startLine:line,endLine:line+1,label:/^0+$/.test(sha)?'Uncommitted':sha.slice(0,8)+' · '+author+' · '+date});line=null;}}
      return {ranges};
    }})
  };
})()
