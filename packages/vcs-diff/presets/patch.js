// Trusted expression helper for backends that explicitly request Git patch format.
(() => {
  function decoded(s) {
    if (!s.startsWith('"')) return s;
    let bytes='';const value=s.slice(1,-1);
    for(let i=0;i<value.length;i++) {
      if(value[i]!=='\\'){const c=String.fromCodePoint(value.codePointAt(i));bytes+=encodeURIComponent(c);i+=c.length-1;continue;}
      const oct=value.slice(i+1).match(/^[0-7]{1,3}/);
      if(oct){bytes+='%'+parseInt(oct[0],8).toString(16).padStart(2,'0');i+=oct[0].length;}
      else {const c=value[++i];bytes+=encodeURIComponent(({t:'\t',n:'\n',r:'\r','"':'"','\\':'\\'})[c]||c);}
    }return decodeURIComponent(bytes);
  }
  function prefixed(s,prefix){const p=decoded(s);if(!p.startsWith(prefix))throw new Error('Unexpected patch path prefix: '+p);return p.slice(prefix.length);}
  return (stdout,before,after) => {
    const files=[];let f=null,h=null;
    for(const row of stdout.split('\n')) {
      if(row.startsWith('diff --git ')) {
        const match=row.match(/^diff --git ("(?:\\.|[^"\\])*"|a\/.*?) ("(?:\\.|[^"\\])*"|b\/.*)$/);
        if(!match)throw new Error('Invalid patch file header');
        const oldPath=prefixed(match[1],'a/'),newPath=prefixed(match[2],'b/');
        f={id:String(files.length)+':'+newPath,oldPath,newPath,status:'modified',added:0,deleted:0,binary:false,before:null,after:null,hunks:[],metadata:[]};files.push(f);h=null;
      } else if(f && row.startsWith('@@ ')) {
        const m=row.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);if(!m)throw new Error('Invalid patch hunk');
        const oc=m[2]===undefined?1:Number(m[2]),nc=m[4]===undefined?1:Number(m[4]);
        h={oldStart:oc?Number(m[1])-1:Number(m[1]),oldCount:oc,newStart:nc?Number(m[3])-1:Number(m[3]),newCount:nc,ops:''};f.hunks.push(h);
      } else if(h && /^[ +\-]/.test(row)) {h.ops+=row[0];if(row[0]==='+')f.added++;if(row[0]==='-')f.deleted++;}
      else if(f && !h) {
        if(row.startsWith('--- ')){const p=decoded(row.slice(4).split('\t')[0]);f.oldPath=p==='/dev/null'?null:prefixed(row.slice(4).split('\t')[0],'a/');}
        else if(row.startsWith('+++ ')){const p=decoded(row.slice(4).split('\t')[0]);f.newPath=p==='/dev/null'?null:prefixed(row.slice(4).split('\t')[0],'b/');}
        else if(row.startsWith('rename from ')){f.oldPath=decoded(row.slice(12));f.status='renamed';}
        else if(row.startsWith('rename to '))f.newPath=decoded(row.slice(10));
        else if(row.startsWith('copy from ')){f.oldPath=decoded(row.slice(10));f.status='copied';}
        else if(row.startsWith('copy to '))f.newPath=decoded(row.slice(8));
        else if(row.startsWith('new file mode ')){f.oldPath=null;f.metadata.push(row);}
        else if(row.startsWith('deleted file mode ')){f.newPath=null;f.metadata.push(row);}
        else if(row.startsWith('Binary files ')||row==='GIT binary patch'){f.binary=true;f.added=null;f.deleted=null;}
        else if(/^(old mode|new mode|index|similarity index)/.test(row))f.metadata.push(row);
      }
    }
    for(const x of files){if(x.oldPath===null)x.status='added';else if(x.newPath===null)x.status='deleted';else if(x.metadata.some(m=>m.startsWith('old mode')))x.status='typeChanged';x.before=x.oldPath===null?null:{path:x.oldPath,revision:before};x.after=x.newPath===null?null:{path:x.newPath,revision:after};}
    return {files};
  };
})()
