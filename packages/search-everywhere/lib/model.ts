export type Kind = "file" | "content";
export type Range = [number, number];
export interface SearchResult {
  kind: Kind; path: string; name: string;
  line?: number; col?: number; byte?: number; snippet?: string;
  filenameMatch?: boolean;
  matches?: { name?: Range[]; snippet?: Range[] };
}
// Linux filenames remain case-sensitive identities. Literal search folds ASCII only,
// identically to the foreground helper; Unicode beyond ASCII matches exactly.
export function fold(text: string): string { return text.replace(/[A-Z]/g, c => c.toLowerCase()); }
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
    b += utf8Length(c); u += c.length;
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
    if (u > offset || /[\ud800-\udfff]/.test(c) && c.length === 1) return null;
    b += utf8Length(c);
  }
  return u === offset ? b : null;
}
// Lexical containment is not a scope authorization. Helper proves physical scope.
export function canonicalPath(root: string, input: string): string | null {
  if (!root.startsWith("/") || !input || /[\x00-\x1f\x7f\\]/.test(input) || /^[a-zA-Z][\w+.-]*:/.test(input)) return null;
  const clean = (p: string) => {
    const parts: string[] = [];
    for (const x of p.split("/")) {
      if (x === "..") parts.pop(); else if (x && x !== ".") parts.push(x);
    }
    return "/" + parts.join("/");
  };
  const r = clean(root), p = clean(input.startsWith("/") ? input : r + "/" + input);
  return p !== r && p.startsWith(r + "/") ? p : null;
}
export function normalize(value: unknown, root: string): SearchResult | null {
  if (!value || typeof value !== "object") return null;
  const r = value as SearchResult;
  if (!["file", "content"].includes(r.kind) || typeof r.path !== "string" || typeof r.name !== "string" ||
      !r.name || /[\x00-\x1f\x7f]/.test(r.name) || r.path.split('/').some(c => c === '.' || c === '..')) return null;
  const path = canonicalPath(root, r.path);
  if (!path || r.kind === 'content' && (!Number.isSafeInteger(r.line) || r.line! < 1 ||
      typeof r.snippet !== 'string' || utf8Length(r.snippet) > 8192 ||
      r.byte !== undefined && (!Number.isSafeInteger(r.byte) || r.byte < 0) ||
      r.col !== undefined && (!Number.isSafeInteger(r.col) || r.col < 1))) return null;
  return {...r, path, name: path.split("/").pop()!};
}
// Session/root/authority ownership is held by the controller. One key per physical path.
export function key(r: SearchResult): string { return r.path; }
export function matchRanges(text: string, query: string): Range[] {
  if (!query) return [];
  const t = fold(text), q = fold(query), i = t.indexOf(q);
  if (i >= 0) return [[i, i + query.length]];
  return [];
}
export function validatedRanges(text: string, ranges: unknown): Range[] {
  if (!Array.isArray(ranges)) return [];
  return ranges.filter((r): r is Range => Array.isArray(r) && r.length === 2 && r[0] < r[1] &&
    r[1] <= text.length && utf16ToByte(text, r[0]) !== null && utf16ToByte(text, r[1]) !== null);
}
export function previewMatches(r: SearchResult, _query: string): Range[] {
  return validatedRanges(r.snippet || "", r.matches?.snippet);
}
