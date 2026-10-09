(() => {
  const patch=load('./patch.js');
  const symlinks=new Set();
  function parsePatch(stdout,before,after){const result=patch(stdout,before,after);if(stdout.trim()&&!result.files.length&&!/^commit [0-9a-f]+\n/.test(stdout))throw new Error('Unexpected Arc patch output');for(const f of result.files){if(f.newPath){const mode=f.metadata.find(m=>m.startsWith('new mode')||m.startsWith('new file mode'))||f.metadata.find(m=>m.startsWith('index '))||'';if(mode.endsWith('120000'))symlinks.add(f.newPath);else symlinks.delete(f.newPath);}}return result;}
  const rev=r=>{if(typeof r!=='string'||!r||r.startsWith('-')||/[\0\r\n]/.test(r))throw new Error('Invalid Arc revision');return r;};
  return {
    name:'Arc',capabilities:{sources:['staged','unstaged','commit'],history:true,content:true,blame:true},
    diff:({source,revision})=>{
      const r=source==='commit'?rev(revision):null;
      const args=source==='commit'?['show','--git','--no-color','--relative=.',r]:['diff','--git','--no-color','--relative=.',...(source==='staged'?['--cached']:[])];
      return {command:'arc',args,parse:s=>parsePatch(s,source==='unstaged'?'INDEX':source==='staged'?'HEAD':r+'^',source==='unstaged'?'WORKTREE':source==='staged'?'INDEX':r)};
    },
    history:({limit})=>({command:'arc',args:['log','--json','--first-parent','-n',String(limit)],parse:s=>JSON.parse(s).map(c=>({revision:c.commit,label:c.commit.slice(0,8)+' · '+c.message.split('\n')[0]}))}),
    content:({path,revision})=>revision==='WORKTREE'?(symlinks.has(path)?{command:'readlink',args:['--',path],parse:text=>({text:text.replace(/\n$/,'')})}:{command:'cat',args:['--',path],parse:text=>({text})}):{command:'arc',args:['show',revision==='INDEX'?':'+path:rev(revision)+':'+path],parse:text=>({text})},
    blame:({path})=>({command:'arc',args:['blame','--json',path],parse:s=>({ranges:JSON.parse(s).annotation.map(a=>({startLine:a.line-1,endLine:a.line,label:a.commit.slice(0,8)+' · '+a.author+' · '+a.date.slice(0,10)}))})})
  };
})()
