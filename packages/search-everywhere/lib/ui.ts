import {key, matchRanges, previewMatches, utf16ToByte, utf8Length, type Range, type SearchResult} from "./model.ts";
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
  // Native syntax keeps its foreground; selection is handled at the card boundary.
  if (grey && !syntax.length) inlineOverlays.push({start: 0, end: utf8Length(text), style: {fg: palette.demoted}, unit: "byte"});
  return {text, inlineOverlays, ...(grey ? {style: {fg: palette.demoted}} : {})};
}
export function fileIcon(path: string): string {
  const icons: Record<string, string> = {kt: "", kts: "", ts: "", tsx: "", js: "", json: "", py: "", rs: "", md: "", sh: "", yaml: "", yml: ""};
  return icons[path.split(".").pop()!.toLowerCase()] || "󰈙";
}
function resultCard(s: State, r: SearchResult, patterns: string[], root: string): unknown {
  const active = key(r) === s.selected, grey = !active && demoted(r.path, patterns), icon = fileIcon(r.path);
  const basename = r.path.split("/").pop() || r.path;
  const title = basename + ":" + (r.line || 1);
  const relative = root && r.path.startsWith(root + "/") ? r.path.slice(root.length + 1) : basename;
  const location = relative + ":" + (r.line || 1) + ":" + (r.col || 1);
  const prefix = (active ? "> " : "  ") + icon + " ", rail = active ? "│ " : "  ";
  const row = (text: string, ranges: Range[], titleRow = false): TextPropertyEntry => {
    const entry = rich(text, ranges, grey);
    let foreground: string = palette.secondary;
    if (active) foreground = palette.selectedFg;
    else if (grey) foreground = palette.demoted;
    else if (titleRow) foreground = palette.text;
    entry.style = {fg: foreground,
      ...(active ? {bg: palette.selectedBg} : {}), ...(titleRow && active ? {bold: true} : {})};
    if (active && !titleRow) entry.inlineOverlays!.push({start: 0, end: utf8Length("│"), style: {fg: palette.selectedFg}, unit: "byte"});
    return entry;
  };
  const ranges = matchRanges(title, s.query).map(([a, b]): Range => [a + prefix.length, b + prefix.length]);
  let kindLabel = "text";
  if (r.kind === "symbol") kindLabel = "symbol " + r.name;
  else if (r.kind === "file") kindLabel = "file";
  return {kind: "raw", entries: [row(prefix + title, ranges, true),
    row(rail + kindLabel + " · " + location, []),
    row(rail + (r.snippet || "[no saved snippet]"), previewMatches(r, s.query).map(([a,b]): Range => [a + rail.length, b + rail.length]))]};
}
function statusFooter(s: State, preview: TextPropertyEntry[], notice: string): TextPropertyEntry {
  const safety = [notice, ...preview.map(p => p.text), ...s.errors, ...s.warnings.map(w => "Incomplete: " + w)].filter(Boolean);
  const status = [...safety, s.results.length + " results"].join(" · ").replace(/[\r\n]/g, " ");
  const footer = rich(status);
  footer.style = {fg: palette.secondary};
  return footer;
}
export function spec(s: State, patterns: string[], preview: TextPropertyEntry[], notice: string, root = "", height = 19, phase = 0): unknown {
  const itemSpecs = s.results.map(r => resultCard(s, r, patterns, root));
  const selected = Math.max(0, s.results.findIndex(r => key(r) === s.selected));
  const footer = statusFooter(s, preview, notice);
  const resultsLabel = s.pending ? "Results · " + loadingFrame(phase) + " Searching" : "Results";
  const tiny = height < 9;
  return {kind: "col", children: [
    ...(!tiny ? [{kind: "raw", entries: [{text: "SEARCH EVERYWHERE", style: {fg: palette.accent, bold: true}}]}] : []),
    {kind: "text", key: "query", label: "Query", value: s.query, focused: true, rows: 1, fullWidth: true},
    ...(!tiny ? [{kind: "toggle", key: "grep", label: "Grep (Enter to search disk)", checked: s.mode === "grep", focused: false}] : []),
    {kind: "labeledSection", label: resultsLabel, child: {kind: "list", key: "results",
      items: [], itemSpecs, itemKeys: s.results.map(key), selectedIndex: selected, visibleRows: Math.max(1, height - (tiny ? 5 : 7)), focusable: false}},
    {kind: "raw", entries: [footer]},
    ...(!tiny ? [{kind: "hintBar", entries: [{keys: "↑/↓", label: "select"}, {keys: "Tab", label: "Grep toggle"},
      {keys: "Enter", label: s.mode === "grep" && !s.armed ? "run grep" : "open"}, {keys: "Esc", label: "close"}]}] : [])
  ]};
}
