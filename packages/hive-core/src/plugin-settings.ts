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
import { FIELD_ID, MAX_TEXT, parseSettingFields, type SettingField } from "@hivemind/view-sdk/settings";
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
  options?: Record<string, string | number | boolean>;
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

/** The stored state from anything (settings.json): each record checked, a bad one dropped. */
export function parsePluginStates(raw: unknown): Record<string, PluginState> {
  const out: Record<string, PluginState> = {};
  if (!isObj(raw)) return out;
  for (const [key, v] of Object.entries(raw).slice(0, MAX_PLUGINS)) {
    if (!keyOk(key) || !isObj(v)) continue;
    const state: PluginState = {};
    if (typeof v.enabled === "boolean") state.enabled = v.enabled;
    if (isObj(v.options)) {
      const options: Record<string, string | number | boolean> = {};
      for (const [k, x] of Object.entries(v.options).slice(0, MAX_OPTIONS)) {
        if (!FIELD_ID.test(k)) continue;
        if (typeof x === "boolean" || (typeof x === "number" && Number.isFinite(x))) options[k] = x;
        else if (typeof x === "string") options[k] = x.slice(0, MAX_TEXT);
      }
      if (Object.keys(options).length) state.options = options;
    }
    if (state.enabled !== undefined || state.options) out[key] = state;
  }
  return out;
}

/** Whether a plugin is on: as stored, else as it is by default. */
export function isPluginEnabled(states: Record<string, PluginState>, kind: PluginKind, id: string, byDefault = true): boolean {
  return states[pluginKey(kind, id)]?.enabled ?? byDefault;
}

/** The ids of `kind` switched off. */
export function disabledPlugins(states: Record<string, PluginState>, kind: PluginKind): string[] {
  return Object.entries(states).filter(([k, s]) => k.startsWith(`${kind}:`) && s.enabled === false).map(([k]) => k.slice(kind.length + 1));
}

/** The values stored for a plugin's fields (unchecked: resolve them against its fields). */
export function pluginOptions(states: Record<string, PluginState>, kind: PluginKind, id: string): Record<string, string | number | boolean> {
  return states[pluginKey(kind, id)]?.options ?? {};
}

/** Option values as an agent's launch takes them: its options are all text. */
export function stringOptions(options: Record<string, string | number | boolean>): Record<string, string> {
  return Object.fromEntries(Object.entries(options).filter((e): e is [string, string] => typeof e[1] === "string"));
}

/** `states` with one plugin's record changed; a record left empty is removed. */
export function withPluginState(states: Record<string, PluginState>, kind: PluginKind, id: string, change: (s: PluginState) => PluginState): Record<string, PluginState> {
  const key = pluginKey(kind, id);
  const next = change({ ...states[key] });
  const out = { ...states };
  if (next.enabled === undefined && (!next.options || !Object.keys(next.options).length)) delete out[key];
  else out[key] = next;
  return out;
}

/**
 * The records the settings.json of a version before plugin state held, in its own keys:
 * `agents.disabled`, `agents.options`, `plugins.disabled` (views), `tools.enabledPlugins` and
 * `tools.disabledTools` (a tool switched off inside a plugin is that plugin's option, false).
 */
export function pluginStatesFromLegacy(raw: Record<string, unknown>): Record<string, PluginState> {
  let states: Record<string, PluginState> = {};
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const agents = isObj(raw.agents) ? raw.agents : {};
  const plugins = isObj(raw.plugins) ? raw.plugins : {};
  const tools = isObj(raw.tools) ? raw.tools : {};
  for (const id of list(agents.disabled)) states = withPluginState(states, "agent", id, (s) => ({ ...s, enabled: false }));
  if (isObj(agents.options)) {
    for (const [id, opts] of Object.entries(agents.options)) {
      if (!isObj(opts)) continue;
      const options = Object.fromEntries(Object.entries(opts).filter(([, v]) => typeof v === "string")) as Record<string, string>;
      states = withPluginState(states, "agent", id, (s) => ({ ...s, options: { ...s.options, ...options } }));
    }
  }
  for (const id of list(plugins.disabled)) states = withPluginState(states, "view", id, (s) => ({ ...s, enabled: false }));
  for (const id of list(tools.enabledPlugins)) states = withPluginState(states, "tool", id, (s) => ({ ...s, enabled: true }));
  for (const toolId of list(tools.disabledTools)) {
    const cut = toolId.lastIndexOf("/");
    if (cut <= 0) continue;
    states = withPluginState(states, "tool", toolId.slice(0, cut), (s) => ({ ...s, options: { ...s.options, [toolId.slice(cut + 1)]: false } }));
  }
  return parsePluginStates(states);
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
