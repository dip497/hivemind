/**
 * Views, widgets and tools installed before packages lived in `views/`, `widgets/` and `tools/`
 * of the config root. Each folder is installed as a package of one, on or off as it was, with its
 * settings kept (they are keyed by kind and id, which do not change); then the old folders go,
 * their copy kept in this migration's backup. A folder the checks of today refuse is left out and
 * named, and stays in the backup.
 *
 * The rules for which id an old folder was installed as are frozen here: the code that read these
 * folders is gone.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { installPackage, switchPackage } from "../package-install.js";
import { packagesDir, readInstalledPackages } from "../installed-packages.js";
import { pluginKey, type PluginKind, type PluginState } from "../plugin-settings.js";
import { readSettings, settingsPath, updateSettings } from "../settings.js";
import type { Migration } from "./runner.js";

interface OldPlugin { kind: PluginKind; dir: string; path: string; id: string | null }

const folders = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  for (const f of (await readdir(dir).catch(() => [] as string[])).sort()) {
    if (!f.startsWith(".") && (await stat(path.join(dir, f)).catch(() => null))?.isDirectory()) out.push(f);
  }
  return out;
};

/** Every old install, with the id it was installed as where its folder decided it (null: its
 *  manifest did). */
async function oldPlugins(root: string): Promise<OldPlugin[]> {
  const out: OldPlugin[] = [];
  for (const f of await folders(path.join(root, "views"))) {
    const names = f.startsWith("@") ? (await folders(path.join(root, "views", f))).map((n) => `${f}/${n}`) : [f];
    for (const n of names) out.push({ kind: "view", dir: path.join(root, "views", n), path: `views/${n}`, id: null });
  }
  for (const f of await folders(path.join(root, "widgets"))) {
    const dir = path.join(root, "widgets", f);
    let said: unknown;
    try { said = (JSON.parse(await readFile(path.join(dir, "widget.json"), "utf8")) as { id?: unknown }).id; } catch { /* checked when installed */ }
    const scoped = typeof said === "string" && /^@[^/]+\/[^/]+$/.test(said) ? said : null;
    out.push({ kind: "widget", dir, path: `widgets/${f}`, id: scoped && scoped.slice(1).replace("/", "--") === f ? scoped : f });
  }
  for (const f of await folders(path.join(root, "tools"))) {
    if (!f.includes("--")) continue;
    out.push({ kind: "tool", dir: path.join(root, "tools", f), path: `tools/${f}`, id: `@${f.replace("--", "/")}` });
  }
  return out;
}

/** On as it was: views and widgets were on unless switched off; a tool you added was off until
 *  switched on. */
function wasOn(kind: PluginKind, state: PluginState | undefined): boolean {
  return kind === "tool" ? state?.enabled === true : state?.enabled !== false;
}

export const m0001: Migration = {
  id: "0001-adopt-plugins-as-packages",
  root: "config",
  backsUp: ["views", "widgets", "tools", "settings.json"],
  async run(ctx) {
    if (path.resolve(path.dirname(packagesDir())) !== path.resolve(ctx.root)) throw new Error(`the packages of ${ctx.root} are not kept in it`);
    const states = (await readSettings(settingsPath())).plugins.state;
    let adopted = 0;
    const skipped: { path: string; why: string }[] = [];
    for (const old of await oldPlugins(ctx.root)) {
      try {
        const planned = await installPackage(old.dir, { dryRun: true });
        const member = planned.record.members[0]!;
        if (planned.record.members.length !== 1 || member.kind !== old.kind) throw new Error(`it holds ${planned.record.members.map((m) => `${m.kind} ${m.id}`).join(", ")}, not one ${old.kind}`);
        if (old.id && member.id !== old.id) throw new Error(`it was installed as ${old.id}, but it says it is ${member.id}`);
        const installed = (await readInstalledPackages()).find((r) => r.id === planned.record.id);
        if (installed && installed.digest !== planned.record.digest) throw new Error(`${installed.id} ${installed.version} is already installed as a package`);
        await installPackage(old.dir);
        await switchPackage(planned.record.id, wasOn(old.kind, states[pluginKey(old.kind, member.id)]));
        adopted++;
      } catch (e) {
        skipped.push({ path: old.path, why: e instanceof Error ? e.message : String(e) });
      }
    }
    for (const rel of ["views", "widgets", "tools"]) await ctx.remove(rel);
    // A package of one is switched as a whole: its own switch in settings goes.
    const ofOne = new Set((await readInstalledPackages()).filter((r) => r.members.length === 1).map((r) => pluginKey(r.members[0]!.kind as PluginKind, r.members[0]!.id)));
    await updateSettings((cur) => {
      const state = Object.fromEntries(Object.entries(cur.plugins.state).map(([key, s]) => {
        if (!ofOne.has(key as ReturnType<typeof pluginKey>)) return [key, s];
        const { enabled: _, ...kept } = s;
        return [key, kept];
      }).filter(([, s]) => Object.keys(s as object).length));
      return { ...cur, plugins: { ...cur.plugins, state } };
    }, settingsPath());
    return { adopted, skipped };
  },
};
