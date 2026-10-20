/**
 * `hive plugins` — every plugin on this machine, of every kind, and what is stored for each: on or
 * off, and the values set for the settings it declares. The same record the app's Settings ▸
 * Plugins writes (`plugins.state["<kind>:<id>"]` in settings.json); a running app picks a change
 * up at once.
 *
 *   hive plugins new <tool|widget|view> <name> [--dir <folder>] [--owner <login>]   a starter that works, with PROMPT.md
 *   hive plugins install <folder|id>               a folder holding a plugin, or one from HiveHub
 *                                                  (@owner/name is HiveHub's: write a folder as ./x)
 *   hive plugins remove <plugin>                   one you added; what shows it stays, saying it is missing
 *   hive plugins check <folder> [--json]           its types, its manifest, and its code drawn once
 *   hive plugins api --kind <tool|widget|view>     what its code is given, as type declarations
 *   hive plugins list [--kind agent|view|widget|tool] [--json]
 *   hive plugins show <plugin> [--json]            its settings: each field, its value and what it takes
 *
 * A plugin is named by its id, or as <kind>:<id> when two kinds have that id.
 *   hive plugins enable <plugin>  |  disable <plugin>
 *   hive plugins set <plugin> <setting> <value>    checked against the setting (a choice, a number…)
 *   hive plugins reset <plugin> [setting]          back to its default (every setting, without one)
 *   hive plugins workspaces <tool> [folder…] [--none]   the workspaces a tool's service may drive
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { defineCommand } from "citty";
import { HiveError, findRoot, listInstalledViews, readSettings, updateSettings } from "@hivemind/core";
import {
  PLUGIN_KINDS, agentSettingFields, isPluginEnabled, isPluginId, parseSettingValue, pluginKey, pluginOptions, resolveSettings,
  serviceWorkspaces, toolSettingFields, withPluginState, type PluginKind, type PluginState, type SettingField,
} from "@hivemind/core/plugin-settings";
import { BUNDLED_TOOL_PLUGINS } from "@hivemind/core/tool-plugins";
import { listWidgets } from "@hivemind/core/widgets";
import { listToolPackages } from "@hivemind/core/tool-packages";
import { err, ok } from "../format.js";
import { driveCall } from "../drive.js";
import { personOnly } from "../person-only.js";
import { KINDS, kindNamed, type AuthoredKind } from "../plugin-kinds.js";
import { stageFromRegistry } from "../registry.js";
import { checkPlugin, DRAW_ALONE } from "../check/check.js";
import { where } from "../check/problem.js";

interface Plugin {
  key: string;
  kind: PluginKind;
  id: string;
  name: string;
  /** On unless switched off; a tool that is not built in is off until switched on. */
  enabledByDefault: boolean;
  fields: SettingField[];
  problem: string | null;
  /** What its service runs, for a tool plugin that brings one. */
  service?: string[];
  /** The tools `hive ctl open-tool` opens, for a tool plugin. */
  opens?: string[];
  /** Where it is installed, for one you added. */
  dir?: string;
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
    ...views.map((v): Plugin => ({ key: pluginKey("view", v.id), kind: "view", id: v.id, name: v.manifest?.name ?? v.id, enabledByDefault: true, fields: v.manifest?.settings ?? [], problem: v.error, dir: v.dir })),
    ...widgets.map((w): Plugin => ({ key: pluginKey("widget", w.id), kind: "widget", id: w.id, name: w.name, enabledByDefault: true, fields: [], problem: null, ...(w.dir ? { dir: w.dir } : {}) })),
    ...BUNDLED_TOOL_PLUGINS.map((t): Plugin => ({ key: pluginKey("tool", t.id), kind: "tool", id: t.id, name: t.tools.map((x) => x.label).join(", "), enabledByDefault: !!t.builtin, fields: toolSettingFields(t), problem: null, opens: opensOf(t) })),
    ...added.map((t): Plugin => ({ key: pluginKey("tool", t.id), kind: "tool", id: t.id, name: t.name, enabledByDefault: false, fields: [...toolSettingFields(t), ...t.settings], problem: t.problem, ...(t.service ? { service: t.service.command } : {}), opens: opensOf(t), dir: t.dir })),
  ];
  return out;
}

const opensOf = (t: { id: string; tools: readonly { key: string; tileKind?: string }[] }): string[] =>
  t.tools.filter((x) => x.tileKind).map((x) => `${t.id}/${x.key}`);

/** A plugin by its id, or by `<kind>:<id>` when two kinds have that id. */
async function find(raw: string): Promise<Plugin> {
  const all = await inventory();
  const cut = raw.indexOf(":");
  const kind = raw.slice(0, cut) as PluginKind;
  if (cut > 0 && PLUGIN_KINDS.includes(kind)) {
    const id = raw.slice(cut + 1);
    const p = isPluginId(kind, id) ? all.find((x) => x.kind === kind && x.id === id) : undefined;
    if (!p) throw new Error(`there is no ${kind} "${id}" on this machine (\`hive plugins list --kind ${kind}\`)`);
    return p;
  }
  const named = all.filter((x) => x.id === raw);
  if (named.length === 1) return named[0]!;
  if (named.length > 1) throw new Error(`"${raw}" is ${named.map((x) => x.key).join(" and ")}: name one of those`);
  throw new Error(`there is no plugin "${raw}" on this machine (\`hive plugins list\` shows them)`);
}

/** One plugin's record changed inside the settings lock, and a running app told. */
async function change(p: Plugin, fn: (s: PluginState) => PluginState): Promise<{ state: PluginState; reloaded: boolean }> {
  const after = await updateSettings((cur) => ({ ...cur, plugins: { ...cur.plugins, state: withPluginState(cur.plugins.state, p.kind, p.id, fn) } }));
  const reloaded = await driveCall("settings.reload", [], 5000).then(() => true, () => false);
  return { state: after.plugins.state[p.key] ?? {}, reloaded };
}
const note = (reloaded: boolean) => (reloaded ? "app reloaded" : "app not running — applies on next start");
const fail = (ctx: { json: boolean }, e: unknown, code: string): never =>
  err(ctx, e instanceof HiveError ? e.code : code, e instanceof Error ? e.message : String(e));
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
        ...(p.opens ? { opens: p.opens } : {}), ...(p.dir ? { dir: p.dir } : {}),
      }));
      return ok(ctx, { plugins: rows }, () => rows.map((r) => [`${r.enabled ? "on " : "off"}  ${r.key.padEnd(30)} ${r.name}${r.problem ? `  (${r.problem})` : ""}`,
        ...(r.opens ?? []).map((t) => `       open-tool ${t}`)].join("\n")).join("\n") || "no plugins");
    } catch (e) { return fail(ctx, e, "list_failed"); }
  },
});

const showCmd = defineCommand({
  meta: { name: "show", description: "One plugin's settings: each one's value and what it takes" },
  args: { plugin: { type: "positional", required: true, description: "its id, or <kind>:<id>, e.g. agent:claude" }, json: { type: "boolean" } },
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
  args: { plugin: { type: "positional", required: true, description: "its id, or <kind>:<id>" }, json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    personOnly(ctx, on ? "switch plugins on" : "switch plugins off", `hive plugins ${on ? "enable" : "disable"} ${String(args.plugin)}`);
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
    plugin: { type: "positional", required: true, description: "its id, or <kind>:<id>" },
    setting: { type: "positional", required: true },
    value: { type: "positional", required: true },
    json: { type: "boolean" },
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    personOnly(ctx, "change a plugin's settings", `hive plugins set ${String(args.plugin)} ${String(args.setting)} ${String(args.value)}`);
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
  args: { plugin: { type: "positional", required: true, description: "its id, or <kind>:<id>" }, setting: { type: "positional", required: false }, json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    personOnly(ctx, "change a plugin's settings", `hive plugins reset ${String(args.plugin)}${args.setting ? ` ${String(args.setting)}` : ""}`);
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

/** A folder as the drive socket compares it: in full, links followed. */
const realFolder = (f: string): string => {
  const full = path.resolve(f);
  try { return fs.realpathSync(full); } catch { return full; }
};

const workspacesCmd = defineCommand({
  meta: { name: "workspaces", description: "The workspaces a tool plugin's service may drive: set them, clear them with --none, or show them" },
  args: {
    plugin: { type: "positional", required: true, description: "@owner/name of a tool" },
    none: { type: "boolean", description: "it may drive none: it stops" },
    json: { type: "boolean" },
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const p = await find(String(args.plugin));
      if (!p.service) throw new Error(`${p.key} brings no service`);
      const folders = (args._ as string[]).slice(1).map(realFolder);
      if (!folders.length && !args.none) {
        const workspaces = serviceWorkspaces((await readSettings()).plugins.state, p.id);
        return ok(ctx, { key: p.key, workspaces }, () => (workspaces.length ? workspaces.join("\n") : `none: ${p.key}'s service waits for one`));
      }
      personOnly(ctx, "choose the workspaces a plugin's service drives", `hive plugins workspaces ${p.key} ${args.none ? "--none" : folders.join(" ")}`);
      const { state, reloaded } = await change(p, ({ workspaces: _, ...s }) => (folders.length ? { ...s, workspaces: [...new Set(folders)] } : s));
      const workspaces = state.workspaces ?? [];
      return ok(ctx, { key: p.key, workspaces, reloaded }, () => `${p.key}'s service drives ${workspaces.length ? workspaces.join(", ") : "nothing"}; ${note(reloaded)}`);
    } catch (e) { return fail(ctx, e, "workspaces_failed"); }
  },
});

// ── writing and installing: one path for every kind in KINDS ──────────────────

/** The GitHub login `gh` is signed in as: a plugin's owner is its publisher's account. */
function githubLogin(): string | null {
  try { return execFileSync("gh", ["api", "user", "--jq", ".login"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; } catch { return null; }
}

/** Ask a running app to load them again. False when no app is reachable. */
async function rescanApp(k: AuthoredKind): Promise<boolean> {
  try { for (const m of k.rescan) await driveCall(m, [], 5000); return true; } catch { return false; }
}
const appNote = (rescanned: boolean) => (rescanned ? "app updated" : "app not running — it loads it when it starts");
const steps = (lines: string[]) => lines.map((l) => `  ${l}`).join("\n");
const KIND_NAMES = KINDS.map((k) => k.kind).join(", ");
/** An id HiveHub lists: `@owner/name`. */
const HUB_ID = /^@[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9-]{0,63}$/;

const newCmd = defineCommand({
  meta: { name: "new", description: "Start a plugin that works as written, with a PROMPT.md to hand your coding agent" },
  args: {
    kind: { type: "positional", required: true, description: KIND_NAMES },
    name: { type: "positional", required: true, description: "lowercase letters, digits and single dashes" },
    dir: { type: "string", description: "the folder to start it in (default: ./<name>); it must be empty or not there" },
    owner: { type: "string", description: "your GitHub login (default: the account `gh` is signed in as)" },
    json: { type: "boolean" },
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const k = kindNamed(String(args.kind));
    if (!k) return err(ctx, "usage", `the kind is one of: ${KIND_NAMES}`, 2);
    const name = String(args.name);
    if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(name) || name.includes("--")) return err(ctx, "bad_name", `"${name}" is not a name: lowercase letters, digits and single dashes`);
    const owner = (args.owner ? String(args.owner) : githubLogin())?.replace(/^@/, "").toLowerCase() ?? null;
    if (!owner) return err(ctx, "no_owner", `pass --owner <your GitHub login>: a ${k.noun} is published under its owner's login`);
    const id = k.idOf(owner, name);
    const given = args.dir ? String(args.dir) : name;
    const dir = path.resolve(given);
    // Printed as a path, so `install` never reads it as an id on HiveHub.
    const shown = /^(\.{1,2}\/|\/|~)/.test(given) ? given : `./${given}`;
    const there = fs.existsSync(dir);
    if (there && (!fs.statSync(dir).isDirectory() || (await readdir(dir)).length)) return err(ctx, "exists", `${dir} is already there and not an empty folder`);
    try {
      for (const [file, text] of Object.entries(k.starter(owner, name))) {
        await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
        await writeFile(path.join(dir, file), text);
      }
    } catch (e) {
      // Half a starter is worse than none: what was written goes, the folder too if it was made here.
      if (there) for (const f of await readdir(dir).catch(() => [])) await rm(path.join(dir, f), { recursive: true, force: true });
      else await rm(dir, { recursive: true, force: true });
      return fail(ctx, e, "new_failed");
    }
    const next = [...k.prepare(shown), `hive plugins check ${shown}`, ...k.add(shown), ...(k.onByDefault ? [] : [`hive plugins enable ${k.kind}:${id}`]), ...k.see(id)];
    return ok(ctx, { kind: k.kind, id, dir, next, prompt: path.join(dir, "PROMPT.md"), guide: k.guide }, () => [
      `started ${k.noun} ${id} in ${dir}`, "Next:", steps(next),
      `Want an agent to build it? Write your idea into ${shown}/PROMPT.md and hand it that file.`,
      `Guide: ${k.guide}`,
    ].join("\n"));
  },
});

const installCmd = defineCommand({
  meta: { name: "install", description: "Add a plugin from a folder, or from HiveHub by its id" },
  args: { source: { type: "positional", required: true, description: `a folder holding ${KINDS.map((k) => k.manifest).join(", ")} (./x, ../x, /x or ~/x); or an id on HiveHub (@owner/name)` }, json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const source = String(args.source);
    let staged: string | null = null;
    // Errors exit the process (`err` does), so a `finally` would never run: discard by hand.
    const discard = async () => { if (staged) await rm(staged, { recursive: true, force: true }).catch(() => {}); };
    try {
      let k: AuthoredKind | undefined;
      let hubId: string | undefined;
      // An id is always HiveHub's: a folder in someone else's repository cannot pass for it.
      if (HUB_ID.test(source)) {
        const folder = fs.existsSync(source) ? `; to install the folder, write ./${source}` : "";
        const got = await stageFromRegistry(source).catch((e: unknown) => { throw new Error(`${e instanceof Error ? e.message : String(e)}${folder}`); });
        staged = got.dir;
        k = kindNamed(got.entry.type);
        if (!k) throw new Error(`${source} is an agent: \`hive agents install ${source}\``);
        hubId = source;
      } else if (fs.existsSync(source)) {
        k = KINDS.find((x) => fs.existsSync(path.join(source, x.manifest)));
        if (!k) throw new Error(`${path.resolve(source)} holds no ${KINDS.map((x) => x.manifest).join(", ")}`);
      } else {
        throw new Error(`there is no folder ${path.resolve(source)}, and "${source}" is not an id on HiveHub`);
      }
      const p = await k.install(staged ?? path.resolve(source), hubId);
      await discard();
      const rescanned = await rescanApp(k);
      const enabled = isPluginEnabled((await readSettings()).plugins.state, k.kind, p.id, k.onByDefault);
      const next = [...(enabled ? [] : [`hive plugins enable ${k.kind}:${p.id}`]), ...k.see(p.id)];
      return ok(ctx, { kind: k.kind, id: p.id, name: p.name, dir: p.dir, enabled, rescanned, next }, () => [
        `installed ${k.noun} ${p.id} (${p.name}) → ${p.dir}; ${appNote(rescanned)}`,
        enabled ? "It is on." : "It is off until you switch it on, if you trust who wrote it.",
        "Next:", steps(next),
      ].join("\n"));
    } catch (e) { await discard(); return fail(ctx, e, "install_failed"); }
  },
});

const removeCmd = defineCommand({
  meta: { name: "remove", description: "Remove a plugin you added" },
  args: { plugin: { type: "positional", required: true, description: "its id, or <kind>:<id>" }, json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const p = await find(String(args.plugin));
      const k = kindNamed(p.kind);
      if (!k) throw new Error(`${p.key} is an agent: \`hive agents remove ${p.id}\``);
      await k.remove(p.id);
      const rescanned = await rescanApp(k);
      return ok(ctx, { key: p.key, rescanned }, () => `removed ${p.key}; ${appNote(rescanned)}`);
    } catch (e) { return fail(ctx, e, "remove_failed"); }
  },
});

const checkCmd = defineCommand({
  meta: { name: "check", description: "Check a plugin's folder: its types, its manifest, and its code loaded and drawn once against a fake app. It runs the plugin's own code, as `bun test` would: check only code you would run" },
  args: { folder: { type: "positional", required: true, description: "the plugin's folder" }, json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const dir = path.resolve(String(args.folder));
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return err(ctx, "not_found", `there is no folder ${dir}`);
    const k = KINDS.find((x) => fs.existsSync(path.join(dir, x.manifest)));
    if (!k) return err(ctx, "not_a_plugin", `${dir} holds no ${KINDS.map((x) => x.manifest).join(", ")}`);
    if (process.env[DRAW_ALONE] === "1") {
      const problems = await k.draw(dir).catch((e: unknown) => [{ step: "draw", message: `drawing it failed: ${e instanceof Error ? e.message : String(e)}` }]);
      process.stdout.write(JSON.stringify(problems) + "\n");
      process.exit(0);
    }
    const report = await checkPlugin(k, dir).catch((e: unknown) => fail(ctx, e, "check_failed"));
    const text = () => [
      ...report.problems.map((p) => `${p.step.padEnd(8)} ${where(p) ? `${where(p)}  ` : ""}${p.message}`),
      `${report.problems.length ? `${report.problems.length} problem${report.problems.length === 1 ? "" : "s"}` : "ok"}: ${k.noun} in ${dir}`,
      ...Object.entries(report.steps).map(([step, s]) => `  ${step.padEnd(9)} ${s}`),
      ...report.notes,
      "It ran the plugin's own code, in its folder, with only PATH and HOME of your environment.",
    ].join("\n");
    // The plugin's code may have left timers or sockets open: what it did is known, so stop here.
    if (!report.problems.length) { ok(ctx, report, text); process.exit(0); }
    // With problems it is still the report, on stdout as a result is, and the exit says it failed.
    if (ctx.json) console.log(JSON.stringify(report));
    else process.stderr.write(text() + "\n");
    process.exit(1);
  },
});

const apiCmd = defineCommand({
  meta: { name: "api", description: "What a plugin's code is given: the declarations its starter's types hold, for this version" },
  args: { kind: { type: "string", required: true, description: KIND_NAMES } },
  run({ args }) {
    const k = kindNamed(String(args.kind));
    if (!k) return err({ json: false }, "usage", `--kind is one of: ${KIND_NAMES}`, 2);
    process.stdout.write(k.api());
  },
});

export const pluginsCmd = defineCommand({
  meta: { name: "plugins", description: "Tools, widgets, views and agents: start, install, remove; on or off, and their settings" },
  subCommands: { new: newCmd, check: checkCmd, install: installCmd, remove: removeCmd, api: apiCmd, list: listCmd, show: showCmd, enable: switchCmd(true), disable: switchCmd(false), set: setCmd, reset: resetCmd, workspaces: workspacesCmd },
});
