/**
 * `hive notifications` — the app's notifications and sounds: the `notifications` section of
 * settings.json, read and written through the same normalizer as the app, and a sound played in
 * the running app. The person's alone (person-only.ts): an agent may not make their computer chime.
 *
 *   hive notifications show [--json]
 *   hive notifications set <key> <value>     enabled, inApp, osPopups, popupText, sound,
 *                                            sounds.needs|done|error, volume (0–1),
 *                                            kinds.needs|done|error, dnd.enabled|start|end
 *   hive notifications play <needs|done|error> [--json]
 *   hive notifications recent [--json]       the last 10 bursts: anyone may read them
 */
import { defineCommand } from "citty";
import { HiveError, getPath, patchSettingsFile, readSettings } from "@hivemind/core";
import { NOTICE_KINDS, NOTICE_TONES, notificationSettingProblem, type NoticeKind } from "@hivemind/core/notification-settings";
import { STATUS_MARKS } from "@hivemind/view-sdk/status";
import { err, ok } from "../format.js";
import { driveCall, reloadApp } from "../drive.js";
import { personOnly } from "../person-only.js";
import type { RecentSound } from "@hivemind/workspace-api/notifications";

/** `text` as a value: on, off, true and false as a switch, a number or a percentage as a number,
 *  anything else as text. `notificationSettingProblem` then says whether `key` takes it. */
export function valueOf(text: string): unknown {
  if (text === "true" || text === "on") return true;
  if (text === "false" || text === "off") return false;
  const n = text.endsWith("%") ? Number(text.slice(0, -1)) / 100 : Number(text);
  return text.trim() !== "" && Number.isFinite(n) ? n : text;
}

const onOff = (b: boolean) => (b ? "on" : "off");

const showCmd = defineCommand({
  meta: { name: "show", description: "Print the notification and sound settings" },
  args: { json: { type: "boolean" } },
  async run({ args }) {
    const n = (await readSettings()).notifications;
    return ok({ json: !!args.json }, n, () => [
      `notifications   ${onOff(n.enabled)}`,
      `about           needs you ${onOff(n.kinds.needs)}, finished ${onOff(n.kinds.done)}, failed ${onOff(n.kinds.error)}`,
      `toasts          ${onOff(n.inApp)}`,
      `OS pop-ups      ${onOff(n.osPopups)}${n.popupText ? ", with commands and questions" : ""}`,
      `sounds          ${onOff(n.sound)}: needs you ${onOff(n.sounds.needs)}, finished ${onOff(n.sounds.done)}, failed ${onOff(n.sounds.error)}; volume ${Math.round(n.volume * 100)}%`,
      `do not disturb  ${n.dnd.enabled ? `${n.dnd.start}–${n.dnd.end}` : "off"}`,
    ].join("\n"));
  },
});

const setCmd = defineCommand({
  meta: { name: "set", description: "Set one notification setting and reload the app (the person only)" },
  args: { key: { type: "positional", required: true }, value: { type: "positional", required: true }, json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const key = String(args.key);
    personOnly(ctx, "change the app's sounds and notifications", `hive notifications set ${key} ${String(args.value)}`, "Notifications");
    const value = valueOf(String(args.value));
    const why = notificationSettingProblem(key, value);
    if (why) return err(ctx, "usage", why, undefined, "run `hive notifications show` to see them, or `hive notifications --help`");
    try {
      const after = await patchSettingsFile([{ path: `notifications.${key}`, value }]);
      const stored = getPath(after.notifications, key);
      const reloaded = await reloadApp();
      return ok(ctx, { key, value: stored, reloaded }, () => `${key} = ${JSON.stringify(stored)}; ${reloaded ? "app reloaded" : "app not running — applies on next start"}`);
    } catch (e) {
      return err(ctx, e instanceof HiveError ? e.code : "set_failed", e instanceof Error ? e.message : String(e));
    }
  },
});

const playCmd = defineCommand({
  meta: { name: "play", description: "Play a moment's sound in the running app and say what became of it (the person only)" },
  args: { moment: { type: "positional", required: true, description: "needs, done or error" }, json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const moment = String(args.moment);
    personOnly(ctx, "play the app's sounds", `hive notifications play ${moment}`, "Notifications");
    if (!NOTICE_KINDS.includes(moment as NoticeKind)) return err(ctx, "usage", `the moment is needs, done or error, not "${moment}"`);
    let r: { played: boolean; why?: string; pack?: string };
    try {
      r = (await driveCall("notifications.play", [moment], 6000)) as typeof r;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "UNAVAILABLE" || code === "UNKNOWN_METHOD") {
        return err(ctx, "UNAVAILABLE", "no hivemind app is running to play it", undefined, "open the hivemind app, then run this again; `hive host` plays no sounds");
      }
      throw e;
    }
    return ok(ctx, { moment, ...r }, () => (r.played ? `played ${moment}${r.pack ? ` (${r.pack})` : ""}${r.why ? `: ${r.why}` : ""}` : `blocked: ${r.why ?? "it did not play"}`));
  },
});

const recentCmd = defineCommand({
  meta: { name: "recent", description: "The last 10 bursts of agents' changes: how many agents, the sound and the pop-ups" },
  args: { json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    let rows: RecentSound[];
    try {
      rows = (await driveCall("notifications.recentSounds", [], 5000)) as RecentSound[];
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "UNAVAILABLE" || code === "UNKNOWN_METHOD") return err(ctx, "UNAVAILABLE", "no hivemind app is running: Recent lives in it", undefined, "open the hivemind app; `hive host` plays no sounds");
      throw e;
    }
    return ok(ctx, { recent: rows }, () => rows.length === 0 ? "nothing yet" : rows.map((r) => {
      const when = new Date(r.at).toLocaleTimeString();
      const sound = `${r.sound}${r.pack ? ` (${r.pack})` : ""}${r.why ? `: ${r.why}` : ""}`;
      return `${when}  ${STATUS_MARKS[NOTICE_TONES[r.moment]].word.padEnd(9)}  ${(r.agents ? `${r.agents} agent${r.agents === 1 ? "" : "s"}` : "asked for").padStart(10)}  ${String(r.popups).padStart(2)} pop-up${r.popups === 1 ? " " : "s"}  ${sound}`;
    }).join("\n"));
  },
});

export const notificationsCmd = defineCommand({
  meta: { name: "notifications", description: "The app's notifications and sounds: show, set, play (the person only), recent" },
  subCommands: { show: showCmd, set: setCmd, play: playCmd, recent: recentCmd },
});
