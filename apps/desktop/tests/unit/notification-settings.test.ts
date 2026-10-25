// Pure decision predicates for notification preferences. Both the main OS-
// popup gate (agent-notify.ts) and the renderer in-app-toast gate
// (useAgentAwareness) must agree, so the logic lives in ONE place and is tested
// here without loading Electron or React.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  normalizeNotificationSettings,
  dndActive,
  shouldNotify,
  widgetNoticeAllowed,
  widgetNoticeBody,
  widgetNoticeText,
  type NotificationSettings,
} from "../../src/shared/notification-settings.ts";

const S = (over: Partial<NotificationSettings>): NotificationSettings => ({
  ...DEFAULT_NOTIFICATION_SETTINGS,
  ...over,
});

test("defaults let everything through", () => {
  for (const kind of ["needs", "done", "error"] as const) {
    for (const surface of ["inApp", "osPopups"] as const) {
      assert.equal(shouldNotify(DEFAULT_NOTIFICATION_SETTINGS, kind, surface), true);
    }
  }
});

test("master switch off suppresses every kind + surface", () => {
  const s = S({ enabled: false });
  assert.equal(shouldNotify(s, "needs", "inApp"), false);
  assert.equal(shouldNotify(s, "error", "osPopups"), false);
});

test("per-kind mute suppresses only that kind", () => {
  const s = S({ kinds: { needs: true, done: false, error: true } });
  assert.equal(shouldNotify(s, "done", "inApp"), false);
  assert.equal(shouldNotify(s, "needs", "inApp"), true);
});

test("surface flag suppresses only that surface", () => {
  const s = S({ osPopups: false, inApp: true });
  assert.equal(shouldNotify(s, "needs", "osPopups"), false);
  assert.equal(shouldNotify(s, "needs", "inApp"), true);
});

test("DND same-day window (09:00→17:00)", () => {
  const s = S({ dnd: { enabled: true, start: "09:00", end: "17:00" } });
  assert.equal(dndActive(s, new Date(2025, 0, 1, 12, 0)), true); // noon
  assert.equal(dndActive(s, new Date(2025, 0, 1, 8, 59)), false); // before
  assert.equal(dndActive(s, new Date(2025, 0, 1, 17, 0)), false); // at end (exclusive)
});

test("DND overnight window wraps past midnight (22:00→07:00)", () => {
  const s = S({ dnd: { enabled: true, start: "22:00", end: "07:00" } });
  assert.equal(dndActive(s, new Date(2025, 0, 1, 23, 30)), true); // late night
  assert.equal(dndActive(s, new Date(2025, 0, 2, 3, 0)), true); // early morning
  assert.equal(dndActive(s, new Date(2025, 0, 1, 12, 0)), false); // midday
});

test("DND mutes done + error but NEVER needs-you", () => {
  const s = S({ dnd: { enabled: true, start: "00:00", end: "23:59" } });
  const noon = new Date(2025, 0, 1, 12, 0);
  assert.equal(shouldNotify(s, "needs", "inApp", noon), true); // urgent: bypasses DND
  assert.equal(shouldNotify(s, "done", "inApp", noon), false);
  assert.equal(shouldNotify(s, "error", "osPopups", noon), false);
});

test("DND disabled is a no-op regardless of window", () => {
  const s = S({ dnd: { enabled: false, start: "00:00", end: "23:59" } });
  assert.equal(dndActive(s, new Date(2025, 0, 1, 3, 0)), false);
});

test("a widget's notice shows as the person allows OS pop-ups, outside DND, its text cut short, and says how many more it held", () => {
  const noon = new Date(2025, 0, 1, 12, 0).getTime();
  assert.equal(widgetNoticeAllowed(DEFAULT_NOTIFICATION_SETTINGS, noon), true);
  // A widget is never urgent: Do Not Disturb mutes it, as the master and pop-up switches do.
  for (const s of [S({ enabled: false }), S({ osPopups: false }), S({ dnd: { enabled: true, start: "09:00", end: "17:00" } })]) {
    assert.equal(widgetNoticeAllowed(s, noon), false);
  }
  assert.equal(widgetNoticeText("Build passed"), "Build passed");
  const long = widgetNoticeText("x".repeat(5_000));
  assert.deepEqual([[...long].length <= 200, long.endsWith("…")], [true, true]);
  assert.deepEqual([widgetNoticeBody("Build passed", 0), widgetNoticeBody("Build passed", 2)], ["Build passed", "Build passed\nand 2 more"]);
});

test("normalize backfills missing fields from an older settings blob", () => {
  const n = normalizeNotificationSettings({ enabled: false }); // pre-kinds/dnd shape
  assert.equal(n.enabled, false);
  assert.deepEqual(n.kinds, { needs: true, done: true, error: true });
  assert.equal(n.dnd.enabled, false);
  assert.equal(n.inApp, true);
  assert.equal(n.osPopups, true);
});

test("normalize tolerates garbage without throwing", () => {
  assert.deepEqual(normalizeNotificationSettings(null), DEFAULT_NOTIFICATION_SETTINGS);
  assert.deepEqual(normalizeNotificationSettings("oops"), DEFAULT_NOTIFICATION_SETTINGS);
});

test("a blob from before sounds gets them off, needs you chosen, at 0.6, and pop-ups without text", () => {
  // What every release up to 2026-10 stored (sound reserved, never played).
  const n = normalizeNotificationSettings({ enabled: true, kinds: { needs: true, done: true, error: true }, dnd: { enabled: false, start: "22:00", end: "07:00" }, osPopups: true, inApp: true, sound: false });
  assert.deepEqual([n.sound, n.sounds, n.volume, n.popupText], [false, { needs: true, done: false, error: false }, 0.6, false]);
});

test("bad values fall back each on its own: volume clamped, a time that is not HH:MM, a word for a switch", () => {
  const n = normalizeNotificationSettings({ volume: 7, sounds: { done: "yes", error: true }, dnd: { start: "25:00", end: "6:30" } });
  assert.equal(n.volume, 1);
  assert.equal(normalizeNotificationSettings({ volume: -1 }).volume, 0);
  assert.equal(normalizeNotificationSettings({ volume: Number.NaN }).volume, 0.6);
  assert.deepEqual(n.sounds, { needs: true, done: false, error: true });
  assert.deepEqual([n.dnd.start, n.dnd.end], ["22:00", "6:30"]);
});

test("a sound needs the master switch and its moment; DND mutes finished and failed, never needs you", () => {
  const on = S({ sound: true, sounds: { needs: true, done: true, error: true } });
  assert.equal(shouldNotify(S({ sounds: { needs: true, done: true, error: true } }), "needs", "sound"), false, "Play a sound is off");
  assert.equal(shouldNotify(S({ sound: true, sounds: { needs: true, done: false, error: true } }), "done", "sound"), false);
  assert.equal(shouldNotify(on, "done", "sound"), true);
  const night = S({ sound: true, sounds: { needs: true, done: true, error: true }, dnd: { enabled: true, start: "22:00", end: "07:00" } });
  const late = new Date(2025, 0, 1, 23, 0);
  assert.deepEqual((["needs", "done", "error"] as const).map((k) => shouldNotify(night, k, "sound", late)), [true, false, false]);
});
