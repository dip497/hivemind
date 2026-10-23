/**
 * `hive config` — read/write settings.json (the app's one configuration file)
 * and `hive theme` — the appearance presets. Both edit the file directly and
 * ask a running app to reload on its drive socket (`settings.reload`), so a change shows
 * without a restart; without an app they just say so.
 *
 *   hive config path
 *   hive config get [appearance.glass.blur]      whole file or one dotted path (JSON)
 *   hive config set appearance.glass.blur 12     value is JSON (strings need quotes: '"nord"')
 *   hive theme list | use <preset> | export [file] | import <file>
 */
import { defineCommand } from "citty";
import { promises as fs } from "node:fs";
import {
  HiveError, PRESETS, applyPreset, exportAppearance, getPath, importAppearance, patchSettingsFile, readSettings, settingsPath, updateSettings,
} from "@hivemind/core";
import { err, ok } from "../format.js";
import { driveCall } from "../drive.js";
import { personOnly } from "../person-only.js";

async function reloadApp(): Promise<boolean> {
  try { await driveCall("settings.reload", [], 5000); return true; } catch { return false; }
}
const note = (r: boolean) => (r ? "app reloaded" : "app not running — applies on next start");
const fail = (ctx: { json: boolean }, e: unknown, code: string): never => err(ctx, e instanceof HiveError ? e.code : code, e instanceof Error ? e.message : String(e));

const pathCmd = defineCommand({
  meta: { name: "path", description: "Print where settings.json lives" },
  args: { json: { type: "boolean" } },
  run({ args }) { return ok({ json: !!args.json }, { path: settingsPath() }, () => settingsPath()); },
});

const getCmd = defineCommand({
  meta: { name: "get", description: "Print the settings (or one dotted path) as JSON" },
  args: { path: { type: "positional", required: false }, json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const s = await readSettings();
    const v = args.path ? getPath(s, String(args.path)) : s;
    if (v === undefined) return err(ctx, "not_found", `no setting at "${args.path}"`);
    return ok(ctx, { path: args.path ? String(args.path) : null, value: v }, () => JSON.stringify(v, null, 2));
  },
});

const setCmd = defineCommand({
  meta: { name: "set", description: "Set one dotted path to a JSON value and reload the app" },
  args: { path: { type: "positional", required: true }, value: { type: "positional", required: true }, json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    // Which plugins run is the person's to say, here as in `hive plugins`.
    if (String(args.path).split(".")[0] === "plugins") personOnly(ctx, "change which plugins run and their settings", `hive config set ${String(args.path)} ${String(args.value)}`);
    let value: unknown;
    try { value = JSON.parse(String(args.value)); } catch { return err(ctx, "usage", `value must be JSON (a string needs quotes: '"nord"'); got ${JSON.stringify(args.value)}`); }
    try {
      // One dotted path, applied to the file inside the shared lock — never to
      // a snapshot read a moment ago (the app writes the same file).
      const after = await patchSettingsFile([{ path: String(args.path), value }]);
      const stored = getPath(after, String(args.path));
      const rescanned = await reloadApp();
      return ok(ctx, { path: args.path, value: stored, rescanned }, () => `${args.path} = ${JSON.stringify(stored)}; ${note(rescanned)}${JSON.stringify(stored) !== JSON.stringify(value) ? " (value was normalised by validation)" : ""}`);
    } catch (e) { return fail(ctx, e, "set_failed"); }
  },
});

export const configCmd = defineCommand({
  meta: { name: "config", description: "Read / write settings.json" },
  subCommands: { path: pathCmd, get: getCmd, set: setCmd },
});

const listCmd = defineCommand({
  meta: { name: "list", description: "List the appearance presets" },
  args: { json: { type: "boolean" } },
  async run({ args }) {
    const cur = (await readSettings()).appearance.preset;
    const rows = Object.values(PRESETS).map((p) => ({ id: p.id, label: p.label, mode: p.mode, active: p.id === cur }));
    return ok({ json: !!args.json }, { themes: rows }, () => rows.map((r) => `${r.active ? "*" : " "} ${r.id.padEnd(16)} ${r.label}`).join("\n"));
  },
});

const useCmd = defineCommand({
  meta: { name: "use", description: "Switch to a preset (palette, terminal colours, accent)" },
  args: { preset: { type: "positional", required: true }, json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const p = PRESETS[String(args.preset)];
    if (!p) return err(ctx, "not_found", `unknown preset "${args.preset}" (known: ${Object.keys(PRESETS).join(", ")})`);
    await updateSettings((cur) => ({ ...cur, appearance: applyPreset(cur.appearance, p) }));
    const rescanned = await reloadApp();
    return ok(ctx, { preset: p.id, rescanned }, () => `theme: ${p.label}; ${note(rescanned)}`);
  },
});

const exportCmd = defineCommand({
  meta: { name: "export", description: "Write the current appearance as JSON (stdout or a file), without its media files" },
  args: { file: { type: "positional", required: false }, json: { type: "boolean" } },
  async run({ args }) {
    const { theme, leftOut, note } = exportAppearance((await readSettings()).appearance);
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
  meta: { name: "import", description: "Replace the appearance with a JSON file (validated); your wallpaper media and overlays stay" },
  args: { file: { type: "positional", required: true }, json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    let raw: unknown;
    try { raw = JSON.parse(await fs.readFile(String(args.file), "utf8")); } catch (e) { return err(ctx, "invalid_theme", `cannot read ${args.file}: ${(e as Error).message}`); }
    const written = await updateSettings((cur) => ({ ...cur, appearance: importAppearance(raw, cur.appearance) }));
    const appearance = written.appearance;
    const rescanned = await reloadApp();
    return ok(ctx, { preset: appearance.preset, rescanned }, () => `imported ${args.file} (preset ${appearance.preset}); ${note(rescanned)}`);
  },
});

export const themeCmd = defineCommand({
  meta: { name: "theme", description: "Appearance presets: list, use, export, import" },
  subCommands: { list: listCmd, use: useCmd, export: exportCmd, import: importCmd },
});
