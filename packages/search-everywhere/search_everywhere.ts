import {configure, defaults} from "./lib/config.ts";
import type {Config} from "./lib/config.ts";
import {canonicalPath, fold, key, previewMatches, utf16ToByte, utf8Length, type SearchResult} from "./lib/model.ts";
import {Query, readSettings} from "./lib/query.ts";
import {enterAction, initial, replaceResults, type State} from "./lib/search.ts";
import {spec} from "./lib/ui.ts";
import {BRAND_PALETTE, LOADING_STEP_MS} from "../_shared/runtime_brand.ts";

const editor = getEditor();
const PANEL = 73621, MODE = "search-everywhere", WIDTH_PCT = 78, HEIGHT_PCT = 65;
let config = defaults();
interface Session {
  state: State; windowId: number; splitId: number; windowRoot: string; root: string; authority: string;
  preview: TextPropertyEntry[]; previewToken: number; previewBusy: boolean;
  original: SplitSnapshot; cursor: number; ownedPreview: number | null; foreignPreview: boolean;
  mounted: boolean; decorated: Set<number>; namespace: string;
  loadingTimer: number | null; loadingGeneration: number; loadingFrame: number; loadingNextAt: number;
}
let session: Session | null = null;
let index: Query | null = null;
editor.defineConfigEnum('backend', {values: ['rg', 'remote'] as const, default: 'rg', description: 'Verified non-Arc project search provider'});
editor.defineConfigEnum('arcBackend', {values: ['rg', 'remote'] as const, default: 'remote', description: 'Verified Arc project search provider (trunk)'});
let namespaceId = 0;
type Cleanup = Pick<Session, "windowId" | "windowRoot" | "authority" | "decorated" | "namespace">;
const pendingDecorations = new Map<string, Cleanup>();
let cleanupTimer: number | null = null;
function ownsWindow(s: Session): boolean {
  return editor.activeWindow() === s.windowId && editor.getAuthorityLabel() === s.authority &&
    editor.listWindows().some(w => w.id === s.windowId && w.root === s.windowRoot && w.root === s.root);
}
function valid(s: Session): boolean { return session === s && ownsWindow(s); }
function geometry(): {height: number; width: number} | null {
  const screen = editor.getScreenSize();
  const availableWidth = screen.width - (editor.dockOpen() ? editor.dockCols() : 0);
  const width = Math.min(availableWidth, Math.max(20, Math.floor(availableWidth * WIDTH_PCT / 100))) - 2;
  if (screen.height < 8 || width < 28) return null;
  return {height: Math.max(6, Math.floor(screen.height * HEIGHT_PCT / 100) - 2), width};
}
function clearDecorations(s: Cleanup): void {
  if (!s.decorated.size) return;
  pendingDecorations.set(s.namespace, s);
  if (editor.getAuthorityLabel() === s.authority) {
    const window = editor.listWindows().find(w => w.id === s.windowId);
    if (!window || window.root !== s.windowRoot) s.decorated.clear();
    else if (editor.activeWindow() === s.windowId) for (const id of s.decorated) {
      const b = editor.getBufferInfo(id);
      if (b && b.window_id !== s.windowId) continue;
      if (b) { editor.clearNamespace(id, s.namespace + ":row"); editor.clearNamespace(id, s.namespace + ":match"); }
      s.decorated.delete(id);
    }
  }
  if (!s.decorated.size) pendingDecorations.delete(s.namespace);
  if (pendingDecorations.size && cleanupTimer === null) cleanupTimer = editor.setInterval(100, "search_everywhere_cleanup");
  if (!pendingDecorations.size && cleanupTimer !== null) { editor.clearInterval(cleanupTimer); cleanupTimer = null; }
}
function stopLoading(s: Session): void {
  if (s.loadingTimer !== null) editor.clearInterval(s.loadingTimer);
  s.loadingTimer = null; s.loadingFrame = 0; s.loadingNextAt = 0;
}
function draw(s: Session): void {
  if (!valid(s)) { if (session === s) close(); return; }
  const size = geometry();
  if (!size) { close(); editor.setStatus("Too small: search needs 8 rows / 28 content columns"); return; }

  if (s.state.pending && s.loadingTimer === null) {
    s.loadingGeneration = s.state.generation; s.loadingNextAt = Date.now() + LOADING_STEP_MS;
    s.loadingTimer = editor.setInterval(LOADING_STEP_MS, "search_everywhere_loading");
  } else if (!s.state.pending) stopLoading(s);
  editor.updateFloatingWidget(PANEL, spec(s.state, config.demotePaths, s.preview, index?.notice || "Type a literal query",
    s.root, size.height, s.loadingFrame, size.width));
}
function invalidate(s: Session): void {
  s.state.generation++; s.previewToken++; stopLoading(s); clearDecorations(s);
  index?.cancelQuery();
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
  if (!s) return;
  invalidate(s);
  if (!keep && editor.activeWindow() === s.windowId && editor.getAuthorityLabel() === s.authority) {
    dismissOwned(s);
    if (editor.listSplits().some(p => p.splitId === s.splitId) && editor.getBufferInfo(s.original.bufferId)) {
      editor.setSplitBuffer(s.splitId, s.original.bufferId); editor.setBufferCursor(s.original.bufferId, s.cursor);
      editor.setSplitScroll(s.splitId, s.original.viewport.topByte);
    }
  }
  if (s.mounted && editor.activeWindow() === s.windowId && editor.getAuthorityLabel() === s.authority) {
    s.mounted = false; editor.unmountFloatingWidget(PANEL);
  }
  stopIndex();
}
function stopIndex(): void {
  index?.dispose(); index = null;

}
function dirty(s: Session, path: string): boolean {
  return editor.listBuffers().some(b => b.window_id === s.windowId && b.modified && canonicalPath(s.root, b.path) === path);
}
async function decorate(s: Session, r: SearchResult, id: number, alive: () => boolean): Promise<void> {
  const safe = () => alive() && s.state.selected === key(r) && !dirty(s, r.path) &&
    editor.getActiveBufferId() === id && editor.getBufferInfo(id)?.path === r.path;
  if (!safe() || r.kind !== "content") return;
  const start = await editor.getLineStartPosition(r.line! - 1);
  if (!safe() || start === null) return;
  const end = await editor.getLineEndPosition(r.line! - 1);
  if (!safe() || end === null || end < start) return;
  const text = await editor.getBufferText(id, start, Math.min(end, start + 2401));
  if (!safe() || !r.snippet || text.replace(/\r$/, "") !== r.snippet) return;
  s.decorated.add(id);
  editor.addOverlay(id, s.namespace + ":row", start, end, {bg: BRAND_PALETTE.previewRowBg, extendToLineEnd: true});
  for (const [a, b] of previewMatches(r, s.state.query)) {
    const from = utf16ToByte(r.snippet, a), to = utf16ToByte(r.snippet, b);
    if (from !== null && to !== null && start + to <= end)
      editor.addOverlay(id, s.namespace + ":match", start + from, start + to, {bg: BRAND_PALETTE.matchBg, bold: true});
  }
  await editor.flush(); if (!safe()) clearDecorations(s);
}
function preview(s: Session): void {
  if (!valid(s)) return;
  const token = ++s.previewToken; clearDecorations(s);
  const r = s.state.results.find(r => key(r) === s.state.selected);
  if (!r) { dismissOwned(s); s.preview = []; draw(s); return; }
  if (dirty(s, r.path)) {
    dismissOwned(s); s.preview = [{text: "Unsaved buffer preserved; saved preview suppressed"}]; draw(s); return;
  }
  if (s.foreignPreview) { s.preview = [{text: "Existing preview preserved; Enter opens selected file"}]; draw(s); return; }
  if (s.previewBusy) return;
  s.previewBusy = true;
  void runPreview(s, r, token);
}
async function runPreview(s: Session, r: SearchResult, token: number): Promise<void> {
  const alive = () => valid(s) && token === s.previewToken;
  try {
    await editor.flush(); if (!alive() || dirty(s, r.path)) return;
    if (editor.listBuffers().some(b => b.window_id === s.windowId && b.is_preview && b.id !== s.ownedPreview)) {
      s.foreignPreview = true; s.preview = [{text: "Existing preview preserved; Enter opens selected file"}]; draw(s); return;
    }
    const beforeIds = new Set(editor.listBuffers().map(b => b.id));
    const owner = index;
    if (!owner || !await owner.validate(r) || !alive() || dirty(s, r.path)) {
      if (alive()) { s.preview = [{text: 'Selected source unsafe, changed or busy; retry selection'}]; draw(s); }
      return;
    }
    editor.previewFileInSplit(s.splitId, r.path, 1, 1);
    await editor.flush();
    // IDs are authority-local. Leave an orphan rather than resolve a foreign owner's ID.
    if (!ownsWindow(s)) return;
    const created = editor.listBuffers().find(b => !beforeIds.has(b.id) && b.window_id === s.windowId && b.path === r.path && b.is_preview);
    const pane = editor.listSplits().find(p => p.splitId === s.splitId), buffer = pane && editor.getBufferInfo(pane.bufferId);
    if (buffer?.path === r.path && buffer.is_preview) s.ownedPreview = buffer.id;
    if (!alive()) {
      if (ownsWindow(s) && created && !created.modified && !created.splits.length && !editor.listSplits().some(p => p.bufferId === created.id) && session?.original.bufferId !== created.id)
        editor.closeBuffer(created.id);
      return;
    }
    if (!await owner.validate(r) || !alive()) {
      if (alive()) { dismissOwned(s); s.preview = [{text: 'Selected source identity changed; preview suppressed'}]; draw(s); }
      return;
    }
    if (dirty(s, r.path)) { dismissOwned(s); s.preview = [{text: "Unsaved edits: saved preview suppressed"}]; }
    else {
      s.preview = buffer?.path === r.path ? [] : [{text: "Native file preview failed"}];
      if (buffer?.path === r.path) await decorate(s, r, buffer.id, alive);
    }
    if (alive()) draw(s);
  } catch { if (alive()) { s.preview = [{text: "Preview unavailable"}]; draw(s); } }
  finally { s.previewBusy = false; if (valid(s) && token !== s.previewToken) preview(s); }
}
function query(s: Session, manual = false): void {
  if (!valid(s)) { close(); return; }
  invalidate(s); s.state.errors = []; s.state.warnings = []; s.state.pending = s.state.query ? 1 : 0;
  s.state.results = []; s.state.selected = null; s.preview = []; dismissOwned(s);
  const generation = s.state.generation;
  index?.request(s.state.query, (results, warnings, error) => {
    if (!valid(s) || generation !== s.state.generation) return;
    s.state.pending = 0; s.state.warnings = warnings; s.state.errors = error ? [error] : [];
    replaceResults(s.state, results); draw(s); preview(s);
  });
  draw(s);
}
function open(): void {
  if (session?.mounted && valid(session)) { editor.floatingPanelControl(PANEL, "focus", 0); return; }
  const size = geometry();
  if (!size) { editor.setStatus("Too small: search needs 8 rows / 28 content columns"); return; }
  close();
  const windowId = editor.activeWindow(), window = editor.listWindows().find(w => w.id === windowId);
  const original = editor.listSplits().find(p => p.splitId === editor.getActiveSplitId());
  if (!window || !original) return;
  const s: Session = {state: initial(), windowId, splitId: editor.getActiveSplitId(), windowRoot: window.root,
    root: window.root, authority: editor.getAuthorityLabel(), preview: [], previewToken: 0, previewBusy: false,
    original, cursor: editor.getPrimaryCursor()?.position || 0, ownedPreview: null,
    foreignPreview: editor.listBuffers().some(b => b.window_id === windowId && b.is_preview), mounted: false,
    loadingTimer: null, loadingGeneration: 0, loadingFrame: 0, loadingNextAt: 0,
    decorated: new Set(), namespace: "search-everywhere:" + Date.now() + ":" + windowId + ":" + ++namespaceId};
  session = s;
  s.mounted = editor.mountFloatingWidget(PANEL, spec(s.state, config.demotePaths, [], "Type a literal query", s.root,
    size.height, 0, size.width), WIDTH_PCT, HEIGHT_PCT, false, false, "Search Everywhere", true, false, MODE);
  if (!s.mounted) { close(); return; }
  // HARD lazy boundary: nothing backend-related starts until the native mount succeeds.
  if (!index?.alive() || index.windowId !== windowId || index.windowRoot !== window.root) {
    stopIndex(); index = new Query(editor, windowId, window.root, s.authority, s.root, () => config, () => readSettings(editor));
  }
  query(s, true);
}
let opening = false;
async function enter(): Promise<void> {
  if (opening) return;
  opening = true;
  try { await openSelected(); } finally { opening = false; }
}
async function openSelected(): Promise<void> {
  const s = session, owner = index;
  if (!s || !owner || !valid(s)) { close(); return; }
  if (enterAction(s.state) !== 'open') { editor.setStatus('Search pending, errored or empty; no location selected'); return; }
  const r = s.state.results.find(r => key(r) === s.state.selected)!;
  const generation = s.state.generation;
  const alive = () => valid(s) && owner === index && generation === s.state.generation && s.state.selected === key(r);
  try {
    if (!await owner.validate(r) || !alive()) {
      if (alive()) editor.setStatus('Selected source unsafe, changed or busy; retry Enter');
      return;
    }
    const existing = editor.listBuffers().find(b => b.window_id === s.windowId && canonicalPath(s.root, b.path) === r.path);
    if (existing?.modified) {
      close(true); editor.setSplitBuffer(s.splitId, existing.id); editor.focusSplit(s.splitId);
      editor.setStatus('Unsaved buffer preserved; saved search location not applied'); return;
    }
    // Native path APIs are not descriptor-pinned: a narrow check-to-open race remains.
    editor.openFileInSplit(s.splitId, r.path);
    editor.focusSplit(s.splitId);
    await editor.flush();
    if (!alive()) return;
    if (editor.getActiveSplitId() !== s.splitId) {
      editor.setStatus('Selected buffer or split changed; no search cursor applied'); return;
    }
    const pane = editor.listSplits().find(p => p.splitId === s.splitId);
    const buffer = pane && editor.getBufferInfo(pane.bufferId);
    if (!buffer || buffer.window_id !== s.windowId || canonicalPath(s.root, buffer.path) !== r.path) {
      editor.setStatus('Native file open failed'); return;
    }
    // Line-position APIs refer to the active buffer, not the explicit getBufferText id.
    const locationOwned = () => alive() && editor.getActiveSplitId() === s.splitId &&
      editor.getActiveBufferId() === buffer.id &&
      editor.listSplits().some(p => p.splitId === s.splitId && p.bufferId === buffer.id) &&
      editor.getBufferInfo(buffer.id)?.path === r.path && !dirty(s, r.path);
    const safeLocation = () => {
      if (locationOwned()) return true;
      if (alive()) editor.setStatus('Selected buffer or split changed; no search cursor applied');
      return false;
    };
    if (!safeLocation() || !await owner.validate(r) || !safeLocation()) return;
    if (r.kind === 'content' && !buffer.modified) {
      if (!safeLocation()) return;
      const start = await editor.getLineStartPosition(r.line! - 1);
      if (!safeLocation()) return;
      const end = await editor.getLineEndPosition(r.line! - 1);
      if (!safeLocation()) return;
      let offset: number | null = null;
      if (start !== null && end !== null && end >= start && end - start <= 8193) {
        const text = (await editor.getBufferText(buffer.id, start, end)).replace(/\r$/, '');
        if (!safeLocation()) return;
        const at = fold(text).indexOf(fold(s.state.query));
        if (text === r.snippet && at >= 0) offset = utf16ToByte(text, at);
      }
      if (!safeLocation() || !await owner.validate(r) || !safeLocation()) return;
      editor.setBufferCursor(buffer.id, offset !== null && start !== null ? start + offset : 0);
      if (offset === null) editor.setStatus('Search source differs from current file; opened beginning');
    }
    if (!safeLocation()) return;
    editor.focusSplit(s.splitId); close(true);
  } catch (error) { if (alive()) { s.state.errors = ['Selected source validation failed: ' + String(error)]; draw(s); } }
}
registerHandler("search_everywhere_open", open);
registerHandler("search_everywhere_enter", () => { void enter(); });
registerHandler("search_everywhere_close", () => close());
registerHandler("search_everywhere_cleanup", () => { for (const c of pendingDecorations.values()) clearDecorations(c); });
registerHandler("search_everywhere_loading", () => {
  const s = session;
  if (!s || !valid(s) || !s.state.pending || s.loadingTimer === null || Date.now() < s.loadingNextAt) return;
  s.loadingNextAt = Date.now() + LOADING_STEP_MS; s.loadingFrame++; draw(s);
});
registerHandler("search_everywhere_query", () => {
  if (!index?.alive()) { close(); stopIndex(); return; }
  index.tick();
});
registerHandler("search_everywhere_event", (ev: HookEventMap["widget_event"]) => {
  const s = session;
  if (!s || ev.panel_id !== PANEL || ev.window_id !== s.windowId) return;
  if (!valid(s) || ev.event_type === "cancel") { close(); return; }
  if (ev.widget_key === "query" && ev.event_type === "change") {
    s.state.query = String(ev.payload.value || ""); query(s, true);
  } else if (ev.widget_key === "results" && ["select", "activate"].includes(ev.event_type)) {
    const r = s.state.results[Number(ev.payload.index)];
    if (r && (!ev.payload.key || ev.payload.key === key(r))) {
      s.state.selected = key(r); preview(s); if (ev.event_type === "activate") void enter();
    }
  }
});
registerHandler("search_everywhere_authority", () => { close(); stopIndex(); });
registerHandler("search_everywhere_window_closed", (ev: HookEventMap["window_closed"]) => {
  if (index?.windowId === ev.id) { close(); stopIndex(); }
});
registerHandler("search_everywhere_resize", () => { if (session?.mounted && valid(session)) draw(session); });
registerHandler('search_everywhere_config', () => {
  if (session) { session.previewToken++; session.state.results = []; session.preview = []; close(); }
  stopIndex(); editor.setStatus('Search configuration changed; reopen Search Everywhere');
});
for (const [hook, handler] of [["resize", "resize"], ["widget_event", "event"], ["authority_changed", "authority"],
  ["active_window_changed", "authority"], ["window_closed", "window_closed"], ['config_changed', 'config']] as const)
  editor.on(hook, "search_everywhere_" + handler);
editor.defineMode(MODE, [["Enter", "search_everywhere_enter", "shortcut"], ["Escape", "search_everywhere_close", "shortcut"]], true, true, false);
editor.registerCommand("Search Everywhere", "Literal filename and content search · configured trunk/local provider", "search_everywhere_open");
editor.exportPluginApi("search-everywhere", {
  configure(patch: Partial<Config>) { config = configure(config, patch); if (session) query(session); },
  // Read-only readiness/ownership diagnostics contain no query or source/live text.
  status() {
    const mounted = !!session?.mounted && valid(session);
    return {activated: index !== null, mounted, focus: mounted ? editor.getPanelFocusKey(PANEL) : "",
      notice: index?.notice || "Inactive", settings: readSettings(editor), root: index?.root || null, results: session?.state.results.length || 0,
      pending: session?.state.pending || 0};
  }
});
