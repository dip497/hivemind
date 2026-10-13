/** Settings navigation: fixed pages, grouped, plus one page per plugin of any kind
 *  (`plugin:agent:claude`, `plugin:view:canvas`, `plugin:widget:pet`, `plugin:tool:hivemind/web`).
 *  `chunk` keeps cheap pages out of the lazy Settings bundle. */
import { Bell, Blocks, Info, Key, Keyboard, Palette, UserRound, UserPlus, Network, MonitorSmartphone } from "./components/icons";
import type { Icon } from "./components/icons";

export type SettingsGroup = "General" | "Connect" | "Plugins" | "Advanced";
export const SETTINGS_GROUPS: readonly SettingsGroup[] = ["General", "Connect", "Plugins", "Advanced"];

export interface SettingsPageDef {
  id: string;
  group: SettingsGroup;
  /** Sidebar label; `title` is the page heading when it differs. */
  label: string;
  title?: string;
  /** One muted line under the label: what the person does there, where the label alone may not say. */
  hint?: string;
  icon: Icon;
  description: string;
  /** "eager" = rendered by App.tsx itself; "lazy" = by the Settings chunk. */
  chunk: "eager" | "lazy";
}

export const SETTINGS_PAGES: readonly SettingsPageDef[] = [
  { id: "profile", group: "General", label: "Profile", icon: UserRound, description: "Your name and colour, and this computer's ids.", chunk: "lazy" },
  { id: "appearance", group: "General", label: "Appearance", icon: Palette, description: "Theme, wallpaper, and effects.", chunk: "lazy" },
  { id: "notifications", group: "General", label: "Notifications", icon: Bell, description: "Alerts and sounds.", chunk: "eager" },
  { id: "shortcuts", group: "General", label: "Shortcuts", icon: Keyboard, description: "Keyboard shortcuts.", chunk: "lazy" },
  { id: "people", group: "Connect", label: "People", hint: "Invite people to this workspace", icon: UserPlus, description: "An invite link to the workspace in this window, who has access, and where it is hosted.", chunk: "lazy" },
  { id: "your-devices", group: "Connect", label: "Your devices", hint: "Your phone, other computers, a browser tab", icon: MonitorSmartphone, description: "Use this app on your phone, on another computer, or in a browser here; and the devices paired with it.", chunk: "lazy" },
  { id: "api", group: "Connect", label: "API access", hint: "Scripts and tools that drive agents", icon: Key, description: "Tokens for scripts and tools that start and answer agents here, and taking them back.", chunk: "lazy" },
  { id: "plugins", group: "Plugins", label: "Plugins", icon: Blocks, description: "Agents, views, widgets and tools: the ones you have and the ones on HiveHub.", chunk: "lazy" },
  { id: "servers", group: "Advanced", label: "Servers", hint: "Relay and discovery; most people never change this", icon: Network, description: "The relay and discovery servers this computer uses, if any.", chunk: "lazy" },
  { id: "about", group: "Advanced", label: "About and updates", icon: Info, description: "Version, updates, and whether the app checks for them.", chunk: "eager" },
] as const;

/** The sidebar: each group's pages, in order. */
export const SETTINGS_NAV: ReadonlyArray<{ group: SettingsGroup; pages: readonly SettingsPageDef[] }> =
  SETTINGS_GROUPS.map((group) => ({ group, pages: SETTINGS_PAGES.filter((p) => p.group === group) }));

export const SETTINGS_PAGE_IDS: readonly string[] = SETTINGS_PAGES.map((p) => p.id);

/** A plugin's page, always in the lazy chunk: `plugin:<kind>:<id>`. */
export const PLUGIN_PAGE_KINDS = ["agent", "view", "widget", "tool"] as const;
export type PluginPageKind = (typeof PLUGIN_PAGE_KINDS)[number];

export function pluginPage(id: string): { kind: PluginPageKind; pluginId: string } | null {
  const m = /^plugin:([a-z]+):(.+)$/.exec(id);
  return m && (PLUGIN_PAGE_KINDS as readonly string[]).includes(m[1]!) ? { kind: m[1] as PluginPageKind, pluginId: m[2]! } : null;
}

/** Pages renamed for what the person does there, by their old ids. */
const RENAMED: Record<string, string> = { share: "people", network: "servers", devices: "your-devices", programs: "api" };

/** Where old ids lead now: a renamed page to its new id; the per-kind lists Plugins replaced to
 *  Plugins, a plugin's own settings page (`agent:claude`) to its page. */
function moved(id: string): string | null {
  if (Object.hasOwn(RENAMED, id)) return RENAMED[id]!;
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
