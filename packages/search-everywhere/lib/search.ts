import {key, type SearchResult} from "./model.ts";
export interface State {
  generation: number; query: string; pending: number;
  errors: string[]; warnings: string[]; results: SearchResult[]; selected: string | null;
}
export function initial(): State {
  return {generation: 0, query: "", pending: 0, errors: [], warnings: [], results: [], selected: null};
}
export function replaceResults(s: State, results: SearchResult[]): void {
  s.results = results;
  if (!results.some(r => key(r) === s.selected)) s.selected = results[0] ? key(results[0]) : null;
}
export function enterAction(s: State): "open" | "wait" {
  return s.results.some(r => key(r) === s.selected) ? "open" : "wait";
}
