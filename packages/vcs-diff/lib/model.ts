export type Source = 'staged' | 'unstaged' | 'commit';
export type Ref = {path: string; revision: string | null} | null;
export interface Hunk {oldStart: number; oldCount: number; newStart: number; newCount: number; ops: string}
export interface FileDiff {id: string; oldPath: string | null; newPath: string | null; status: string; added: number | null; deleted: number | null; binary: boolean; before: Ref; after: Ref; hunks: Hunk[]; metadata?: string[]}
export interface Diff {files: FileDiff[]}
export interface Commit {revision: string; label: string}
export interface Content {text: string}
export interface Blame {ranges: {startLine: number; endLine: number; label: string}[]}
export interface Command<T> {command: string; args: string[]; parse(stdout: string): T}
export interface Adapter {name: string; capabilities: {sources: Source[]; history: boolean; content: boolean; blame: boolean}; diff(p: {cwd: string; source: Source; revision: string | null}): Command<Diff>; history?(p: {cwd: string; limit: number}): Command<Commit[]>; content?(p: {cwd: string; path: string; revision: string | null}): Command<Content>; blame?(p: {cwd: string; path: string}): Command<Blame>}
export function bytes(text:string){return unescape(encodeURIComponent(text)).length;}
export const MAX_TEXT = 4 * 1024 * 1024;
export function string(v: unknown, label = 'string'): asserts v is string {if (typeof v !== 'string' || v.includes('\0') || v.length > MAX_TEXT) throw new Error('Invalid ' + label);}
export function path(v: unknown): asserts v is string {string(v, 'path');if (!v || v.length>4096 || v.startsWith('/') || v.includes('\\') || v.split('/').some(x => !x || x === '..' || x === '.') || /^[A-Za-z]:/.test(v)) throw new Error('Unsafe relative path: ' + v);}
function integer(v: unknown) {if (!Number.isSafeInteger(v) || (v as number) < 0) throw new Error('Invalid line/count');}
function array(v: unknown, max: number): asserts v is any[] {if (!Array.isArray(v) || v.length > max) throw new Error('Invalid or excessive result array');}
export function validate(kind: 'diff'|'history'|'content'|'blame', value: any): any {
  if (kind === 'content') {string(value?.text, 'content');return value;}
  if (kind === 'history') {array(value, 200);for (const c of value) {string(c?.revision);string(c?.label);if (c.label.length>512 || !c.revision || /[\r\n]/.test(c.label)) throw new Error('Invalid history');}return value;}
  if (kind === 'blame') {array(value?.ranges, 20000);let end = 0;for (const r of value.ranges) {integer(r.startLine);integer(r.endLine);if (r.endLine <= r.startLine || r.startLine < end) throw new Error('Invalid blame range');string(r.label);if (r.label.length>512 || /[\r\n]/.test(r.label)) throw new Error('Invalid blame label');end = r.endLine;}return value;}
  array(value?.files, 1000);const ids = new Set();let hunks = 0;
  for (const f of value.files) {
    string(f?.id);if (!f.id || ids.has(f.id)) throw new Error('Duplicate/empty file id');ids.add(f.id);
    if (!['added','modified','deleted','renamed','copied','typeChanged','unmerged'].includes(f.status) || typeof f.binary !== 'boolean') throw new Error('Invalid file metadata');
    for (const p of [f.oldPath, f.newPath]) if (p !== null) path(p);
    if (f.oldPath === null && f.newPath === null) throw new Error('Missing paths');
    for (const n of [f.added,f.deleted]) if (n !== null) integer(n);
    for (const ref of [f.before,f.after]) if (ref !== null) {path(ref?.path);if (ref.revision !== null) string(ref.revision);}
    array(f.hunks, 10000);hunks += f.hunks.length;if (hunks > 10000) throw new Error('Too many hunks');
    let oldEnd=0,newEnd=0;
    for (const h of f.hunks) {for (const n of [h.oldStart,h.oldCount,h.newStart,h.newCount]) integer(n);string(h.ops);if (/[^ +\-]/.test(h.ops) || [...h.ops].filter(x=>x!=='+').length!==h.oldCount || [...h.ops].filter(x=>x!=='-').length!==h.newCount || h.oldStart<oldEnd || h.newStart<newEnd) throw new Error('Invalid hunk operations');oldEnd=h.oldStart+h.oldCount;newEnd=h.newStart+h.newCount;}
    if (f.metadata !== undefined) {array(f.metadata, 50);f.metadata.forEach((s: unknown)=>{string(s);if(s.length>4096)throw new Error('Metadata limit exceeded');});}
  }return value;
}
