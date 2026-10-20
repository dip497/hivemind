/**
 * `hive plugins` — every plugin on this machine, of every kind, and what is stored for each: on or
 * off, and the values set for the settings it declares. The same record the app's Settings ▸
 * Plugins writes (`plugins.state["<kind>:<id>"]` in settings.json); a running app picks a change
 * up at once.
 *
 *   hive plugins new <tool|widget|view> <name> [--dir <folder>] [--owner <login>]   a starter that works, with PROMPT.md
 *   hive plugins new package <name> [--dir <folder>]  a package to hold several, with PROMPT.md
 *   hive plugins new <tool|widget|view> <name> --in <package folder>   a starter, as a member of that package
 *   hive plugins add <folder> --to <package folder>  one already written, as a member of that package
 *   hive plugins install <folder|id>               a folder holding a plugin, or one from HiveHub
 *                                                  (@owner/name is HiveHub's: write a folder as ./x);
 *                                                  every install is a package, a folder of one plugin a package of one
 *   hive plugins remove <plugin>                   one you added, with its package; what shows it stays, saying it is missing
 *   hive plugins reload [--json]                   the running app loads every plugin again
 *   hive plugins check <folder> [--json]           its types, its manifest, and its code drawn once;
 *                                                  of a package, its manifest and every member
 *   hive plugins api --kind <tool|widget|view>     what its code is given, as type declarations
 *   hive plugins search [words…] [--kind <kind>] [--limit N] [--json]   HiveHub's plugins, best match first
 *   hive plugins list [--kind agent|view|widget|tool] [--json]
 *   hive plugins show <plugin> [--json]            its settings: each field, its value and what it takes
 *
 * A plugin is named by its id, or as <kind>:<id> when two kinds have that id. A package is named
 * by its id, or as package:<id>: remove, enable and disable take one. A plugin that is part of a
 * bigger package is not installed, removed or switched on apart from it (exit 7).
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
  PLUGIN_KINDS, agentSettingFields, isPluginOn, isPluginId, parseSettingValue, pluginKey, pluginOptions, resolveSettings,
  serviceWorkspaces, toolSettingFields, withPluginState, type PackageOf, type PluginKind, type PluginState, type SettingField,
} from "@hivemind/core/plugin-settings";
import { installPackage, removePackage, removePlugin, rollbackPackage, switchPackage, switchPlugin, type InstalledPackage, type MemberChange } from "@hivemind/core/package-install";
import { readInstalledPackages, type PackageRecord } from "@hivemind/core/installed-packages";
import { memberKind } from "@hivemind/core/package-kinds";
import { BUILTIN_WIDGETS } from "@hivemind/core/widget-format";
import { BUNDLED_TOOL_PLUGINS } from "@hivemind/core/tool-plugins";
import { listWidgets } from "@hivemind/core/widgets";
import { listToolPackages } from "@hivemind/core/tool-packages";
import { err, ok } from "../format.js";
import { driveCall } from "../drive.js";
import { HcpCliError } from "../hcp.js";
import { EXIT } from "../exit-codes.js";
import { personOnly } from "../person-only.js";
import { KINDS, kindNamed, type AuthoredKind } from "../plugin-kinds.js";
import { stageFromRegistry } from "../registry.js";
import { searchPlugins } from "@hivemind/core/plugin-search";
import { checkPlugin, DRAW_ALONE } from "../check/check.js";
import { checkPackage } from "../check/package.js";
import { where } from "../check/problem.js";
import { PACKAGE_MANIFEST, memberFormat } from "@hivemind/hub";
import { addEntry, arrivesOff, memberId, memberPath, packageStarter, readPackageFolder, type PackageFolder } from "../package-authoring.js";

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
  /** The package it was installed with, for one you added. */
  package?: PackageOf;
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
    ...views.map((v): Plugin => ({ key: pluginKey("view", v.id), kind: "view", id: v.id, name: v.manifest?.name ?? v.id, enabledByDefault: true, fields: v.manifest?.settings ?? [], problem: v.error, dir: v.dir, ...(v.package ? { package: v.package } : {}) })),
    ...widgets.map((w): Plugin => ({ key: pluginKey("widget", w.id), kind: "widget", id: w.id, name: w.name, enabledByDefault: true, fields: [], problem: null, ...(w.dir ? { dir: w.dir } : {}), ...(w.package ? { package: w.package } : {}) })),
    ...BUNDLED_TOOL_PLUGINS.map((t): Plugin => ({ key: pluginKey("tool", t.id), kind: "tool", id: t.id, name: t.tools.map((x) => x.label).join(", "), enabledByDefault: !!t.builtin, fields: toolSettingFields(t), problem: null, opens: opensOf(t) })),
    ...added.map((t): Plugin => ({ key: pluginKey("tool", t.id), kind: "tool", id: t.id, name: t.name, enabledByDefault: false, fields: [...toolSettingFields(t), ...t.settings], problem: t.problem, ...(t.service ? { service: t.service.command } : {}), opens: opensOf(t), dir: t.dir, ...(t.package ? { package: t.package } : {}) })),
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

/** What remove, enable and disable name: a plugin, or an installed package by its id
 *  (`package:<id>`, or an id no plugin has). */
async function findTarget(raw: string): Promise<{ plugin: Plugin } | { package: PackageRecord }> {
  const records = await readInstalledPackages();
  if (raw.startsWith("package:")) {
    const r = records.find((x) => x.id === raw.slice("package:".length));
    if (!r) throw new Error(`no package ${raw.slice("package:".length)} is installed (\`hive plugins list\` shows them)`);
    return { package: r };
  }
  try { return { plugin: await find(raw) }; } catch (e) {
    const r = records.find((x) => x.id === raw);
    if (r) return { package: r };
    throw e;
  }
}

/** One plugin's record changed inside the settings lock, and a running app told. */
async function change(p: Plugin, fn: (s: PluginState) => PluginState): Promise<{ state: PluginState; reloaded: boolean }> {
  const after = await updateSettings((cur) => ({ ...cur, plugins: { ...cur.plugins, state: withPluginState(cur.plugins.state, p.kind, p.id, fn) } }));
  const reloaded = await driveCall("settings.reload", [], 5000).then(() => true, () => false);
  return { state: after.plugins.state[p.key] ?? {}, reloaded };
}
const note = (reloaded: boolean) => (reloaded ? "app reloaded" : "app not running — applies on next start");
/** A plugin a package holds, asked to change apart from it, is refused as the control plane
 *  refuses (exit 7); anything else fails (exit 1). */
const fail = (ctx: { json: boolean }, e: unknown, code: string): never =>
  err(ctx, e instanceof HiveError ? e.code : code, e instanceof Error ? e.message : String(e), e instanceof HiveError && e.code === "part_of_a_package" ? 7 : 1);
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
        enabled: isPluginOn(states, p.kind, p, p.enabledByDefault),
        settings: resolveSettings(p.fields, pluginOptions(states, p.kind, p.id)), problem: p.problem,
        ...(p.opens ? { opens: p.opens } : {}), ...(p.dir ? { dir: p.dir } : {}), ...(p.package ? { package: p.package } : {}),
      }));
      return ok(ctx, { plugins: rows }, () => rows.map((r) => [`${r.enabled ? "on " : "off"}  ${r.key.padEnd(30)} ${r.name}${r.package && r.package.members > 1 ? `  [${r.package.id} ${r.package.version}${r.package.on ? "" : ", off"}]` : ""}${r.problem ? `  (${r.problem})` : ""}`,
        ...(r.opens ?? []).map((t) => `       open-tool ${t}`)].join("\n")).join("\n") || "no plugins");
    } catch (e) { return fail(ctx, e, "list_failed"); }
  },
});

const searchCmd = defineCommand({
  meta: { name: "search", description: "Find plugins on HiveHub by words, best match first" },
  args: {
    words: { type: "positional", required: false, description: "every word must start a word of its name, id, category or description" },
    kind: { type: "string", description: "agent, view, widget, tool or package" },
    limit: { type: "string", description: "how many to show, 1 to 100 (default 20)" },
    json: { type: "boolean" },
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const limit = args.limit === undefined ? 20 : Number(args.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return err(ctx, "usage", "--limit is a whole number from 1 to 100");
    const kinds = [...PLUGIN_KINDS, "package"];
    if (args.kind && !kinds.includes(args.kind)) return err(ctx, "usage", `--kind is one of: ${kinds.join(", ")}`);
    const query = (args._ as string[]).join(" ");
    try {
      const { fetchCatalog } = await import("@hivemind/core/plugin-catalog");
      const found = searchPlugins((await fetchCatalog()).plugins.filter((p) => !args.kind || p.type === args.kind), query);
      const shown = found.slice(0, limit).map((p) => ({ id: p.id, type: p.type, name: p.name, description: p.description, category: p.category ?? "other" }));
      return ok(ctx, { plugins: shown, total: found.length }, () => shown.length
        ? [...shown.map((p) => `${p.type.padEnd(7)} ${p.id.padEnd(30)} ${p.description}`),
          ...(found.length > limit ? [`${found.length - limit} more: add a word, or --limit ${Math.min(100, found.length)}`] : []),
          "Install one: hive plugins install <id> (an agent: hive agents install <id>)"].join("\n")
        : `nothing on HiveHub matches "${query}"`);
    } catch (e) { return fail(ctx, e, "search_failed"); }
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
      const data = { key: p.key, name: p.name, enabled: isPluginOn(states, p.kind, p, p.enabledByDefault), fields: p.fields, values, ...(p.package ? { package: p.package } : {}) };
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
      const target = await findTarget(String(args.plugin));
      if ("package" in target) {
        const r = await switchPackage(target.package.id, on);
        const reloaded = (await Promise.all([driveCall("settings.reload", [], 5000).then(() => true, () => false), rescanApp(r.members.map((m) => m.kind))]))[0];
        return ok(ctx, { package: r.id, enabled: on, reloaded }, () => `${r.id} ${on ? "on" : "off"}, with ${r.members.length} plugin${r.members.length === 1 ? "" : "s"}; ${note(reloaded)}`);
      }
      const p = target.plugin;
      // One you added is switched with its package; one that comes with the app by its own setting.
      if (p.package) {
        const pkg = await switchPlugin(p.kind, p.id, on);
        const reloaded = (await Promise.all([driveCall("settings.reload", [], 5000).then(() => true, () => false), rescanApp([p.kind])]))[0];
        return ok(ctx, { key: p.key, enabled: on, package: pkg?.id ?? p.package.id, reloaded }, () => `${p.key} ${on ? "on" : "off"}; ${note(reloaded)}`);
      }
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

/** What the app said when asked to load plugins again: `appError` is null when no app is running. */
type AppAnswer = { rescanned: true; appError: null } | { rescanned: false; appError: string | null };

/** Ask a running app to load plugins of these kinds again. */
async function rescanApp(kinds: readonly string[]): Promise<AppAnswer> {
  const methods = [...new Set(kinds.flatMap((k) => kindNamed(k)?.rescan ?? []))];
  try {
    for (const m of methods) await driveCall(m, [], 5000);
    return { rescanned: true, appError: null };
  } catch (e) {
    if (e instanceof HcpCliError && e.code === "UNAVAILABLE") return { rescanned: false, appError: null };
    return { rescanned: false, appError: e instanceof Error ? e.message : String(e) };
  }
}
const appNote = (a: AppAnswer) => (a.rescanned ? "app updated"
  : a.appError === null ? "app not running — it loads it when it starts"
  : `the app did not load it: ${a.appError}. \`hive plugins reload\` asks it again`);
const steps = (lines: string[]) => lines.map((l) => `  ${l}`).join("\n");
const KIND_NAMES = KINDS.map((k) => k.kind).join(", ");
/** An id HiveHub lists: `@owner/name`. */
const HUB_ID = /^@[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9-]{0,63}$/;

/** The kind `hive plugins new` starts that holds the others. */
const PACKAGE = { kind: "package", noun: "package", guide: "https://hivemind.griiken.com/guide/packages/" } as const;
const NEW_KINDS = `${KIND_NAMES}, ${PACKAGE.kind}`;
/** A folder as printed, so `install` never reads it as an id on HiveHub. */
const shownPath = (given: string) => (given === "." || /^(\.{1,2}\/|\/|~)/.test(given) ? given : `./${given}`);
/** `to` as written from the current folder. */
const shownFrom = (to: string) => shownPath(path.relative(process.cwd(), to) || ".");

/** Write `files` into `dir`; half a starter is worse than none, so a failure takes back what was
 *  written, the folder too if it was made here. */
async function writeStarter(dir: string, files: Record<string, string>): Promise<void> {
  const there = fs.existsSync(dir);
  try {
    for (const [file, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await writeFile(path.join(dir, file), text);
    }
  } catch (e) {
    if (there) for (const f of await readdir(dir).catch(() => [])) await rm(path.join(dir, f), { recursive: true, force: true });
    else await rm(dir, { recursive: true, force: true });
    throw e;
  }
}

const notEmpty = async (dir: string) => fs.existsSync(dir) && (!fs.statSync(dir).isDirectory() || (await readdir(dir)).length > 0);

const newCmd = defineCommand({
  meta: { name: "new", description: "Start a plugin that works as written, or a package to hold several, with a PROMPT.md to hand your coding agent" },
  args: {
    kind: { type: "positional", required: true, description: NEW_KINDS },
    name: { type: "positional", required: true, description: "lowercase letters, digits and single dashes" },
    dir: { type: "string", description: "the folder to start it in (default: ./<name>, or <package>/<tools|widgets|views>/<name> with --in); it must be empty or not there" },
    in: { type: "string", description: "a package's folder: start it there, as one of the package's members" },
    owner: { type: "string", description: "your GitHub login (default: the account `gh` is signed in as; with --in, the package's owner)" },
    json: { type: "boolean" },
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const isPackage = String(args.kind) === PACKAGE.kind;
    const k = isPackage ? null : kindNamed(String(args.kind));
    if (!isPackage && !k) return err(ctx, "usage", `the kind is one of: ${NEW_KINDS}`, 2);
    if (isPackage && args.in) return err(ctx, "usage", "a package holds tools, widgets and views, not another package", 2);
    const name = String(args.name);
    if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(name) || name.includes("--")) return err(ctx, "bad_name", `"${name}" is not a name: lowercase letters, digits and single dashes`);
    let pkg: PackageFolder | null = null;
    if (args.in) {
      try { pkg = await readPackageFolder(String(args.in)); } catch (e) { return fail(ctx, e, "not_a_package"); }
    }
    const given = args.owner ? String(args.owner).replace(/^@/, "").toLowerCase() : null;
    if (pkg && given && given !== pkg.owner) return err(ctx, "not_the_owner", `${pkg.id} is ${pkg.owner}'s: every member of it is @${pkg.owner}/<name>`);
    const owner = pkg?.owner ?? given ?? githubLogin()?.toLowerCase() ?? null;
    if (!owner) return err(ctx, "no_owner", `pass --owner <your GitHub login>: a ${k?.noun ?? PACKAGE.noun} is published under its owner's login`);
    const dir = args.dir ? path.resolve(String(args.dir)) : pkg && k ? path.join(pkg.dir, memberFormat(k.kind)!.list, name) : path.resolve(name);
    const shown = args.dir ? shownPath(String(args.dir)) : shownFrom(dir);
    if (pkg && !dir.startsWith(pkg.dir + path.sep)) return err(ctx, "usage", `--dir must be inside the package, ${pkg.dir}`, 2);
    if (await notEmpty(dir)) return err(ctx, "exists", `${dir} is already there and not an empty folder`);

    if (!k) {
      const id = `@${owner}/${name}`;
      try { await writeStarter(dir, packageStarter(owner, name)); } catch (e) { return fail(ctx, e, "new_failed"); }
      const next = [...KINDS.map((x) => `hive plugins new ${x.kind} <name> --in ${shown}`), `hive plugins add <folder> --to ${shown}`];
      return ok(ctx, { kind: PACKAGE.kind, id, dir, next, prompt: path.join(dir, "PROMPT.md"), guide: PACKAGE.guide }, () => [
        `started package ${id} in ${dir}; it holds nothing yet`, "Add its members:", steps(next),
        `Want an agent to build it? Write your idea into ${shown}/PROMPT.md and hand it that file.`,
        `Guide: ${PACKAGE.guide}`,
      ].join("\n"));
    }

    const id = k.idOf(owner, name);
    const inPackage = pkg ? { root: path.relative(dir, pkg.dir).split(path.sep).join("/"), id: pkg.id } : undefined;
    try {
      await writeStarter(dir, k.starter(owner, name, inPackage));
      if (pkg) await addEntry(pkg, k, memberPath(pkg, k, dir));
    } catch (e) { return fail(ctx, e, "new_failed"); }
    const at = pkg ? shownFrom(pkg.dir) : shown;
    const next = pkg
      ? [...k.prepare(shown), `hive plugins check ${at}`, `hive plugins install ${at}`, ...(arrivesOff(pkg) ? [`hive plugins enable ${pkg.id}`] : []), ...k.see(id)]
      : [...k.prepare(shown), `hive plugins check ${shown}`, ...k.add(shown), ...(k.onByDefault ? [] : [`hive plugins enable ${k.kind}:${id}`]), ...k.see(id)];
    return ok(ctx, { kind: k.kind, id, dir, ...(pkg ? { package: pkg.id } : {}), next, prompt: path.join(dir, "PROMPT.md"), guide: k.guide }, () => [
      `started ${k.noun} ${id} in ${dir}${pkg ? `, a member of ${pkg.id}` : ""}`, "Next:", steps(next),
      `Want an agent to build it? Write your idea into ${shown}/PROMPT.md and hand it that file.`,
      `Guide: ${k.guide}`,
    ].join("\n"));
  },
});

/** Copy a plugin's folder, without what a build or a checkout leaves beside it. */
const copyMember = (from: string, to: string) =>
  fs.cpSync(from, to, { recursive: true, errorOnExist: true, filter: (f) => !["node_modules", ".git"].includes(path.basename(f)) });

const addCmd = defineCommand({
  meta: { name: "add", description: "Make a plugin already written a member of a package: copied into it when it is outside, and named in its hivemind-package.json" },
  args: {
    folder: { type: "positional", required: true, description: "the plugin's folder" },
    to: { type: "string", required: true, description: "the package's folder" },
    json: { type: "boolean" },
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const pkg = await readPackageFolder(String(args.to));
      const from = path.resolve(String(args.folder));
      if (!fs.existsSync(from) || !fs.statSync(from).isDirectory()) return err(ctx, "not_found", `there is no folder ${from}`);
      const k = KINDS.find((x) => fs.existsSync(path.join(from, x.manifest)));
      if (!k) return err(ctx, "not_a_plugin", `${from} holds no ${KINDS.map((x) => x.manifest).join(", ")}`);
      const id = await memberId(k, from);
      if (!id.startsWith(`@${pkg.owner}/`)) return err(ctx, "not_the_owner", `${k.noun} ${id} is not @${pkg.owner}'s: every member of ${pkg.id} is @${pkg.owner}/<name>. Give it an id of @${pkg.owner}/<name> in its ${k.manifest} first`);
      const inside = from.startsWith(pkg.dir + path.sep);
      const dir = inside ? from : path.join(pkg.dir, memberFormat(k.kind)!.list, path.basename(from));
      if (!inside && fs.existsSync(dir)) return err(ctx, "exists", `${dir} is already there: move the plugin into the package yourself, or remove that folder`);
      const entry = memberPath(pkg, k, dir);
      const list = (pkg.manifest[memberFormat(k.kind)!.list] as Array<{ path?: string }> | undefined) ?? [];
      if (list.some((e) => e.path === entry)) return err(ctx, "already_a_member", `${PACKAGE_MANIFEST} already names ${entry}`);
      if (!inside) copyMember(from, dir);
      await addEntry(pkg, k, entry);
      const at = shownFrom(pkg.dir);
      const next = [`hive plugins check ${at}`, `hive plugins install ${at}`, ...(arrivesOff(pkg) ? [`hive plugins enable ${pkg.id}`] : []), ...k.see(id)];
      return ok(ctx, { package: pkg.id, kind: k.kind, id, path: entry, copied: !inside, dir, next }, () => [
        `added ${k.noun} ${id} to ${pkg.id} as ${entry}${inside ? "" : `, copied from ${from}`}`, "Next:", steps(next),
      ].join("\n"));
    } catch (e) { return fail(ctx, e, "add_failed"); }
  },
});

const installCmd = defineCommand({
  meta: { name: "install", description: "Add a plugin from a folder, or from HiveHub by its id" },
  args: { source: { type: "positional", required: true, description: `a folder holding ${KINDS.map((k) => k.manifest).join(", ")} (./x, ../x, /x or ~/x); or an id on HiveHub (@owner/name)` }, "dry-run": { type: "boolean", description: "check it and say what would change, installing nothing" }, json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const source = String(args.source);
    const dryRun = !!args["dry-run"];
    let staged: string | null = null;
    // Errors exit the process (`err` does), so a `finally` would never run: discard by hand.
    const discard = async () => { if (staged) await rm(staged, { recursive: true, force: true }).catch(() => {}); };
    try {
      let hubId: string | undefined;
      // An id is always HiveHub's: a folder in someone else's repository cannot pass for it.
      if (HUB_ID.test(source)) {
        const folder = fs.existsSync(source) ? `; to install the folder, write ./${source}` : "";
        const got = await stageFromRegistry(source).catch((e: unknown) => { throw new Error(`${e instanceof Error ? e.message : String(e)}${folder}`); });
        staged = got.dir;
        if (got.entry.type === "agent") throw new Error(`${source} is an agent: \`hive agents install ${source}\``);
        hubId = source;
      } else if (!fs.existsSync(source)) {
        throw new Error(`there is no folder ${path.resolve(source)}, and "${source}" is not an id on HiveHub`);
      }
      const installed = await installPackage(staged ?? path.resolve(source), { ...(hubId ? { id: hubId } : {}), dryRun });
      await discard();
      const app: AppAnswer = dryRun ? { rescanned: false, appError: null } : await rescanApp(installed.members.map((m) => m.kind));
      const report = { ...installReport(installed, app), installed: !dryRun };
      const { record } = installed;
      return ok(ctx, report, () => [
        dryRun
          ? `would install ${record.id} (${record.name}), version ${record.version}${installed.replaced ? `, replacing ${installed.replaced.version}` : ""}; nothing was installed`
          : `installed ${record.id} (${record.name}), version ${record.version}${installed.replaced ? `, replacing ${installed.replaced.version}` : ""}; ${appNote(app)}`,
        ...installed.members.map((m) => `  ${memberKind(m.kind)?.noun ?? m.kind} ${m.id}${m.permissions.length ? ` (asks for ${m.permissions.join(", ")})` : ""}`),
        ...(installed.replaced ? installed.changes.length ? ["Changes:", ...installed.changes.map((c) => `  ${changeLine(c)}`)] : ["Nothing changed."] : []),
        ...installed.tookOver.map((t) => `It took over ${t}, installed on its own before; what you set it to is kept.`),
        dryRun ? (record.on ? "It would be on." : "It would be off until you switch it on.")
          : record.on ? "It is on." : installed.changes.some((c) => c.switchesOff) && installed.replaced ? `It is off: a change above needs you to trust it again. \`hive plugins rollback ${record.id}\` puts back ${installed.replaced.version}.` : "It is off until you switch it on, if you trust who wrote it.",
        ...(dryRun ? [] : ["Next:", steps(report.next)]),
      ].join("\n"));
    } catch (e) { await discard(); return fail(ctx, e, "install_failed"); }
  },
});

/** What `install` says it did, for a person and as --json. */
function installReport(installed: InstalledPackage, app: AppAnswer) {
  const { record } = installed;
  const next = [...(record.on ? [] : [`hive plugins enable ${record.members.length === 1 ? `${record.members[0]!.kind}:${record.members[0]!.id}` : record.id}`]), ...installed.members.flatMap((m) => kindNamed(m.kind)?.see(m.id) ?? [])];
  return {
    id: record.id, name: record.name, version: record.version, digest: record.digest, on: record.on,
    members: installed.members.map((m) => ({ kind: m.kind, id: m.id, name: m.name, dir: m.dir, permissions: m.permissions })),
    replaced: installed.replaced?.version ?? null, tookOver: installed.tookOver, changes: installed.changes, ...app, next,
  };
}

/** One member's change, in a sentence. */
function changeLine(c: MemberChange): string {
  const what = `${memberKind(c.kind)?.noun ?? c.kind} ${c.id}`;
  if (c.change === "gone") return `${what}: removed`;
  const asks = c.newPermissions.length ? `, now asks for ${c.newPermissions.join(", ")}` : "";
  return `${what}: ${c.change === "new" ? "added" : "changed"}${asks}${c.switchesOff ? " (switches the package off)" : ""}`;
}

const rollbackCmd = defineCommand({
  meta: { name: "rollback", description: "Put back the version of a package in use before its last update" },
  args: { package: { type: "positional", required: true, description: "the package's id" }, json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const { record, from } = await rollbackPackage(String(args.package));
      const app = await rescanApp(record.members.map((m) => m.kind));
      return ok(ctx, { id: record.id, version: record.version, on: record.on, from: from.version, ...app },
        () => `${record.id} is back at version ${record.version}, ${record.on ? "on" : "off"} as it was; ${from.version} is kept, and rolling back again returns to it. ${appNote(app)}`);
    } catch (e) { return fail(ctx, e, "rollback_failed"); }
  },
});

const reloadCmd = defineCommand({
  meta: { name: "reload", description: "Ask the running app to load every plugin again" },
  args: { json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const app = await rescanApp(KINDS.map((k) => k.kind));
    if (app.rescanned) return ok(ctx, app, () => "app reloaded every plugin");
    if (app.appError === null) return err(ctx, "app_not_running", "the app is not running: it loads every plugin when it starts", EXIT.unavailable);
    return err(ctx, "reload_failed", app.appError);
  },
});

const removeCmd = defineCommand({
  meta: { name: "remove", description: "Remove a plugin you added" },
  args: { plugin: { type: "positional", required: true, description: "its id, or <kind>:<id>" }, json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const target = await findTarget(String(args.plugin));
      const said = (gone: PackageRecord, app: AppAnswer) => ok(ctx, { package: gone.id, removed: gone.members.map((m) => `${m.kind}:${m.id}`), ...app },
        () => `removed ${gone.id} (${gone.members.map((m) => `${m.kind}:${m.id}`).join(", ")}); ${appNote(app)}`);
      if ("package" in target) {
        const gone = await removePackage(target.package.id);
        return said(gone, await rescanApp(gone.members.map((m) => m.kind)));
      }
      const p = target.plugin;
      if (p.kind === "agent") throw new Error(`${p.key} is an agent: \`hive agents remove ${p.id}\``);
      if (!p.package) throw new Error(p.kind === "widget" && BUILTIN_WIDGETS.some((b) => b.id === p.id) || p.kind === "tool" ? "it comes with the app" : `${p.key} was not installed with \`hive plugins install\`: it comes with the app or with this repository`);
      const gone = await removePlugin(p.kind, p.id);
      return said(gone, await rescanApp(gone.members.map((m) => m.kind)));
    } catch (e) { return fail(ctx, e, "remove_failed"); }
  },
});

const checkCmd = defineCommand({
  meta: { name: "check", description: "Check a plugin's folder: its types, its manifest, and its code loaded and drawn once against a fake app; of a package's folder, its hivemind-package.json and every member. It runs the plugin's own code, as `bun test` would: check only code you would run" },
  args: { folder: { type: "positional", required: true, description: "the plugin's or the package's folder" }, json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const dir = path.resolve(String(args.folder));
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return err(ctx, "not_found", `there is no folder ${dir}`);
    const isPackage = fs.existsSync(path.join(dir, PACKAGE_MANIFEST));
    const k = isPackage ? null : KINDS.find((x) => fs.existsSync(path.join(dir, x.manifest)));
    if (!isPackage && !k) return err(ctx, "not_a_plugin", `${dir} holds no ${[PACKAGE_MANIFEST, ...KINDS.map((x) => x.manifest)].join(", ")}`);
    if (k && process.env[DRAW_ALONE] === "1") {
      const problems = await k.draw(dir).catch((e: unknown) => [{ step: "draw", message: `drawing it failed: ${e instanceof Error ? e.message : String(e)}` }]);
      process.stdout.write(JSON.stringify(problems) + "\n");
      process.exit(0);
    }
    const report = await (k ? checkPlugin(k, dir) : checkPackage(dir)).catch((e: unknown) => fail(ctx, e, "check_failed"));
    const what = k ? k.noun : `package${"id" in report && report.id ? ` ${report.id}` : ""}`;
    const text = () => [
      ...report.problems.map((p) => `${p.step.padEnd(8)} ${where(p) ? `${where(p)}  ` : ""}${p.message}`),
      `${report.problems.length ? `${report.problems.length} problem${report.problems.length === 1 ? "" : "s"}` : "ok"}: ${what} in ${dir}`,
      ...Object.entries(report.steps).map(([step, s], _, all) => `  ${step.padEnd(Math.max(9, ...all.map(([x]) => x.length + 1)))} ${s}`),
      ...report.notes,
      `It ran ${k ? "the plugin's" : "each member's"} own code, in its folder, with only PATH and HOME of your environment.`,
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
  subCommands: { new: newCmd, add: addCmd, check: checkCmd, install: installCmd, search: searchCmd, rollback: rollbackCmd, reload: reloadCmd, remove: removeCmd, api: apiCmd, list: listCmd, show: showCmd, enable: switchCmd(true), disable: switchCmd(false), set: setCmd, reset: resetCmd, workspaces: workspacesCmd },
});
