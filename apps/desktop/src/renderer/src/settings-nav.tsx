/** The Settings sidebar: fixed pages per group, plus a page for each installed agent,
 *  each view, and each tool. Eager: the sidebar renders before the lazy chunk loads. */
import { useState, type ReactNode } from "react";
import { Globe2 } from "lucide-react";
import { BUNDLED_TOOL_PLUGINS } from "@hivemind/core/tool-plugins";
import { SvgMark, useAgents } from "./agents";
import { BUILTIN_CATALOG, GENERIC_AGENT_ICON, defFromManifest } from "@hivemind/agents";
import { getAgentEntries, notReady, useAgentPresence } from "./agent-plugins";
import { useViews } from "./workspace/workspace-view";
import { SETTINGS_GROUPS, SETTINGS_PAGES, pluginPage, type SettingsGroup } from "./settings-registry";

export interface SettingsNavItem { id: string; label: string; icon: ReactNode; /** One agent/view/tool, hidden while its group is folded. */ plugin?: boolean }
export interface SettingsNavGroup { group: SettingsGroup; items: SettingsNavItem[] }

const EXPANDED_KEY = "hivemind:settings-nav-expanded";

/** Groups opened to list their agents, views or tools; folded (Overview only) until then. */
export function useExpandedGroups(): [Set<SettingsGroup>, (g: SettingsGroup) => void] {
  const [expanded, setExpanded] = useState<Set<SettingsGroup>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? "[]") as SettingsGroup[]); } catch { return new Set(); }
  });
  const toggle = (g: SettingsGroup) => setExpanded((cur) => {
    const next = new Set(cur);
    if (!next.delete(g)) next.add(g);
    try { localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next])); } catch { /* private window */ }
    return next;
  });
  return [expanded, toggle];
}

/** Name and mark for any agent Hivemind knows, including ones switched off. */
function agentDef(id: string) {
  const builtin = BUILTIN_CATALOG.find((d) => d.id === id);
  if (builtin) return builtin;
  const entry = getAgentEntries().find((e) => e.id === id && !e.error);
  try { return entry ? defFromManifest(entry.manifest) : undefined; } catch { return undefined; }
}
const agentLabel = (id: string): string => agentDef(id)?.label ?? id;
const agentIcon = (id: string) => agentDef(id)?.icon ?? GENERIC_AGENT_ICON;

export const toolLabel = (pluginId: string): string =>
  BUNDLED_TOOL_PLUGINS.find((p) => p.id === pluginId)?.tools.map((t) => t.label).join(", ") ?? pluginId;

export function useSettingsNav(current?: string): { groups: SettingsNavGroup[]; titleOf: (id: string) => string; describe: (id: string) => string } {
  const agents = useAgents();
  const presence = useAgentPresence();
  const views = useViews();
  const plugin: Record<string, SettingsNavItem[]> = {
    Agents: [
      ...agents
        .filter((a) => a.enabled && !notReady(presence, a.id))
        .map((a) => ({ id: `agent:${a.id}`, label: a.label, icon: <a.icon size={15} />, plugin: true })),
      // The page you are on keeps its place, even once switched off or missing.
      ...(current?.startsWith("agent:") && !agents.some((a) => `agent:${a.id}` === current && a.enabled && !notReady(presence, a.id))
        ? [{ id: current, label: agentLabel(current.slice(6)), icon: <SvgMark icon={agentIcon(current.slice(6))} size={15} />, plugin: true }] : []),
    ],
    Views: views.map((v) => ({ id: `view:${v.id}`, label: v.label, icon: <v.icon size={15} strokeWidth={1.7} />, plugin: true })),
    Tools: BUNDLED_TOOL_PLUGINS.map((p) => ({ id: `tool:${p.id}`, label: toolLabel(p.id), icon: <Globe2 size={15} strokeWidth={1.7} />, plugin: true })),
  };
  const groups = SETTINGS_GROUPS.map((group) => ({
    group,
    items: [
      ...SETTINGS_PAGES.filter((p) => p.group === group).map((p) => ({ id: p.id, label: p.label, icon: <p.icon size={16} strokeWidth={1.7} /> })),
      ...(plugin[group] ?? []),
    ],
  }));
  const titleOf = (id: string): string => {
    const fixed = SETTINGS_PAGES.find((p) => p.id === id);
    if (fixed) return fixed.title ?? fixed.label;
    const pp = pluginPage(id);
    if (pp?.kind === "agent") return agentLabel(pp.pluginId);
    if (pp?.kind === "view") return views.find((v) => v.id === pp.pluginId)?.label ?? pp.pluginId;
    if (pp?.kind === "tool") return toolLabel(pp.pluginId);
    return "Settings";
  };
  const describe = (id: string): string => SETTINGS_PAGES.find((p) => p.id === id)?.description ?? `Settings for ${titleOf(id)}.`;
  return { groups, titleOf, describe };
}
