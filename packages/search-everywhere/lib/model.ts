export type Kind = "file" | "symbol" | "content";
export type Range = [number, number];
export interface SearchResult {
  kind: Kind; path: string; name: string;
  line?: number; col?: number; snippet?: string;
  matches?: { name?: Range[]; snippet?: Range[] };
}
export interface SearchContext {
  readonly root: string; readonly windowId: number; readonly query: string;
  readonly cancelled: boolean; readonly maxResults: number;
  /** Report candidate truncation or incomplete backend coverage, separately from empty. */
  warn(message: string): void;
  onCancel(fn: () => void): () => void;
}
export interface Provider {
  name: string; kind: "files" | "symbols" | "grep";
  search(query: string, ctx: SearchContext): Promise<SearchResult[]>;
}
export function utf8Length(text: string): number {
  let n = 0;
  for (const c of text) { const cp = c.codePointAt(0)!; n += cp < 128 ? 1 : cp < 2048 ? 2 : cp < 65536 ? 3 : 4; }
  return n;
}
export function byteToUtf16(text: string, byte: number): number | null {
  if (!Number.isInteger(byte) || byte < 0) return null;
  let b = 0, u = 0;
  for (const c of text) {
    if (b === byte) return u;
    const cp = c.codePointAt(0)!;
    b += cp < 128 ? 1 : cp < 2048 ? 2 : cp < 65536 ? 3 : 4;
    u += c.length;
    if (b > byte) return null;
  }
  return b === byte ? u : null;
}
export function utf16ToByte(text: string, offset: number): number | null {
  if (!Number.isInteger(offset) || offset < 0) return null;
  let b = 0, u = 0;
  for (const c of text) {
    if (u === offset) return b;
    u += c.length;
    if (u > offset) return null;
    const cp = c.codePointAt(0)!;
    if (cp >= 0xd800 && cp <= 0xdfff) return null;
    b += cp < 128 ? 1 : cp < 2048 ? 2 : cp < 65536 ? 3 : 4;
  }
  return u === offset ? b : null;
}
// Lexical containment, not realpath: no symlink traversal is performed by the plugin.
export function canonicalPath(root: string, input: string): string | null {
  if (!input || /[\x00-\x1f\x7f]/.test(input)) return null;
  if (input.startsWith("file:")) {
    try {
      const m = /^file:\/\/([^/]*)(\/.*)$/.exec(input);
      if (!m || (m[1] && m[1] !== "localhost")) return null;
      input = decodeURIComponent(m[2]);
    } catch { return null; }
  } else if (/^[a-zA-Z][\w+.-]*:/.test(input)) return null;
  if (/[\x00-\x1f\x7f]/.test(input) || input.includes("\\")) return null;
  function clean(p: string): string {
    const parts: string[] = [];
    for (const x of p.split("/")) {
      if (x === "..") parts.pop(); else if (x && x !== ".") parts.push(x);
    }
    return "/" + parts.join("/");
  }
  if (!root.startsWith("/")) return null;
  const r = clean(root), p = clean(input.startsWith("/") ? input : r + "/" + input);
  return p !== r && (r === "/" || p.startsWith(r + "/")) ? p : null;
}
export function normalize(value: unknown, root: string): SearchResult | null {
  if (!value || typeof value !== "object") return null;
  const r = value as SearchResult;
  if (!["file", "symbol", "content"].includes(r.kind) || typeof r.path !== "string" ||
      typeof r.name !== "string" || !r.name || r.name.length > 512 || /[\x00-\x1f\x7f]/.test(r.name)) return null;
  const path = canonicalPath(root, r.path);
  if (!path || ((r.line === undefined) !== (r.col === undefined))) return null;
  if (r.line !== undefined && (!Number.isSafeInteger(r.line) || r.line < 1 ||
      !Number.isSafeInteger(r.col) || r.col! < 1)) return null;
  if (r.kind !== "file" && r.line === undefined) return null;
  // Provider snippets are never an authority: the adapter replaces them with disk text.
  return {kind: r.kind, path, name: r.name, line: r.line, col: r.col,
    ...(typeof r.snippet === "string" ? {snippet: r.snippet, matches: r.matches} : {})};
}
export function key(r: SearchResult): string {
  return JSON.stringify([r.kind, r.path, r.line || 0, r.col || 0, r.name]);
}
export function matchRanges(text: string, query: string): Range[] {
  if (!query) return [];
  const i = text.toLowerCase().indexOf(query.toLowerCase());
  if (i >= 0) return [[i, i + query.length]];
  let cursor = 0;
  const out: Range[] = [];
  for (const c of query.toLowerCase()) {
    const j = text.toLowerCase().indexOf(c, cursor);
    if (j < 0) return [];
    out.push([j, j + c.length]); cursor = j + c.length;
  }
  return out;
}
export function savedLocation(r: SearchResult, text: string): SearchResult | null {
  const lines = text.split("\n");
  const line = lines[(r.line || 1) - 1];
  if (line === undefined || utf16ToByte(line, (r.col || 1) - 1) === null) return null;
  if (r.kind === "symbol") {
    const start = r.col! - 1;
    if (line.slice(start, start + r.name.length) !== r.name ||
        /[\p{L}\p{N}_$]/u.test(line[start - 1] || "") ||
        /[\p{L}\p{N}_$]/u.test(line[start + r.name.length] || "")) return null;
  }
  const saved = line.replace(/\r$/, ""), snippet = saved.slice(0, 600);
  const ranges = r.snippet === saved ? validatedRanges(snippet, r.matches?.snippet) : [];
  return {...r, snippet, matches: {snippet: ranges}};
}
export function validatedRanges(text: string, ranges: unknown): Range[] {
  if (!Array.isArray(ranges)) return [];
  return ranges.filter((r): r is Range => Array.isArray(r) && r.length === 2 &&
    r[0] < r[1] && r[1] <= text.length && utf16ToByte(text, r[0]) !== null && utf16ToByte(text, r[1]) !== null);
}
export function previewMatches(r: SearchResult, query: string): Range[] {
  if (r.kind === "content") return validatedRanges(r.snippet || "", r.matches?.snippet);
  const text = r.snippet || "";
  if (!query) return [];
  // Escaped literal with Unicode matching keeps indices in the original UTF-16 text.
  const literal = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  return validatedRanges(text, [...text.matchAll(literal)].map(m => [m.index!, m.index! + m[0].length]));
}
