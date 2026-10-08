/** Settings navigation: fixed pages, grouped, plus one page per plugin of any kind
 *  (`plugin:agent:claude`, `plugin:view:canvas`, `plugin:widget:pet`, `plugin:tool:hivemind/web`).
 *  `chunk` keeps cheap pages out of the lazy Settings bundle. */
import { Bell, Blocks, Info, Keyboard, Palette, UserRound, UserPlus, Network, MonitorSmartphone } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type SettingsGroup = "General" | "Plugins";
export const SETTINGS_GROUPS: readonly SettingsGroup[] = ["General", "Plugins"];

export interface SettingsPageDef {
  id: string;
  group: SettingsGroup;
  /** Sidebar label; `title` is the page heading when it differs. */
  label: string;
  title?: string;
  icon: LucideIcon;
  description: string;
  /** "eager" = rendered by App.tsx itself; "lazy" = by the Settings chunk. */
  chunk: "eager" | "lazy";
}

export const SETTINGS_PAGES: readonly SettingsPageDef[] = [
  { id: "profile", group: "General", label: "Profile", icon: UserRound, description: "Your name and colour, and this computer's ids.", chunk: "lazy" },
  { id: "share", group: "General", label: "Share", title: "Share this workspace", icon: UserPlus, description: "Invite people to the workspace in this window, and where it is hosted.", chunk: "lazy" },
  { id: "network", group: "General", label: "Network", icon: Network, description: "Which servers this computer uses, if any, and the update check.", chunk: "lazy" },
  { id: "devices", group: "General", label: "Devices", icon: MonitorSmartphone, description: "Your hosts and other computers, and pairing another.", chunk: "lazy" },
  { id: "appearance", group: "General", label: "Appearance", icon: Palette, description: "Theme, wallpaper, and effects.", chunk: "lazy" },
  { id: "notifications", group: "General", label: "Notifications", icon: Bell, description: "Alerts and sounds.", chunk: "eager" },
  { id: "shortcuts", group: "General", label: "Shortcuts", icon: Keyboard, description: "Keyboard shortcuts.", chunk: "lazy" },
  { id: "about", group: "General", label: "About", title: "About and updates", icon: Info, description: "Version and updates.", chunk: "eager" },
  { id: "plugins", group: "Plugins", label: "Plugins", icon: Blocks, description: "Agents, views, widgets and tools: the ones you have and the ones on HiveHub.", chunk: "lazy" },
] as const;

export const SETTINGS_PAGE_IDS: readonly string[] = SETTINGS_PAGES.map((p) => p.id);

/** A plugin's page, always in the lazy chunk: `plugin:<kind>:<id>`. */
export const PLUGIN_PAGE_KINDS = ["agent", "view", "widget", "tool"] as const;
export type PluginPageKind = (typeof PLUGIN_PAGE_KINDS)[number];

export function pluginPage(id: string): { kind: PluginPageKind; pluginId: string } | null {
  const m = /^plugin:([a-z]+):(.+)$/.exec(id);
  return m && (PLUGIN_PAGE_KINDS as readonly string[]).includes(m[1]!) ? { kind: m[1] as PluginPageKind, pluginId: m[2]! } : null;
}

/** Where the ids of the pages Plugins replaced lead now: the per-kind lists to Plugins, a
 *  plugin's own settings page (`agent:claude`) to its page. */
function moved(id: string): string | null {
  if (["agents", "views", "tools", "installed"].includes(id)) return "plugins";
  const m = /^(agent|view|tool):(.+)$/.exec(id);
  return m ? `plugin:${m[1]}:${m[2]}` : null;
}

/** The page an id opens, or null when it names none. */
export function resolveSettingsPage(id: string): string | null {
  const to = moved(id) ?? id;
  return SETTINGS_PAGE_IDS.includes(to) || pluginPage(to) ? to : null;
}

export function settingsPage(id: string): SettingsPageDef | undefined {
  return SETTINGS_PAGES.find((p) => p.id === id);
}
