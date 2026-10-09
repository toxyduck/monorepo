import {fold, key, matchRanges, type SearchResult} from "./model.ts";
export const defaultDemotePaths = ["**/build/**", "**/generated/**", "**/.gradle/**"];
export function demoted(path: string, patterns: string[]): boolean {
  return patterns.some(pattern => {
    const re = pattern.split("**").map(part => part.split("*")
      .map(x => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*");
    return new RegExp("^" + re + "$").test(path);
  });
}
export function quality(text: string, query: string): number {
  const t = fold(text), q = fold(query);
  if (!q || t === q) return 0;
  if (t.startsWith(q)) return 1;
  if (t.includes(q)) return 2;
  return matchRanges(text, query).length ? 4 : 5;
}
export function rank(results: SearchResult[], query: string, patterns: string[], limit: number): SearchResult[] {
  const unique = new Map<string, SearchResult>();
  for (const r of results) {
    const prior = unique.get(key(r));
    // One representative content row per path; filename-only rows remain searchable.
    if (!prior || r.kind === 'content' && (prior.kind === 'file' || r.line! < prior.line!))
      unique.set(key(r), {...r, matches: {name: matchRanges(r.name, query), snippet: r.matches?.snippet || []}});
  }
  const score = (r: SearchResult) => Math.min(quality(r.name, query), r.kind === "content" ? 3 : quality(r.path, query) + 1);
  return [...unique.values()].sort((a, b) =>
    Number(demoted(a.path, patterns)) - Number(demoted(b.path, patterns)) ||
    score(a) - score(b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).slice(0, limit);
}
