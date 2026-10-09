// Bounded read-only checks of ONE existing safe file. Never create/edit an Arc test area.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {validate} from '../lib/model.ts';
const cwd=process.argv[2],dest=process.argv[3];assert(cwd&&dest,'Usage: node --experimental-strip-types live_arc.mjs EXISTING_ARC_ROOT ARTIFACT_DIR');fs.mkdirSync(dest,{recursive:true});
function load(file){return new Function('load','return ('+fs.readFileSync(file,'utf8')+'\n)')(child=>load(path.resolve(path.dirname(file),child)));}
const a=load(path.resolve(import.meta.dirname,'../presets/arc.js'));const revision='47c1d33914b557f98629a64c904871373e60c983',file='.arcignore',rows=[];
function run(kind,op,name){const result=execFileSync(op.command,op.args,{cwd,encoding:'utf8',timeout:15000,maxBuffer:4*1024*1024});fs.writeFileSync(path.join(dest,name+'.stdout'),result);const parsed=validate(kind,op.parse(result));rows.push({name,command:op.command,args:op.args,parsed});return parsed;}
for(const source of ['staged','unstaged','commit']){const op=a.diff({cwd,source,revision});op.args.push(file);run('diff',op,'diff-'+source);}
const parentPatch=execFileSync('arc',['diff','--git','--no-color',revision+'^',revision,file],{cwd,encoding:'utf8',timeout:15000,maxBuffer:4*1024*1024});assert.deepEqual(a.diff({cwd,source:'commit',revision}).parse(parentPatch),rows.find(r=>r.name==='diff-commit').parsed,'Arc show must match explicit first-parent comparison on the safe merge file');
const h=a.history({cwd,limit:1});h.args.push(file);run('history',h,'history');run('blame',a.blame({cwd,path:file}),'blame');
for(const ref of ['HEAD','INDEX','WORKTREE',revision,revision+'^'])run('content',a.content({cwd,path:file,revision:ref}),'content-'+ref.replace(/\^/g,'parent'));
assert.equal(rows.find(r=>r.name==='content-WORKTREE').parsed.text,fs.readFileSync(path.join(cwd,file),'utf8'));
fs.writeFileSync(path.join(dest,'results.json'),JSON.stringify({caption:'Live read-only Arc, exact existing .arcignore; NOT live staged/unstaged fixture or write acceptance.',rows},null,2)+'\n');console.log('PASS readonly Arc .arcignore; operations:',rows.length);
