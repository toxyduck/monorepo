(() => {
  // packages/search-everywhere/lib/model.ts
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
      if (u > offset) return null;
      const cp = c.codePointAt(0);
      if (cp >= 55296 && cp <= 57343) return null;
      b += cp < 128 ? 1 : cp < 2048 ? 2 : cp < 65536 ? 3 : 4;
    }
    return u === offset ? b : null;
  }
  function canonicalPath(root, input) {
    if (!input || /[\x00-\x1f\x7f]/.test(input)) return null;
    if (input.startsWith("file:")) {
      try {
        const m = /^file:\/\/([^/]*)(\/.*)$/.exec(input);
        if (!m || m[1] && m[1] !== "localhost") return null;
        input = decodeURIComponent(m[2]);
      } catch {
        return null;
      }
    } else if (/^[a-zA-Z][\w+.-]*:/.test(input)) return null;
    if (/[\x00-\x1f\x7f]/.test(input) || input.includes("\\")) return null;
    function clean(p2) {
      const parts = [];
      for (const x of p2.split("/")) {
        if (x === "..") parts.pop();
        else if (x && x !== ".") parts.push(x);
      }
      return "/" + parts.join("/");
    }
    if (!root.startsWith("/")) return null;
    const r = clean(root), p = clean(input.startsWith("/") ? input : r + "/" + input);
    return p !== r && (r === "/" || p.startsWith(r + "/")) ? p : null;
  }
  function normalize(value, root) {
    if (!value || typeof value !== "object") return null;
    const r = value;
    if (!["file", "symbol", "content"].includes(r.kind) || typeof r.path !== "string" || typeof r.name !== "string" || !r.name || r.name.length > 512 || /[\x00-\x1f\x7f]/.test(r.name)) return null;
    const path = canonicalPath(root, r.path);
    if (!path || r.line === void 0 !== (r.col === void 0)) return null;
    if (r.line !== void 0 && (!Number.isSafeInteger(r.line) || r.line < 1 || !Number.isSafeInteger(r.col) || r.col < 1)) return null;
    if (r.kind !== "file" && r.line === void 0) return null;
    return {
      kind: r.kind,
      path,
      name: r.name,
      line: r.line,
      col: r.col,
      ...typeof r.snippet === "string" ? { snippet: r.snippet, matches: r.matches } : {}
    };
  }
  function key(r) {
    return JSON.stringify([r.kind, r.path, r.line || 0, r.col || 0, r.name]);
  }
  function matchRanges(text, query2) {
    if (!query2) return [];
    const i = text.toLowerCase().indexOf(query2.toLowerCase());
    if (i >= 0) return [[i, i + query2.length]];
    let cursor = 0;
    const out = [];
    for (const c of query2.toLowerCase()) {
      const j = text.toLowerCase().indexOf(c, cursor);
      if (j < 0) return [];
      out.push([j, j + c.length]);
      cursor = j + c.length;
    }
    return out;
  }
  function savedLocation(r, text) {
    const lines = text.split("\n");
    const line = lines[(r.line || 1) - 1];
    if (line === void 0 || utf16ToByte(line, (r.col || 1) - 1) === null) return null;
    if (r.kind === "symbol") {
      const start = r.col - 1;
      if (line.slice(start, start + r.name.length) !== r.name || /[\p{L}\p{N}_$]/u.test(line[start - 1] || "") || /[\p{L}\p{N}_$]/u.test(line[start + r.name.length] || "")) return null;
    }
    const saved = line.replace(/\r$/, ""), snippet = saved.slice(0, 600);
    const ranges = r.snippet === saved ? validatedRanges(snippet, r.matches?.snippet) : [];
    return { ...r, snippet, matches: { snippet: ranges } };
  }
  function validatedRanges(text, ranges) {
    if (!Array.isArray(ranges)) return [];
    return ranges.filter((r) => Array.isArray(r) && r.length === 2 && r[0] < r[1] && r[1] <= text.length && utf16ToByte(text, r[0]) !== null && utf16ToByte(text, r[1]) !== null);
  }
  function previewMatches(r, query2) {
    if (r.kind === "content") return validatedRanges(r.snippet || "", r.matches?.snippet);
    const text = r.snippet || "";
    if (!query2) return [];
    const literal = new RegExp(query2.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
    return validatedRanges(text, [...text.matchAll(literal)].map((m) => [m.index, m.index + m[0].length]));
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
    const t = text.toLowerCase(), q = query2.toLowerCase();
    if (!q || t === q) return 0;
    if (t.startsWith(q)) return 1;
    if (t.includes(q)) return 2;
    return matchRanges(text, query2).length ? 3 : 4;
  }
  function rank(results, query2, patterns, limit) {
    const unique = /* @__PURE__ */ new Map();
    for (const r of results) unique.set(key(r), { ...r, matches: {
      name: matchRanges(r.name, query2),
      snippet: r.matches?.snippet || []
    } });
    const kind = { file: 0, symbol: 1, content: 2 };
    return [...unique.values()].sort((a, b) => Number(demoted(a.path, patterns)) - Number(demoted(b.path, patterns)) || quality(a.kind === "content" ? a.snippet || "" : a.name, query2) - quality(b.kind === "content" ? b.snippet || "" : b.name, query2) || kind[a.kind] - kind[b.kind] || key(a).localeCompare(key(b))).slice(0, limit);
  }

  // packages/search-everywhere/lib/config.ts
  function defaults() {
    return { demotePaths: [...defaultDemotePaths], symbolLanguages: ["kotlin"], maxResults: 80, timeoutMs: 5e3 };
  }
  function configure(current, patch) {
    for (const k of Object.keys(patch)) if (!["demotePaths", "symbolLanguages", "maxResults", "timeoutMs"].includes(k)) throw new Error("Unknown setting: " + k);
    const c = { ...current, ...patch };
    if (!Array.isArray(c.demotePaths) || c.demotePaths.length > 32 || c.demotePaths.some((s) => typeof s !== "string" || s.length > 256) || !Array.isArray(c.symbolLanguages) || c.symbolLanguages.length > 8 || c.symbolLanguages.some((s) => typeof s !== "string" || !s)) throw new Error("Invalid search paths/languages");
    if (!Number.isInteger(c.maxResults) || c.maxResults < 1 || c.maxResults > 200 || !Number.isInteger(c.timeoutMs) || c.timeoutMs < 100 || c.timeoutMs > 3e4) throw new Error("Invalid search limits");
    return { ...c, demotePaths: [...c.demotePaths], symbolLanguages: [...c.symbolLanguages] };
  }
  function validateProvider(p) {
    if (!p || typeof p.name !== "string" || !p.name || p.name.length > 128 || !["files", "symbols", "grep"].includes(p.kind) || typeof p.search !== "function") throw new Error("Invalid provider");
  }

  // packages/search-everywhere/lib/providers.ts
  var PREFIX_BYTES = 65536;
  function parseSymbols(value, root, limit) {
    if (!Array.isArray(value)) throw new Error("workspace/symbol did not return an array");
    const out = [];
    for (const s of value.slice(0, limit)) {
      const p = s?.location?.range?.start;
      if (!p || !Number.isInteger(p.line) || !Number.isInteger(p.character) || p.line < 0 || p.character < 0) continue;
      const r = normalize({ kind: "symbol", path: s.location.uri, name: s.name, line: p.line + 1, col: p.character + 1 }, root);
      if (r) out.push(r);
    }
    return out;
  }
  async function symbolLanguage(editor2, query2, ctx, language) {
    if (!query2.trim() || ctx.cancelled) return [];
    const value = await editor2.sendLspRequest(language, "workspace/symbol", { query: query2 });
    if (ctx.cancelled) return [];
    if (Array.isArray(value) && value.length > ctx.maxResults) ctx.warn("LSP candidate cap reached; incomplete coverage");
    return parseSymbols(value, ctx.root, ctx.maxResults);
  }
  async function grep(_editor, query2, ctx) {
    if (!query2.trim() || ctx.cancelled) return [];
    throw new Error("Builtin rg unavailable: bounded process output is not verified; register a bounded grep provider (PARTIAL)");
  }
  async function diskResults(editor2, values, ctx) {
    if (!Array.isArray(values)) throw new Error("Provider must return SearchResult[]");
    const result = { results: [], errors: [], warnings: [] };
    if (values.length > ctx.maxResults) result.warnings.push("Candidate cap " + ctx.maxResults + " reached before ranking; coverage incomplete");
    const candidates = [];
    for (const value of values.slice(0, ctx.maxResults)) {
      const r = normalize(value, ctx.root);
      if (r) candidates.push(r);
      else result.warnings.push("Invalid provider result omitted (path/name/location)");
    }
    const dirty2 = new Set(editor2.listBuffers().filter((b) => b.window_id === ctx.windowId && b.modified).map((b) => b.path));
    const paths = [...new Set(candidates.map((r) => r.path))];
    if (!paths.length || ctx.cancelled) return result;
    const machine = await editor2.openMachine({ kind: "window", window: ctx.windowId });
    try {
      if (ctx.cancelled) return result;
      const prefixes = await machine.readFilePrefixes(paths.map((path) => ({ path, maxBytes: PREFIX_BYTES })));
      if (ctx.cancelled) return result;
      const byPath = new Map(prefixes.map((p) => [p.path, p]));
      const failed = /* @__PURE__ */ new Set();
      for (const r of candidates) {
        if (r.kind === "symbol" && dirty2.has(r.path)) {
          result.warnings.push(r.path + ": dirty-file symbol omitted");
          continue;
        }
        const prefix = byPath.get(r.path);
        if (prefix?.text === void 0) {
          if (!failed.has(r.path)) result.errors.push(r.path + ": " + (prefix?.error || "No disk read result"));
          failed.add(r.path);
          continue;
        }
        const disk = prefix.text, truncated = utf8Length(disk) >= PREFIX_BYTES;
        const bounded = truncated ? disk.slice(0, disk.lastIndexOf("\n") + 1) : disk;
        if (truncated && (r.line || 1) >= bounded.split("\n").length) {
          result.warnings.push(r.path + ":" + r.line + ": location unverified beyond 64 KiB disk prefix (PARTIAL)");
          continue;
        }
        const valid2 = savedLocation(r, bounded);
        if (!valid2) {
          result.warnings.push(r.path + ":" + (r.line || 1) + ": saved position/name not confirmed");
          continue;
        }
        if (bounded.split("\n")[(r.line || 1) - 1].length > 600) result.warnings.push(r.path + ": saved snippet clipped to 600 UTF-16 units");
        result.results.push(valid2);
      }
      return result;
    } finally {
      await machine.close();
    }
  }

  // packages/search-everywhere/lib/search.ts
  function initial() {
    return { generation: 0, query: "", mode: "everywhere", pending: 0, errors: [], warnings: [], results: [], selected: null, armed: false };
  }
  function replaceResults(s, results) {
    s.results = results;
    if (!results.some((r) => key(r) === s.selected)) s.selected = results[0] ? key(results[0]) : null;
  }
  function enterAction(s) {
    if (s.mode === "grep") return s.armed && s.selected ? "open" : s.pending ? "wait" : "grep";
    if (s.selected) return "open";
    return s.pending || s.errors.length || s.warnings.length || !s.query.trim() ? "wait" : "grep";
  }
  function cancellation(root, windowId, query2, maxResults, warn = () => {
  }, reportCancelError = () => {
  }) {
    let cancelled = false;
    const handlers = /* @__PURE__ */ new Set();
    function invoke(fn) {
      try {
        fn();
      } catch (error) {
        try {
          reportCancelError(error);
        } catch {
        }
      }
    }
    return {
      ctx: {
        root,
        windowId,
        query: query2,
        maxResults,
        warn,
        get cancelled() {
          return cancelled;
        },
        onCancel(fn) {
          if (cancelled) invoke(fn);
          else handlers.add(fn);
          return () => handlers.delete(fn);
        }
      },
      cancel() {
        if (cancelled) return;
        cancelled = true;
        const callbacks = [...handlers];
        handlers.clear();
        for (const fn of callbacks) invoke(fn);
      }
    };
  }
  function isCurrent(s, generation, ctx) {
    return s.generation === generation && !ctx.cancelled;
  }

  // packages/_shared/runtime_icons.ts
  function fileIcon(path) {
    const icons = { kt: "\uE634", kts: "\uE634", ts: "\uE628", tsx: "\uE628", js: "\uE60C", json: "\uE60B", py: "\uE606", rs: "\uE7A8", md: "\uE609", sh: "\uE795", yaml: "\uE615", yml: "\uE615" };
    return icons[path.split(".").pop().toLowerCase()] || "\u{F0219}";
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
    loadingAccent: "ui.help_key_fg"
  };
  var LOADING_STEP_MS = 180;
  var LOADING_FRAMES = ["\u2022\xB7\xB7", "\xB7\u2022\xB7", "\xB7\xB7\u2022", "\xB7\u2022\xB7"];
  function loadingFrame(phase) {
    const index = Math.trunc(phase);
    return LOADING_FRAMES[(index % LOADING_FRAMES.length + LOADING_FRAMES.length) % LOADING_FRAMES.length];
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
    if (r.kind === "symbol") {
      append(r.name, BRAND_PALETTE.symbol, true, matchRanges(r.name, s.query));
      append(" \xB7 ", BRAND_PALETTE.secondary);
    }
    const identity = basename + ":" + (r.line || 1);
    append(identity, BRAND_PALETTE.text, true, matchRanges(identity, s.query));
    if (r.kind === "content") {
      append(" \xB7 ", BRAND_PALETTE.secondary);
      append(r.snippet || "[no saved snippet]", BRAND_PALETTE.text, false, previewMatches(r, s.query));
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
    const coordinates = ":" + (r.line || 1) + ":" + (r.col || 1);
    return {
      text: (width < 48 ? basename + coordinates + " \xB7 " : "") + relative + coordinates,
      style: { fg: BRAND_PALETTE.secondary }
    };
  }
  function statusFooter(s, preview2, notice) {
    const safety = [notice, ...preview2.map((p) => p.text), ...s.errors, ...s.warnings.map((w) => "Incomplete: " + w)].filter(Boolean);
    const status = [...safety, s.results.length + " results"].join(" \xB7 ").replace(/[\r\n]/g, " ");
    const footer = rich(status);
    footer.style = { fg: BRAND_PALETTE.text };
    return footer;
  }
  function spec(s, patterns, preview2, notice, root = "", height2 = 19, phase = 0, width = 52) {
    const items = s.results.map((r) => resultRow(s, r, patterns, root, width));
    const selected = Math.max(0, s.results.findIndex((r) => key(r) === s.selected));
    const tiny = height2 < 9;
    const grep2 = { kind: "toggle", key: "grep", label: "Grep", checked: s.mode === "grep", focused: false };
    const hints = { kind: "hintBar", entries: [
      { keys: "\u2191/\u2193", label: width < 48 ? "" : "select" },
      { keys: "Tab", label: width < 48 ? "" : "Grep" },
      { keys: "Enter", label: width < 48 ? "" : s.mode === "grep" && !s.armed ? "run grep" : "open" },
      { keys: "Esc", label: width < 48 ? "" : "close" }
    ] };
    const header = rich("Results \xB7 " + s.results.length + (s.pending ? " \xB7 Searching " + loadingFrame(phase) : ""));
    header.style = { fg: BRAND_PALETTE.accent };
    return { kind: "col", children: [
      { kind: "text", key: "query", label: "Query", value: s.query, focused: true, rows: 1, fullWidth: true },
      ...!tiny ? [grep2] : [],
      { kind: "raw", key: "results-status", entries: [header] },
      {
        kind: "list",
        key: "results",
        items,
        itemKeys: s.results.map(key),
        selectedIndex: selected,
        visibleRows: Math.max(1, height2 - (tiny ? 5 : 6)),
        focusable: false
      },
      { kind: "raw", key: "selected-location", entries: [selectedLocation(s, root, width)] },
      { kind: "raw", entries: [statusFooter(s, preview2, notice)] },
      tiny ? { kind: "row", wrap: false, children: [grep2, width < 48 ? { kind: "raw", entries: [{ text: " \u2191\u2193 Tab \u21B5 Esc", style: { fg: BRAND_PALETTE.accent } }] } : hints] } : hints
    ] };
  }

  // packages/search-everywhere/search_everywhere.ts
  var editor = getEditor();
  var PANEL = 73621;
  var MODE = "search-everywhere";
  var config = defaults();
  var providers = /* @__PURE__ */ new Map();
  var busy = /* @__PURE__ */ new Set();
  var queued = /* @__PURE__ */ new Map();
  var session = null;
  var timer = null;
  var namespaceId = 0;
  var pendingDecorations = /* @__PURE__ */ new Map();
  var cleanupTimer = null;
  function retryDecorations() {
    for (const cleanup of pendingDecorations.values()) clearDecorations(cleanup);
    if (!pendingDecorations.size && cleanupTimer !== null) {
      editor.clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
  }
  function valid(s) {
    return session === s && editor.activeWindow() === s.windowId && editor.getAuthorityLabel() === s.authority && editor.listWindows().some((w) => w.id === s.windowId && w.root === s.root);
  }
  function height() {
    const panes = editor.listSplits();
    return panes.length ? Math.max(...panes.map((p) => p.y + p.height)) - Math.min(...panes.map((p) => p.y)) : Math.max(1, editor.getScreenSize().height - 2);
  }
  function clearDecorations(s) {
    if (!s.decorated.size) return;
    pendingDecorations.set(s.namespace, {
      windowId: s.windowId,
      root: s.root,
      authority: s.authority,
      decorated: s.decorated,
      namespace: s.namespace
    });
    if (editor.getAuthorityLabel() === s.authority) {
      const window = editor.listWindows().find((w) => w.id === s.windowId);
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
      editor.clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
  }
  async function decorate(s, r, id, alive) {
    const safe = () => alive() && s.state.selected === key(r) && !dirty(s, r.path) && editor.getActiveBufferId() === id && editor.getBufferInfo(id)?.path === r.path;
    if (!safe()) return;
    const start = await editor.getLineStartPosition((r.line || 1) - 1);
    if (!safe() || start === null) return;
    const end = await editor.getLineEndPosition((r.line || 1) - 1);
    if (!safe() || end === null || end < start) return;
    const text = await editor.getBufferText(id, start, Math.min(end, start + 2401));
    if (!safe()) return;
    const line = text.replace(/\r$/, "");
    if (!r.snippet || line.slice(0, 600) !== r.snippet) return;
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
  function stopLoading(s) {
    if (s.loadingTimer !== null) editor.clearInterval(s.loadingTimer);
    s.loadingTimer = null;
    s.loadingFrame = 0;
    s.loadingNextAt = 0;
  }
  function syncLoading(s) {
    if (!s.mounted || !s.state.pending) {
      stopLoading(s);
      return;
    }
    if (s.loadingTimer !== null && s.loadingGeneration === s.state.generation) return;
    stopLoading(s);
    s.loadingGeneration = s.state.generation;
    s.loadingNextAt = Date.now() + LOADING_STEP_MS;
    s.loadingTimer = editor.setInterval(LOADING_STEP_MS, "search_everywhere_loading");
  }
  function loadingTick() {
    const s = session;
    if (!s || !s.mounted || s.loadingTimer === null || !valid(s) || !s.state.pending || s.loadingGeneration !== s.state.generation) return;
    const now = Date.now();
    if (now < s.loadingNextAt) return;
    s.loadingNextAt = now + LOADING_STEP_MS;
    s.loadingFrame++;
    draw(s);
  }
  function draw(s) {
    if (!valid(s)) {
      if (session === s) close();
      return;
    }
    syncLoading(s);
    const notice = [...providers.values()].some((p) => p.kind === "files") ? "" : "file provider not configured";
    editor.updateFloatingWidget(PANEL, spec(s.state, config.demotePaths, s.preview, notice, s.root, height(), s.loadingFrame, editor.dockCols()));
  }
  function invalidate(s) {
    stopLoading(s);
    s.state.generation++;
    for (const cancel of s.cancel) cancel();
    s.cancel = [];
    s.jobs.clear();
    s.previewToken++;
    clearDecorations(s);
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
    if (s) {
      invalidate(s);
      if (!keep && editor.activeWindow() === s.windowId && editor.getAuthorityLabel() === s.authority) {
        dismissOwned(s);
        if (editor.listSplits().some((p) => p.splitId === s.splitId) && editor.getBufferInfo(s.original.bufferId)) {
          editor.setSplitBuffer(s.splitId, s.original.bufferId);
          editor.setBufferCursor(s.original.bufferId, s.cursor);
          editor.setSplitScroll(s.splitId, s.original.viewport.topByte);
        }
      }
    }
    if (timer !== null) editor.clearInterval(timer);
    timer = null;
    if (s?.mounted && editor.activeWindow() === s.windowId && editor.getAuthorityLabel() === s.authority) {
      s.mounted = false;
      editor.unmountFloatingWidget(PANEL);
    }
  }
  function dirty(s, path) {
    return editor.listBuffers().some((b) => b.window_id === s.windowId && canonicalPath(s.root, b.path) === canonicalPath(s.root, path) && b.modified);
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
      s.preview = [{ text: "Unsaved edits: native saved preview/location unavailable" }];
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
    runPreview(s, r, token).catch((e) => editor.setStatus(String(e)));
  }
  async function disposeOrphanPreview(s, created) {
    if (!created || editor.activeWindow() !== s.windowId || editor.getAuthorityLabel() !== s.authority) return;
    const current = editor.getBufferInfo(created.id);
    const replacement = session;
    const selected = replacement && replacement.state.results.find((v) => key(v) === replacement.state.selected);
    if (!current?.is_preview || current.modified || current.splits.length || editor.listSplits().some((p) => p.bufferId === current.id) || replacement?.original.bufferId === current.id || selected?.path === current.path) return;
    editor.closeBuffer(current.id);
    await editor.flush();
    const next = session;
    if (next && valid(next)) {
      next.foreignPreview = editor.listBuffers().some((b) => b.window_id === next.windowId && b.is_preview && b.id !== next.ownedPreview);
      preview(next);
    }
  }
  async function runPreview(s, r, token) {
    const alive = () => valid(s) && token === s.previewToken;
    try {
      await editor.flush();
      if (!alive()) return;
      if (dirty(s, r.path)) {
        dismissOwned(s);
        s.preview = [{ text: "Unsaved edits: preview unavailable" }];
        draw(s);
        return;
      }
      if (editor.listBuffers().some((b) => b.window_id === s.windowId && b.is_preview && b.id !== s.ownedPreview)) {
        s.foreignPreview = true;
        s.preview = [{ text: "Existing preview preserved; Enter opens selected file" }];
        draw(s);
        return;
      }
      const beforeIds = new Set(editor.listBuffers().map((b) => b.id));
      editor.previewFileInSplit(s.splitId, r.path, r.line || 1, r.col || 1);
      await editor.flush();
      const created = editor.listBuffers().find((b) => !beforeIds.has(b.id) && b.window_id === s.windowId && b.path === r.path && b.is_preview);
      const pane = editor.listSplits().find((p) => p.splitId === s.splitId);
      const buffer = pane && editor.getBufferInfo(pane.bufferId);
      if (buffer?.path === r.path && buffer.is_preview) s.ownedPreview = buffer.id;
      if (!alive()) {
        if (session !== s) await disposeOrphanPreview(s, created);
        return;
      }
      if (dirty(s, r.path)) {
        dismissOwned(s);
        s.preview = [{ text: "Unsaved edits: preview unavailable" }];
      } else {
        s.preview = buffer?.path === r.path ? [] : [{ text: "Native file preview failed" }];
        if (buffer?.path === r.path) await decorate(s, r, buffer.id, alive);
      }
      if (alive()) draw(s);
    } catch (error) {
      if (alive()) {
        clearDecorations(s);
        s.preview = [{ text: "Preview error: " + String(error) }];
        draw(s);
      }
    } finally {
      s.previewBusy = false;
      if (valid(s) && token !== s.previewToken) preview(s);
    }
  }
  function selectedResults(s, results) {
    const before = s.state.selected;
    replaceResults(s.state, rank(results, s.state.query, config.demotePaths, config.maxResults));
    if (results.length > config.maxResults && !s.state.warnings.includes("Display limited after ranking")) s.state.warnings.push("Display limited after ranking");
    draw(s);
    if (before !== s.state.selected) preview(s);
  }
  function launch(s, p, merge, jobKey = JSON.stringify(["provider", p.name])) {
    const generation = s.state.generation;
    const c = cancellation(s.root, s.windowId, s.state.query, Math.min(800, config.maxResults * 4), (message) => {
      if (valid(s) && s.state.generation === generation && !c.ctx.cancelled) s.state.warnings.push(p.name + ": " + message);
    }, (error) => editor.setStatus(p.name + ": cancellation callback failed: " + String(error)));
    s.cancel.push(c.cancel);
    s.state.pending++;
    let finished = false;
    const job = { deadline: Date.now() + config.timeoutMs, timeout: () => {
      c.cancel();
      finish(void 0, "timeout (cancel requested)");
    } };
    s.jobs.add(job);
    function finish(results, error) {
      if (finished) return;
      finished = true;
      s.jobs.delete(job);
      if (!valid(s) || s.state.generation !== generation) return;
      s.state.pending--;
      if (error) s.state.errors.push(p.name + ": " + error);
      if (results) merge.push(...results);
      selectedResults(s, merge);
    }
    const start = () => {
      if (!valid(s) || c.ctx.cancelled || s.state.generation !== generation) return;
      busy.add(jobKey);
      async function execute() {
        try {
          const values = await p.search(c.ctx.query, c.ctx);
          if (!isCurrent(s.state, generation, c.ctx) || !valid(s)) return;
          const disk = await diskResults(editor, values, c.ctx);
          if (!isCurrent(s.state, generation, c.ctx) || !valid(s)) return;
          s.state.errors.push(...disk.errors.map((e) => p.name + ": " + e));
          s.state.warnings.push(...new Set(disk.warnings.map((w) => p.name + ": " + w)));
          finish(disk.results);
        } catch (error) {
          finish(void 0, String(error));
        } finally {
          busy.delete(jobKey);
          if (!finished) finish();
          const next = queued.get(jobKey);
          queued.delete(jobKey);
          if (next) next();
        }
      }
      Promise.resolve().then(execute).catch((e) => editor.setStatus(String(e)));
    };
    c.ctx.onCancel(() => {
      if (queued.get(jobKey) === start) queued.delete(jobKey);
    });
    if (busy.has(jobKey)) queued.set(jobKey, start);
    else start();
  }
  function query(s, runGrep = false) {
    if (!valid(s)) {
      close();
      return;
    }
    invalidate(s);
    s.state.pending = 0;
    s.state.errors = [];
    s.state.warnings = [];
    s.state.armed = false;
    s.state.results = [];
    s.state.selected = null;
    s.preview = [];
    dismissOwned(s);
    const merge = [];
    if (s.state.query.trim()) {
      if (runGrep) {
        const override = [...providers.values()].filter((p2) => p2.kind === "grep");
        const p = override[override.length - 1] || { name: "builtin-grep", kind: "grep", search: (q, ctx) => grep(editor, q, ctx) };
        launch(s, p, merge);
      } else if (s.state.mode === "everywhere") {
        for (const p of providers.values()) if (p.kind === "files" || p.kind === "symbols") launch(s, p, merge);
        if (![...providers.values()].some((p) => p.kind === "symbols")) {
          for (const language of new Set(config.symbolLanguages)) {
            launch(
              s,
              {
                name: "builtin-symbols:" + language,
                kind: "symbols",
                search: (q, ctx) => symbolLanguage(editor, q, ctx, language)
              },
              merge,
              JSON.stringify(["lsp", language])
            );
          }
        }
      }
    }
    draw(s);
  }
  function open() {
    if (session?.mounted && valid(session)) {
      editor.floatingPanelControl(PANEL, "focus", 0);
      return;
    }
    if (editor.dockOpen()) {
      editor.setStatus("Search Everywhere needs a free dock; existing panel preserved");
      return;
    }
    close();
    const windowId = editor.activeWindow(), window = editor.listWindows().find((w) => w.id === windowId);
    if (!window || !window.root.startsWith("/")) {
      editor.setStatus("Search Everywhere requires an absolute POSIX project root");
      return;
    }
    const original = editor.listSplits().find((p) => p.splitId === editor.getActiveSplitId());
    if (!original) return;
    const s = {
      state: initial(),
      windowId,
      splitId: editor.getActiveSplitId(),
      root: window.root,
      authority: editor.getAuthorityLabel(),
      cancel: [],
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
      jobs: /* @__PURE__ */ new Set(),
      decorated: /* @__PURE__ */ new Set(),
      namespace: "search-everywhere:" + Date.now() + ":" + windowId + ":" + ++namespaceId
    };
    session = s;
    s.mounted = editor.mountFloatingWidget(
      PANEL,
      spec(s.state, config.demotePaths, [], "file provider not configured", s.root, height(), 0, editor.dockCols()),
      38,
      100,
      true,
      false,
      "Search Everywhere",
      true,
      false,
      MODE
    );
    if (!s.mounted) {
      close();
      return;
    }
    timer = editor.setInterval(100, "search_everywhere_tick");
    draw(s);
  }
  function enter() {
    const s = session;
    if (!s || !valid(s)) {
      close();
      return;
    }
    const action = enterAction(s.state);
    if (action === "open") {
      const r = s.state.results.find((r2) => key(r2) === s.state.selected);
      if (!r) return;
      const modified = dirty(s, r.path);
      if (modified && r.kind !== "file") {
        s.state.errors.push("Selected file has unsaved edits; save before opening a location");
        draw(s);
        return;
      }
      close(true);
      if (modified) editor.openFileInSplit(s.splitId, r.path);
      else editor.openFileInSplit(s.splitId, r.path, r.line || 1, r.col || 1);
    } else if (action === "grep") {
      s.state.mode = "grep";
      query(s, true);
    } else {
      editor.setStatus("Search pending, errored, or empty query; no automatic grep");
      draw(s);
    }
  }
  registerHandler("search_everywhere_open", open);
  registerHandler("search_everywhere_enter", enter);
  registerHandler("search_everywhere_close", () => close());
  registerHandler("search_everywhere_cleanup", retryDecorations);
  registerHandler("search_everywhere_loading", loadingTick);
  registerHandler("search_everywhere_tick", () => {
    const s = session;
    if (!s) return;
    if (!valid(s)) {
      close();
      return;
    }
    const selected = s.state.results.find((r) => key(r) === s.state.selected);
    if (selected && dirty(s, selected.path) && !s.preview.length) preview(s);
    for (const job of s.jobs) if (Date.now() >= job.deadline) job.timeout();
  });
  registerHandler("search_everywhere_event", (ev) => {
    const s = session;
    if (!s || ev.panel_id !== PANEL || ev.window_id !== s.windowId) return;
    if (!valid(s) || ev.event_type === "cancel") {
      close();
      return;
    }
    if (ev.widget_key === "query" && ev.event_type === "change") {
      s.state.query = String(ev.payload.value || "").slice(0, 512);
      query(s);
    } else if (ev.widget_key === "grep" && ev.event_type === "toggle") {
      s.state.mode = ev.payload.checked ? "grep" : "everywhere";
      query(s);
    } else if (ev.widget_key === "results" && ["select", "activate"].includes(ev.event_type)) {
      const r = s.state.results[Number(ev.payload.index)];
      if (r && (!ev.payload.key || ev.payload.key === key(r))) {
        s.state.selected = key(r);
        s.state.armed = true;
        preview(s);
        if (ev.event_type === "activate") enter();
      }
    }
  });
  registerHandler("search_everywhere_authority", close);
  registerHandler("search_everywhere_resize", () => {
    const s = session;
    if (s?.mounted && valid(s)) draw(s);
  });
  editor.on("resize", "search_everywhere_resize");
  editor.on("widget_event", "search_everywhere_event");
  editor.on("authority_changed", "search_everywhere_authority");
  editor.defineMode(MODE, [["Enter", "search_everywhere_enter", "shortcut"], ["Escape", "search_everywhere_close", "shortcut"]], true, true, false);
  editor.registerCommand("Search Everywhere", "Files provider, workspace symbols, and disk grep", "search_everywhere_open");
  editor.exportPluginApi("search-everywhere", {
    configure(patch) {
      config = configure(config, patch);
      if (session) query(session);
    },
    registerProvider(p) {
      validateProvider(p);
      providers.set(p.name, p);
      if (session) query(session);
      return () => {
        if (providers.get(p.name) === p) {
          providers.delete(p.name);
          if (session) query(session);
        }
      };
    }
  });
})();
