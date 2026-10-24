/**
 * Notification preferences: the top-level `notifications` key of settings.json, its shape, its
 * normalizer and the pure decisions on it. Browser-safe, so main (the notice desk), every window
 * (in-app toasts, the screen reader's line) and the `hive` CLI apply the same rules from one place.
 *
 * Gating precedence for a given (kind, surface):
 *   1. master `enabled` off → nothing.
 *   2. `kinds[kind]` off → nothing of that kind.
 *   3. the surface's switch off (`inApp`, `osPopups`; for a sound, `sound` and `sounds[kind]`).
 *   4. Do Not Disturb on, and the kind is not "needs": nothing. An agent that needs you waits on
 *      you, so DND never mutes it; only the noisier finished and failed.
 */

import type { StatusTone } from "@hivemind/view-sdk/protocol";

export type NoticeKind = "needs" | "done" | "error";
export const NOTICE_KINDS: readonly NoticeKind[] = ["needs", "done", "error"];
/** The status each kind is a change to: its word and mark come from `STATUS_MARKS[tone]`
 *  (`@hivemind/view-sdk/status`), so a pop-up, Recent and the CLI say it as the app does. */
export const NOTICE_TONES: Readonly<Record<NoticeKind, StatusTone>> = { needs: "attention", done: "done", error: "failed" };
export type NoticeSurface = "inApp" | "osPopups" | "sound";

export interface NotificationSettings {
  /** Master switch. Off: nothing fires (no toast, pop-up or sound). */
  enabled: boolean;
  /** Per kind: needs you, finished, failed. */
  kinds: { needs: boolean; done: boolean; error: boolean };
  /** Do Not Disturb (local time, 24h "HH:MM"); an overnight wrap (22:00→07:00) works. Mutes
   *  finished and failed, never needs you. */
  dnd: { enabled: boolean; start: string; end: string };
  /** The OS pop-up and the in-app toast, each on its own. */
  osPopups: boolean;
  inApp: boolean;
  /** Play a sound: the master switch for `sounds`. */
  sound: boolean;
  /** Which moments play a sound once `sound` is on. */
  sounds: { needs: boolean; done: boolean; error: boolean };
  /** 0–1. */
  volume: number;
  /** OS pop-ups say what an agent waits on (its command or question) or its last line. Off: they
   *  say only who and what happened, since a command on screen may hold a secret. */
  popupText: boolean;
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: true,
  kinds: { needs: true, done: true, error: true },
  dnd: { enabled: false, start: "22:00", end: "07:00" },
  osPopups: true,
  inApp: true,
  // Off after an upgrade: a sound nobody asked for is the fastest way to have them all switched off.
  sound: false,
  sounds: { needs: true, done: false, error: false },
  volume: 0.6,
  popupText: false,
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const bool = (v: unknown, def: boolean) => (typeof v === "boolean" ? v : def);
const HM_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;
const hm = (v: unknown, def: string) => (typeof v === "string" && HM_RE.test(v.trim()) ? v.trim() : def);
const trio = (v: unknown, base: { needs: boolean; done: boolean; error: boolean }) => {
  const o = isObj(v) ? v : {};
  return { needs: bool(o.needs, base.needs), done: bool(o.done, base.done), error: bool(o.error, base.error) };
};

/** Settings from anything stored (an older file, a hand edit, a patch): each field checked, and
 *  one missing or wrong kept as `base` has it (the defaults, for a file just read). */
export function normalizeNotificationSettings(raw: unknown, base: NotificationSettings = DEFAULT_NOTIFICATION_SETTINGS): NotificationSettings {
  const r = isObj(raw) ? raw : {};
  const dnd = isObj(r.dnd) ? r.dnd : {};
  const volume = typeof r.volume === "number" && Number.isFinite(r.volume) ? Math.min(1, Math.max(0, r.volume)) : base.volume;
  return {
    enabled: bool(r.enabled, base.enabled),
    kinds: trio(r.kinds, base.kinds),
    dnd: { enabled: bool(dnd.enabled, base.dnd.enabled), start: hm(dnd.start, base.dnd.start), end: hm(dnd.end, base.dnd.end) },
    osPopups: bool(r.osPopups, base.osPopups),
    inApp: bool(r.inApp, base.inApp),
    sound: bool(r.sound, base.sound),
    sounds: trio(r.sounds, base.sounds),
    volume,
    popupText: bool(r.popupText, base.popupText),
  };
}

/** Why `value` cannot be stored at `key` (dotted, under `notifications`; "" the section), or null
 *  when it can: the one check `hive notifications set` and `hive config set notifications.*` share. A key is one of
 *  DEFAULT_NOTIFICATION_SETTINGS' own (a group too, whose value sets some of its keys); a value
 *  is of its default's kind: on or off, the volume from 0 to 1, a time of day as HH:MM. */
export function notificationSettingProblem(key: string, value: unknown): string | null {
  let def: unknown = DEFAULT_NOTIFICATION_SETTINGS;
  for (const k of key.split(".").filter(Boolean)) {
    if (!isObj(def) || !Object.hasOwn(def, k)) return `no notification setting "${key}"; one of ${NOTIFICATION_KEYS.join(", ")}`;
    def = def[k];
  }
  return problemOf(key, def, value);
}

function problemOf(key: string, def: unknown, value: unknown): string | null {
  if (isObj(def)) {
    if (!isObj(value)) return `${key || "notifications"} is a group of settings (${Object.keys(def).join(", ")}), not ${JSON.stringify(value)}`;
    for (const [k, v] of Object.entries(value)) {
      const at = key ? `${key}.${k}` : k;
      if (!Object.hasOwn(def, k)) return `no notification setting "${at}"; one of ${NOTIFICATION_KEYS.join(", ")}`;
      const why = problemOf(at, def[k], v);
      if (why) return why;
    }
    return null;
  }
  if (typeof def === "boolean") return typeof value === "boolean" ? null : `${key} is on or off (true or false), not ${JSON.stringify(value)}`;
  if (typeof def === "number") return typeof value === "number" && value >= 0 && value <= 1 ? null : `${key} is from 0 to 1 (0% to 100%), not ${JSON.stringify(value)}`;
  return typeof value === "string" && HM_RE.test(value) ? null : `${key} is a time of day as HH:MM (24 hours), not ${JSON.stringify(value)}`;
}

/** Every setting's dotted key, as the defaults have them. */
export const NOTIFICATION_KEYS: readonly string[] = (function leaves(o: Record<string, unknown>, at: string): string[] {
  return Object.entries(o).flatMap(([k, v]) => (isObj(v) ? leaves(v, `${at}${k}.`) : [`${at}${k}`]));
})(DEFAULT_NOTIFICATION_SETTINGS as unknown as Record<string, unknown>, "");

type MaybeDate = Date | number;

function minutes(time: string): number {
  // "HH:MM" → minutes of the day; anything else 0, so a bad value never throws.
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return 0;
  const h = Math.min(23, Math.max(0, parseInt(m[1] ?? "0", 10)));
  const min = Math.min(59, Math.max(0, parseInt(m[2] ?? "0", 10)));
  return h * 60 + min;
}

/** Is DND in effect now? Handles an overnight wrap (start > end). */
export function dndActive(s: NotificationSettings, now: MaybeDate = new Date()): boolean {
  if (!s.dnd.enabled) return false;
  const d = typeof now === "number" ? new Date(now) : now;
  const cur = d.getHours() * 60 + d.getMinutes();
  const start = minutes(s.dnd.start);
  const end = minutes(s.dnd.end);
  if (start === end) return false;
  return start > end ? cur >= start || cur < end : cur >= start && cur < end;
}

/** The one decision: does this (kind, surface) fire now? */
export function shouldNotify(s: NotificationSettings, kind: NoticeKind, surface: NoticeSurface, now: MaybeDate = new Date()): boolean {
  if (!s.enabled) return false;
  if (!s.kinds[kind]) return false;
  if (surface === "inApp" && !s.inApp) return false;
  if (surface === "osPopups" && !s.osPopups) return false;
  if (surface === "sound" && !(s.sound && s.sounds[kind])) return false;
  if (kind !== "needs" && dndActive(s, now)) return false;
  return true;
}
