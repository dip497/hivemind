import { PLUGIN_KINDS, type PluginKind } from "./kinds";

/** Which plugins the Plugins page lists: yours, or HiveHub's. Remembered per window; set before
 *  opening the page when what to show is known (no agent yet: HiveHub). */
export type PluginsScope = "installed" | "hub";
const KEY = "hivemind:plugins-scope";

export function pluginsScope(): PluginsScope {
  try { return localStorage.getItem(KEY) === "hub" ? "hub" : "installed"; } catch { return "installed"; }
}
export function setPluginsScope(scope: PluginsScope): void {
  try { localStorage.setItem(KEY, scope); } catch { /* private window */ }
}

/** Which kind's tab the Plugins page shows, remembered the same way. */
const TAB_KEY = "hivemind:plugins-tab";
export function pluginsTab(): PluginKind {
  try { const t = localStorage.getItem(TAB_KEY); return PLUGIN_KINDS.find((k) => k === t) ?? "agent"; } catch { return "agent"; }
}
export function setPluginsTab(tab: PluginKind): void {
  try { localStorage.setItem(TAB_KEY, tab); } catch { /* private window */ }
}
