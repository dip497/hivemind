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
 */
import { defineCommand } from "citty";
import { HiveError, patchSettingsFile, readSettings } from "@hivemind/core";
import { NOTICE_KINDS, type NoticeKind } from "@hivemind/core/notification-settings";
import { err, ok } from "../format.js";
import { driveCall } from "../drive.js";
import { personOnly } from "../person-only.js";

type Kind = "bool" | "volume" | "time";
/** Every key `set` takes, and what its value is. */
export const NOTIFICATION_KEYS: Record<string, Kind> = {
  enabled: "bool", inApp: "bool", osPopups: "bool", popupText: "bool", sound: "bool", volume: "volume",
  "sounds.needs": "bool", "sounds.done": "bool", "sounds.error": "bool",
  "kinds.needs": "bool", "kinds.done": "bool", "kinds.error": "bool",
  "dnd.enabled": "bool", "dnd.start": "time", "dnd.end": "time",
};

/** `text` as `key`'s value, or why it is not one. */
export function valueOf(key: string, text: string): { value: unknown } | { why: string } {
  const kind = NOTIFICATION_KEYS[key];
  if (!kind) return { why: `no notification setting "${key}"; one of ${Object.keys(NOTIFICATION_KEYS).join(", ")}` };
  if (kind === "bool") {
    if (text === "true" || text === "on") return { value: true };
    if (text === "false" || text === "off") return { value: false };
    return { why: `${key} is on or off (true or false), not "${text}"` };
  }
  if (kind === "volume") {
    const n = Number(text.endsWith("%") ? Number(text.slice(0, -1)) / 100 : text);
    return text.trim() !== "" && Number.isFinite(n) && n >= 0 && n <= 1 ? { value: n } : { why: `volume is from 0 to 1 (or 0% to 100%), not "${text}"` };
  }
  return /^([01]?\d|2[0-3]):[0-5]\d$/.test(text) ? { value: text } : { why: `${key} is a time of day as HH:MM (24 hours), not "${text}"` };
}

async function reloadApp(): Promise<boolean> {
  try { await driveCall("settings.reload", [], 5000); return true; } catch { return false; }
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
    const v = valueOf(key, String(args.value));
    if ("why" in v) return err(ctx, "usage", v.why, undefined, "run `hive notifications show` to see them, or `hive notifications --help`");
    try {
      const after = await patchSettingsFile([{ path: `notifications.${key}`, value: v.value }]);
      const stored = key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], after.notifications);
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

export const notificationsCmd = defineCommand({
  meta: { name: "notifications", description: "The app's notifications and sounds: show, set, play (the person only)" },
  subCommands: { show: showCmd, set: setCmd, play: playCmd },
});
