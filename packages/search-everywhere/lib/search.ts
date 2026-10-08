import {key, type SearchContext, type SearchResult} from "./model.ts";
export type Mode = "everywhere" | "grep";
export interface State {
  generation: number; query: string; mode: Mode; pending: number;
  errors: string[]; warnings: string[]; results: SearchResult[]; selected: string | null; armed: boolean;
}
export function initial(): State {
  return {generation: 0, query: "", mode: "everywhere", pending: 0, errors: [], warnings: [], results: [], selected: null, armed: false};
}
export function replaceResults(s: State, results: SearchResult[]): void {
  s.results = results;
  if (!results.some(r => key(r) === s.selected)) s.selected = results[0] ? key(results[0]) : null;
}
export function enterAction(s: State): "open" | "grep" | "wait" {
  if (s.mode === "grep") return s.armed && s.selected ? "open" : s.pending ? "wait" : "grep";
  if (s.selected) return "open";
  return s.pending || s.errors.length || s.warnings.length || !s.query.trim() ? "wait" : "grep";
}
export function cancellation(root: string, windowId: number, query: string, maxResults: number, warn: (message: string) => void = () => {}): {
  ctx: SearchContext; cancel: () => void;
} {
  let cancelled = false;
  const handlers = new Set<() => void>();
  return {ctx: {root, windowId, query, maxResults, warn, get cancelled() { return cancelled; },
    onCancel(fn) { if (cancelled) fn(); else handlers.add(fn); return () => handlers.delete(fn); }},
    cancel() { if (cancelled) return; cancelled = true; for (const fn of handlers) fn(); handlers.clear(); }};
}
export function isCurrent(s: State, generation: number, ctx: SearchContext): boolean {
  return s.generation === generation && !ctx.cancelled;
}
