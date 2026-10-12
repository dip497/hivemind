// A session's output to every viewer that shows it (src/session-relay.ts): two windows, one terminal.
import { expect, test } from "bun:test";
import { PACED_WINDOW, SessionRelay, type ReadScreen, type Viewer } from "../src/session-relay.js";

const RESET = "<reset>";
const tick = () => new Promise((r) => setTimeout(r, 40));

function viewer(): Viewer & { got: string[]; alive: () => boolean; gone: () => void } {
  let alive = true;
  const got: string[] = [];
  return { got, data: (_t, d) => void got.push(d), exit: (_t, i) => void got.push(`exit ${i.code}`), alive: () => alive, gone: () => { alive = false; } };
}
function relay() {
  const recorded: string[] = [];
  return { recorded, relay: new SessionRelay({ record: (_t, d) => void recorded.push(d), screenPrefix: RESET }) };
}
/** A host screen the test answers when it likes, in order with the output as the host would. */
function laterScreen(): { read: ReadScreen; answer: (s: string) => void } {
  let pending: ((s: string | null) => void) | undefined;
  return { read: (cb) => { pending = cb; return true; }, answer: (s) => pending?.(s) };
}

test("every viewer of a session gets its output, coalesced, and it is recorded once", async () => {
  const { relay: r, recorded } = relay();
  const a = viewer(), b = viewer();
  r.add("t", a); r.add("t", b);
  r.push("t", "he"); r.push("t", "llo");
  await tick();
  expect(a.got).toEqual(["hello"]);
  expect(b.got).toEqual(["hello"]);
  expect(recorded).toEqual(["hello"]);
});

test("a viewer that joins gets the host's screen, then live bytes; output older than that screen goes to the others only", async () => {
  const { relay: r } = relay();
  const a = viewer(), b = viewer();
  r.add("t", a);
  r.push("t", "old");
  const screen = laterScreen();
  expect(r.join("t", b, screen.read)).toBe(true);
  r.push("t", "meanwhile");
  screen.answer("SCREEN");
  r.push("t", "new");
  await tick();
  expect(a.got).toEqual(["oldmeanwhile", "new"]);
  expect(b.got).toEqual([`${RESET}SCREEN`, "new"]);
  expect(r.join("t", viewer(), () => false)).toBe(false);
});

test("a viewer that shows the session nowhere gets nothing while the host keeps its screen, and the screen again when it does", async () => {
  const { relay: r } = relay();
  const a = viewer(), b = viewer(), c = viewer();
  r.add("t", a); r.add("t", b); r.add("t", c);
  const screen = laterScreen();
  r.show("t", b, false, screen.read);
  r.show("t", c, false, null); // a host that keeps no screen: it must keep up
  r.push("t", "while hidden");
  await tick();
  r.show("t", b, true, screen.read);
  screen.answer("NOW");
  r.push("t", "after");
  await tick();
  expect(a.got).toEqual(["while hidden", "after"]);
  expect(b.got).toEqual([`${RESET}NOW`, "after"]);
  expect(c.got).toEqual(["while hidden", "after"]);
});

test("a viewer shown again that missed nothing keeps what it shows: no screen, and what was held back while it was hidden comes live", async () => {
  const { relay: r } = relay();
  const a = viewer(), b = viewer();
  r.add("t", a); r.add("t", b);
  let asked = 0;
  const screen: ReadScreen = (cb) => { asked++; cb("SCREEN"); return true; };
  r.show("t", b, false, screen);
  await tick();
  r.show("t", b, true, screen);
  expect(asked).toBe(0);
  // Output still batched when it was hidden is not missed: it goes to it as to the others.
  r.show("t", b, false, screen);
  r.push("t", "pending");
  r.show("t", b, true, screen);
  await tick();
  expect(asked).toBe(0);
  expect(b.got).toEqual(["pending"]);
  // Output sent to the others while it was hidden is: the screen, once.
  r.show("t", b, false, screen);
  r.push("t", "gone by");
  await tick();
  r.show("t", b, true, screen);
  r.show("t", b, false, screen);
  r.show("t", b, true, screen);
  expect(asked).toBe(1);
  expect(a.got).toEqual(["pending", "gone by"]);
  expect(b.got).toEqual(["pending", `${RESET}SCREEN`]);
});

test("an exit reaches every viewer after the output before it; one that left, or is gone, gets nothing", async () => {
  const { relay: r } = relay();
  const a = viewer(), b = viewer(), left = viewer(), gone = viewer();
  for (const v of [a, b, left, gone]) r.add("t", v);
  expect(r.leave("t", left)).toBe(3);
  gone.gone();
  r.push("t", "last words");
  r.exit("t", { code: 0 });
  expect(a.got).toEqual(["last words", "exit 0"]);
  expect(b.got).toEqual(["last words", "exit 0"]);
  expect(left.got).toEqual([]);
  expect(gone.got).toEqual([]);
  expect(r.count("t")).toBe(0);
});

test("a viewer that goes leaves every session it watched; those nobody watches now are named", () => {
  const { relay: r } = relay();
  const a = viewer(), b = viewer();
  r.add("shared", a); r.add("shared", b); r.add("mine", a);
  expect(r.leaveAll(a)).toEqual(["mine"]);
  expect(r.count("shared")).toBe(1);
  expect(r.count("mine")).toBe(0);
});

test("a paced viewer is sent no more than its window ahead of what it took; behind, nothing until it took all it was sent, then the screen in place of what it missed, which the window does not count", async () => {
  const { relay: r } = relay();
  const near = viewer(), far = viewer();
  const half = "x".repeat(PACED_WINDOW / 2);
  const screen = laterScreen();
  r.add("t", near);
  r.add("t", far, () => screen.read);
  const batch = async (data: string) => { r.push("t", data); await tick(); };
  await batch(`1${half.slice(1)}`); // the first goes, whatever its size
  await batch(half); // the window's worth
  await batch("3"); // past it
  await batch("4");
  r.acked("t", far, half.length); // not all of it: still behind
  await batch("5");
  expect(far.got.map((d) => d.slice(0, 1))).toEqual(["1", "x"]);
  r.acked("t", far, PACED_WINDOW);
  const big = "S".repeat(PACED_WINDOW * 2);
  screen.answer(big);
  await batch("6"); // live again at once: the screen is not what it has to take
  await batch("7");
  expect(far.got.slice(2)).toEqual([`${RESET}${big}`, "6", "7"]);
  expect(near.got).toEqual([`1${half.slice(1)}`, half, "3", "4", "5", "6", "7"]);
});

/** A start the test finishes when it likes, counting how often it was asked for. */
function laterStart(): { start: () => Promise<{ pid: number }>; finish: (pid: number) => void; fail: () => void; starts: () => number } {
  let starts = 0;
  let settle: { finish: (pid: number) => void; fail: () => void } | undefined;
  return {
    start: () => { starts++; return new Promise((resolve, reject) => { settle = { finish: (pid) => resolve({ pid }), fail: () => reject(new Error("no pty")) }; }); },
    finish: (pid) => settle?.finish(pid),
    fail: () => settle?.fail(),
    starts: () => starts,
  };
}

test("two viewers opening a session at once start it once: the second joins it, its screen first, and only the one that started it gives it its task", async () => {
  const { relay: r } = relay();
  const a = viewer(), b = viewer();
  const s = laterStart();
  const screen = laterScreen();
  const opening = [r.open("t", a, s.start, () => screen.read), r.open("t", b, s.start, () => screen.read)];
  // What the session prints while it starts reaches the one starting it.
  r.push("t", "banner");
  await tick();
  s.finish(42);
  await tick();
  screen.answer("banner");
  expect(await Promise.all(opening)).toEqual([{ pid: 42, joined: false }, { pid: 42, joined: true }]);
  expect(s.starts()).toBe(1);
  r.push("t", "live");
  await tick();
  expect(a.got).toEqual(["banner", "live"]);
  expect(b.got).toEqual([`${RESET}banner`, "live"]);
  // The one that started it opening it again (a remount) still gives it its task.
  expect(await r.open("t", a, s.start, () => screen.read)).toEqual({ pid: 42, joined: false });
  expect(s.starts()).toBe(1);
});

test("a start that fails, or finds no session, leaves no viewer behind, and the next open starts again; so does an exit", async () => {
  const { relay: r } = relay();
  const a = viewer(), b = viewer();
  const s = laterStart();
  const failing = r.open("t", a, s.start, () => null);
  s.fail();
  await expect(failing).rejects.toThrow("no pty");
  expect(r.count("t")).toBe(0);
  const missing = r.open("t", a, s.start, () => null);
  s.finish(-1);
  expect(await missing).toEqual({ pid: -1, joined: false });
  expect(r.count("t")).toBe(0);
  const running = r.open("t", a, s.start, () => null);
  s.finish(7);
  expect(await running).toEqual({ pid: 7, joined: false });
  r.exit("t", { code: 0 });
  const again = r.open("t", b, s.start, () => null);
  s.finish(8);
  expect(await again).toEqual({ pid: 8, joined: false });
  expect(s.starts()).toBe(4);
});
