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
