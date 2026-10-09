import {MAX_TEXT, bytes, string, validate, type Command} from './model.ts';
export interface Job {
  cancelled: boolean;
  cancel(): void;
  run<T>(kind: 'diff'|'history'|'content'|'blame', builder: ()=>Command<T>, cwd: string): Promise<T>;
}
// Fresh foreground kill may return false: GNU timeout owns the child process
// group and bounds its lifetime even after immediate UI cancellation.
let backendBusy = false;
const checkedTimeouts=new Set<string>();
export function job(editor: EditorAPI, timeoutMs=15000, timeoutCommand='timeout'): Job {
  const state: Job = {
    cancelled: false,
    cancel() {
      state.cancelled = true;
      // Do not kill the timeout supervisor: it must survive to signal its group.

    },
    async run(kind,builder,cwd) {
      if (state.cancelled) throw new Error('Cancelled');
      if (backendBusy) throw new Error('Previous adapter process still running; no additional child started');
      string(cwd,'cwd');
      if (!editor.pathIsAbsolute(cwd)) throw new Error('cwd must be absolute');
      const command=builder();
      string(command?.command,'executable');
      if (!command.command || !Array.isArray(command.args) || command.args.length>4096 || typeof command.parse!=='function') throw new Error('Invalid command');
      let argvBytes=0;
      command.args.forEach(a=>{string(a,'argv');argvBytes+=bytes(a);});
      if (argvBytes>MAX_TEXT) throw new Error('argv limit exceeded');
      const window=editor.activeWindow(),authority=editor.getAuthorityLabel();
      if (authority) throw new Error('VCS Diff currently requires a local authority');
      string(timeoutCommand,'GNU timeout executable');if(!timeoutCommand)throw new Error('GNU timeout executable is required');
      if(!checkedTimeouts.has(timeoutCommand)){
        backendBusy=true;
        try {const version=await editor.spawnProcess(timeoutCommand,['--version'],cwd);if(version.exit_code!==0||!/^timeout \(GNU coreutils\) /m.test(version.stdout))throw new Error('Unsupported timeout implementation');checkedTimeouts.add(timeoutCommand);}
        catch(e){throw new Error('GNU coreutils timeout required (set timeoutCommand to timeout/gtimeout): '+String(e));}
        finally{backendBusy=false;}
      }
      if(state.cancelled)throw new Error('Cancelled');
      const token=editor.scratchCreate('vcs-diff-output');
      if (!token) throw new Error('Cannot create output staging');
      const dir=editor.scratchPath(token);
      if (!dir) {editor.scratchDiscard(token);throw new Error('Missing staging path');}
      const output=editor.pathJoin(dir,'stdout');
      let handle:ProcessHandle<SpawnResult>;
      try {handle=editor.spawnProcess(timeoutCommand,['--signal=TERM','--kill-after=1s',(timeoutMs/1000)+'s',command.command,...command.args],cwd,output);}
      catch(e) {editor.scratchDiscard(token);throw e;}
      backendBusy=true;
      let settled=false,stopReason:Error|null=null;
      const started=Date.now();
      // Stdout is sent directly to disk; ONLY a bounded prefix enters JS.
      // debt: disk growth can overshoot polls; hard disk/stderr quota needs
      // native support. Child lifetime is bounded by GNU timeout, not polling.
      const work=(async()=>{
        try {
          const result=await handle;settled=true;
          if (state.cancelled) throw new Error('Cancelled');
          if (stopReason) throw stopReason;
          if (editor.activeWindow()!==window || editor.getAuthorityLabel()!==authority) throw new Error('Context changed');
          if ([124,137].includes(result.exit_code)) throw new Error('Adapter timed out (GNU timeout; backend exited)');
          if (result.exit_code!==0) throw new Error('Adapter failed ('+result.exit_code+'): '+result.stderr.slice(0,600));
          const machine=await editor.openMachine({kind:'window',window});
          let text:string;
          try {
            const [r]=await machine.readFilePrefixes([{path:output,maxBytes:MAX_TEXT+1}]);
            if (r.text===undefined) throw new Error(r.error||'Cannot read adapter output');
            text=r.text;
          } finally {await machine.close();}
          if (bytes(text)>MAX_TEXT) throw new Error('Adapter output limit exceeded');
          return validate(kind,command.parse(text));
        } finally {
          settled=true;backendBusy=false;editor.scratchDiscard(token);
        }
      })();
      const watching=(async()=>{
        while (!settled) {
          if (editor.activeWindow()!==window || editor.getAuthorityLabel()!==authority) state.cancel();
          const stat=editor.fileStat(editor.localPath(output)) as {size?:number}|null;
          const reason=state.cancelled?'Cancelled':Date.now()-started>timeoutMs?'Adapter timed out':stat && typeof stat.size==='number' && stat.size>MAX_TEXT?'Adapter output limit exceeded':null;
          if (reason) {
            stopReason=new Error(reason);
            stopReason=new Error(reason+'; wait/retry after bounded backend exit');
            throw stopReason;
          }
          await editor.delay(40);
        }
        return work;
      })();
      // Both promises have rejection consumers even if a stopped UI no longer
      // waits for the real process. Staging cleanup waits for its actual exit.
      return await Promise.race([work,watching]);
    }
  };
  return state;
}
