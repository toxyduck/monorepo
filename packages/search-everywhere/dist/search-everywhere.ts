(() => {
  var __defProp = Object.defineProperty;
  var __defNormalProp = (obj, key2, value) => key2 in obj ? __defProp(obj, key2, { enumerable: true, configurable: true, writable: true, value }) : obj[key2] = value;
  var __publicField = (obj, key2, value) => __defNormalProp(obj, typeof key2 !== "symbol" ? key2 + "" : key2, value);

  // packages/search-everywhere/lib/model.ts
  function fold(text) {
    return text.replace(/[A-Z]/g, (c) => c.toLowerCase());
  }
  function utf8Length(text) {
    let n = 0;
    for (const c of text) {
      const cp = c.codePointAt(0);
      n += cp < 128 ? 1 : cp < 2048 ? 2 : cp < 65536 ? 3 : 4;
    }
    return n;
  }
  function utf16ToByte(text, offset) {
    if (!Number.isInteger(offset) || offset < 0) return null;
    let b = 0, u = 0;
    for (const c of text) {
      if (u === offset) return b;
      u += c.length;
      if (u > offset || /[\ud800-\udfff]/.test(c) && c.length === 1) return null;
      b += utf8Length(c);
    }
    return u === offset ? b : null;
  }
  function canonicalPath(root, input) {
    if (!root.startsWith("/") || !input || /[\x00-\x1f\x7f\\]/.test(input) || /^[a-zA-Z][\w+.-]*:/.test(input)) return null;
    const clean = (p2) => {
      const parts = [];
      for (const x of p2.split("/")) {
        if (x === "..") parts.pop();
        else if (x && x !== ".") parts.push(x);
      }
      return "/" + parts.join("/");
    };
    const r = clean(root), p = clean(input.startsWith("/") ? input : r + "/" + input);
    return p !== r && p.startsWith(r + "/") ? p : null;
  }
  function normalize(value, root) {
    if (!value || typeof value !== "object") return null;
    const r = value;
    if (!["file", "content"].includes(r.kind) || typeof r.path !== "string" || typeof r.name !== "string" || !r.name || /[\x00-\x1f\x7f]/.test(r.name) || r.path.split("/").some((c) => c === "." || c === "..")) return null;
    const path = canonicalPath(root, r.path);
    if (!path || r.kind === "content" && (!Number.isSafeInteger(r.line) || r.line < 1 || typeof r.snippet !== "string" || utf8Length(r.snippet) > 8192 || r.byte !== void 0 && (!Number.isSafeInteger(r.byte) || r.byte < 0) || r.col !== void 0 && (!Number.isSafeInteger(r.col) || r.col < 1))) return null;
    return { ...r, path, name: path.split("/").pop() };
  }
  function key(r) {
    return r.path;
  }
  function matchRanges(text, query2) {
    if (!query2) return [];
    const t = fold(text), q = fold(query2), i = t.indexOf(q);
    if (i >= 0) return [[i, i + query2.length]];
    return [];
  }
  function validatedRanges(text, ranges) {
    if (!Array.isArray(ranges)) return [];
    return ranges.filter((r) => Array.isArray(r) && r.length === 2 && r[0] < r[1] && r[1] <= text.length && utf16ToByte(text, r[0]) !== null && utf16ToByte(text, r[1]) !== null);
  }
  function previewMatches(r, _query) {
    return validatedRanges(r.snippet || "", r.matches?.snippet);
  }

  // packages/search-everywhere/lib/rank.ts
  var defaultDemotePaths = ["**/build/**", "**/generated/**", "**/.gradle/**"];
  function demoted(path, patterns) {
    return patterns.some((pattern) => {
      const re = pattern.split("**").map((part) => part.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*");
      return new RegExp("^" + re + "$").test(path);
    });
  }
  function quality(text, query2) {
    const t = fold(text), q = fold(query2);
    if (!q || t === q) return 0;
    if (t.startsWith(q)) return 1;
    if (t.includes(q)) return 2;
    return matchRanges(text, query2).length ? 4 : 5;
  }
  function rank(results, query2, patterns, limit) {
    const unique = /* @__PURE__ */ new Map();
    for (const r of results) {
      const prior = unique.get(key(r));
      if (!prior || r.kind === "content" && (prior.kind === "file" || r.line < prior.line))
        unique.set(key(r), { ...r, matches: { name: matchRanges(r.name, query2), snippet: r.matches?.snippet || [] } });
    }
    const score = (r) => Math.min(quality(r.name, query2), r.kind === "content" ? 3 : quality(r.path, query2) + 1);
    return [...unique.values()].sort((a, b) => Number(demoted(a.path, patterns)) - Number(demoted(b.path, patterns)) || score(a) - score(b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).slice(0, limit);
  }

  // packages/search-everywhere/lib/config.ts
  function defaults() {
    return { demotePaths: [...defaultDemotePaths], maxResults: 80, timeoutMs: 15e3 };
  }
  function configure(current, patch) {
    for (const k of Object.keys(patch)) if (!["demotePaths", "maxResults", "timeoutMs"].includes(k)) throw new Error("Unknown setting: " + k);
    const c = { ...current, ...patch };
    if (!Array.isArray(c.demotePaths) || c.demotePaths.length > 32 || c.demotePaths.some((s) => typeof s !== "string" || s.length > 256)) throw new Error("Invalid search paths");
    if (!Number.isInteger(c.maxResults) || c.maxResults < 1 || c.maxResults > 200 || !Number.isInteger(c.timeoutMs) || c.timeoutMs < 100 || c.timeoutMs > 3e4) throw new Error("Invalid search limits");
    return { ...c, demotePaths: [...c.demotePaths] };
  }

  // packages/search-everywhere/lib/query.ts
  function readSettings(editor2) {
    const value = editor2.getPluginConfig();
    if (!value || !["rg", "remote"].includes(value.backend) || !["rg", "remote"].includes(value.arcBackend))
      throw new Error("Configuration error: backend and arcBackend must be rg or remote");
    return { backend: value.backend, arcBackend: value.arcBackend };
  }
  var ownedProcess = null;
  var ownedDeadline = 0;
  var Query = class {
    constructor(editor2, windowId, windowRoot, authority, root, config2, settings) {
      __publicField(this, "notice", "Type a literal query");
      __publicField(this, "identity", "");
      __publicField(this, "source", "");
      __publicField(this, "disposed", false);
      __publicField(this, "token", 0);
      __publicField(this, "process", null);
      __publicField(this, "pending", null);
      __publicField(this, "timer", null);
      __publicField(this, "due", 0);
      __publicField(this, "deadline", 0);
      __publicField(this, "active", null);
      __publicField(this, "editor");
      __publicField(this, "windowId");
      __publicField(this, "windowRoot");
      __publicField(this, "authority");
      __publicField(this, "root");
      __publicField(this, "config");
      __publicField(this, "settings");
      this.editor = editor2;
      this.windowId = windowId;
      this.windowRoot = windowRoot;
      this.authority = authority;
      this.root = root;
      this.config = config2;
      this.settings = settings;
    }
    alive() {
      return !this.disposed && this.editor.activeWindow() === this.windowId && this.editor.getAuthorityLabel() === this.authority && this.editor.listWindows().some((w) => w.id === this.windowId && w.root === this.windowRoot && w.root === this.root);
    }
    cancelQuery() {
      this.token++;
      this.pending = null;
      if (this.timer !== null) this.editor.clearInterval(this.timer);
      this.timer = null;
      if (this.process) void this.process.kill().catch(() => {
      });
    }
    dispose() {
      this.disposed = true;
      this.cancelQuery();
    }
    request(query2, done) {
      this.cancelQuery();
      this.identity = "";
      this.source = "";
      this.notice = "Type a literal query";
      if (!query2) {
        done([], []);
        return;
      }
      if (query2.length > 512 || /[\x00\r\n]/.test(query2) || Array.from(query2).some((c) => c.length === 1 && /[\ud800-\udfff]/.test(c))) {
        done([], [], "Query must be a valid single-line literal, up to 512 UTF-16 units");
        return;
      }
      this.pending = { query: query2, done, token: this.token };
      this.due = Date.now() + 250;
      this.timer = this.editor.setInterval(250, "search_everywhere_query");
    }
    tick() {
      if (!this.alive()) {
        this.dispose();
        return;
      }
      if (this.process) {
        if (Date.now() > this.deadline) {
          void this.process.kill().catch(() => {
          });
          if (this.active && this.active.token === this.token) {
            this.active.done([], [], "Search deadline exceeded; ownership cleanup pending");
            this.token++;
          }
        }
        return;
      }
      if (ownedProcess) {
        if (Date.now() > ownedDeadline && this.pending) {
          void ownedProcess.kill().catch(() => {
          });
          this.pending.done([], [], "Previous search ownership cleanup pending; retry explicitly");
          this.pending = null;
          if (this.timer !== null) this.editor.clearInterval(this.timer);
          this.timer = null;
        }
        return;
      }
      if (!this.pending || Date.now() < this.due) return;
      const request = this.pending;
      this.pending = null;
      this.active = request;
      void this.search(request);
    }
    async run(operation, extra) {
      if (!this.alive() || this.authority || ownedProcess) throw new Error("Search scope closed or busy");
      const settings = this.settings();
      const handle = this.editor.spawnProcess("python3", [
        this.editor.getPluginDir() + "/search_backend.py",
        operation,
        "--root",
        this.root,
        "--authority",
        this.authority,
        "--backend",
        settings.backend,
        "--arc-backend",
        settings.arcBackend,
        "--work-ms",
        String(this.config().timeoutMs),
        ...extra
      ]);
      this.process = ownedProcess = handle;
      this.deadline = ownedDeadline = Date.now() + this.config().timeoutMs + 9e3;
      if (this.timer === null) this.timer = this.editor.setInterval(250, "search_everywhere_query");
      try {
        const result = await handle;
        if (!this.alive()) throw new Error("Search scope closed");
        if (result.stdout.length > 1024 * 1024 || result.stderr.length > 16384) throw new Error("Helper output cap exceeded");
        let reply;
        try {
          reply = JSON.parse(result.stdout);
        } catch {
          throw new Error("Search helper unavailable; install Python 3");
        }
        if (result.exit_code !== 0 || reply.state !== "ok") throw new Error(reply.error || "Search helper failed");
        return reply;
      } finally {
        if (this.process === handle) this.process = null;
        if (ownedProcess === handle) ownedProcess = null;
        if (!this.pending && this.timer !== null) {
          this.editor.clearInterval(this.timer);
          this.timer = null;
        }
      }
    }
    async search(request) {
      try {
        this.notice = "Verifying scope / searching filenames and content";
        const reply = await this.run("query", ["--query=" + request.query]);
        if (!this.alive() || request.token !== this.token) return;
        if (reply.root !== this.root || !reply.identity || !["local", "trunk"].includes(reply.source || "") || !Array.isArray(reply.results))
          throw new Error("Invalid helper scope/results");
        this.identity = reply.identity;
        this.source = reply.source;
        this.notice = "Source: " + this.source;
        const results = reply.results.map((r) => normalize(r, this.root)).filter((r) => !!r);
        if (results.length !== reply.results.length) throw new Error("Invalid helper result record");
        for (const r of results) r.matches = { snippet: matchRanges(r.snippet || "", request.query) };
        request.done(rank(results, request.query, this.config().demotePaths, this.config().maxResults), reply.warnings || []);
      } catch (error) {
        if (this.alive() && request.token === this.token) {
          this.notice = "Search failed";
          request.done([], [], String(error));
        }
      } finally {
        if (this.active === request) this.active = null;
        if (!this.pending && !this.process && this.timer !== null) {
          this.editor.clearInterval(this.timer);
          this.timer = null;
        }
      }
    }
    async validate(r) {
      if (!this.identity || ownedProcess) return false;
      const token = this.token, identity = this.identity;
      const reply = await this.run("validate", ["--path", r.path.slice(this.root.length + 1), "--identity", identity]);
      return this.alive() && token === this.token && identity === this.identity && reply.identity === identity && !!reply.valid;
    }
  };

  // packages/search-everywhere/lib/search.ts
  function initial() {
    return { generation: 0, query: "", pending: 0, errors: [], warnings: [], results: [], selected: null };
  }
  function replaceResults(s, results) {
    s.results = results;
    if (!results.some((r) => key(r) === s.selected)) s.selected = results[0] ? key(results[0]) : null;
  }
  function enterAction(s) {
    return s.results.some((r) => key(r) === s.selected) ? "open" : "wait";
  }

  // packages/_shared/runtime_brand.ts
  var BRAND_PALETTE = {
    accent: "ui.help_key_fg",
    text: "ui.popup_text_fg",
    secondary: "editor.line_number_fg",
    symbol: "syntax.function",
    icon: "syntax.type",
    demoted: "editor.line_number_fg",
    selectedBg: "ui.popup_selection_bg",
    selectedFg: "ui.popup_selection_fg",
    previewRowBg: "editor.current_line_bg",
    matchBg: "search.match_bg",
    code: "editor.fg",
    fileHeaderBg: "editor.current_line_bg",
    toolbarBg: "ui.status_bar_bg",
    addBg: "editor.diff_add_bg",
    removeBg: "editor.diff_remove_bg",
    fillerBg: "editor.current_line_bg",
    divider: "ui.split_separator_fg",
    loadingAccent: "ui.help_key_fg"
  };
  var LOADING_STEP_MS = 180;
  var LOADING_FRAMES = ["\u2022\xB7\xB7", "\xB7\u2022\xB7", "\xB7\xB7\u2022", "\xB7\u2022\xB7"];
  function loadingFrame(phase) {
    const index2 = Math.trunc(phase);
    return LOADING_FRAMES[(index2 % LOADING_FRAMES.length + LOADING_FRAMES.length) % LOADING_FRAMES.length];
  }

  // packages/search-everywhere/lib/ui.ts
  function rich(text, matches = [], grey = false, syntax = []) {
    const inlineOverlays = syntax.map((s) => ({
      start: s.start,
      end: s.end,
      // QuickJS's native bridge maps present undefined values to null; omit absent flags.
      style: {
        fg: s.color,
        ...s.bold === void 0 ? {} : { bold: s.bold },
        ...s.italic === void 0 ? {} : { italic: s.italic }
      },
      unit: "byte"
    }));
    for (const [a, b] of matches) {
      const start = utf16ToByte(text, a), end = utf16ToByte(text, b);
      if (start !== null && end !== null) inlineOverlays.push({ start, end, style: { bold: true, bg: BRAND_PALETTE.matchBg }, unit: "byte" });
    }
    if (grey && !syntax.length) inlineOverlays.push({ start: 0, end: utf8Length(text), style: { fg: BRAND_PALETTE.demoted }, unit: "byte" });
    return { text, inlineOverlays, ...grey ? { style: { fg: BRAND_PALETTE.demoted } } : {} };
  }
  function fileIcon(path) {
    const icons = { kt: "\uE634", kts: "\uE634", ts: "\uE628", tsx: "\uE628", js: "\uE60C", json: "\uE60B", py: "\uE606", rs: "\uE7A8", md: "\uE609", sh: "\uE795", yaml: "\uE615", yml: "\uE615" };
    return icons[path.split(".").pop().toLowerCase()] || "\u{F0219}";
  }
  function resultRow(s, r, patterns, root, width) {
    const active = key(r) === s.selected;
    const basename = r.path.split("/").pop() || r.path;
    const relative = root && r.path.startsWith(root + "/") ? r.path.slice(root.length + 1) : basename;
    const directory = relative.slice(0, relative.length - basename.length);
    let text = active ? "> " : "  ";
    const regions = [], matches = [];
    const append = (value, fg, bold = false, ranges = []) => {
      const prefix = text.length;
      text += value;
      regions.push({
        start: utf8Length(text.substring(0, prefix)),
        end: utf8Length(text),
        color: active ? BRAND_PALETTE.selectedFg : fg,
        bold
      });
      matches.push(...ranges.map(([a, b]) => [prefix + a, prefix + b]));
    };
    append(fileIcon(r.path) + " ", BRAND_PALETTE.icon);
    const identity = basename + (r.kind === "content" ? ":" + r.line : "");
    append(identity, BRAND_PALETTE.text, true, matchRanges(identity, s.query));
    if (r.kind === "content") {
      append(" \xB7 ", BRAND_PALETTE.secondary);
      append(r.snippet || "[no source snippet]", BRAND_PALETTE.text, false, previewMatches(r, s.query));
    }
    if (width >= 48) {
      if (directory) append(" \xB7 " + directory, BRAND_PALETTE.secondary);
      if (r.kind === "file") append(" \xB7 file", BRAND_PALETTE.secondary);
    }
    if (demoted(r.path, patterns)) append(" \xB7 generated", BRAND_PALETTE.secondary);
    const entry = rich(text, matches, false, regions);
    entry.style = active ? { fg: BRAND_PALETTE.selectedFg, bg: BRAND_PALETTE.selectedBg } : { fg: BRAND_PALETTE.text };
    return entry;
  }
  function selectedLocation(s, root, width) {
    const r = s.results.find((r2) => key(r2) === s.selected);
    if (!r) return { text: "", style: { fg: BRAND_PALETTE.secondary } };
    const basename = r.path.split("/").pop() || r.path;
    const relative = root && r.path.startsWith(root + "/") ? r.path.slice(root.length + 1) : basename;
    const coordinates = r.line ? ":" + r.line + (r.col ? ":" + r.col : " (source line)") : "";
    return {
      text: (width < 48 ? basename + coordinates + " \xB7 " : "") + relative + coordinates,
      style: { fg: BRAND_PALETTE.secondary }
    };
  }
  function statusFooter(s, preview2, notice) {
    const safety = [notice, ...preview2.map((p) => p.text), ...s.errors, ...s.warnings.map((w) => "Incomplete: " + w)].filter(Boolean);
    const status = [s.results.length + " results", ...safety].join(" \xB7 ").replace(/[\r\n]/g, " ");
    const footer = rich(status);
    footer.style = { fg: BRAND_PALETTE.text };
    return footer;
  }
  function spec(s, patterns, preview2, notice, root = "", height = 19, phase = 0, width = 52) {
    const items = s.results.map((r) => resultRow(s, r, patterns, root, width));
    const selected = Math.max(0, s.results.findIndex((r) => key(r) === s.selected));
    const tiny = height < 9;
    const hints = { kind: "hintBar", entries: [
      { keys: "\u2191/\u2193", label: width < 48 ? "" : "select" },
      { keys: "Enter", label: width < 48 ? "" : "open" },
      { keys: "Esc", label: width < 48 ? "" : "close" }
    ] };
    const header = rich("Results \xB7 " + s.results.length + (s.pending ? " \xB7 Searching " + loadingFrame(phase) : ""));
    header.style = { fg: BRAND_PALETTE.accent };
    return { kind: "col", children: [
      { kind: "text", key: "query", label: "Query", value: s.query, focused: true, rows: 1, fullWidth: true },
      { kind: "raw", key: "results-status", entries: [header] },
      {
        kind: "list",
        key: "results",
        items,
        itemKeys: s.results.map(key),
        selectedIndex: selected,
        visibleRows: Math.max(1, height - 5),
        focusable: false
      },
      { kind: "raw", key: "selected-location", entries: [selectedLocation(s, root, width)] },
      { kind: "raw", entries: [statusFooter(s, preview2, notice)] },
      tiny ? { kind: "raw", entries: [{ text: " \u2191\u2193 \u21B5 Esc", style: { fg: BRAND_PALETTE.accent } }] } : hints
    ] };
  }

  // packages/search-everywhere/search_everywhere.ts
  var editor = getEditor();
  var PANEL = 73621;
  var MODE = "search-everywhere";
  var WIDTH_PCT = 78;
  var HEIGHT_PCT = 65;
  var config = defaults();
  var session = null;
  var index = null;
  editor.defineConfigEnum("backend", { values: ["rg", "remote"], default: "rg", description: "Verified non-Arc project search provider" });
  editor.defineConfigEnum("arcBackend", { values: ["rg", "remote"], default: "remote", description: "Verified Arc project search provider (trunk)" });
  var namespaceId = 0;
  var pendingDecorations = /* @__PURE__ */ new Map();
  var cleanupTimer = null;
  function ownsWindow(s) {
    return editor.activeWindow() === s.windowId && editor.getAuthorityLabel() === s.authority && editor.listWindows().some((w) => w.id === s.windowId && w.root === s.windowRoot && w.root === s.root);
  }
  function valid(s) {
    return session === s && ownsWindow(s);
  }
  function geometry() {
    const screen = editor.getScreenSize();
    const availableWidth = screen.width - (editor.dockOpen() ? editor.dockCols() : 0);
    const width = Math.min(availableWidth, Math.max(20, Math.floor(availableWidth * WIDTH_PCT / 100))) - 2;
    if (screen.height < 8 || width < 28) return null;
    return { height: Math.max(6, Math.floor(screen.height * HEIGHT_PCT / 100) - 2), width };
  }
  function clearDecorations(s) {
    if (!s.decorated.size) return;
    pendingDecorations.set(s.namespace, s);
    if (editor.getAuthorityLabel() === s.authority) {
      const window = editor.listWindows().find((w) => w.id === s.windowId);
      if (!window || window.root !== s.windowRoot) s.decorated.clear();
      else if (editor.activeWindow() === s.windowId) for (const id of s.decorated) {
        const b = editor.getBufferInfo(id);
        if (b && b.window_id !== s.windowId) continue;
        if (b) {
          editor.clearNamespace(id, s.namespace + ":row");
          editor.clearNamespace(id, s.namespace + ":match");
        }
        s.decorated.delete(id);
      }
    }
    if (!s.decorated.size) pendingDecorations.delete(s.namespace);
    if (pendingDecorations.size && cleanupTimer === null) cleanupTimer = editor.setInterval(100, "search_everywhere_cleanup");
    if (!pendingDecorations.size && cleanupTimer !== null) {
      editor.clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
  }
  function stopLoading(s) {
    if (s.loadingTimer !== null) editor.clearInterval(s.loadingTimer);
    s.loadingTimer = null;
    s.loadingFrame = 0;
    s.loadingNextAt = 0;
  }
  function draw(s) {
    if (!valid(s)) {
      if (session === s) close();
      return;
    }
    const size = geometry();
    if (!size) {
      close();
      editor.setStatus("Too small: search needs 8 rows / 28 content columns");
      return;
    }
    if (s.state.pending && s.loadingTimer === null) {
      s.loadingGeneration = s.state.generation;
      s.loadingNextAt = Date.now() + LOADING_STEP_MS;
      s.loadingTimer = editor.setInterval(LOADING_STEP_MS, "search_everywhere_loading");
    } else if (!s.state.pending) stopLoading(s);
    editor.updateFloatingWidget(PANEL, spec(
      s.state,
      config.demotePaths,
      s.preview,
      index?.notice || "Type a literal query",
      s.root,
      size.height,
      s.loadingFrame,
      size.width
    ));
  }
  function invalidate(s) {
    s.state.generation++;
    s.previewToken++;
    stopLoading(s);
    clearDecorations(s);
    index?.cancelQuery();
  }
  function dismissOwned(s) {
    if (editor.activeWindow() !== s.windowId || editor.getAuthorityLabel() !== s.authority) return;
    const previews = editor.listBuffers().filter((b) => b.window_id === s.windowId && b.is_preview);
    if (s.ownedPreview !== null && previews.length === 1 && previews[0].id === s.ownedPreview && editor.listSplits().some((p) => p.splitId === s.splitId && p.bufferId === s.ownedPreview)) editor.dismissPreview();
    s.ownedPreview = null;
  }
  function close(keep = false) {
    const s = session;
    session = null;
    if (!s) return;
    invalidate(s);
    if (!keep && editor.activeWindow() === s.windowId && editor.getAuthorityLabel() === s.authority) {
      dismissOwned(s);
      if (editor.listSplits().some((p) => p.splitId === s.splitId) && editor.getBufferInfo(s.original.bufferId)) {
        editor.setSplitBuffer(s.splitId, s.original.bufferId);
        editor.setBufferCursor(s.original.bufferId, s.cursor);
        editor.setSplitScroll(s.splitId, s.original.viewport.topByte);
      }
    }
    if (s.mounted && editor.activeWindow() === s.windowId && editor.getAuthorityLabel() === s.authority) {
      s.mounted = false;
      editor.unmountFloatingWidget(PANEL);
    }
    stopIndex();
  }
  function stopIndex() {
    index?.dispose();
    index = null;
  }
  function dirty(s, path) {
    return editor.listBuffers().some((b) => b.window_id === s.windowId && b.modified && canonicalPath(s.root, b.path) === path);
  }
  async function decorate(s, r, id, alive) {
    const safe = () => alive() && s.state.selected === key(r) && !dirty(s, r.path) && editor.getActiveBufferId() === id && editor.getBufferInfo(id)?.path === r.path;
    if (!safe() || r.kind !== "content") return;
    const start = await editor.getLineStartPosition(r.line - 1);
    if (!safe() || start === null) return;
    const end = await editor.getLineEndPosition(r.line - 1);
    if (!safe() || end === null || end < start) return;
    const text = await editor.getBufferText(id, start, Math.min(end, start + 2401));
    if (!safe() || !r.snippet || text.replace(/\r$/, "") !== r.snippet) return;
    s.decorated.add(id);
    editor.addOverlay(id, s.namespace + ":row", start, end, { bg: BRAND_PALETTE.previewRowBg, extendToLineEnd: true });
    for (const [a, b] of previewMatches(r, s.state.query)) {
      const from = utf16ToByte(r.snippet, a), to = utf16ToByte(r.snippet, b);
      if (from !== null && to !== null && start + to <= end)
        editor.addOverlay(id, s.namespace + ":match", start + from, start + to, { bg: BRAND_PALETTE.matchBg, bold: true });
    }
    await editor.flush();
    if (!safe()) clearDecorations(s);
  }
  function preview(s) {
    if (!valid(s)) return;
    const token = ++s.previewToken;
    clearDecorations(s);
    const r = s.state.results.find((r2) => key(r2) === s.state.selected);
    if (!r) {
      dismissOwned(s);
      s.preview = [];
      draw(s);
      return;
    }
    if (dirty(s, r.path)) {
      dismissOwned(s);
      s.preview = [{ text: "Unsaved buffer preserved; saved preview suppressed" }];
      draw(s);
      return;
    }
    if (s.foreignPreview) {
      s.preview = [{ text: "Existing preview preserved; Enter opens selected file" }];
      draw(s);
      return;
    }
    if (s.previewBusy) return;
    s.previewBusy = true;
    void runPreview(s, r, token);
  }
  async function runPreview(s, r, token) {
    const alive = () => valid(s) && token === s.previewToken;
    try {
      await editor.flush();
      if (!alive() || dirty(s, r.path)) return;
      if (editor.listBuffers().some((b) => b.window_id === s.windowId && b.is_preview && b.id !== s.ownedPreview)) {
        s.foreignPreview = true;
        s.preview = [{ text: "Existing preview preserved; Enter opens selected file" }];
        draw(s);
        return;
      }
      const beforeIds = new Set(editor.listBuffers().map((b) => b.id));
      const owner = index;
      if (!owner || !await owner.validate(r) || !alive() || dirty(s, r.path)) {
        if (alive()) {
          s.preview = [{ text: "Selected source unsafe, changed or busy; retry selection" }];
          draw(s);
        }
        return;
      }
      editor.previewFileInSplit(s.splitId, r.path, 1, 1);
      await editor.flush();
      if (!ownsWindow(s)) return;
      const created = editor.listBuffers().find((b) => !beforeIds.has(b.id) && b.window_id === s.windowId && b.path === r.path && b.is_preview);
      const pane = editor.listSplits().find((p) => p.splitId === s.splitId), buffer = pane && editor.getBufferInfo(pane.bufferId);
      if (buffer?.path === r.path && buffer.is_preview) s.ownedPreview = buffer.id;
      if (!alive()) {
        if (ownsWindow(s) && created && !created.modified && !created.splits.length && !editor.listSplits().some((p) => p.bufferId === created.id) && session?.original.bufferId !== created.id)
          editor.closeBuffer(created.id);
        return;
      }
      if (!await owner.validate(r) || !alive()) {
        if (alive()) {
          dismissOwned(s);
          s.preview = [{ text: "Selected source identity changed; preview suppressed" }];
          draw(s);
        }
        return;
      }
      if (dirty(s, r.path)) {
        dismissOwned(s);
        s.preview = [{ text: "Unsaved edits: saved preview suppressed" }];
      } else {
        s.preview = buffer?.path === r.path ? [] : [{ text: "Native file preview failed" }];
        if (buffer?.path === r.path) await decorate(s, r, buffer.id, alive);
      }
      if (alive()) draw(s);
    } catch {
      if (alive()) {
        s.preview = [{ text: "Preview unavailable" }];
        draw(s);
      }
    } finally {
      s.previewBusy = false;
      if (valid(s) && token !== s.previewToken) preview(s);
    }
  }
  function query(s, manual = false) {
    if (!valid(s)) {
      close();
      return;
    }
    invalidate(s);
    s.state.errors = [];
    s.state.warnings = [];
    s.state.pending = s.state.query ? 1 : 0;
    s.state.results = [];
    s.state.selected = null;
    s.preview = [];
    dismissOwned(s);
    const generation = s.state.generation;
    index?.request(s.state.query, (results, warnings, error) => {
      if (!valid(s) || generation !== s.state.generation) return;
      s.state.pending = 0;
      s.state.warnings = warnings;
      s.state.errors = error ? [error] : [];
      replaceResults(s.state, results);
      draw(s);
      preview(s);
    });
    draw(s);
  }
  function open() {
    if (session?.mounted && valid(session)) {
      editor.floatingPanelControl(PANEL, "focus", 0);
      return;
    }
    const size = geometry();
    if (!size) {
      editor.setStatus("Too small: search needs 8 rows / 28 content columns");
      return;
    }
    close();
    const windowId = editor.activeWindow(), window = editor.listWindows().find((w) => w.id === windowId);
    const original = editor.listSplits().find((p) => p.splitId === editor.getActiveSplitId());
    if (!window || !original) return;
    const s = {
      state: initial(),
      windowId,
      splitId: editor.getActiveSplitId(),
      windowRoot: window.root,
      root: window.root,
      authority: editor.getAuthorityLabel(),
      preview: [],
      previewToken: 0,
      previewBusy: false,
      original,
      cursor: editor.getPrimaryCursor()?.position || 0,
      ownedPreview: null,
      foreignPreview: editor.listBuffers().some((b) => b.window_id === windowId && b.is_preview),
      mounted: false,
      loadingTimer: null,
      loadingGeneration: 0,
      loadingFrame: 0,
      loadingNextAt: 0,
      decorated: /* @__PURE__ */ new Set(),
      namespace: "search-everywhere:" + Date.now() + ":" + windowId + ":" + ++namespaceId
    };
    session = s;
    s.mounted = editor.mountFloatingWidget(PANEL, spec(
      s.state,
      config.demotePaths,
      [],
      "Type a literal query",
      s.root,
      size.height,
      0,
      size.width
    ), WIDTH_PCT, HEIGHT_PCT, false, false, "Search Everywhere", true, false, MODE);
    if (!s.mounted) {
      close();
      return;
    }
    if (!index?.alive() || index.windowId !== windowId || index.windowRoot !== window.root) {
      stopIndex();
      index = new Query(editor, windowId, window.root, s.authority, s.root, () => config, () => readSettings(editor));
    }
    query(s, true);
  }
  var opening = false;
  async function enter() {
    if (opening) return;
    opening = true;
    try {
      await openSelected();
    } finally {
      opening = false;
    }
  }
  async function openSelected() {
    const s = session, owner = index;
    if (!s || !owner || !valid(s)) {
      close();
      return;
    }
    if (enterAction(s.state) !== "open") {
      editor.setStatus("Search pending, errored or empty; no location selected");
      return;
    }
    const r = s.state.results.find((r2) => key(r2) === s.state.selected);
    const generation = s.state.generation;
    const alive = () => valid(s) && owner === index && generation === s.state.generation && s.state.selected === key(r);
    try {
      if (!await owner.validate(r) || !alive()) {
        if (alive()) editor.setStatus("Selected source unsafe, changed or busy; retry Enter");
        return;
      }
      const existing = editor.listBuffers().find((b) => b.window_id === s.windowId && canonicalPath(s.root, b.path) === r.path);
      if (existing?.modified) {
        close(true);
        editor.setSplitBuffer(s.splitId, existing.id);
        editor.focusSplit(s.splitId);
        editor.setStatus("Unsaved buffer preserved; saved search location not applied");
        return;
      }
      editor.openFileInSplit(s.splitId, r.path);
      editor.focusSplit(s.splitId);
      await editor.flush();
      if (!alive()) return;
      if (editor.getActiveSplitId() !== s.splitId) {
        editor.setStatus("Selected buffer or split changed; no search cursor applied");
        return;
      }
      const pane = editor.listSplits().find((p) => p.splitId === s.splitId);
      const buffer = pane && editor.getBufferInfo(pane.bufferId);
      if (!buffer || buffer.window_id !== s.windowId || canonicalPath(s.root, buffer.path) !== r.path) {
        editor.setStatus("Native file open failed");
        return;
      }
      const locationOwned = () => alive() && editor.getActiveSplitId() === s.splitId && editor.getActiveBufferId() === buffer.id && editor.listSplits().some((p) => p.splitId === s.splitId && p.bufferId === buffer.id) && editor.getBufferInfo(buffer.id)?.path === r.path && !dirty(s, r.path);
      const safeLocation = () => {
        if (locationOwned()) return true;
        if (alive()) editor.setStatus("Selected buffer or split changed; no search cursor applied");
        return false;
      };
      if (!safeLocation() || !await owner.validate(r) || !safeLocation()) return;
      if (r.kind === "content" && !buffer.modified) {
        if (!safeLocation()) return;
        const start = await editor.getLineStartPosition(r.line - 1);
        if (!safeLocation()) return;
        const end = await editor.getLineEndPosition(r.line - 1);
        if (!safeLocation()) return;
        let offset = null;
        if (start !== null && end !== null && end >= start && end - start <= 8193) {
          const text = (await editor.getBufferText(buffer.id, start, end)).replace(/\r$/, "");
          if (!safeLocation()) return;
          const at = fold(text).indexOf(fold(s.state.query));
          if (text === r.snippet && at >= 0) offset = utf16ToByte(text, at);
        }
        if (!safeLocation() || !await owner.validate(r) || !safeLocation()) return;
        editor.setBufferCursor(buffer.id, offset !== null && start !== null ? start + offset : 0);
        if (offset === null) editor.setStatus("Search source differs from current file; opened beginning");
      }
      if (!safeLocation()) return;
      editor.focusSplit(s.splitId);
      close(true);
    } catch (error) {
      if (alive()) {
        s.state.errors = ["Selected source validation failed: " + String(error)];
        draw(s);
      }
    }
  }
  registerHandler("search_everywhere_open", open);
  registerHandler("search_everywhere_enter", () => {
    void enter();
  });
  registerHandler("search_everywhere_close", () => close());
  registerHandler("search_everywhere_cleanup", () => {
    for (const c of pendingDecorations.values()) clearDecorations(c);
  });
  registerHandler("search_everywhere_loading", () => {
    const s = session;
    if (!s || !valid(s) || !s.state.pending || s.loadingTimer === null || Date.now() < s.loadingNextAt) return;
    s.loadingNextAt = Date.now() + LOADING_STEP_MS;
    s.loadingFrame++;
    draw(s);
  });
  registerHandler("search_everywhere_query", () => {
    if (!index?.alive()) {
      close();
      stopIndex();
      return;
    }
    index.tick();
  });
  registerHandler("search_everywhere_event", (ev) => {
    const s = session;
    if (!s || ev.panel_id !== PANEL || ev.window_id !== s.windowId) return;
    if (!valid(s) || ev.event_type === "cancel") {
      close();
      return;
    }
    if (ev.widget_key === "query" && ev.event_type === "change") {
      s.state.query = String(ev.payload.value || "");
      query(s, true);
    } else if (ev.widget_key === "results" && ["select", "activate"].includes(ev.event_type)) {
      const r = s.state.results[Number(ev.payload.index)];
      if (r && (!ev.payload.key || ev.payload.key === key(r))) {
        s.state.selected = key(r);
        preview(s);
        if (ev.event_type === "activate") void enter();
      }
    }
  });
  registerHandler("search_everywhere_authority", () => {
    close();
    stopIndex();
  });
  registerHandler("search_everywhere_window_closed", (ev) => {
    if (index?.windowId === ev.id) {
      close();
      stopIndex();
    }
  });
  registerHandler("search_everywhere_resize", () => {
    if (session?.mounted && valid(session)) draw(session);
  });
  registerHandler("search_everywhere_config", () => {
    if (session) {
      session.previewToken++;
      session.state.results = [];
      session.preview = [];
      close();
    }
    stopIndex();
    editor.setStatus("Search configuration changed; reopen Search Everywhere");
  });
  for (const [hook, handler] of [
    ["resize", "resize"],
    ["widget_event", "event"],
    ["authority_changed", "authority"],
    ["active_window_changed", "authority"],
    ["window_closed", "window_closed"],
    ["config_changed", "config"]
  ])
    editor.on(hook, "search_everywhere_" + handler);
  editor.defineMode(MODE, [["Enter", "search_everywhere_enter", "shortcut"], ["Escape", "search_everywhere_close", "shortcut"]], true, true, false);
  editor.registerCommand("Search Everywhere", "Literal filename and content search \xB7 configured trunk/local provider", "search_everywhere_open");
  editor.exportPluginApi("search-everywhere", {
    configure(patch) {
      config = configure(config, patch);
      if (session) query(session);
    },
    // Read-only readiness/ownership diagnostics contain no query or source/live text.
    status() {
      const mounted = !!session?.mounted && valid(session);
      return {
        activated: index !== null,
        mounted,
        focus: mounted ? editor.getPanelFocusKey(PANEL) : "",
        notice: index?.notice || "Inactive",
        settings: readSettings(editor),
        root: index?.root || null,
        results: session?.state.results.length || 0,
        pending: session?.state.pending || 0
      };
    }
  });
})();
