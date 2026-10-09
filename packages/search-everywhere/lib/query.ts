import {normalize, matchRanges, type SearchResult} from './model.ts';
import {rank} from './rank.ts';
import type {Config} from './config.ts';

export interface BackendSettings {backend: 'rg' | 'remote'; arcBackend: 'rg' | 'remote';}
export function readSettings(editor: EditorAPI): BackendSettings {
  const value = editor.getPluginConfig<BackendSettings>();
  if (!value || !['rg', 'remote'].includes(value.backend) || !['rg', 'remote'].includes(value.arcBackend))
    throw new Error('Configuration error: backend and arcBackend must be rg or remote');
  return {backend: value.backend, arcBackend: value.arcBackend};
}
interface Reply {state: string; error?: string; identity?: string; root?: string; source?: string;
  valid?: boolean; results?: unknown[]; warnings?: string[];}
interface Request {query: string; token: number; done: (results: SearchResult[], warnings: string[], error?: string) => void;}
// Ownership survives popup/controller replacement until the old SDK handle settles.
let ownedProcess: ProcessHandle<SpawnResult> | null = null;
let ownedDeadline = 0;
// One foreground helper, one latest pending request. Replacements wait for handle settlement.
export class Query {
  notice = 'Type a literal query'; identity = ''; source = '';
  private disposed = false; private token = 0;
  private process: ProcessHandle<SpawnResult> | null = null;
  private pending: Request | null = null; private timer: number | null = null;
  private due = 0; private deadline = 0; private active: Request | null = null;
  private editor: EditorAPI; readonly windowId: number; readonly windowRoot: string;
  readonly authority: string; readonly root: string; private config: () => Config;
  private settings: () => BackendSettings;
  constructor(editor: EditorAPI, windowId: number, windowRoot: string,
    authority: string, root: string, config: () => Config, settings: () => BackendSettings) {
    this.editor = editor; this.windowId = windowId; this.windowRoot = windowRoot;
    this.authority = authority; this.root = root; this.config = config; this.settings = settings;
  }
  alive(): boolean {
    return !this.disposed && this.editor.activeWindow() === this.windowId &&
      this.editor.getAuthorityLabel() === this.authority &&
      this.editor.listWindows().some(w => w.id === this.windowId && w.root === this.windowRoot && w.root === this.root);
  }
  cancelQuery(): void {
    this.token++; this.pending = null;
    if (this.timer !== null) this.editor.clearInterval(this.timer);
    this.timer = null;
    if (this.process) void this.process.kill().catch(() => {});
  }
  dispose(): void { this.disposed = true; this.cancelQuery(); }
  request(query: string, done: Request['done']): void {
    this.cancelQuery(); this.identity = ''; this.source = ''; this.notice = 'Type a literal query';
    if (!query) { done([], []); return; }
    if (query.length > 512 || /[\x00\r\n]/.test(query) || Array.from(query).some(c => c.length === 1 && /[\ud800-\udfff]/.test(c))) {
      done([], [], 'Query must be a valid single-line literal, up to 512 UTF-16 units'); return;
    }
    this.pending = {query, done, token: this.token}; this.due = Date.now() + 250;
    this.timer = this.editor.setInterval(250, 'search_everywhere_query');
  }
  tick(): void {
    if (!this.alive()) { this.dispose(); return; }
    if (this.process) {
      if (Date.now() > this.deadline) {
        void this.process.kill().catch(() => {});
        if (this.active && this.active.token === this.token) {
          this.active.done([], [], 'Search deadline exceeded; ownership cleanup pending'); this.token++;
        }
      }
      return;
    }
    if (ownedProcess) {
      if (Date.now() > ownedDeadline && this.pending) {
        void ownedProcess.kill().catch(() => {});
        this.pending.done([], [], 'Previous search ownership cleanup pending; retry explicitly');
        this.pending = null;
        if (this.timer !== null) this.editor.clearInterval(this.timer);
        this.timer = null;
      }
      return;
    }
    if (!this.pending || Date.now() < this.due) return;
    const request = this.pending; this.pending = null; this.active = request;
    void this.search(request);
  }
  private async run(operation: string, extra: string[]): Promise<Reply> {
    if (!this.alive() || this.authority || ownedProcess) throw new Error('Search scope closed or busy');
    const settings = this.settings();
    const handle = this.editor.spawnProcess('python3', [this.editor.getPluginDir() + '/search_backend.py', operation,
      '--root', this.root, '--authority', this.authority, '--backend', settings.backend,
      '--arc-backend', settings.arcBackend, '--work-ms', String(this.config().timeoutMs), ...extra]);
    this.process = ownedProcess = handle;
    this.deadline = ownedDeadline = Date.now() + this.config().timeoutMs + 9000;
    if (this.timer === null) this.timer = this.editor.setInterval(250, 'search_everywhere_query');
    try {
      const result = await handle;
      if (!this.alive()) throw new Error('Search scope closed');
      if (result.stdout.length > 1024 * 1024 || result.stderr.length > 16384) throw new Error('Helper output cap exceeded');
      let reply: Reply;
      try { reply = JSON.parse(result.stdout); } catch { throw new Error('Search helper unavailable; install Python 3'); }
      if (result.exit_code !== 0 || reply.state !== 'ok') throw new Error(reply.error || 'Search helper failed');
      return reply;
    } finally {
      if (this.process === handle) this.process = null;
      if (ownedProcess === handle) ownedProcess = null;
      if (!this.pending && this.timer !== null) { this.editor.clearInterval(this.timer); this.timer = null; }
    }
  }
  private async search(request: Request): Promise<void> {
    try {
      this.notice = 'Verifying scope / searching filenames and content';
      const reply = await this.run('query', ['--query=' + request.query]);
      if (!this.alive() || request.token !== this.token) return;
      if (reply.root !== this.root || !reply.identity || !['local', 'trunk'].includes(reply.source || '') || !Array.isArray(reply.results))
        throw new Error('Invalid helper scope/results');
      this.identity = reply.identity; this.source = reply.source!; this.notice = 'Source: ' + this.source;
      const results = reply.results.map(r => normalize(r, this.root)).filter((r): r is SearchResult => !!r);
      if (results.length !== reply.results.length) throw new Error('Invalid helper result record');
      for (const r of results) r.matches = {snippet: matchRanges(r.snippet || '', request.query)};
      request.done(rank(results, request.query, this.config().demotePaths, this.config().maxResults), reply.warnings || []);
    } catch (error) {
      if (this.alive() && request.token === this.token) { this.notice = 'Search failed'; request.done([], [], String(error)); }
    } finally {
      if (this.active === request) this.active = null;
      if (!this.pending && !this.process && this.timer !== null) { this.editor.clearInterval(this.timer); this.timer = null; }
    }
    // No retry. The debounce timer for the latest pending query owns the next invocation.
  }
  async validate(r: SearchResult): Promise<boolean> {
    if (!this.identity || ownedProcess) return false;
    const token = this.token, identity = this.identity;
    const reply = await this.run('validate', ['--path', r.path.slice(this.root.length + 1), '--identity', identity]);
    return this.alive() && token === this.token && identity === this.identity && reply.identity === identity && !!reply.valid;
  }
}
