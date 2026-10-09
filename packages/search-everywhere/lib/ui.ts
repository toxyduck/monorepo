import {key, matchRanges, previewMatches, utf16ToByte, utf8Length, type Range, type SearchResult} from "./model.ts";
import {demoted} from "./rank.ts";
import type {State} from "./search.ts";
import {BRAND_PALETTE as palette, loadingFrame} from "../../_shared/runtime_brand.ts";
export function rich(text: string, matches: Range[] = [], grey = false, syntax: TsHighlightSpan[] = []): TextPropertyEntry {
  // Native offsets are bytes, not JS UTF-16 or Unicode scalar indices.
  const inlineOverlays: InlineOverlay[] = syntax.map(s => ({start: s.start, end: s.end,
    // QuickJS's native bridge maps present undefined values to null; omit absent flags.
    style: {fg: s.color, ...(s.bold === undefined ? {} : {bold: s.bold}),
      ...(s.italic === undefined ? {} : {italic: s.italic})}, unit: "byte"}));
  for (const [a, b] of matches) {
    const start = utf16ToByte(text, a), end = utf16ToByte(text, b);
    if (start !== null && end !== null) inlineOverlays.push({start, end, style: {bold: true, bg: palette.matchBg}, unit: "byte"});
  }
  // Native syntax keeps its foreground; selection is handled at the result-row boundary.
  if (grey && !syntax.length) inlineOverlays.push({start: 0, end: utf8Length(text), style: {fg: palette.demoted}, unit: "byte"});
  return {text, inlineOverlays, ...(grey ? {style: {fg: palette.demoted}} : {})};
}
export function fileIcon(path: string): string {
  const icons: Record<string, string> = {kt: "", kts: "", ts: "", tsx: "", js: "", json: "", py: "", rs: "", md: "", sh: "", yaml: "", yml: ""};
  return icons[path.split(".").pop()!.toLowerCase()] || "󰈙";
}
// Regions are local UTF-16 ranges; convert once after joining the actual prefixes.
function resultRow(s: State, r: SearchResult, patterns: string[], root: string, width: number): TextPropertyEntry {
  const active = key(r) === s.selected;
  const basename = r.path.split("/").pop() || r.path;
  const relative = root && r.path.startsWith(root + "/") ? r.path.slice(root.length + 1) : basename;
  const directory = relative.slice(0, relative.length - basename.length);
  let text = active ? "> " : "  ";
  const regions: TsHighlightSpan[] = [], matches: Range[] = [];
  const append = (value: string, fg: string, bold = false, ranges: Range[] = []) => {
    const prefix = text.length;
    text += value;
    regions.push({start: utf8Length(text.substring(0, prefix)), end: utf8Length(text),
      color: active ? palette.selectedFg : fg, bold});
    matches.push(...ranges.map(([a, b]): Range => [prefix + a, prefix + b]));
  };
  append(fileIcon(r.path) + " ", palette.icon);
  const identity = basename + (r.kind === "content" ? ":" + r.line : "");
  append(identity, palette.text, true, matchRanges(identity, s.query));
  if (r.kind === "content") {
    append(" · ", palette.secondary);
    append(r.snippet || "[no source snippet]", palette.text, false, previewMatches(r, s.query));
  }
  if (width >= 48) {
    if (directory) append(" · " + directory, palette.secondary);
    if (r.kind === "file") append(" · file", palette.secondary);
  }
  if (demoted(r.path, patterns)) append(" · generated", palette.secondary);
  const entry = rich(text, matches, false, regions);
  entry.style = active ? {fg: palette.selectedFg, bg: palette.selectedBg} : {fg: palette.text};
  // Native one-row viewport clipping keeps text within cell bounds.
  return entry;
}
function selectedLocation(s: State, root: string, width: number): TextPropertyEntry {
  const r = s.results.find(r => key(r) === s.selected);
  if (!r) return {text: "", style: {fg: palette.secondary}};
  const basename = r.path.split("/").pop() || r.path;
  const relative = root && r.path.startsWith(root + "/") ? r.path.slice(root.length + 1) : basename;
  const coordinates = r.line ? ':' + r.line + (r.col ? ':' + r.col : ' (source line)') : '';
  return {text: (width < 48 ? basename + coordinates + " · " : "") + relative + coordinates,
    style: {fg: palette.secondary}};
}
function statusFooter(s: State, preview: TextPropertyEntry[], notice: string): TextPropertyEntry {
  const safety = [notice, ...preview.map(p => p.text), ...s.errors, ...s.warnings.map(w => "Incomplete: " + w)].filter(Boolean);
  const status = [s.results.length + " results", ...safety].join(" · ").replace(/[\r\n]/g, " ");
  const footer = rich(status);
  footer.style = {fg: palette.text};
  return footer;
}
export function spec(s: State, patterns: string[], preview: TextPropertyEntry[], notice: string, root = "", height = 19, phase = 0, width = 52): unknown {
  const items = s.results.map(r => resultRow(s, r, patterns, root, width));
  const selected = Math.max(0, s.results.findIndex(r => key(r) === s.selected));
  const tiny = height < 9;
  const hints = {kind: "hintBar", entries: [{keys: "↑/↓", label: width < 48 ? "" : "select"},
    {keys: "Enter", label: width < 48 ? "" : "open"},
    {keys: "Esc", label: width < 48 ? "" : "close"}]};
  const header = rich("Results · " + s.results.length + (s.pending ? " · Searching " + loadingFrame(phase) : ""));
  header.style = {fg: palette.accent};
  return {kind: "col", children: [
    {kind: "text", key: "query", label: "Query", value: s.query, focused: true, rows: 1, fullWidth: true},
    {kind: "raw", key: "results-status", entries: [header]},
    {kind: "list", key: "results", items, itemKeys: s.results.map(key), selectedIndex: selected,
      visibleRows: Math.max(1, height - 5), focusable: false},
    {kind: "raw", key: "selected-location", entries: [selectedLocation(s, root, width)]},
    {kind: "raw", entries: [statusFooter(s, preview, notice)]},
    tiny ? {kind: "raw", entries: [{text: " ↑↓ ↵ Esc", style: {fg: palette.accent}}]} : hints,
  ]};
}
