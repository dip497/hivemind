/**
 * A settings.json from before plugin state kept each switch in a key of its own:
 * `agents.disabled`, `agents.options`, `plugins.disabled` (views), `tools.enabledPlugins` and
 * `tools.disabledTools` (a tool switched off inside a plugin). They become one record per plugin
 * in `plugins.state`, and the old keys go, with the `migrated` flag an older one-off left.
 */
import { readFile } from "node:fs/promises";
import { patchSettingsExtras, settingsPath, updateSettings } from "../settings.js";
import { parsePluginStates, withPluginState, type PluginState } from "../plugin-settings.js";
import type { Migration } from "./runner.js";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Whether the file holds plugin state in the old keys. */
function hasOldKeys(p: Record<string, unknown>): boolean {
  const has = (o: unknown, k: string) => isObj(o) && o[k] !== undefined;
  return has(p.agents, "disabled") || has(p.agents, "options") || has(p.plugins, "disabled") || isObj(p.tools);
}

/** The records the old keys held. */
function statesFromOldKeys(raw: Record<string, unknown>): Record<string, PluginState> {
  let states: Record<string, PluginState> = {};
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const agents = isObj(raw.agents) ? raw.agents : {};
  const plugins = isObj(raw.plugins) ? raw.plugins : {};
  const tools = isObj(raw.tools) ? raw.tools : {};
  for (const id of list(agents.disabled)) states = withPluginState(states, "agent", id, (s) => ({ ...s, enabled: false }));
  if (isObj(agents.options)) {
    for (const [id, opts] of Object.entries(agents.options)) {
      if (!isObj(opts)) continue;
      const options = Object.fromEntries(Object.entries(opts).filter(([, v]) => typeof v === "string")) as Record<string, string>;
      states = withPluginState(states, "agent", id, (s) => ({ ...s, options: { ...s.options, ...options } }));
    }
  }
  for (const id of list(plugins.disabled)) states = withPluginState(states, "view", id, (s) => ({ ...s, enabled: false }));
  // A tool from before @owner/name was owner/name: 0001 installs it as @owner/name.
  const tool = (id: string) => (id.startsWith("@") ? id : `@${id}`);
  for (const id of list(tools.enabledPlugins)) states = withPluginState(states, "tool", tool(id), (s) => ({ ...s, enabled: true }));
  for (const toolId of list(tools.disabledTools)) {
    const cut = toolId.lastIndexOf("/");
    if (cut <= 0) continue;
    states = withPluginState(states, "tool", tool(toolId.slice(0, cut)), (s) => ({ ...s, options: { ...s.options, [toolId.slice(cut + 1)]: false } }));
  }
  return parsePluginStates(states);
}

/** Write `plugins.state` from the old keys, when the file has them and no state yet. 0001 runs it
 *  first: it reads the state to switch each adopted plugin as it was. */
export async function writePluginStateFromOldKeys(file = settingsPath()): Promise<boolean> {
  let raw: unknown;
  try { raw = JSON.parse(await readFile(file, "utf8")); } catch { return false; }
  if (!isObj(raw) || !hasOldKeys(raw) || (isObj(raw.plugins) && isObj(raw.plugins.state))) return false;
  const state = statesFromOldKeys(raw);
  await updateSettings((cur) => ({ ...cur, plugins: { ...cur.plugins, state } }), file);
  return true;
}

export const m0002: Migration = {
  id: "0002-plugin-state-from-old-keys",
  root: "config",
  backsUp: ["settings.json"],
  movesFilesAnOlderAppReads: false,
  async run() {
    const file = settingsPath();
    const moved = await writePluginStateFromOldKeys(file);
    let raw: unknown = {};
    try { raw = JSON.parse(await readFile(file, "utf8")); } catch { /* no settings yet */ }
    const left = isObj(raw) ? ["tools", "migrated"].filter((k) => k in raw) : [];
    if (left.length) await patchSettingsExtras(Object.fromEntries(left.map((k) => [k, undefined])), file);
    return { moved, removed: left };
  },
};
