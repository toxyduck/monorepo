import {configure, defaults, validateProvider} from "./lib/config.ts";
import type {Config} from "./lib/config.ts";
import {canonicalPath, key, previewMatches, utf16ToByte, type Provider, type SearchResult} from "./lib/model.ts";
import {diskResults, grep, symbolLanguage} from "./lib/providers.ts";
import {rank} from "./lib/rank.ts";
import {cancellation, enterAction, initial, isCurrent, replaceResults, type State} from "./lib/search.ts";
import {spec} from "./lib/ui.ts";
import {BRAND_PALETTE, LOADING_STEP_MS} from "../_shared/runtime_brand.ts";

const editor = getEditor();
const PANEL = 73621, MODE = "search-everywhere";
let config = defaults();
const providers = new Map<string, Provider>();
// Busy remains set until the actual promise settles, including after timeout/cancel.
// LSP has no supported cancel route; never accumulate uncancellable calls per provider.
const busy = new Set<string>();
const queued = new Map<string, () => void>();
interface Session {
  state: State; windowId: number; splitId: number; root: string; authority: string;
  cancel: (() => void)[]; preview: TextPropertyEntry[]; previewToken: number;
  previewBusy: boolean; original: SplitSnapshot; cursor: number; ownedPreview: number | null; foreignPreview: boolean;
  mounted: boolean; jobs: Set<{deadline: number; timeout: () => void}>;
  decorated: Set<number>; namespace: string;
  loadingTimer: number | null; loadingGeneration: number; loadingFrame: number; loadingNextAt: number;
}
let session: Session | null = null;
let timer: number | null = null;
let namespaceId = 0;
type DecorationCleanup = Pick<Session, "windowId" | "root" | "authority" | "decorated" | "namespace">;
const pendingDecorations = new Map<string, DecorationCleanup>();
let cleanupTimer: number | null = null;
function retryDecorations(): void {
  for (const cleanup of pendingDecorations.values()) clearDecorations(cleanup);
  if (!pendingDecorations.size && cleanupTimer !== null) {
    editor.clearInterval(cleanupTimer); cleanupTimer = null;
  }
}
function valid(s: Session): boolean {
  return session === s && editor.activeWindow() === s.windowId &&
    editor.getAuthorityLabel() === s.authority && editor.listWindows().some(w => w.id === s.windowId && w.root === s.root);
}
function height(): number {
  const panes = editor.listSplits();
  return panes.length ? Math.max(...panes.map(p => p.y + p.height)) - Math.min(...panes.map(p => p.y)) : Math.max(1, editor.getScreenSize().height - 2);
}
function clearDecorations(s: DecorationCleanup): void {
  if (!s.decorated.size) return;
  pendingDecorations.set(s.namespace, {windowId: s.windowId, root: s.root, authority: s.authority,
    decorated: s.decorated, namespace: s.namespace});
  // Do not resolve buffer IDs in another authority or window. Keep only cleanup metadata after close.
  if (editor.getAuthorityLabel() === s.authority) {
    const window = editor.listWindows().find(w => w.id === s.windowId);
    if (!window || window.root !== s.root) s.decorated.clear();
    else if (editor.activeWindow() === s.windowId) {
      for (const id of s.decorated) {
        const buffer = editor.getBufferInfo(id);
        if (buffer && buffer.window_id !== s.windowId) continue;
        if (buffer) {
          editor.clearNamespace(id, s.namespace + ":row");
          editor.clearNamespace(id, s.namespace + ":match");
        }
        s.decorated.delete(id);
      }
    }
  }
  if (!s.decorated.size) pendingDecorations.delete(s.namespace);
  if (pendingDecorations.size && cleanupTimer === null)
    cleanupTimer = editor.setInterval(100, "search_everywhere_cleanup");
  if (!pendingDecorations.size && cleanupTimer !== null) {
    editor.clearInterval(cleanupTimer); cleanupTimer = null;
  }
}
async function decorate(s: Session, r: SearchResult, id: number, alive: () => boolean): Promise<void> {
  const safe = () => alive() && s.state.selected === key(r) && !dirty(s, r.path) &&
    editor.getActiveBufferId() === id && editor.getBufferInfo(id)?.path === r.path;
  if (!safe()) return;
  const start = await editor.getLineStartPosition((r.line || 1) - 1);
  if (!safe() || start === null) return;
  const end = await editor.getLineEndPosition((r.line || 1) - 1);
  if (!safe() || end === null || end < start) return;
  // Saved snippets are bounded to 600 UTF-16 units; never read a whole large native line.
  const text = await editor.getBufferText(id, start, Math.min(end, start + 2401));
  if (!safe()) return;
  const line = text.replace(/\r$/, "");
  if (!r.snippet || line.slice(0, 600) !== r.snippet) return;
  s.decorated.add(id);
  editor.addOverlay(id, s.namespace + ":row", start, end, {bg: BRAND_PALETTE.previewRowBg, extendToLineEnd: true});
  for (const [a, b] of previewMatches(r, s.state.query)) {
    const from = utf16ToByte(r.snippet, a), to = utf16ToByte(r.snippet, b);
    if (from !== null && to !== null && start + to <= end)
      editor.addOverlay(id, s.namespace + ":match", start + from, start + to, {bg: BRAND_PALETTE.matchBg, bold: true});
  }
  await editor.flush();
  if (!safe()) clearDecorations(s);
}
function stopLoading(s: Session): void {
  if (s.loadingTimer !== null) editor.clearInterval(s.loadingTimer);
  s.loadingTimer = null; s.loadingFrame = 0; s.loadingNextAt = 0;
}
function syncLoading(s: Session): void {
  if (!s.mounted || !s.state.pending) { stopLoading(s); return; }
  if (s.loadingTimer !== null && s.loadingGeneration === s.state.generation) return;
  stopLoading(s);
  s.loadingGeneration = s.state.generation;
  s.loadingNextAt = Date.now() + LOADING_STEP_MS;
  s.loadingTimer = editor.setInterval(LOADING_STEP_MS, "search_everywhere_loading");
}
function loadingTick(): void {
  const s = session;
  // Native named callbacks may already be queued after clearInterval. The current
  // owner's deadline also prevents an old tick from advancing a newly reset query.
  if (!s || !s.mounted || s.loadingTimer === null || !valid(s) ||
      !s.state.pending || s.loadingGeneration !== s.state.generation) return;
  const now = Date.now();
  if (now < s.loadingNextAt) return;
  s.loadingNextAt = now + LOADING_STEP_MS;
  s.loadingFrame++; draw(s);
}
function draw(s: Session): void {
  if (!valid(s)) { if (session === s) close(); return; }
  syncLoading(s);
  const notice = [...providers.values()].some(p => p.kind === "files") ? "" : "file provider not configured";
  editor.updateFloatingWidget(PANEL, spec(s.state, config.demotePaths, s.preview, notice, s.root, height(), s.loadingFrame));
}
function invalidate(s: Session): void {
  stopLoading(s);
  s.state.generation++;
  for (const cancel of s.cancel) cancel();
  s.cancel = []; s.jobs.clear(); s.previewToken++; clearDecorations(s);
}
function dismissOwned(s: Session): void {
  if (editor.activeWindow() !== s.windowId || editor.getAuthorityLabel() !== s.authority) return;
  const previews = editor.listBuffers().filter(b => b.window_id === s.windowId && b.is_preview);
  if (s.ownedPreview !== null && previews.length === 1 && previews[0].id === s.ownedPreview &&
      editor.listSplits().some(p => p.splitId === s.splitId && p.bufferId === s.ownedPreview)) editor.dismissPreview();
  s.ownedPreview = null;
}
function close(keep = false): void {
  const s = session; session = null;
  if (s) {
    invalidate(s);
    if (!keep && editor.activeWindow() === s.windowId && editor.getAuthorityLabel() === s.authority) {
      dismissOwned(s);
      if (editor.listSplits().some(p => p.splitId === s.splitId) && editor.getBufferInfo(s.original.bufferId)) {
        editor.setSplitBuffer(s.splitId, s.original.bufferId);
        editor.setBufferCursor(s.original.bufferId, s.cursor);
        editor.setSplitScroll(s.splitId, s.original.viewport.topByte);
      }
    }
  }
  if (timer !== null) editor.clearInterval(timer);
  timer = null;
  if (s?.mounted && editor.activeWindow() === s.windowId && editor.getAuthorityLabel() === s.authority) {
    s.mounted = false; editor.unmountFloatingWidget(PANEL);
  }
}
function dirty(s: Session, path: string): boolean {
  return editor.listBuffers().some(b => b.window_id === s.windowId && canonicalPath(s.root, b.path) === canonicalPath(s.root, path) && b.modified);
}
function preview(s: Session): void {
  if (!valid(s)) return;
  const token = ++s.previewToken;
  clearDecorations(s);
  const r = s.state.results.find(r => key(r) === s.state.selected);
  if (!r) { dismissOwned(s); s.preview = []; draw(s); return; }
  if (dirty(s, r.path)) {
    dismissOwned(s); s.preview = [{text: "Unsaved edits: native saved preview/location unavailable"}]; draw(s); return;
  }
  // debt: preserve foreign transient tabs by declining browse; exact preview-state restoration is needed to browse alongside them.
  if (s.foreignPreview) { s.preview = [{text: "Existing preview preserved; Enter opens selected file"}]; draw(s); return; }
  if (s.previewBusy) return;
  s.previewBusy = true;
  const alive = () => valid(s) && token === s.previewToken;
  (async () => {
    // Flush before dispatch: stale callbacks must never open after teardown.
    await editor.flush();
    if (!alive()) return;
    if (dirty(s, r.path)) { dismissOwned(s); s.preview = [{text: "Unsaved edits: preview unavailable"}]; draw(s); return; }
    if (editor.listBuffers().some(b => b.window_id === s.windowId && b.is_preview && b.id !== s.ownedPreview)) {
      s.foreignPreview = true; s.preview = [{text: "Existing preview preserved; Enter opens selected file"}]; draw(s); return;
    }
    const beforeIds = new Set(editor.listBuffers().map(b => b.id));
    editor.previewFileInSplit(s.splitId, r.path, r.line || 1, r.col || 1);
    await editor.flush();
    const created = editor.listBuffers().find(b => !beforeIds.has(b.id) && b.window_id === s.windowId &&
      b.path === r.path && b.is_preview);
    const pane = editor.listSplits().find(p => p.splitId === s.splitId);
    const buffer = pane && editor.getBufferInfo(pane.bufferId);
    if (buffer?.path === r.path && buffer.is_preview) s.ownedPreview = buffer.id;
    if (!alive()) {
      if (session !== s) {
        // Esc may already have restored the pane before ownership was observed.
        // Only dispose the newly created, still-transient orphan; never restore an old layout here.
        if (created && editor.activeWindow() === s.windowId && editor.getAuthorityLabel() === s.authority) {
          const current = editor.getBufferInfo(created.id);
          const selected = session?.state.results.find(v => key(v) === session!.state.selected);
          if (current?.is_preview && !current.modified && !current.splits.length &&
              !editor.listSplits().some(p => p.bufferId === current.id) &&
              session?.original.bufferId !== current.id && selected?.path !== current.path) {
            editor.closeBuffer(current.id);
            await editor.flush();
            const next = session;
            if (next && valid(next)) {
              next.foreignPreview = editor.listBuffers().some(b => b.window_id === next.windowId && b.is_preview && b.id !== next.ownedPreview);
              preview(next);
            }
          }
        }
      }
      return;
    }
    if (dirty(s, r.path)) { dismissOwned(s); s.preview = [{text: "Unsaved edits: preview unavailable"}]; }
    else {
      s.preview = buffer?.path === r.path ? [] : [{text: "Native file preview failed"}];
      if (buffer?.path === r.path) await decorate(s, r, buffer.id, alive);
    }
    if (alive()) draw(s);
  })().catch(e => { if (alive()) { clearDecorations(s); s.preview = [{text: "Preview error: " + String(e)}]; draw(s); } })
    .finally(() => { s.previewBusy = false; if (valid(s) && token !== s.previewToken) preview(s); })
    .catch(e => editor.setStatus(String(e)));
}
function selectedResults(s: Session, results: SearchResult[]): void {
  const before = s.state.selected;
  replaceResults(s.state, rank(results, s.state.query, config.demotePaths, config.maxResults));
  if (results.length > config.maxResults && !s.state.warnings.includes("Display limited after ranking")) s.state.warnings.push("Display limited after ranking");
  draw(s);
  if (before !== s.state.selected) preview(s);
}
function launch(s: Session, p: Provider, merge: SearchResult[], jobKey = JSON.stringify(["provider", p.name])): void {
  const generation = s.state.generation;
  const c = cancellation(s.root, s.windowId, s.state.query, Math.min(800, config.maxResults * 4), message => {
    if (valid(s) && s.state.generation === generation && !c.ctx.cancelled) s.state.warnings.push(p.name + ": " + message);
  });
  s.cancel.push(c.cancel); s.state.pending++;
  let finished = false;
  const job = {deadline: Date.now() + config.timeoutMs, timeout: () => { c.cancel(); finish(undefined, "timeout (cancel requested)"); }};
  s.jobs.add(job);
  function finish(results?: SearchResult[], error?: string): void {
    if (finished) return;
    finished = true; s.jobs.delete(job);
    if (!valid(s) || s.state.generation !== generation) return;
    s.state.pending--;
    if (error) s.state.errors.push(p.name + ": " + error);
    if (results) merge.push(...results);
    selectedResults(s, merge);
  }
  // Keep only the latest queued query while an uncancellable call occupies this provider.
  const start = () => {
    if (!valid(s) || c.ctx.cancelled || s.state.generation !== generation) return;
    busy.add(jobKey);
    // Every detached path is caught; callbacks supplied by init stay real functions.
    Promise.resolve().then(() => p.search(c.ctx.query, c.ctx)).then(async values => {
    if (!isCurrent(s.state, generation, c.ctx) || !valid(s)) return;
    const disk = await diskResults(editor, values, c.ctx);
    if (isCurrent(s.state, generation, c.ctx) && valid(s)) {
      s.state.errors.push(...disk.errors.map(e => p.name + ": " + e));
      s.state.warnings.push(...new Set(disk.warnings.map(w => p.name + ": " + w)));
      finish(disk.results);
    }
  }).catch(e => finish(undefined, String(e))).finally(() => {
    busy.delete(jobKey);
    if (!finished) finish();
    const next = queued.get(jobKey); queued.delete(jobKey); if (next) next();
  }).catch(e => editor.setStatus(String(e)));
  };
  c.ctx.onCancel(() => { if (queued.get(jobKey) === start) queued.delete(jobKey); });
  if (busy.has(jobKey)) queued.set(jobKey, start); else start();
}
function query(s: Session, runGrep = false): void {
  if (!valid(s)) { close(); return; }
  invalidate(s);
  s.state.pending = 0; s.state.errors = []; s.state.warnings = []; s.state.armed = false;
  s.state.results = []; s.state.selected = null; s.preview = []; dismissOwned(s);
  const merge: SearchResult[] = [];
  if (s.state.query.trim()) {
    if (runGrep) {
      const override = [...providers.values()].filter(p => p.kind === "grep");
      // A registered grep function replaces the entire backend, not only its flags.
      const p = override[override.length - 1] || {name: "builtin-grep", kind: "grep" as const, search: (q, ctx) => grep(editor, q, ctx)};
      launch(s, p, merge);
    } else if (s.state.mode === "everywhere") {
      for (const p of providers.values()) if (p.kind === "files" || p.kind === "symbols") launch(s, p, merge);
      if (![...providers.values()].some(p => p.kind === "symbols")) {
        // Explicit languages only: Fresh has no verified project-scoped runtime LSP registry.
        for (const language of new Set(config.symbolLanguages)) {
          launch(s, {name: "builtin-symbols:" + language, kind: "symbols",
            search: (q, ctx) => symbolLanguage(editor, q, ctx, language)}, merge,
            JSON.stringify(["lsp", language]));
        }
      }
    }
  }
  draw(s);
}
function open(): void {
  if (session?.mounted && valid(session)) { editor.floatingPanelControl(PANEL, "focus", 0); return; }
  // debt: no generic dock push/pop API; browse only when the shared native slot is free.
  // Check before teardown: even unmounting an old panel id can affect another window's dock.
  if (editor.dockOpen()) {
    editor.setStatus("Search Everywhere needs a free dock; existing panel preserved"); return;
  }
  close();
  const windowId = editor.activeWindow(), window = editor.listWindows().find(w => w.id === windowId);
  if (!window || !window.root.startsWith("/")) { editor.setStatus("Search Everywhere requires an absolute POSIX project root"); return; }
  const original = editor.listSplits().find(p => p.splitId === editor.getActiveSplitId());
  if (!original) return;
  const s: Session = {state: initial(), windowId, splitId: editor.getActiveSplitId(), root: window.root,
    authority: editor.getAuthorityLabel(), cancel: [], preview: [], previewToken: 0, previewBusy: false,
    original, cursor: editor.getPrimaryCursor()?.position || 0, ownedPreview: null,
    foreignPreview: editor.listBuffers().some(b => b.window_id === windowId && b.is_preview), mounted: false,
    loadingTimer: null, loadingGeneration: 0, loadingFrame: 0, loadingNextAt: 0,
    jobs: new Set(), decorated: new Set(), namespace: "search-everywhere:" + Date.now() + ":" + windowId + ":" + ++namespaceId};
  session = s;
  s.mounted = editor.mountFloatingWidget(PANEL, spec(s.state, config.demotePaths, [], "file provider not configured", s.root, height()),
    38, 100, true, false, "Search Everywhere", true, false, MODE);
  if (!s.mounted) { close(); return; }
  timer = editor.setInterval(100, "search_everywhere_tick"); draw(s);
}
function enter(): void {
  const s = session;
  if (!s || !valid(s)) { close(); return; }
  const action = enterAction(s.state);
  if (action === "open") {
    const r = s.state.results.find(r => key(r) === s.state.selected);
    if (!r) return;
    const modified = dirty(s, r.path);
    // Disk coordinates are unsafe in an already dirty native buffer. Don't silently navigate there.
    if (modified && r.kind !== "file") { s.state.errors.push("Selected file has unsaved edits; save before opening a location"); draw(s); return; }
    close(true);
    if (modified) editor.openFileInSplit(s.splitId, r.path);
    else editor.openFileInSplit(s.splitId, r.path, r.line || 1, r.col || 1);
  } else if (action === "grep") { s.state.mode = "grep"; query(s, true); }
  else { editor.setStatus("Search pending, errored, or empty query; no automatic grep"); draw(s); }
}
registerHandler("search_everywhere_open", open);
registerHandler("search_everywhere_enter", enter);
registerHandler("search_everywhere_close", () => close());
registerHandler("search_everywhere_cleanup", retryDecorations);
registerHandler("search_everywhere_loading", loadingTick);
registerHandler("search_everywhere_tick", () => {
  const s = session;
  if (!s) return;
  if (!valid(s)) { close(); return; }
  const selected = s.state.results.find(r => key(r) === s.state.selected);
  if (selected && dirty(s, selected.path) && !s.preview.length) preview(s);
  for (const job of s.jobs) if (Date.now() >= job.deadline) job.timeout();
});
registerHandler("search_everywhere_event", (ev: HookEventMap["widget_event"]) => {
  const s = session;
  if (!s || ev.panel_id !== PANEL || ev.window_id !== s.windowId) return;
  if (!valid(s) || ev.event_type === "cancel") { close(); return; }
  if (ev.widget_key === "query" && ev.event_type === "change") {
    s.state.query = String(ev.payload.value || "").slice(0, 512); query(s);
  } else if (ev.widget_key === "grep" && ev.event_type === "toggle") {
    s.state.mode = ev.payload.checked ? "grep" : "everywhere"; query(s);
  } else if (ev.widget_key === "results" && ["select", "activate"].includes(ev.event_type)) {
    const r = s.state.results[Number(ev.payload.index)];
    if (r && (!ev.payload.key || ev.payload.key === key(r))) {
      s.state.selected = key(r); s.state.armed = true; preview(s);
      if (ev.event_type === "activate") enter();
    }
  }
});
registerHandler("search_everywhere_authority", close);
registerHandler("search_everywhere_resize", () => { const s = session; if (s?.mounted && valid(s)) draw(s); });
editor.on("resize", "search_everywhere_resize");
editor.on("widget_event", "search_everywhere_event");
editor.on("authority_changed", "search_everywhere_authority");
editor.defineMode(MODE, [["Enter", "search_everywhere_enter", "shortcut"], ["Escape", "search_everywhere_close", "shortcut"]], true, true, false);
editor.registerCommand("Search Everywhere", "Files provider, workspace symbols, and disk grep", "search_everywhere_open");
editor.exportPluginApi("search-everywhere", {
  configure(patch: Partial<Config>) { config = configure(config, patch); if (session) query(session); },
  registerProvider(p: Provider) {
    validateProvider(p); providers.set(p.name, p); if (session) query(session);
    return () => { if (providers.get(p.name) === p) { providers.delete(p.name); if (session) query(session); } };
  }
});
