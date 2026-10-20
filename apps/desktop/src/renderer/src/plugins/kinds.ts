/** The four kinds of plugin, and which rows the Plugins page shows under each tab, as HiveHub's
 *  home has them: one kind per tab, then a group per category; the last tab lists the packages
 *  that hold several plugins. */
import { groupByCategory, type PluginCategory } from "@hivemind/view-sdk/category";

export type PluginKind = "agent" | "view" | "widget" | "tool";
export const PLUGIN_KINDS: readonly PluginKind[] = ["agent", "view", "widget", "tool"];
export const KIND_LABEL: Record<PluginKind, string> = { agent: "Agent", view: "View", widget: "Widget", tool: "Tool" };

export type PluginTab = PluginKind | "package";
/** The tabs' order. */
export const PLUGIN_TABS: readonly PluginTab[] = [...PLUGIN_KINDS, "package"];
export const TAB_LABEL: Record<PluginTab, string> = { agent: "Agents", view: "Views", widget: "Widgets", tool: "Tools", package: "Packages" };

export interface KindTab<T> {
  /** How many rows each tab has. */
  counts: Record<PluginTab, number>;
  /** The open tab's rows under their categories, in PLUGIN_CATEGORIES order; empty ones left out.
   *  Packages have no category: their tab is one group without a heading. */
  groups: [PluginCategory | null, T[]][];
}

export function rowsInKindTab<T extends { kind: PluginTab; category: PluginCategory }>(rows: readonly T[], tab: PluginTab): KindTab<T> {
  const counts = { agent: 0, view: 0, widget: 0, tool: 0, package: 0 };
  for (const r of rows) counts[r.kind]++;
  const open = rows.filter((r) => r.kind === tab);
  return { counts, groups: tab === "package" ? (open.length ? [[null, open]] : []) : groupByCategory(open, (r) => r.category) };
}
