import {key, matchRanges, previewMatches, utf16ToByte, utf8Length, type Range} from "./model.ts";
import {demoted} from "./rank.ts";
import type {State} from "./search.ts";
import {BRAND_PALETTE as palette, loadingFrame} from "../../_shared/runtime_brand.ts";
export function rich(text: string, matches: Range[] = [], grey = false, syntax: TsHighlightSpan[] = []): TextPropertyEntry {
  // Native offsets are bytes, not JS UTF-16 or Unicode scalar indices.
  const inlineOverlays: InlineOverlay[] = syntax.map(s => ({start: s.start, end: s.end,
    style: {fg: s.color, bold: s.bold, italic: s.italic}, unit: "byte"}));
  for (const [a, b] of matches) {
    const start = utf16ToByte(text, a), end = utf16ToByte(text, b);
    if (start !== null && end !== null) inlineOverlays.push({start, end, style: {bold: true, bg: palette.matchBg}, unit: "byte"});
  }
  // Last overlay wins: demotion covers both name and snippet, even syntax/matches.
  if (grey) inlineOverlays.push({start: 0, end: utf8Length(text), style: {fg: palette.demoted}, unit: "byte"});
  return {text, inlineOverlays, ...(grey ? {style: {fg: palette.demoted}} : {})};
}
export function fileIcon(path: string): string {
  const icons: Record<string, string> = {kt: "", kts: "", ts: "", tsx: "", js: "", json: "", py: "", rs: "", md: "", sh: "", yaml: "", yml: ""};
  return icons[path.split(".").pop()!.toLowerCase()] || "󰈙";
}
export function spec(s: State, patterns: string[], preview: TextPropertyEntry[], notice: string, root = "", height = 19, phase = 0): unknown {
  const itemSpecs = s.results.map(r => {
    const grey = demoted(r.path, patterns), icon = fileIcon(r.path), active = key(r) === s.selected;
    const basename = r.path.split("/").pop() || r.path;
    const title = basename + ":" + (r.line || 1);
    const relative = root && r.path.startsWith(root + "/") ? r.path.slice(root.length + 1) : basename;
    const location = relative + ":" + (r.line || 1) + ":" + (r.col || 1);
    const prefix = (active ? "> " : "  ") + icon + " ", rail = active ? "│ " : "  ";
    const row = (text: string, ranges: Range[], titleRow = false): TextPropertyEntry => {
      const entry = rich(text, ranges, grey);
      entry.style = {fg: grey ? palette.demoted : titleRow ? palette.text : palette.secondary,
        ...(active ? {bg: palette.selectedBg} : {}), ...(titleRow && active ? {bold: true} : {})};
      if (active && !titleRow) entry.inlineOverlays!.push({start: 0, end: utf8Length("│"), style: {fg: palette.accent}, unit: "byte"});
      return entry;
    };
    const ranges = matchRanges(title, s.query).map(([a, b]): Range => [a + prefix.length, b + prefix.length]);
    return {kind: "raw", entries: [row(prefix + title, ranges, true),
      row(rail + (r.kind === "symbol" ? "symbol " + r.name : r.kind === "file" ? "file" : "text") + " · " + location, []),
      row(rail + (r.snippet || "[no saved snippet]"), previewMatches(r, s.query).map(([a,b]): Range => [a + rail.length, b + rail.length]))]};
  });
  const selected = Math.max(0, s.results.findIndex(r => key(r) === s.selected));
  // Safety/refusal information precedes counts and the quiet fixed-width loader.
  const safety = [notice, ...preview.map(p => p.text), ...s.errors, ...s.warnings.map(w => "Incomplete: " + w)].filter(Boolean);
  const status = [...safety, s.pending ? loadingFrame(phase) + " Searching" : s.results.length + " results"].join(" · ").replace(/[\r\n]/g, " ");
  const loaderAt = s.pending ? status.length - (loadingFrame(phase) + " Searching").length : -1;
  const footer = rich(status);
  footer.style = {fg: palette.secondary};
  if (loaderAt >= 0) footer.inlineOverlays!.push({start: utf16ToByte(status, loaderAt)!, end: utf16ToByte(status, loaderAt + 1)!, style: {fg: palette.loadingAccent}, unit: "byte"});
  const tiny = height < 9;
  return {kind: "col", children: [
    ...(!tiny ? [{kind: "raw", entries: [{text: "SEARCH EVERYWHERE", style: {fg: palette.accent, bold: true}}]}] : []),
    {kind: "text", key: "query", label: "Query", value: s.query, focused: true, rows: 1, fullWidth: true},
    ...(!tiny ? [{kind: "toggle", key: "grep", label: "Grep (Enter to search disk)", checked: s.mode === "grep", focused: false}] : []),
    {kind: "labeledSection", label: "Results", child: {kind: "list", key: "results",
      items: [], itemSpecs, itemKeys: s.results.map(key), selectedIndex: selected, visibleRows: Math.max(1, height - (tiny ? 5 : 7)), focusable: false}},
    {kind: "raw", entries: [footer]},
    ...(!tiny ? [{kind: "hintBar", entries: [{keys: "↑/↓", label: "select"}, {keys: "Tab", label: "Grep toggle"},
      {keys: "Enter", label: s.mode === "grep" && !s.armed ? "run grep" : "open"}, {keys: "Esc", label: "close"}]}] : [])
  ]};
}
