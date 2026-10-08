/** The Settings sidebar: fixed pages per group. Every plugin, of every kind, is on the one Plugins
 *  page, and each has its own page from there. Eager: the sidebar renders before the lazy chunk. */
import type { ReactNode } from "react";
import { BUNDLED_TOOL_PLUGINS } from "@hivemind/core/tool-plugins";
import { defFromManifest } from "@hivemind/agents";
import { getAgentEntries } from "./agent-plugins";
import { useViews } from "./workspace/workspace-view";
import { useWidgetPackages } from "./board-objects/widget-runtime";
import { getToolPackages } from "./tiles/tool-plugins";
import { SETTINGS_GROUPS, SETTINGS_PAGES, pluginPage, type SettingsGroup } from "./settings-registry";

export interface SettingsNavItem { id: string; label: string; icon: ReactNode }
export interface SettingsNavGroup { group: SettingsGroup; items: SettingsNavItem[] }

/** Name for any agent Hivemind knows, including ones switched off. */
function agentLabel(id: string): string {
  const entry = getAgentEntries().find((e) => e.id === id && !e.error);
  try { return entry ? defFromManifest(entry.manifest).label : id; } catch { return id; }
}

export const toolLabel = (pluginId: string): string =>
  getToolPackages().find((p) => p.id === pluginId)?.name
  ?? BUNDLED_TOOL_PLUGINS.find((p) => p.id === pluginId)?.tools.map((t) => t.label).join(", ") ?? pluginId;

export function useSettingsNav(): { groups: SettingsNavGroup[]; titleOf: (id: string) => string; describe: (id: string) => string; selected: (page: string) => string } {
  const views = useViews();
  const widgets = useWidgetPackages();
  const groups = SETTINGS_GROUPS.map((group) => ({
    group,
    items: SETTINGS_PAGES.filter((p) => p.group === group).map((p) => ({ id: p.id, label: p.label, icon: <p.icon size={16} /> })),
  }));
  const titleOf = (id: string): string => {
    const fixed = SETTINGS_PAGES.find((p) => p.id === id);
    if (fixed) return fixed.title ?? fixed.label;
    const pp = pluginPage(id);
    if (pp?.kind === "agent") return agentLabel(pp.pluginId);
    if (pp?.kind === "view") return views.find((v) => v.id === pp.pluginId)?.label ?? pp.pluginId;
    if (pp?.kind === "widget") return widgets.find((w) => w.id === pp.pluginId)?.name ?? pp.pluginId;
    if (pp?.kind === "tool") return toolLabel(pp.pluginId);
    return "Settings";
  };
  const describe = (id: string): string => SETTINGS_PAGES.find((p) => p.id === id)?.description ?? `${titleOf(id)}: what it is, its settings and what it can do.`;
  // A plugin's page is reached from Plugins, so Plugins stays the entry shown as current.
  const selected = (page: string): string => (pluginPage(page) ? "plugins" : page);
  return { groups, titleOf, describe, selected };
}
