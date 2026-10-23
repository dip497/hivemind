// The notice desk in main (notice-desk-core.ts): every window's copy of an agent's change becomes
// one event; pop-ups are gated, and a burst of one kind gathers into one; sounds are gated, paced
// and counted; Recent says what each burst did. Driven at the desk's own boundary (`receive`,
// `result`, `recent`) on a clock the test moves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { DEDUPE_MAX, NoticeDesk, NoticeDeskCore, type Popup, type Sound } from "../../src/main/notice-desk-core.ts";
import { DEFAULT_NOTIFICATION_SETTINGS, type NotificationSettings } from "../../src/shared/notification-settings.ts";
import type { AgentNotice } from "../../src/shared/ipc.ts";

/** A clock the test moves, with the timers it would run. */
function clock(start = new Date(2025, 0, 1, 12, 0).getTime()) {
  let t = start;
  const timers: { at: number; fn: () => void }[] = [];
  return {
    now: () => t,
    schedule: (fn: () => void, ms: number) => { timers.push({ at: t + ms, fn }); },
    /** Move on `ms`, running each timer due on the way, in order. */
    tick(ms: number) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        t = next.at;
        next.fn();
      }
      t = end;
    },
  };
}

const SOUNDS_ON: NotificationSettings = { ...DEFAULT_NOTIFICATION_SETTINGS, sound: true, sounds: { needs: true, done: true, error: true } };

function desk(settings: Partial<NotificationSettings> = {}, focused = false) {
  const c = clock();
  const popups: Popup[] = [];
  const sounds: (Sound & { at: number })[] = [];
  let s: NotificationSettings = { ...SOUNDS_ON, ...settings };
  let isFocused = focused;
  const d = new NoticeDeskCore({
    now: c.now, schedule: c.schedule, settings: () => s, focused: () => isFocused,
    popup: (p) => popups.push(p),
    sound: (x) => sounds.push({ ...x, at: c.now() }),
  });
  return { d, c, popups, sounds, set: (more: Partial<NotificationSettings>) => { s = { ...s, ...more }; }, focus: (f: boolean) => { isFocused = f; } };
}

const n = (tileId: string, kind: AgentNotice["kind"]): AgentNotice => ({ tileId, label: tileId, kind });

test("two windows' copies of a change make one event: one pop-up, one sound for one agent", () => {
  const { d, c, popups, sounds } = desk();
  d.receive(n("a", "done"), false);
  c.tick(5);
  d.receive(n("a", "done"), false); // the second window's copy
  c.tick(2000);
  assert.equal(popups.length, 1);
  assert.deepEqual(sounds.map((x) => [x.moment, x.count]), [["done", 1]]);
  assert.deepEqual(d.recent().map((b) => [b.moment, b.agents, b.popups]), [["done", 1, 1]]);
});

test("10 agents that finish together make one sound, counted 10", () => {
  const { d, c, sounds } = desk();
  for (let i = 0; i < 10; i++) { d.receive(n(`t${i}`, "done"), false); c.tick(10); }
  c.tick(2000);
  assert.deepEqual(sounds.map((x) => [x.moment, x.count]), [["done", 10]]);
});

test("a failure and a finish together play the failure; the finish says why it was skipped", () => {
  const { d, c, sounds } = desk();
  d.receive(n("a", "done"), false);
  d.receive(n("b", "error"), false);
  c.tick(2000);
  assert.deepEqual(sounds.map((x) => x.moment), ["error"]);
  const done = d.recent().find((b) => b.moment === "done")!;
  assert.deepEqual([done.sound, done.why], ["skipped", "the failed sound played instead"]);
});

test("a second burst inside 1.2 s waits for the gap, and one sound plays for it", () => {
  const { d, c, sounds } = desk();
  d.receive(n("a", "needs"), false);
  c.tick(500);
  d.receive(n("b", "needs"), false);
  d.receive(n("c", "needs"), false);
  c.tick(3000);
  const start = new Date(2025, 0, 1, 12, 0).getTime();
  assert.deepEqual(sounds.map((x) => [x.at - start, x.count]), [[150, 1], [1350, 2]]);
});

test("Do Not Disturb mutes finished and failed, sound and pop-up, never needs you", () => {
  const { d, c, sounds, popups } = desk({ dnd: { enabled: true, start: "11:00", end: "13:00" } });
  d.receive(n("a", "done"), false);
  d.receive(n("b", "error"), false);
  d.receive(n("c", "needs"), false);
  c.tick(2000);
  assert.deepEqual(sounds.map((x) => x.moment), ["needs"]);
  assert.deepEqual(popups.map((p) => p.kind), ["needs"]);
  // Muted, not outplayed.
  assert.deepEqual(d.recent().map((b) => [b.moment, b.sound]), [["needs", "waiting"], ["error", "off"], ["done", "off"]]);
});

test("a finish of a tile selected in the focused window makes no sound; another tile's does", () => {
  const { d, c, sounds } = desk({}, true);
  d.receive(n("a", "done"), false);
  d.receive(n("a", "done"), true); // the focused window has it selected: its copy says so
  c.tick(2000);
  assert.deepEqual(sounds, []);
  assert.deepEqual([d.recent()[0]!.sound, d.recent()[0]!.why], ["skipped", "you were looking at it"]);
  d.receive(n("b", "done"), false);
  c.tick(2000);
  assert.deepEqual(sounds.map((x) => x.moment), ["done"]);
});

test("the dedupe map keeps at most 1024 entries, and a burst of 1500 notices takes under 25 ms", (t) => {
  const c = clock();
  const dedupe = new NoticeDesk(c);
  for (let i = 0; i < 3000; i++) dedupe.admit(n(`t${i}`, "done"), false);
  assert.equal(dedupe.size, DEDUPE_MAX);
  c.tick(2001);
  dedupe.admit(n("late", "done"), false);
  assert.equal(dedupe.size, 1, "the expired go on the next admit");

  const { d } = desk();
  const notices = Array.from({ length: 1500 }, (_, i) => n(`b${i}`, i % 3 === 0 ? "error" : "done"));
  const started = performance.now();
  for (const x of notices) d.receive(x, false);
  const took = performance.now() - started;
  t.diagnostic(`1500 notices: ${took.toFixed(3)} ms`);
  assert.ok(took < 25, `${took} ms`);
});

test("pop-ups: the first of a kind shows at once, the rest of its burst gather into one, and needs you is never folded into finished", () => {
  const { d, c, popups } = desk();
  d.receive(n("a", "done"), false);
  assert.deepEqual(popups.map((p) => [p.kind, p.notices.length, p.more]), [["done", 1, false]], "at once");
  for (let i = 0; i < 9; i++) { c.tick(100); d.receive(n(`d${i}`, "done"), false); }
  d.receive(n("x", "needs"), false);
  d.receive(n("y", "needs"), false);
  c.tick(3000);
  assert.deepEqual(popups.map((p) => [p.kind, p.notices.length, p.more]), [["done", 1, false], ["needs", 1, false], ["done", 9, true], ["needs", 1, true]]);
  // Its click goes to the first agent it gathered.
  assert.equal(popups[2]!.notices[0]!.tileId, "d0");
  assert.deepEqual(d.recent().map((b) => [b.moment, b.agents, b.popups]), [["needs", 2, 2], ["done", 10, 2]]);
});

test("no pop-up while a window has the focus, and a pop-up is silent while the app plays its own sound", () => {
  const { d, c, popups, focus, set } = desk({}, true);
  d.receive(n("a", "done"), false);
  c.tick(2000);
  assert.equal(popups.length, 0);
  focus(false);
  d.receive(n("b", "done"), false);
  set({ sounds: { needs: true, done: false, error: true } });
  d.receive(n("c", "error"), false);
  d.receive(n("e", "done"), false);
  c.tick(2000);
  assert.deepEqual(popups.map((p) => [p.notices[0]!.tileId, p.silent]), [["b", true], ["c", true], ["e", false]]);
});

test("Recent keeps the last 10 bursts and what the window said of each sound", () => {
  const { d, c, sounds } = desk();
  for (let i = 0; i < 12; i++) { d.receive(n(`t${i}`, "needs"), false); c.tick(2000); }
  assert.equal(d.recent().length, 10);
  d.result(sounds.at(-1)!.id, false, "suspended");
  d.result(sounds.at(-2)!.id, true, undefined, "Harbour");
  assert.deepEqual(d.recent().slice(0, 2).map((b) => [b.sound, b.why, b.pack]), [["blocked", "suspended", undefined], ["played", undefined, "Harbour"]]);
  const asked = d.play("error");
  d.result(asked.id, true);
  assert.deepEqual([d.recent()[0]!.moment, d.recent()[0]!.sound, d.recent()[0]!.count], ["error", "played", 1]);
});

test("a pop-up's text: none unless the person turned it on or for a gathered one; a wait as one line, waited for up to 1 s; else the last line", async () => {
  const { popupTextOf } = await import("../../src/main/notice-desk-core.ts");
  const one = (kind: AgentNotice["kind"]): Popup => ({ kind, notices: [n("hm:t1", kind)], more: false, silent: false });
  let slept = 0;
  let wait: unknown;
  const o = {
    waitingOf: (bare: string) => (bare === "t1" ? (wait as never) : undefined),
    lineOf: (bare: string) => (bare === "t1" ? "214 tests‮ passed\u0007" : undefined),
    sleep: async (ms: number) => { slept += ms; if (slept >= 500) wait = { kind: "permission", since: 1, tool: { name: "Bash", about: "rm -rf build\nsecond line" } }; },
  };
  assert.equal(await popupTextOf(one("done"), false, o), undefined, "off by default");
  assert.equal(await popupTextOf({ ...one("done"), more: true }, true, o), undefined);
  assert.equal(await popupTextOf(one("done"), true, o), "214 tests passed", "controls and bidi stripped");
  assert.equal(await popupTextOf(one("needs"), true, o), "Bash: rm -rf build");
  assert.equal(slept, 500, "it waited for the feed to bring the wait");
  wait = undefined; slept = -1e9;
  assert.equal(await popupTextOf(one("needs"), true, { ...o, sleep: async (ms: number) => { slept += ms; } }), undefined, "it gives up after 1 s");
});
