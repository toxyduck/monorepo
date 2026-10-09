import {string, type Adapter} from './model.ts';
export function loadConfig(editor: Pick<EditorAPI,'getPluginConfig'|'getConfigDir'|'pathJoin'|'pathDirname'|'pathIsAbsolute'|'readFile'|'localPath'>): Adapter[] {
  const settings = editor.getPluginConfig() as {adapterConfig?: unknown};
  string(settings?.adapterConfig, 'explicit trusted adapterConfig');
  if (!settings.adapterConfig) throw new Error('Set plugins.vcs_diff.settings.adapterConfig to a trusted JS expression');
  const configPath = editor.pathIsAbsolute(settings.adapterConfig) ? settings.adapterConfig : editor.pathJoin(editor.getConfigDir(), settings.adapterConfig);
  const stack = new Set<string>();
  function load(file: string): unknown {
    if (stack.has(file) || stack.size >= 16) throw new Error('Cyclic/excessive trusted config load');
    stack.add(file);
    try {
      const text = editor.readFile(editor.localPath(file));if (text === null || text.length > 262144) throw new Error('Missing/large trusted config: ' + file);
      // This is trusted executable user code, NOT a sandbox or project discovery.
      return new Function('load', '"use strict"; return (' + text + '\n);')((child: unknown) => {string(child,'load path');return load(editor.pathIsAbsolute(child) ? child : editor.pathJoin(editor.pathDirname(file), child));});
    } finally {stack.delete(file);}
  }
  const cfg = load(configPath) as {adapters?: Adapter[]};
  if (!Array.isArray(cfg?.adapters) || !cfg.adapters.length || cfg.adapters.length > 16) throw new Error('Config needs 1–16 adapters');
  const names=new Set();
  for (const a of cfg.adapters) {
    string(a?.name);if (!a.name || names.has(a.name)) throw new Error('Adapter names must be unique');names.add(a.name);
    const c=a.capabilities;
    if (!c || !Array.isArray(c.sources) || c.sources.some(s=>!['staged','unstaged','commit'].includes(s)) || typeof a.diff !== 'function') throw new Error('Invalid adapter diff/capabilities');
    for (const op of ['history','content','blame'] as const) if (typeof c[op] !== 'boolean' || (c[op] && typeof a[op] !== 'function')) throw new Error('Invalid adapter '+op);
  }return cfg.adapters;
}
