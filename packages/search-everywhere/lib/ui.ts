import {key, matchRanges, previewMatches, utf16ToByte, utf8Length, type Range, type SearchResult} from "./model.ts";
import {demoted} from "./rank.ts";
import type {State} from "./search.ts";
export function rich(text: string, matches: Range[] = [], grey = false, syntax: TsHighlightSpan[] = []): TextPropertyEntry {
  // Native offsets are bytes, not JS UTF-16 or Unicode scalar indices.
  const inlineOverlays: InlineOverlay[] = syntax.map(s => ({start: s.start, end: s.end,
    style: {fg: s.color, bold: s.bold, italic: s.italic}, unit: "byte"}));
  for (const [a, b] of matches) {
    const start = utf16ToByte(text, a), end = utf16ToByte(text, b);
    if (start !== null && end !== null) inlineOverlays.push({start, end, style: {bold: true, bg: [125, 85, 10]}, unit: "byte"});
  }
  // Last overlay wins: demotion covers both name and snippet, even syntax/matches.
  if (grey) inlineOverlays.push({start: 0, end: utf8Length(text), style: {fg: [125, 125, 125]}, unit: "byte"});
  return {text, inlineOverlays, ...(grey ? {style: {fg: [125, 125, 125] as [number, number, number]}} : {})};
}
export function fileIcon(path: string): string {
  const icons: Record<string, string> = {kt: "", kts: "", ts: "", tsx: "", js: "", json: "", py: "", rs: "", md: "", sh: "", yaml: "", yml: ""};
  return icons[path.split(".").pop()!.toLowerCase()] || "󰈙";
}
export function spec(s: State, patterns: string[], preview: TextPropertyEntry[], notice: string, root = "", height = 19): unknown {
  const itemSpecs = s.results.map(r => {
    const grey = demoted(r.path, patterns), icon = fileIcon(r.path);
    const basename = r.path.split("/").pop() || r.path;
    const title = basename + ":" + (r.line || 1);
    const relative = root && r.path.startsWith(root + "/") ? r.path.slice(root.length + 1) : basename;
    const location = relative + ":" + (r.line || 1) + ":" + (r.col || 1);
    const name = icon + " " + title;
    const ranges = matchRanges(title, s.query).map(([a, b]): Range => [a + icon.length + 1, b + icon.length + 1]);
    return {kind: "raw", entries: [rich(name, ranges, grey), rich((r.kind === "symbol" ? "symbol " + r.name : r.kind === "file" ? "file" : "text") + " · " + location, [], grey),
      rich(r.snippet || "[no saved snippet]", previewMatches(r, s.query), grey)]};
  });
  const selected = Math.max(0, s.results.findIndex(r => key(r) === s.selected));
  const status = [notice, s.pending ? "Pending: " + s.pending : s.results.length + " results",
    ...s.errors, ...s.warnings.map(w => "Incomplete: " + w), s.mode === "grep" ? (s.armed ? "Enter: open selected" : "Enter: run grep; arrows then Enter: open") : "Enter: open / grep when completed empty"].filter(Boolean).join(" · ");
  const tiny = height < 9;
  const secondary = tiny ? [] : [{kind: "toggle", key: "grep", label: "Grep (Enter to search disk)", checked: s.mode === "grep", focused: false}];
  return {kind: "col", children: [
    {kind: "text", key: "query", label: "Query", value: s.query, focused: true, rows: 1, fullWidth: true},
    ...secondary,
    {kind: "labeledSection", label: "Results", child: {kind: "list", key: "results",
      items: [], itemSpecs, itemKeys: s.results.map(key), selectedIndex: selected, visibleRows: Math.max(1, height - (tiny ? 4 : 6)), focusable: false}},
    ...(!tiny ? [{kind: "raw", entries: [{text: [...preview.map(p => p.text), status].join(" · ").replace(/[\r\n]/g, " ")}]},
      {kind: "hintBar", entries: [{keys: "↑/↓", label: "select"}, {keys: "Tab", label: "Grep toggle"}, {keys: "Esc", label: "close"}]}] : [])
  ]};
}
