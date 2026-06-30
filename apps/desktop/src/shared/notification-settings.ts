/**
 * Notification preferences — shared shape + pure decision predicates.
 *
 * Lives under shared/ so BOTH the main process (native OS popup gate, in
 * agent-notify.ts) and the renderer (in-app toast gate, in useAgentAwareness)
 * apply the IDENTICAL rules from one source of truth. The persisted blob sits
 * inside main's settings.json; main answers `getNotificationSettings` over IPC
 * and the renderer caches a snapshot.
 *
 * Gating precedence for a given (kind, surface):
 *   1. master `enabled` off → suppress everything.
 *   2. `kounds[kind]` off → suppress that kind.
 *   3. surface flag (`inApp` / `osPopups`) off → suppress that surface only.
 *   4. Do-Not-Disturb active AND kind !== "needs" → suppress. A blocked agent
 *      ("needs") is urgent (it's waiting on you), so DND never mutes it — only
 *      the noisier done/error kinds.
 */

export type NoticeSurface = "inApp" | "osPopups";

export interface NotificationSettings {
  /** Master kill switch. Off → nothing fires (neither toast nor OS popup). */
  enabled: boolean;
  /** Per-kind mute. The three agent transitions: needs-you, finished, failed. */
  kinds: { needs: boolean; done: boolean; error: boolean };
  /** Do-Not-Disturb window (local time, 24h "HH:MM"). Overnight wrap (start >
   *  end, e.g. 22:00→07:00) is supported. Mutes done/error, NOT needs. */
  dnd: { enabled: boolean; start: string; end: string };
  /** Surface toggles — in-app toast vs. native OS popup, independently. */
  osPopups: boolean;
  inApp: boolean;
  /** Reserved: play a short sound on needs/error. Stored now, wired later. */
  sound: boolean;
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: true,
  kinds: { needs: true, done: true, error: true },
  dnd: { enabled: false, start: "22:00", end: "07:00" },
  osPopups: true,
  inApp: true,
  sound: false,
};

/** Merge a partial/loaded blob onto defaults so missing fields (from an older
 *  settings.json written before a field existed) never crash a predicate. */
export function normalizeNotificationSettings(raw: unknown): NotificationSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_NOTIFICATION_SETTINGS };
  const r = raw as Partial<NotificationSettings> & { kinds?: Partial<NotificationSettings["kinds"]>; dnd?: Partial<NotificationSettings["dnd"]> };
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : DEFAULT_NOTIFICATION_SETTINGS.enabled,
    kinds: {
      needs: typeof r.kinds?.needs === "boolean" ? r.kinds.needs : true,
      done: typeof r.kinds?.done === "boolean" ? r.kinds.done : true,
      error: typeof r.kinds?.error === "boolean" ? r.kinds.error : true,
    },
    dnd: {
      enabled: typeof r.dnd?.enabled === "boolean" ? r.dnd.enabled : false,
      start: typeof r.dnd?.start === "string" ? r.dnd.start : "22:00",
      end: typeof r.dnd?.end === "string" ? r.dnd.end : "07:00",
    },
    osPopups: typeof r.osPopups === "boolean" ? r.osPopups : true,
    inApp: typeof r.inApp === "boolean" ? r.inApp : true,
    sound: typeof r.sound === "boolean" ? r.sound : false,
  };
}

type MaybeDate = Date | number;

function minutes(hm: string): number {
  // "HH:MM" → minutes-of-day. Bad input falls back to 0 so a malformed setting
  // never throws; the DND window just becomes 00:00→00:00 (inactive).
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
  if (!m) return 0;
  const h = Math.min(23, Math.max(0, parseInt(m[1] ?? "0", 10)));
  const min = Math.min(59, Math.max(0, parseInt(m[2] ?? "0", 10)));
  return h * 60 + min;
}

/** Is DND currently in effect? Handles an overnight wrap (start > end). */
export function dndActive(s: NotificationSettings, now: MaybeDate = new Date()): boolean {
  if (!s.dnd.enabled) return false;
  const d = typeof now === "number" ? new Date(now) : now;
  const cur = d.getHours() * 60 + d.getMinutes();
  const start = minutes(s.dnd.start);
  const end = minutes(s.dnd.end);
  if (start === end) return false;
  return start > end ? cur >= start || cur < end : cur >= start && cur < end;
}

/** The single decision: does this (kind, surface) fire right now? Pure — safe to
 *  call in either process and to unit-test without Electron. */
export function shouldNotify(
  s: NotificationSettings,
  kind: "needs" | "done" | "error",
  surface: NoticeSurface,
  now: MaybeDate = new Date(),
): boolean {
  if (!s.enabled) return false;
  if (!s.kinds[kind]) return false;
  if (surface === "inApp" ? !s.inApp : !s.osPopups) return false;
  if (kind !== "needs" && dndActive(s, now)) return false;
  return true;
}
