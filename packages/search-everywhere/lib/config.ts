import type {Provider} from "./model.ts";
import {defaultDemotePaths} from "./rank.ts";
export interface Config { demotePaths: string[]; symbolLanguages: string[]; maxResults: number; timeoutMs: number; }
export function defaults(): Config {
  return {demotePaths: [...defaultDemotePaths], symbolLanguages: ["kotlin"], maxResults: 80, timeoutMs: 5000};
}
export function configure(current: Config, patch: Partial<Config>): Config {
  for (const k of Object.keys(patch)) if (!["demotePaths", "symbolLanguages", "maxResults", "timeoutMs"].includes(k)) throw new Error("Unknown setting: " + k);
  const c = {...current, ...patch};
  if (!Array.isArray(c.demotePaths) || c.demotePaths.length > 32 || c.demotePaths.some(s => typeof s !== "string" || s.length > 256) ||
      !Array.isArray(c.symbolLanguages) || c.symbolLanguages.length > 8 || c.symbolLanguages.some(s => typeof s !== "string" || !s)) throw new Error("Invalid search paths/languages");
  if (!Number.isInteger(c.maxResults) || c.maxResults < 1 || c.maxResults > 200 ||
      !Number.isInteger(c.timeoutMs) || c.timeoutMs < 100 || c.timeoutMs > 30000) throw new Error("Invalid search limits");
  return {...c, demotePaths: [...c.demotePaths], symbolLanguages: [...c.symbolLanguages]};
}
export function validateProvider(p: Provider): void {
  if (!p || typeof p.name !== "string" || !p.name || p.name.length > 128 ||
      !["files", "symbols", "grep"].includes(p.kind) || typeof p.search !== "function") throw new Error("Invalid provider");
}
