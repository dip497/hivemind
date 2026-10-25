// A widget's `hive.notify` is decided in main, by the notification settings main keeps: those
// saved before this start (a window's own copy is not loaded yet then), then each change any
// window saves. A widget shows at most one notice in 10 s, whichever window runs it; what it sends
// inside that time is held and shows once when the time is up, the latest with how many more.
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";
import { DEFAULT_NOTIFICATION_SETTINGS } from "../../src/shared/notification-settings.ts";

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "hive-widget-notices-"));
process.env.HIVE_TEST_USER_DATA = userData;
// The one settings.json, which main's settings owner reads.
process.env.HIVE_SETTINGS = path.join(userData, "settings.json");
const electron = "export const app = { getPath: () => process.env.HIVE_TEST_USER_DATA }; export const ipcMain = { on() {}, handle() {}, removeHandler() {} }; export const BrowserWindow = { getFocusedWindow: () => null };";
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, next) {
  if (s === "electron") return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(${JSON.stringify(electron)}) };
  return next(s, c);
}`)}`);

test("a widget's notices follow main's settings from start-up; inside 10 s they are held and show once, the latest with how many more", async () => {
  try {
    fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ notifications: { ...DEFAULT_NOTIFICATION_SETTINGS, osPopups: false } }));
    const { widgetNotices } = await import("../../src/main/widget-notices.ts");
    const { patchSettings } = await import("../../src/main/settings-store.ts");
    const noon = new Date(2025, 0, 1, 12, 0).getTime();
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: noon });
    // Every timer main arms, and for how long: the global the module calls, counted as it is called.
    const armed: number[] = [];
    const mocked = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, ms?: number) => { armed.push(ms ?? 0); return mocked(fn, ms); }) as typeof setTimeout;
    const shown: string[] = [];
    const notify = widgetNotices((n) => shown.push(`${n.title}: ${n.body}`));
    const notice = (widget: string, text: string) => ({ repo: "/work", widget, title: "Tally", text });
    /** Move the clock to `ms` after noon, running what falls due on the way. */
    const at = (ms: number) => mock.timers.tick(noon + ms - Date.now());
    const since = (n: number) => shown.slice(n);

    notify(notice("w1", "hi"));
    assert.deepEqual(shown, [], "pop-ups were off when the app started");
    await patchSettings([{ path: "notifications.osPopups", value: true }]); // Settings → Notifications, in any window
    notify(notice("w1", "hi"));
    assert.deepEqual(shown, ["Tally: hi"]);

    // Inside its 10 s, w1's notices wait; another widget's shows at once.
    at(3_000); notify(notice("w1", "again"));
    notify(notice("w2", "other"));
    at(9_500); notify(notice("w1", "still"));
    assert.deepEqual(since(1), ["Tally: other"]);
    // When w1's time is up, they show once: the latest, and how many more came.
    at(10_000);
    assert.deepEqual(since(2), ["Tally: still\nand 1 more"]);
    // That one starts a new 10 s.
    at(12_000); notify(notice("w1", "next"));
    at(19_999); assert.equal(shown.length, 3);
    at(20_000); assert.deepEqual(since(3), ["Tally: next"]);

    // The widget whose time is up first shows first, whichever was held first.
    at(30_000); notify(notice("w3", "three"));
    at(35_000); notify(notice("w4", "four"));
    at(36_000); notify(notice("w4", "four again"));
    at(37_000); notify(notice("w3", "three again"));
    at(40_000); assert.deepEqual(since(6), ["Tally: three again"]);
    at(45_000); assert.deepEqual(since(7), ["Tally: four again"]);
    // And when the one held first is also due first, a later one does not hold it back.
    at(50_000); notify(notice("p1", "a"));
    at(51_000); notify(notice("p2", "b"));
    at(52_000); notify(notice("p1", "a again"));
    at(53_000); notify(notice("p2", "b again"));
    at(60_000); assert.deepEqual(since(10), ["Tally: a again"]);
    at(61_000); assert.deepEqual(since(11), ["Tally: b again"]);

    // A notice that comes when its time is up but before the timer has run brings the held one along,
    // and the held one does not show again after.
    at(70_000); notify(notice("w5", "five"));
    at(71_000); notify(notice("w5", "held"));
    mock.timers.setTime(noon + 80_500); // the clock moves on, the timer has not run yet
    notify(notice("w5", "late"));
    at(80_500);
    assert.deepEqual(since(13), ["Tally: late\nand 1 more"]);
    at(95_000); assert.deepEqual(since(14), []);

    // The clock set back 30 days: a widget that showed "later" is not held for 30 days, nor is a
    // timer set for that long.
    at(100_000); notify(notice("w7", "seven"));
    mock.timers.setTime(noon + 100_000 - 30 * 86_400_000);
    notify(notice("w7", "after the clock moved"));
    mock.timers.tick(10_000);
    assert.deepEqual(since(15), ["Tally: after the clock moved"]);
    assert.ok(Math.max(...armed) <= 10_000, `armed for ${Math.max(...armed)} ms`);
    // Nothing held, so no timer runs on.
    const before = armed.length;
    mock.timers.tick(600_000);
    assert.equal(armed.length, before);

    // Held while the person switches pop-ups off: when its time is up, nothing shows.
    const t = Date.now() - noon;
    at(t + 1_000); notify(notice("w6", "six"));
    at(t + 2_000); notify(notice("w6", "muted"));
    await patchSettings([{ path: "notifications.osPopups", value: false }]);
    at(t + 20_000);
    assert.deepEqual(since(17), []);
    notify({ repo: "/work", title: "Tally", text: "whose?" });
    assert.equal(shown.length, 17);
  } finally {
    mock.timers.reset();
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
