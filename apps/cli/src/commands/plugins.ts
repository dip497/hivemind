/**
 * `hive plugins` — every plugin on this machine, of every kind, and what is stored for each: on or
 * off, and the values set for the settings it declares. The same record the app's Settings ▸
 * Plugins writes (`plugins.state["<kind>:<id>"]` in settings.json); a running app picks a change
 * up at once.
 *
 *   hive plugins list [--kind agent|view|widget|tool] [--json]
 *   hive plugins show <kind:id> [--json]           its settings: each field, its value and what it takes
 *   hive plugins enable <kind:id>  |  disable <kind:id>
 *   hive plugins set <kind:id> <setting> <value>   checked against the setting (a choice, a number…)
 *   hive plugins reset <kind:id> [setting]         back to its default (every setting, without one)
 */
import { defineCommand } from "citty";
import { findRoot, listInstalledViews, readSettings, updateSettings } from "@hivemind/core";
import {
  PLUGIN_KINDS, agentSettingFields, isPluginEnabled, isPluginId, parseSettingValue, pluginKey, pluginOptions, resolveSettings,
  toolSettingFields, withPluginState, type PluginKind, type PluginState, type SettingField,
} from "@hivemind/core/plugin-settings";
import { BUNDLED_TOOL_PLUGINS } from "@hivemind/core/tool-plugins";
import { listWidgets } from "@hivemind/core/widgets";
import { listToolPackages } from "@hivemind/core/tool-packages";
import { err, ok } from "../format.js";
import { driveCall } from "../drive.js";

interface Plugin {
  key: string;
  kind: PluginKind;
  id: string;
  name: string;
  /** On unless switched off; a tool that is not built in is off until switched on. */
  enabledByDefault: boolean;
  fields: SettingField[];
  problem: string | null;
}

/** Every plugin this machine has: agents, installed views, widgets (built in and added), tools
 *  (built in and added). */
async function inventory(): Promise<Plugin[]> {
  const repoRoot = await findRoot().catch(() => null);
  const { loadAgents } = await import("@hivemind/agents/load");
  const agents = (await loadAgents({ repoRoot: repoRoot ?? undefined, disabled: [] })).loaded;
  const views = await listInstalledViews(repoRoot);
  const widgets = await listWidgets();
  const added = await listToolPackages();
  const out: Plugin[] = [
    ...agents.map((a): Plugin => ({ key: pluginKey("agent", a.id), kind: "agent", id: a.id, name: a.def?.label ?? a.id, enabledByDefault: true, fields: a.def ? agentSettingFields(a.def) : [], problem: a.error })),
    ...views.map((v): Plugin => ({ key: pluginKey("view", v.id), kind: "view", id: v.id, name: v.manifest?.name ?? v.id, enabledByDefault: true, fields: v.manifest?.settings ?? [], problem: v.error })),
    ...widgets.map((w): Plugin => ({ key: pluginKey("widget", w.id), kind: "widget", id: w.id, name: w.name, enabledByDefault: true, fields: [], problem: null })),
    ...BUNDLED_TOOL_PLUGINS.map((t): Plugin => ({ key: pluginKey("tool", t.id), kind: "tool", id: t.id, name: t.tools.map((x) => x.label).join(", "), enabledByDefault: !!t.builtin, fields: toolSettingFields(t), problem: null })),
    ...added.map((t): Plugin => ({ key: pluginKey("tool", t.id), kind: "tool", id: t.id, name: t.name, enabledByDefault: false, fields: [...toolSettingFields(t), ...t.settings], problem: t.problem })),
  ];
  return out;
}

/** `agent:claude` as a kind and an id; throws what a key looks like. */
function parseKey(raw: string): { kind: PluginKind; id: string } {
  const cut = raw.indexOf(":");
  const kind = raw.slice(0, cut) as PluginKind;
  const id = raw.slice(cut + 1);
  if (cut <= 0 || !PLUGIN_KINDS.includes(kind) || !isPluginId(kind, id)) {
    throw new Error(`"${raw}" is not a plugin: write <kind>:<id>, the kind one of ${PLUGIN_KINDS.join(", ")} (\`hive plugins list\` shows them)`);
  }
  return { kind, id };
}

async function find(raw: string): Promise<Plugin> {
  const { kind, id } = parseKey(raw);
  const p = (await inventory()).find((x) => x.kind === kind && x.id === id);
  if (!p) throw new Error(`there is no ${kind} "${id}" on this machine (\`hive plugins list --kind ${kind}\`)`);
  return p;
}

/** One plugin's record changed inside the settings lock, and a running app told. */
async function change(p: Plugin, fn: (s: PluginState) => PluginState): Promise<{ state: PluginState; reloaded: boolean }> {
  const after = await updateSettings((cur) => ({ ...cur, plugins: { ...cur.plugins, state: withPluginState(cur.plugins.state, p.kind, p.id, fn) } }));
  const reloaded = await driveCall("settings.reload", [], 5000).then(() => true, () => false);
  return { state: after.plugins.state[p.key] ?? {}, reloaded };
}
const note = (reloaded: boolean) => (reloaded ? "app reloaded" : "app not running — applies on next start");
const fail = (ctx: { json: boolean }, e: unknown, code: string): never => err(ctx, code, e instanceof Error ? e.message : String(e));
const show = (v: unknown) => (typeof v === "string" ? JSON.stringify(v) : String(v));

const listCmd = defineCommand({
  meta: { name: "list", description: "Every plugin on this machine, on or off" },
  args: { kind: { type: "string", description: "agent, view, widget or tool" }, json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    if (args.kind && !PLUGIN_KINDS.includes(args.kind as PluginKind)) return err(ctx, "usage", `--kind is one of: ${PLUGIN_KINDS.join(", ")}`);
    try {
      const states = (await readSettings()).plugins.state;
      const rows = (await inventory()).filter((p) => !args.kind || p.kind === args.kind).map((p) => ({
        key: p.key, kind: p.kind, id: p.id, name: p.name,
        enabled: isPluginEnabled(states, p.kind, p.id, p.enabledByDefault),
        settings: resolveSettings(p.fields, pluginOptions(states, p.kind, p.id)), problem: p.problem,
      }));
      return ok(ctx, rows, () => rows.map((r) => `${r.enabled ? "on " : "off"}  ${r.key.padEnd(30)} ${r.name}${r.problem ? `  (${r.problem})` : ""}`).join("\n") || "no plugins");
    } catch (e) { return fail(ctx, e, "list_failed"); }
  },
});

const showCmd = defineCommand({
  meta: { name: "show", description: "One plugin's settings: each one's value and what it takes" },
  args: { plugin: { type: "positional", required: true, description: "<kind>:<id>, e.g. agent:claude" }, json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const p = await find(String(args.plugin));
      const states = (await readSettings()).plugins.state;
      const values = resolveSettings(p.fields, pluginOptions(states, p.kind, p.id));
      const data = { key: p.key, name: p.name, enabled: isPluginEnabled(states, p.kind, p.id, p.enabledByDefault), fields: p.fields, values };
      return ok(ctx, data, () => [`${p.name} (${p.key}) — ${data.enabled ? "on" : "off"}`,
        ...(p.fields.length ? p.fields.map((f) => `  ${f.id.padEnd(16)} ${show(values[f.id]).padEnd(14)} ${f.type === "choice" ? f.values.join(" | ") : f.type}${f.label !== f.id ? `  ${f.label}` : ""}`)
          : ["  nothing to set"])].join("\n"));
    } catch (e) { return fail(ctx, e, "show_failed"); }
  },
});

const switchCmd = (on: boolean) => defineCommand({
  meta: { name: on ? "enable" : "disable", description: on ? "Switch a plugin on" : "Switch a plugin off (one that runs keeps running until closed)" },
  args: { plugin: { type: "positional", required: true, description: "<kind>:<id>" }, json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const p = await find(String(args.plugin));
      const { reloaded } = await change(p, (s) => ({ ...s, enabled: on }));
      return ok(ctx, { key: p.key, enabled: on, reloaded }, () => `${p.key} ${on ? "on" : "off"}; ${note(reloaded)}`);
    } catch (e) { return fail(ctx, e, "switch_failed"); }
  },
});

const setCmd = defineCommand({
  meta: { name: "set", description: "Set one of a plugin's settings, checked against what it takes" },
  args: {
    plugin: { type: "positional", required: true, description: "<kind>:<id>" },
    setting: { type: "positional", required: true },
    value: { type: "positional", required: true },
    json: { type: "boolean" },
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const p = await find(String(args.plugin));
      const field = p.fields.find((f) => f.id === args.setting);
      if (!field) throw new Error(`${p.key} has no setting "${args.setting}"${p.fields.length ? `; it has: ${p.fields.map((f) => f.id).join(", ")}` : ""}`);
      const value = parseSettingValue(field, String(args.value));
      const { reloaded } = await change(p, (s) => ({ ...s, options: { ...s.options, [field.id]: value } }));
      return ok(ctx, { key: p.key, setting: field.id, value, reloaded }, () => `${p.key} ${field.id} = ${show(value)}; ${note(reloaded)}`);
    } catch (e) { return fail(ctx, e, "set_failed"); }
  },
});

const resetCmd = defineCommand({
  meta: { name: "reset", description: "Put a plugin's setting (or every one, and on/off) back to its default" },
  args: { plugin: { type: "positional", required: true, description: "<kind>:<id>" }, setting: { type: "positional", required: false }, json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const p = await find(String(args.plugin));
      const one = args.setting ? String(args.setting) : null;
      const { state, reloaded } = await change(p, (s) => {
        if (!one) return {};
        const { [one]: _, ...options } = s.options ?? {};
        return { ...s, options };
      });
      return ok(ctx, { key: p.key, state, reloaded }, () => `${p.key} ${one ?? "every setting"} back to its default; ${note(reloaded)}`);
    } catch (e) { return fail(ctx, e, "reset_failed"); }
  },
});

export const pluginsCmd = defineCommand({
  meta: { name: "plugins", description: "Agents, views, widgets and tools: on or off, and their settings" },
  subCommands: { list: listCmd, show: showCmd, enable: switchCmd(true), disable: switchCmd(false), set: setCmd, reset: resetCmd },
});
