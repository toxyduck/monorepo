import {key, matchRanges, type SearchResult} from "./model.ts";
export const defaultDemotePaths = ["**/build/**", "**/generated/**", "**/.gradle/**"];
export function demoted(path: string, patterns: string[]): boolean {
  return patterns.some(pattern => {
    const re = pattern.split("**").map(part => part.split("*")
      .map(x => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*");
    return new RegExp("^" + re + "$").test(path);
  });
}
export function quality(text: string, query: string): number {
  const t = text.toLowerCase(), q = query.toLowerCase();
  if (!q || t === q) return 0;
  if (t.startsWith(q)) return 1;
  if (t.includes(q)) return 2;
  return matchRanges(text, query).length ? 3 : 4;
}
export function rank(results: SearchResult[], query: string, patterns: string[], limit: number): SearchResult[] {
  const unique = new Map<string, SearchResult>();
  for (const r of results) unique.set(key(r), {...r, matches: {
    name: matchRanges(r.name, query), snippet: r.matches?.snippet || []
  }});
  const kind = {file: 0, symbol: 1, content: 2};
  return [...unique.values()].sort((a, b) =>
    Number(demoted(a.path, patterns)) - Number(demoted(b.path, patterns)) ||
    quality(a.kind === "content" ? a.snippet || "" : a.name, query) -
      quality(b.kind === "content" ? b.snippet || "" : b.name, query) ||
    kind[a.kind] - kind[b.kind] || key(a).localeCompare(key(b))).slice(0, limit);
}
