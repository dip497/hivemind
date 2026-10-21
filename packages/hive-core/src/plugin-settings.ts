/**
 * What is stored for each plugin, of every kind (agent, view, widget, tool). What a plugin can be
 * set to (its fields) is the view SDK's vocabulary, re-exported here, so the app, the CLI and a
 * plugin's own build check a value the same way.
 *
 * Stored state is one record per plugin (`settings.plugins.state["<kind>:<id>"]`): whether it is
 * on, and the values set for its fields. A value that no longer fits its field (the plugin renamed
 * a choice, changed a type) reads as the field's default; one for a field the plugin no longer
 * declares is kept, unread, so going back to the older version finds it.
 */

import type { AgentProviderDef } from "@hivemind/agents";
import { FIELD_ID, MAX_LIST, MAX_TEXT, parseSettingFields, type SettingField, type SettingValue } from "@hivemind/view-sdk/settings";
import { TOOL_ID_RE, type ToolPluginContribution } from "./tool-registry.js";
import { isWidgetId } from "./widget-format.js";

export * from "@hivemind/view-sdk/settings";

export const PLUGIN_KINDS = ["agent", "view", "widget", "tool"] as const;
export type PluginKind = (typeof PLUGIN_KINDS)[number];
export type PluginKey = `${PluginKind}:${string}`;

export const pluginKey = (kind: PluginKind, id: string): PluginKey => `${kind}:${id}`;

/** What is stored for one plugin. */
export interface PluginState {
  /** On or off; absent: as the plugin is by default. */
  enabled?: boolean;
  /** Values set for its fields, by field id; absent: each field's default. */
  options?: Record<string, SettingValue>;
  /** The workspaces its service may drive, by their folder: none until picked. */
  workspaces?: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// ── stored state ─────────────────────────────────────────────────────────────

/** What an id of each kind looks like; a record under any other key is dropped. */
const ID_OF: Record<PluginKind, { test(id: string): boolean }> = {
  agent: /^[a-z0-9][a-z0-9-]{0,31}$/,
  view: /^(?!.*--)(?:@[a-z0-9][a-z0-9-]{0,38}\/)?[a-z0-9][a-z0-9-]{0,63}$/,
  widget: { test: isWidgetId },
  tool: TOOL_ID_RE,
};
/** Whether `id` is an id a plugin of `kind` can have. */
export const isPluginId = (kind: PluginKind, id: string): boolean => ID_OF[kind].test(id);
const keyOk = (key: string): boolean => {
  const cut = key.indexOf(":");
  const kind = key.slice(0, cut) as PluginKind;
  return cut > 0 && Object.hasOwn(ID_OF, kind) && ID_OF[kind].test(key.slice(cut + 1));
};
const MAX_PLUGINS = 1000;
const MAX_OPTIONS = 60;
const MAX_WORKSPACES = 50;
/** A folder given in full, on any system the settings file came from. */
const FOLDER = /^(\/|[A-Za-z]:[\\/])/;

/** The stored state from anything (settings.json): each record checked, a bad one dropped. */
export function parsePluginStates(raw: unknown): Record<string, PluginState> {
  const out: Record<string, PluginState> = {};
  if (!isObj(raw)) return out;
  for (const [key, v] of Object.entries(raw).slice(0, MAX_PLUGINS)) {
    if (!keyOk(key) || !isObj(v)) continue;
    const state: PluginState = {};
    if (typeof v.enabled === "boolean") state.enabled = v.enabled;
    if (isObj(v.options)) {
      const options: Record<string, SettingValue> = {};
      for (const [k, x] of Object.entries(v.options).slice(0, MAX_OPTIONS)) {
        if (!FIELD_ID.test(k)) continue;
        if (typeof x === "boolean" || (typeof x === "number" && Number.isFinite(x))) options[k] = x;
        else if (typeof x === "string") options[k] = x.slice(0, MAX_TEXT);
        // Several choices, or a list: texts only, as many as a list may hold.
        else if (Array.isArray(x)) options[k] = x.filter((y): y is string => typeof y === "string").slice(0, MAX_LIST).map((y) => y.slice(0, MAX_TEXT));
      }
      if (Object.keys(options).length) state.options = options;
    }
    if (Array.isArray(v.workspaces)) {
      const workspaces = [...new Set(v.workspaces.filter((w): w is string => typeof w === "string" && FOLDER.test(w) && w.length <= 4096))].slice(0, MAX_WORKSPACES);
      if (workspaces.length) state.workspaces = workspaces;
    }
    if (state.enabled !== undefined || state.options || state.workspaces) out[key] = state;
  }
  return out;
}

/** The package an installed plugin belongs to, as its listing carries it. */
export interface PackageOf {
  id: string;
  name: string;
  version: string;
  /** The package's switch. */
  on: boolean;
  /** How many plugins it holds: one is a package of one, whose switch is the plugin's. */
  members: number;
}

/** Whether a plugin loads: one in a package when its package is on and it was not switched off
 *  on its own; any other as `isPluginEnabled` says. */
export function isPluginOn(states: Record<string, PluginState>, kind: PluginKind, plugin: { id: string; package?: PackageOf }, byDefault = true): boolean {
  if (!plugin.package) return isPluginEnabled(states, kind, plugin.id, byDefault);
  return plugin.package.on && states[pluginKey(kind, plugin.id)]?.enabled !== false;
}

/** Whether a plugin is on: as stored, else as it is by default. */
export function isPluginEnabled(states: Record<string, PluginState>, kind: PluginKind, id: string, byDefault = true): boolean {
  return states[pluginKey(kind, id)]?.enabled ?? byDefault;
}

/** The workspaces a tool plugin's service may drive. */
export function serviceWorkspaces(states: Record<string, PluginState>, id: string): string[] {
  return states[pluginKey("tool", id)]?.workspaces ?? [];
}

/** The ids of `kind` switched off. */
export function disabledPlugins(states: Record<string, PluginState>, kind: PluginKind): string[] {
  return Object.entries(states).filter(([k, s]) => k.startsWith(`${kind}:`) && s.enabled === false).map(([k]) => k.slice(kind.length + 1));
}

/** The values stored for a plugin's fields (unchecked: resolve them against its fields). */
export function pluginOptions(states: Record<string, PluginState>, kind: PluginKind, id: string): Record<string, SettingValue> {
  return states[pluginKey(kind, id)]?.options ?? {};
}

/** Option values as an agent's launch takes them: its options are all text. */
export function stringOptions(options: Record<string, SettingValue>): Record<string, string> {
  return Object.fromEntries(Object.entries(options).filter((e): e is [string, string] => typeof e[1] === "string"));
}

/** `states` with one plugin's record changed; a record left empty is removed. */
export function withPluginState(states: Record<string, PluginState>, kind: PluginKind, id: string, change: (s: PluginState) => PluginState): Record<string, PluginState> {
  const key = pluginKey(kind, id);
  const next = change({ ...states[key] });
  const out = { ...states };
  if (next.enabled === undefined && (!next.options || !Object.keys(next.options).length) && !next.workspaces?.length) delete out[key];
  else out[key] = next;
  return out;
}

// ── fields of the kinds that declare them their own way ─────────────────────

/** An agent's launch options as fields: one with its own values and no flag is a choice of
 *  them ("default": pass nothing); one with a flag takes any text (its values are the agent's,
 *  listed by its own CLI, so they are not known here). */
export function agentSettingFields(def: Pick<AgentProviderDef, "options">): SettingField[] {
  return parseSettingFields((def.options ?? []).map((o) => (!o.flag && o.values
    ? { id: o.id, label: o.label, type: "choice", values: ["default", ...Object.keys(o.values)], default: o.default ?? "default" }
    : { id: o.id, label: o.label, type: "text", default: o.default ?? "", maxLength: 200 })));
}

/** A tool plugin's tools as fields: each one on until switched off inside the plugin. */
export function toolSettingFields(plugin: Pick<ToolPluginContribution, "tools">): SettingField[] {
  return parseSettingFields(plugin.tools.map((t) => ({ id: t.key, label: t.label, type: "boolean", default: true, ...(t.description ? { description: t.description } : {}) })));
}
