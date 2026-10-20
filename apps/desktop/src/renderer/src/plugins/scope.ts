import { PLUGIN_TABS, type PluginTab } from "./kinds";

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

/** Which tab the Plugins page shows, remembered the same way. */
const TAB_KEY = "hivemind:plugins-tab";
export function pluginsTab(): PluginTab {
  try { const t = localStorage.getItem(TAB_KEY); return PLUGIN_TABS.find((k) => k === t) ?? "agent"; } catch { return "agent"; }
}
export function setPluginsTab(tab: PluginTab): void {
  try { localStorage.setItem(TAB_KEY, tab); } catch { /* private window */ }
}

/** The package to open when the page next shows the Packages tab: one a member's page links to. */
let opening: string | null = null;
export function showPackage(id: string): void {
  opening = id;
  setPluginsScope("installed");
  setPluginsTab("package");
}
export function takeOpeningPackage(): string | null {
  const id = opening;
  opening = null;
  return id;
}
