// A session's output to every viewer that shows it (src/session-relay.ts): two windows, one terminal.
import { expect, test } from "bun:test";
import { SessionRelay, type ReadScreen, type Viewer } from "../src/session-relay.js";

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
