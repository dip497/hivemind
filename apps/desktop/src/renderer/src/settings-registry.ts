/** Settings navigation: fixed pages, grouped, plus one page per plugin (`agent:claude`,
 *  `view:canvas`, `tool:browser`). `chunk` keeps cheap pages out of the lazy Settings bundle. */
import { Bell, Bot, Info, Keyboard, Layers, Package, Palette, Store, Wrench } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type SettingsGroup = "General" | "Agents" | "Views" | "Tools" | "Plugins";
export const SETTINGS_GROUPS: readonly SettingsGroup[] = ["General", "Agents", "Views", "Tools", "Plugins"];

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
  { id: "appearance", group: "General", label: "Appearance", icon: Palette, description: "Theme, wallpaper, and effects.", chunk: "lazy" },
  { id: "notifications", group: "General", label: "Notifications", icon: Bell, description: "Alerts and sounds.", chunk: "eager" },
  { id: "shortcuts", group: "General", label: "Shortcuts", icon: Keyboard, description: "Keyboard shortcuts.", chunk: "lazy" },
  { id: "about", group: "General", label: "About", title: "About and updates", icon: Info, description: "Version and updates.", chunk: "eager" },
  { id: "agents", group: "Agents", label: "All agents", title: "Agents", icon: Bot, description: "The default agent, and which agents this machine has.", chunk: "lazy" },
  { id: "views", group: "Views", label: "All views", title: "Views", icon: Layers, description: "The workspace view you work in.", chunk: "lazy" },
  { id: "tools", group: "Tools", label: "All tools", title: "Tools", icon: Wrench, description: "Tiles you can open next to your agents.", chunk: "lazy" },
  { id: "plugins", group: "Plugins", label: "Browse", title: "Browse plugins", icon: Store, description: "Agents and views others have published.", chunk: "lazy" },
  { id: "installed", group: "Plugins", label: "Installed", title: "Installed plugins", icon: Package, description: "Plugins you added, and adding one from a folder.", chunk: "lazy" },
] as const;

export const SETTINGS_PAGE_IDS: readonly string[] = SETTINGS_PAGES.map((p) => p.id);

/** Per-plugin pages, always in the lazy chunk. */
export const PLUGIN_PAGE_KINDS = ["agent", "view", "tool"] as const;
export type PluginPageKind = (typeof PLUGIN_PAGE_KINDS)[number];

export function pluginPage(id: string): { kind: PluginPageKind; pluginId: string } | null {
  const [kind, ...rest] = id.split(":");
  const pluginId = rest.join(":");
  return (PLUGIN_PAGE_KINDS as readonly string[]).includes(kind!) && pluginId ? { kind: kind as PluginPageKind, pluginId } : null;
}

/** Old page ids still sent by `hivemind:open-settings` callers and saved links. */
const ALIASES: Record<string, string> = { extensions: "installed" };

export function resolveSettingsPage(id: string): string | null {
  const real = ALIASES[id] ?? id;
  return SETTINGS_PAGE_IDS.includes(real) || pluginPage(real) ? real : null;
}

export function settingsPage(id: string): SettingsPageDef | undefined {
  return SETTINGS_PAGES.find((p) => p.id === (ALIASES[id] ?? id));
}
