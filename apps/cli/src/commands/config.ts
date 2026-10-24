/**
 * `hive config` — read/write settings.json (the app's one configuration file).
 * `hive theme` is `./theme.ts`. Both edit the file directly and
 * ask a running app to reload on its drive socket (`settings.reload`), so a change shows
 * without a restart; without an app they just say so.
 *
 *   hive config path
 *   hive config get [appearance.glass.blur]      whole file or one dotted path (JSON)
 *   hive config set appearance.glass.blur 12     value is JSON (strings need quotes: '"nord"'); a path
 *                                                that is not a setting here is refused
 */
import { defineCommand } from "citty";
import { HiveError, SETTINGS_VERSION, getPath, patchSettingsFile, readSettings, settingPathProblem, settingsPath } from "@hivemind/core";
import { err, ok } from "../format.js";
import { reloadApp } from "../drive.js";
import { personOnly } from "../person-only.js";
import { notificationSettingProblem } from "@hivemind/core/notification-settings";

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
    // Not on stdout, which is the value.
    if (s.v > SETTINGS_VERSION) process.stderr.write(`settings.json is from a newer version of hivemind (format ${s.v}); this one shows what it knows, and its writes keep the rest.\n`);
    const v = args.path ? getPath(s, String(args.path)) : s;
    if (v === undefined) return err(ctx, "not_found", `no setting at "${args.path}"`);
    return ok(ctx, { path: args.path ? String(args.path) : null, value: v }, () => JSON.stringify(v, null, 2));
  },
});

const setCmd = defineCommand({
  meta: { name: "set", description: "Set one setting (a dotted path) to a JSON value and reload the app; a path that is not a setting is refused" },
  args: { path: { type: "positional", required: true }, value: { type: "positional", required: true }, json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    // Which plugins run, and what the app sounds and pops up, are the person's to say, here as in
    // `hive plugins` and `hive notifications`.
    const section = String(args.path).split(".")[0];
    if (section === "plugins") personOnly(ctx, "change which plugins run and their settings", `hive config set ${String(args.path)} ${String(args.value)}`);
    if (section === "notifications") personOnly(ctx, "change the app's sounds and notifications", `hive config set ${String(args.path)} ${String(args.value)}`, "Notifications");
    // The file keeps keys it does not know, so a mistyped path would be stored and never read.
    const why = settingPathProblem(String(args.path));
    if (why) return err(ctx, "not_found", why, undefined, "run `hive config get` to see every setting, or read the Settings reference in the guide");
    let value: unknown;
    try { value = JSON.parse(String(args.value)); } catch { return err(ctx, "usage", `value must be JSON (a string needs quotes: '"nord"'); got ${JSON.stringify(args.value)}`); }
    // Held to the rules `hive notifications set` follows, rather than stored and read as the default.
    const bad = section === "notifications" ? notificationSettingProblem(String(args.path).slice("notifications".length + 1), value) : null;
    if (bad) return err(ctx, "usage", bad, undefined, "run `hive notifications show` to see them");
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
