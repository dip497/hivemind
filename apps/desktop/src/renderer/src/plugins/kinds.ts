/** The four kinds of plugin, and which rows the Plugins page shows under each kind's tab, as
 *  HiveHub's home has them: one kind per tab, then a group per category. */
import { groupByCategory, type PluginCategory } from "@hivemind/view-sdk/category";

export type PluginKind = "agent" | "view" | "widget" | "tool";
/** The tabs' order. */
export const PLUGIN_KINDS: readonly PluginKind[] = ["agent", "view", "widget", "tool"];
export const KIND_LABEL: Record<PluginKind, string> = { agent: "Agent", view: "View", widget: "Widget", tool: "Tool" };

export interface KindTab<T> {
  /** How many rows each kind's tab has. */
  counts: Record<PluginKind, number>;
  /** The open tab's rows under their categories, in PLUGIN_CATEGORIES order; empty ones left out. */
  groups: [PluginCategory, T[]][];
}

export function rowsInKindTab<T extends { kind: PluginKind; category: PluginCategory }>(rows: readonly T[], tab: PluginKind): KindTab<T> {
  const counts = { agent: 0, view: 0, widget: 0, tool: 0 };
  for (const r of rows) counts[r.kind]++;
  return { counts, groups: groupByCategory(rows.filter((r) => r.kind === tab), (r) => r.category) };
}
