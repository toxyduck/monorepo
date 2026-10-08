import {byteToUtf16, canonicalPath, normalize, savedLocation, utf8Length, type SearchContext, type SearchResult} from "./model.ts";
export const PREFIX_BYTES = 65536;
export interface DiskResults { results: SearchResult[]; errors: string[]; warnings: string[]; }
export function parseRg(stdout: string, root: string, limit: number): SearchResult[] {
  const out: SearchResult[] = [];
  for (const row of stdout.split("\n")) {
    if (!row) continue;
    const event = JSON.parse(row);
    if (event.type !== "match") continue;
    const d = event.data;
    if (typeof d?.path?.text !== "string" || typeof d?.lines?.text !== "string" ||
        !Number.isSafeInteger(d.line_number) || d.line_number < 1 || !Array.isArray(d.submatches))
      throw new Error("Malformed rg match");
    const path = canonicalPath(root, d.path.text);
    if (!path) continue;
    for (const match of d.submatches) {
      const start = byteToUtf16(d.lines.text, match.start), end = byteToUtf16(d.lines.text, match.end);
      if (start === null || end === null || end < start) throw new Error("Invalid rg byte range");
      if (out.length >= limit) throw new Error("rg candidate cap reached; incomplete output");
      out.push({kind: "content", path, name: path.split("/").pop()!, line: d.line_number,
        col: start + 1, snippet: d.lines.text.replace(/\r?\n$/, ""), matches: {snippet: [[start, end]]}});
    }
  }
  return out;
}
export function parseSymbols(value: unknown, root: string, limit: number): SearchResult[] {
  if (!Array.isArray(value)) throw new Error("workspace/symbol did not return an array");
  const out: SearchResult[] = [];
  for (const s of value.slice(0, limit)) {
    const p = s?.location?.range?.start;
    // Unresolved WorkspaceSymbol locations cannot be opened safely without symbol/resolve.
    if (!p || !Number.isInteger(p.line) || !Number.isInteger(p.character) || p.line < 0 || p.character < 0) continue;
    const r = normalize({kind: "symbol", path: s.location.uri, name: s.name, line: p.line + 1, col: p.character + 1}, root);
    if (r) out.push(r);
  }
  return out;
}
export async function symbolLanguage(editor: EditorAPI, query: string, ctx: SearchContext, language: string): Promise<SearchResult[]> {
  if (!query.trim() || ctx.cancelled) return [];
  const value = await editor.sendLspRequest(language, "workspace/symbol", {query});
  if (ctx.cancelled) return [];
  if (Array.isArray(value) && value.length > ctx.maxResults) ctx.warn("LSP candidate cap reached; incomplete coverage");
  return parseSymbols(value, ctx.root, ctx.maxResults);
}
export async function grep(_editor: EditorAPI, query: string, ctx: SearchContext): Promise<SearchResult[]> {
  if (!query.trim() || ctx.cancelled) return [];
  // debt: no confirmed bounded native stdout capture. Re-enable only after capped streaming + kill is verified.
  // Do not spawn a whole-project rg whose stdout Fresh captures without a bound.
  throw new Error("Builtin rg unavailable: bounded process output is not verified; register a bounded grep provider (PARTIAL)");
}
export async function diskResults(editor: EditorAPI, values: unknown, ctx: SearchContext): Promise<DiskResults> {
  if (!Array.isArray(values)) throw new Error("Provider must return SearchResult[]");
  const result: DiskResults = {results: [], errors: [], warnings: []};
  if (values.length > ctx.maxResults) result.warnings.push("Candidate cap " + ctx.maxResults + " reached before ranking; coverage incomplete");
  const candidates: SearchResult[] = [];
  for (const value of values.slice(0, ctx.maxResults)) {
    const r = normalize(value, ctx.root);
    if (r) candidates.push(r); else result.warnings.push("Invalid provider result omitted (path/name/location)");
  }
  const dirty = new Set(editor.listBuffers().filter(b => b.window_id === ctx.windowId && b.modified).map(b => b.path));
  const paths = [...new Set(candidates.map(r => r.path))];
  if (!paths.length || ctx.cancelled) return result;
  const machine = await editor.openMachine({kind: "window", window: ctx.windowId});
  try {
    if (ctx.cancelled) return result;
    const prefixes = await machine.readFilePrefixes(paths.map(path => ({path, maxBytes: PREFIX_BYTES})));
    if (ctx.cancelled) return result;
    const byPath = new Map(prefixes.map(p => [p.path, p]));
    const failed = new Set<string>();
    for (const r of candidates) {
      if (r.kind === "symbol" && dirty.has(r.path)) {
        result.warnings.push(r.path + ": dirty-file symbol omitted"); continue;
      }
      const prefix = byPath.get(r.path);
      if (prefix?.text === undefined) {
        if (!failed.has(r.path)) result.errors.push(r.path + ": " + (prefix?.error || "No disk read result"));
        failed.add(r.path); continue;
      }
      const disk = prefix.text, truncated = utf8Length(disk) >= PREFIX_BYTES;
      const bounded = truncated ? disk.slice(0, disk.lastIndexOf("\n") + 1) : disk;
      if (truncated && (r.line || 1) >= bounded.split("\n").length) {
        result.warnings.push(r.path + ":" + r.line + ": location unverified beyond 64 KiB disk prefix (PARTIAL)"); continue;
      }
      const valid = savedLocation(r, bounded);
      if (!valid) {
        result.warnings.push(r.path + ":" + (r.line || 1) + ": saved position/name not confirmed"); continue;
      }
      if (bounded.split("\n")[(r.line || 1) - 1].length > 600) result.warnings.push(r.path + ": saved snippet clipped to 600 UTF-16 units");
      // No literal query filter here: an override can implement regex, fuzzy or other semantics.
      result.results.push(valid);
    }
    return result;
  } finally { await machine.close(); }
}
