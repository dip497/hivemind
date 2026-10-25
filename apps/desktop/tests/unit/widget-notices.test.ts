// A widget's `hive.notify` is decided in main, by the notification settings main keeps: those
// saved before this start (a window's own copy is not loaded yet then), then each change any
// window saves. A widget shows at most one notice in 10 s, whichever window runs it; what it sends
// inside that time is held and shows once when the time is up, the latest with how many more.
//
// Two clocks, as in Node: the timers run on `performance.now()`, which counts from the process's
// start and only moves on, and `Date.now()` is the time of day, which the person can set back or
// forward. The test moves both itself, and the timers with the first.
import { after, mock, test } from "node:test";
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
fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ notifications: { ...DEFAULT_NOTIFICATION_SETTINGS, osPopups: false } }));
const { widgetNotices } = await import("../../src/main/widget-notices.ts");
const { patchSettings } = await import("../../src/main/settings-store.ts");

const noon = new Date(2025, 0, 1, 12, 0).getTime();
let mono = 1_000;
/** The time of day minus the timers' clock: setting the wall clock moves this. */
let wall = noon - mono;
mock.timers.enable({ apis: ["setTimeout"] });
mock.method(performance, "now", () => mono);
mock.method(Date, "now", () => wall + mono);
// Every timer main arms, and for how long: the global the module calls, counted as it is called.
const armed: number[] = [];
const mocked = globalThis.setTimeout;
globalThis.setTimeout = ((fn: () => void, ms?: number) => { armed.push(ms ?? 0); return mocked(fn, ms); }) as typeof setTimeout;
after(() => {
  globalThis.setTimeout = mocked;
  mock.timers.reset();
  mock.restoreAll();
  fs.rmSync(userData, { recursive: true, force: true });
});

/** Move the timers' clock on `ms`, running what falls due on the way. */
const pass = (ms: number) => { mono += ms; mock.timers.tick(ms); };
/** A fresh decider, its shown notices, and `at(ms)`: move the timers' clock to `ms` after now. */
function widgets() {
  const shown: string[] = [];
  const notify = widgetNotices((n) => shown.push(`${n.title}: ${n.body}`));
  const start = mono;
  return { shown, notify, at: (ms: number) => pass(start + ms - mono), since: (n: number) => shown.slice(n) };
}
const notice = (widget: string, text: string, title = "Tally") => ({ repo: "/work", widget, title, text });

test("a widget's notices follow main's settings from start-up; inside 10 s they are held and show once, the latest with how many more", async () => {
  const { shown, notify, at, since } = widgets();
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
  mono += 9_500; // the clock moves on, the timer has not run yet
  notify(notice("w5", "late"));
  mock.timers.tick(9_500);
  assert.deepEqual(since(13), ["Tally: late\nand 1 more"]);
  at(95_000); assert.deepEqual(since(14), []);

  // Nothing held, so no timer runs on.
  const before = armed.length;
  pass(600_000);
  assert.equal(armed.length, before);

  // Held while the person switches pop-ups off: when its time is up, nothing shows.
  pass(1_000); notify(notice("w6", "six"));
  pass(1_000); notify(notice("w6", "muted"));
  await patchSettings([{ path: "notifications.osPopups", value: false }]);
  pass(20_000);
  assert.deepEqual(since(15), []);
  notify({ repo: "/work", title: "Tally", text: "whose?" });
  assert.equal(shown.length, 15);
});

test("setting the wall clock back or forward holds no notice longer and lets none through sooner; Do Not Disturb reads the time of day", async () => {
  await patchSettings([{ path: "notifications.osPopups", value: true }]);
  const { shown, notify, at, since } = widgets();
  // Back an hour while k is in its 10 s, and another widget shows: k's next is still held its 10 s.
  notify(notice("k", "k1"));
  at(1_000); wall -= 3_600_000;
  at(1_500); notify(notice("l", "l1"));
  at(2_000); notify(notice("k", "k2"));
  assert.deepEqual(shown, ["Tally: k1", "Tally: l1"]);
  at(10_000); assert.deepEqual(since(2), ["Tally: k2"]);
  // Back an hour while n's notice is held: it shows when n's 10 s are up, not 10 s after the step.
  at(20_000); notify(notice("n", "n1"));
  at(20_500); notify(notice("n", "n2"));
  at(29_500); wall -= 3_600_000;
  at(30_000); assert.deepEqual(since(3), ["Tally: n1", "Tally: n2"]);
  // Forward a day: m's next is still held its 10 s.
  at(40_000); notify(notice("m", "m1"));
  wall += 86_400_000;
  at(41_000); notify(notice("m", "m2"));
  assert.deepEqual(since(5), ["Tally: m1"]);
  at(50_000); assert.deepEqual(since(6), ["Tally: m2"]);
  assert.ok(Math.max(...armed) <= 10_000, `armed for ${Math.max(...armed)} ms`);

  // Do Not Disturb from 11:00 to 13:00, at noon by the wall clock: no notice; at 14:00 one shows.
  wall = noon - mono;
  await patchSettings([{ path: "notifications.dnd", value: { enabled: true, start: "11:00", end: "13:00" } }]);
  notify(notice("d", "during"));
  wall += 2 * 3_600_000;
  notify(notice("d", "after"));
  assert.deepEqual(since(7), ["Tally: after"]);
  await patchSettings([{ path: "notifications.dnd", value: DEFAULT_NOTIFICATION_SETTINGS.dnd }]);
});

test("a notice's title is cut to 64 characters and its text to 200, whether it shows at once or after its wait", async () => {
  await patchSettings([{ path: "notifications.osPopups", value: true }]);
  const shown: { title: string; body: string }[] = [];
  const notify = widgetNotices((n) => shown.push(n));
  const long = "x".repeat(300);
  const cut = `${"x".repeat(199)}…`;
  notify(notice("c", long, "T".repeat(100)));
  pass(1_000); notify(notice("c", "y".repeat(300)));
  pass(1_000); notify(notice("c", long, "T".repeat(100)));
  pass(8_000);
  assert.deepEqual(shown, [
    { title: "T".repeat(64), body: cut },
    { title: "T".repeat(64), body: `${cut}\nand 1 more` },
  ]);
});
