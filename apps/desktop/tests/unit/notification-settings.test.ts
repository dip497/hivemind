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
