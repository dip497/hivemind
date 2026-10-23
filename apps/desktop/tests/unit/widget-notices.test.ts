// A widget's `hive.notify` is decided in main, by the notification settings main keeps: those
// saved before this start (a window's own copy is not loaded yet then), then each change any
// window saves, and at most one per widget in 10 s, whichever window runs it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";
import { DEFAULT_NOTIFICATION_SETTINGS } from "../../src/shared/notification-settings.ts";

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "hive-widget-notices-"));
process.env.HIVE_TEST_USER_DATA = userData;
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, next) {
  if (s === "electron") return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent("export const app = { getPath: () => process.env.HIVE_TEST_USER_DATA };") };
  return next(s, c);
}`)}`);

test("a widget's notice follows main's notification settings, from start-up on, once per widget in 10 s", async () => {
  try {
    fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ notifications: { ...DEFAULT_NOTIFICATION_SETTINGS, osPopups: false } }));
    const { widgetNoticeToShow } = await import("../../src/main/widget-notices.ts");
    const { setNotificationSettings } = await import("../../src/main/notification-settings-store.ts");
    const noon = new Date(2025, 0, 1, 12, 0).getTime();
    const notice = (widget: string, text: string) => ({ repo: "/work", widget, title: "Tally", text });

    assert.equal(widgetNoticeToShow(notice("w1", "hi"), noon), null, "pop-ups were off when the app started");
    await setNotificationSettings({ ...DEFAULT_NOTIFICATION_SETTINGS, osPopups: true }); // Settings → Notifications, in any window
    assert.deepEqual(widgetNoticeToShow(notice("w1", "hi"), noon), { title: "Tally", body: "hi" });
    // Within 10 s the same widget stays quiet, before and after another one speaks.
    assert.deepEqual(
      [widgetNoticeToShow(notice("w1", "again"), noon + 9_000), widgetNoticeToShow(notice("w2", "other"), noon + 9_000)?.body, widgetNoticeToShow(notice("w1", "still"), noon + 9_500)],
      [null, "other", null],
    );
    assert.equal(widgetNoticeToShow(notice("w1", "later"), noon + 10_000)?.body, "later");
    assert.equal(widgetNoticeToShow({ repo: "/work", title: "Tally", text: "whose?" }, noon + 60_000), null);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
