/**
 * `hive theme` — the looks: the built-in presets and the themes installed packages hold.
 *
 *   hive theme list                      presets and installed themes (@owner/package/theme), the one in use marked
 *   hive theme use <preset | theme id>   switch to it; a theme's files are copied beside settings.json
 *   hive theme revert                    back to the look before the theme
 *   hive theme export [file] | import <file>
 *
 * Each edits settings.json and asks a running app to reload (`settings.reload`). Looks stay
 * drivable by an agent the person asks: Revert is one step.
 */
import { defineCommand } from "citty";
import { promises as fs } from "node:fs";
import {
  DEFAULT_APPEARANCE, HiveError, PRESETS, exportAppearance, importAppearance, readSettings, updateSettings,
} from "@hivemind/core";
import { IMPORT_EXTRA_PATHS, PRESET_PATHS, importedExtra, withPreset } from "@hivemind/core/appearance-extra";
import { applyTheme, listInstalledThemes, revertTheme, themeStatus } from "@hivemind/core/theme-apply";
import { err, ok } from "../format.js";
import { driveCall } from "../drive.js";

async function reloadApp(): Promise<boolean> {
  try { await driveCall("settings.reload", [], 5000); return true; } catch { return false; }
}
const note = (r: boolean) => (r ? "app reloaded" : "app not running — applies on next start");
const fail = (ctx: { json: boolean }, e: unknown, code: string): never => err(ctx, e instanceof HiveError ? e.code : code, e instanceof Error ? e.message : String(e));

const listCmd = defineCommand({
  meta: { name: "list", description: "List the presets and the themes installed packages hold" },
  args: { json: { type: "boolean" } },
  async run({ args }) {
    const s = await readSettings();
    const record = s.appearanceExtra.theme;
    const { themes, problems } = await listInstalledThemes();
    const status = themeStatus(record, themes);
    const rows = [
      ...Object.values(PRESETS).map((p) => ({ id: p.id, label: p.label, kind: "preset" as const, mode: p.mode, active: !record && p.id === s.appearance.preset })),
      ...themes.map((t) => ({ id: t.id, label: t.name, kind: "theme" as const, mode: t.mode, active: record?.id === t.id, package: t.package.id, version: t.package.version })),
    ];
    // Applied from a package that is gone: the look stays, said once.
    const applied = record ? { id: record.id, name: record.name, version: record.version, update: status?.update ?? null, removed: status?.removed ?? false } : null;
    return ok({ json: !!args.json }, { themes: rows, applied, problems }, () => [
      ...rows.map((r) => `${r.active ? "*" : " "} ${r.id.padEnd(30)} ${r.label}${r.kind === "theme" ? `  [${r.version}${r.mode === "light" ? ", light" : ""}]` : r.mode === "light" ? "  [light]" : ""}`),
      ...(applied?.removed ? [`* ${applied.id.padEnd(30)} ${applied.name}  (its package was removed)`] : []),
      ...(applied?.update ? [`${applied.name} ${applied.update} is installed; you have ${applied.version} applied: \`hive theme use ${applied.id}\``] : []),
      ...(record ? ["`hive theme revert` goes back to the look before it."] : []),
      ...problems.map((p) => `  ${p.id}: cannot be read: ${p.problem}`),
    ].join("\n"));
  },
});

const useCmd = defineCommand({
  meta: { name: "use", description: "Switch to a preset (colours, accent) or an installed theme (@owner/package/theme)" },
  args: { look: { type: "positional", required: true, description: "a preset's id, or a theme's (`hive theme list`)" }, json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const id = String(args.look);
    const p = PRESETS[id];
    if (p) {
      await updateSettings((cur) => withPreset(cur, p), undefined, PRESET_PATHS);
      const rescanned = await reloadApp();
      return ok(ctx, { preset: p.id, rescanned }, () => `theme: ${p.label}; ${note(rescanned)}`);
    }
    const { themes } = await listInstalledThemes();
    const t = themes.find((x) => x.id === id);
    if (!t) return err(ctx, "not_found", `no preset or installed theme "${id}" (presets: ${Object.keys(PRESETS).join(", ")}${themes.length ? `; themes: ${themes.map((x) => x.id).join(", ")}` : ""})`);
    try {
      const s = await applyTheme(t);
      const rescanned = await reloadApp();
      return ok(ctx, { theme: t.id, name: t.name, version: t.package.version, mode: s.appearance.mode, rescanned },
        () => `theme: ${t.name} ${t.package.version}; ${note(rescanned)}\n\`hive theme revert\` goes back to the look before it.`);
    } catch (e) { return fail(ctx, e, "apply_failed"); }
  },
});

const revertCmd = defineCommand({
  meta: { name: "revert", description: "Go back to the look before the theme in use" },
  args: { json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const was = (await readSettings()).appearanceExtra.theme;
    if (!was) return err(ctx, "not_found", "no theme is applied: there is no look to go back to");
    try {
      const s = await revertTheme();
      const rescanned = await reloadApp();
      return ok(ctx, { reverted: was.id, preset: s.appearance.preset, rescanned }, () => `left ${was.name}: back to the look before it; ${note(rescanned)}`);
    } catch (e) { return fail(ctx, e, "revert_failed"); }
  },
});

const exportCmd = defineCommand({
  meta: { name: "export", description: "Write the current appearance as JSON (stdout or a file), without its media files" },
  args: { file: { type: "positional", required: false }, json: { type: "boolean" } },
  async run({ args }) {
    const s = await readSettings();
    const { theme, leftOut, note } = exportAppearance(s.appearance, s.appearanceExtra);
    const text = JSON.stringify(theme, null, 2) + "\n";
    if (args.file) {
      await fs.writeFile(String(args.file), text, "utf8");
      return ok({ json: !!args.json }, { file: String(args.file), leftOut }, () => `wrote ${args.file}${note ? `\n${note}` : ""}`);
    }
    process.stdout.write(text);
    // Not on stdout, which is the file.
    if (note) process.stderr.write(`${note}\n`);
  },
});

const importCmd = defineCommand({
  meta: { name: "import", description: "Replace the appearance with a theme file or a whole settings.json's (validated); your wallpaper media and overlays stay" },
  args: { file: { type: "positional", required: true }, json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    let raw: unknown;
    try { raw = JSON.parse(await fs.readFile(String(args.file), "utf8")); } catch (e) { return err(ctx, "invalid_theme", `cannot read ${args.file}: ${(e as Error).message}`); }
    // A file that sets nothing of the look (a package.json picked by mistake) is refused before the
    // settings are touched; importAppearance says why.
    try { importAppearance(raw, DEFAULT_APPEARANCE); } catch (e) { return err(ctx, "invalid_theme", `cannot import ${args.file}: ${(e as Error).message}`); }
    const written = await updateSettings((cur) => ({ ...cur, appearance: importAppearance(raw, cur.appearance), appearanceExtra: importedExtra(raw, cur.appearanceExtra) }), undefined, ["appearance", ...IMPORT_EXTRA_PATHS]);
    const appearance = written.appearance;
    const rescanned = await reloadApp();
    return ok(ctx, { preset: appearance.preset, rescanned }, () => `imported ${args.file} (preset ${appearance.preset}); ${note(rescanned)}`);
  },
});

export const themeCmd = defineCommand({
  meta: { name: "theme", description: "Looks: presets and the themes packages hold — list, use, revert, export, import" },
  subCommands: { list: listCmd, use: useCmd, revert: revertCmd, export: exportCmd, import: importCmd },
});
