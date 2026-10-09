import {defaultDemotePaths} from "./rank.ts";
export interface Config { demotePaths: string[]; maxResults: number; timeoutMs: number; }
export function defaults(): Config {
  return {demotePaths: [...defaultDemotePaths], maxResults: 80, timeoutMs: 15000};
}
export function configure(current: Config, patch: Partial<Config>): Config {
  for (const k of Object.keys(patch)) if (!["demotePaths", "maxResults", "timeoutMs"].includes(k)) throw new Error("Unknown setting: " + k);
  const c = {...current, ...patch};
  if (!Array.isArray(c.demotePaths) || c.demotePaths.length > 32 || c.demotePaths.some(s => typeof s !== "string" || s.length > 256)) throw new Error("Invalid search paths");
  if (!Number.isInteger(c.maxResults) || c.maxResults < 1 || c.maxResults > 200 ||
      !Number.isInteger(c.timeoutMs) || c.timeoutMs < 100 || c.timeoutMs > 30000) throw new Error("Invalid search limits");
  return {...c, demotePaths: [...c.demotePaths]};
}
