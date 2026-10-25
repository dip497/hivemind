// The notice desk in main (notice-desk-core.ts): every window's copy of an agent's change becomes
// one event; pop-ups are gated, and a burst of one kind gathers into one; sounds are gated, paced
// and counted; Recent says what each burst did. Driven at the desk's own boundary (`receive`,
// `result`, `recent`) on a clock the test moves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { GATHER_MS, GROUP_MS, LATE_COPY_MS, NoticeDeskCore, themeSoundOf, type Popup, type Sound } from "../../src/main/notice-desk-core.ts";
import { mergeSettings } from "@hivemind/core/settings-schema";
import { DEFAULT_NOTIFICATION_SETTINGS, type NoticeKind, type NotificationSettings } from "../../src/shared/notification-settings.ts";
import type { AgentNotice } from "../../src/shared/ipc.ts";

/** A clock the test moves, with the timers it would run: `now` is the clock the timers run on, and
 *  `wall` the time of day, which the person can set back. The first reads six hours behind the
 *  second, so a time of day read on it (Do Not Disturb, Recent) is read at 06:00, not noon. */
function clock(start = new Date(2025, 0, 1, 12, 0).getTime()) {
  let t = start - 6 * 3_600_000;
  let wall = start - t;
  const timers: { at: number; fn: () => void }[] = [];
  return {
    now: () => t,
    wall: () => wall + t,
    /** The wall clock set by `ms`, the timers' clock not. */
    setWall: (ms: number) => { wall += ms; },
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
    now: c.now, wall: c.wall, schedule: c.schedule, settings: () => s, focused: () => isFocused,
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

test("ten finishes spread over 400 ms play twice, and Recent counts all ten for the one burst", () => {
  const { d, c, sounds } = desk();
  for (let i = 0; i < 10; i++) { d.receive(n(`t${i}`, "done"), false); c.tick(40); }
  c.tick(3000);
  // The first sound gathers what came in its 150 ms; the rest wait out the 1.2 s gap.
  assert.deepEqual(sounds.map((x) => x.count), [4, 6]);
  assert.deepEqual(d.recent().map((b) => [b.moment, b.agents, b.count]), [["done", 10, 10]]);
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
  const start = c.now();
  d.receive(n("a", "needs"), false);
  c.tick(500);
  d.receive(n("b", "needs"), false);
  d.receive(n("c", "needs"), false);
  c.tick(3000);
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

test("a finish of a tile selected in the focused window makes no sound, whichever window's copy comes first; another tile's does", () => {
  const { d, c, sounds } = desk({}, true);
  d.receive(n("a", "done"), false);
  d.receive(n("a", "done"), true); // the focused window has it selected: its copy says so
  c.tick(2000);
  assert.deepEqual(sounds, []);
  assert.deepEqual([d.recent()[0]!.sound, d.recent()[0]!.why], ["skipped", "you were looking at it"]);
  // The selected copy first, the other window's after it: a later copy never unsets it.
  d.receive(n("s", "done"), true);
  d.receive(n("s", "done"), false);
  c.tick(2000);
  assert.deepEqual(sounds, []);
  d.receive(n("b", "done"), false);
  c.tick(2000);
  assert.deepEqual(sounds.map((x) => x.moment), ["done"]);
});

test("needs you and failed play while the person looks at that tile", () => {
  for (const kind of ["needs", "error"] as const) {
    const { d, c, sounds } = desk({}, true);
    d.receive(n("a", kind), true);
    c.tick(2000);
    d.result(sounds[0]!.id, true);
    assert.deepEqual([sounds.map((x) => x.moment), d.recent()[0]!.sound], [[kind], "played"], kind);
  }
});

test("on its own clocks, the computer's clock set back an hour delays no sound and holds back no change; Recent says the time of day", (t) => {
  // As main makes it: no clock given. Node runs the timers on `performance.now()`; `Date.now()` is
  // the time of day, which the test moves alone.
  const noon = new Date(2025, 0, 1, 12, 0).getTime();
  let mono = 1000;
  let wall = noon - mono;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(performance, "now", () => mono);
  t.mock.method(Date, "now", () => wall + mono);
  /** Move on `ms`; a timer due on the way runs at its end, so each step ends where one is due. */
  const tick = (ms: number) => { mono += ms; t.mock.timers.tick(ms); };
  const sounds: NoticeKind[] = [];
  const d = new NoticeDeskCore({ settings: () => SOUNDS_ON, focused: () => false, popup: () => {}, sound: (x) => sounds.push(x.moment) });
  d.receive(n("a", "done"), false);
  tick(GATHER_MS);
  tick(2000 - GATHER_MS);
  wall -= 3_600_000;
  d.receive(n("b", "done"), false);
  tick(GATHER_MS);
  assert.deepEqual(sounds, ["done", "done"], "the second sound waits its 150 ms, not an hour");
  // b again 2.1 s later, without the host's time: a change of its own, not a copy of the first.
  tick(2100);
  d.receive(n("b", "done"), false);
  tick(2000);
  assert.equal(sounds.length, 3);
  assert.deepEqual(d.recent().map((b) => b.at - noon), [4250 - 3_600_000, 2000 - 3_600_000, 0]);
});

test("a tile's next session, whose host time starts lower once the clock was set back, is told once 10 s have passed; an earlier change's copy inside them is not", () => {
  const { d, c } = desk();
  const at = (since: number): AgentNotice => ({ ...n("a", "done"), since });
  const noon = new Date(2025, 0, 1, 12, 0).getTime();
  d.receive(at(noon), false);
  d.receive(at(noon + 5000), false);
  c.tick(LATE_COPY_MS - 1);
  d.receive(at(noon), false); // a slow window's copy of the first
  c.tick(60_000);
  d.receive(at(noon + 5000), false); // a copy of the last, however late
  assert.deepEqual(d.recent().map((b) => b.agents), [2]);
  d.receive(at(noon - 3_600_000), false); // the next session, after the clock went back an hour
  assert.deepEqual(d.recent().map((b) => b.agents), [1, 2]);
});

test("a copy 1.9 s after a change merges into it; 2.1 s after, it is a new change", () => {
  const { d, c } = desk();
  d.receive(n("a", "done"), false);
  c.tick(1900);
  d.receive(n("a", "done"), false);
  assert.deepEqual(d.recent().map((b) => b.agents), [1]);
  c.tick(200);
  d.receive(n("a", "done"), false);
  assert.deepEqual(d.recent().map((b) => b.agents), [1, 1]);
});

test("copies carrying the host's time of a change are one change however late; a later time is a new one", () => {
  const { d, c } = desk();
  const at = (tileId: string, since: number): AgentNotice => ({ ...n(tileId, "done"), since });
  d.receive(at("a", 1000), false);
  c.tick(4500); // a busy window sees it seconds after the other
  d.receive(at("a", 1000), false);
  assert.deepEqual(d.recent().map((b) => b.agents), [1]);
  // The same tile finishing again 500 ms later: a change of its own, not a copy.
  d.receive(at("b", 2000), false);
  c.tick(500);
  d.receive(at("b", 2600), false);
  d.receive(at("b", 2000), false); // the slow window's copy of the first
  assert.deepEqual(d.recent().map((b) => b.agents), [2, 1]);
});

test("the dedupe map holds the last 1024 changes: the 1025th puts the first out, so its copy counts again", () => {
  const { d } = desk();
  for (let i = 0; i <= 1024; i++) d.receive(n(`t${i}`, "done"), false);
  d.receive(n("t0", "done"), false); // put out: a new change, which puts t1 out
  d.receive(n("t2", "done"), false); // still held: a copy
  assert.deepEqual(d.recent().map((b) => b.agents), [1026]);
});

test("a burst: a notice 1.4 s after the last gathers into its pop-up; 1.6 s after, it starts a burst with a pop-up of its own", () => {
  const { d, c, popups } = desk();
  d.receive(n("a", "done"), false);
  c.tick(1400);
  d.receive(n("b", "done"), false);
  c.tick(1600);
  d.receive(n("c", "done"), false);
  c.tick(2000);
  assert.deepEqual(popups.map((p) => [p.notices.map((x) => x.tileId), p.more]), [[["a"], false], [["b"], true], [["c"], false]]);
  assert.deepEqual(d.recent().map((b) => b.agents), [1, 2]);
});

test("a window that takes the focus before a burst's pop-up gathers stops it", () => {
  const { d, c, popups, focus } = desk();
  d.receive(n("a", "done"), false);
  d.receive(n("b", "done"), false);
  c.tick(1000);
  focus(true);
  c.tick(1000);
  assert.deepEqual(popups.map((p) => p.notices.map((x) => x.tileId)), [["a"]]);
  assert.equal(d.recent()[0]!.popups, 1);
});

test("1500 notices with their sounds, pop-ups and Recent, in a bound near what they cost", (t) => {
  const notices = Array.from({ length: 1500 }, (_, i) => ({ ...n(`b${i}`, (["needs", "error", "done"] as const)[i % 3]!), since: 1000 + i }));
  // Twice each (two windows): the copies are half the work the desk sees. The fastest of five fresh
  // desks: a busy machine slows a run, never speeds one.
  let took = Infinity;
  for (let run = 0; run < 5; run++) {
    const { d, c } = desk();
    const started = performance.now();
    for (const x of notices) { d.receive(x, false); d.receive(x, false); }
    c.tick(GROUP_MS + GATHER_MS);
    took = Math.min(took, performance.now() - started);
  }
  t.diagnostic(`3000 notices (1500 changes, two windows) and their timers: ${took.toFixed(3)} ms`);
  // 6–7.5 ms measured on a shared 4-CPU container (2026-10-24); the bound gives it twice that.
  assert.ok(took < 15, `${took} ms`);
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

test("a pop-up is silent while the app plays its sound, by Do Not Disturb at the time of day", () => {
  // Do Not Disturb from 05:00 to 07:00, and it is noon: the app plays the finished sound.
  const { d, c, popups } = desk({ dnd: { enabled: true, start: "05:00", end: "07:00" } });
  d.receive(n("a", "done"), false);
  d.receive(n("b", "done"), false);
  c.tick(2000);
  assert.deepEqual(popups.map((p) => [p.more, p.silent]), [[false, true], [true, true]]);
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
  wait = undefined; slept = 0;
  assert.equal(await popupTextOf(one("needs"), true, { ...o, sleep: async (ms: number) => { slept += ms; } }), undefined);
  assert.equal(slept, 1000, "it gives up after 1 s");
});

test("a theme's sound: only a hivemedia: file of the applied theme, named by the theme", () => {
  // As the settings owner reads the file: the record's checks are the gate main hands files through.
  const sound = (theme: Record<string, unknown>) => themeSoundOf(mergeSettings({ appearanceExtra: { theme: { id: "@me/pack/harbour", version: "1.0.0", before: { appearance: {}, extra: {} }, ...theme } } }), "needs");
  const media = "hivemedia://media/theme-1-needs.wav";
  const rows: [string, Record<string, unknown>, ReturnType<typeof themeSoundOf>][] = [
    ["its file", { name: "Harbour", sounds: { needs: media } }, { url: media, pack: "Harbour" }],
    ["a name with spaces around it", { name: "  Harbour  ", sounds: { needs: media } }, { url: media, pack: "Harbour" }],
    ["no name: the theme's id names it", { sounds: { needs: media } }, { url: media, pack: "harbour" }],
    ["a file: URL", { name: "Harbour", sounds: { needs: "file:///etc/hostname" } }, undefined],
    ["an http: URL", { name: "Harbour", sounds: { needs: "http://example.com/a.wav" } }, undefined],
    ["a path out of the media folder", { name: "Harbour", sounds: { needs: "hivemedia://media/../settings.json" } }, undefined],
    ["a URL over 2048 characters", { name: "Harbour", sounds: { needs: `hivemedia://media/${"a".repeat(2048)}.wav` } }, undefined],
    ["no sound for the moment", { name: "Harbour", sounds: { done: media } }, undefined],
  ];
  for (const [what, theme, says] of rows) assert.deepEqual(sound(theme), says, what);
  assert.equal(themeSoundOf(mergeSettings({}), "needs"), undefined, "no theme applied");
});
