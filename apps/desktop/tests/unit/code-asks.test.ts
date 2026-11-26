// The Code tile's timing for questions about code (code-asks.ts): the outline waits for typing to
// stop, and a new question, or the cursor moving, takes back the one still open.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AfterTyping, OneAtATime } from "../../src/renderer/src/code/code-asks";

const later = (ms: number) => new Promise((r) => setTimeout(r, ms));

function question() {
  let answer!: (v: unknown) => void;
  const asked = { cancelled: false, answer: new Promise<unknown>((r) => { answer = r; }), cancel() { asked.cancelled = true; } };
  return { asked, answer };
}

test("a new question takes back the one still open; a question already answered is left alone", async () => {
  const open = new OneAtATime();
  const first = question();
  const second = question();
  open.start(first.asked, () => {}, () => {});
  open.start(second.asked, () => {}, () => {});
  assert.equal(first.asked.cancelled, true);
  assert.equal(second.asked.cancelled, false);

  second.answer("found");
  await second.asked.answer;
  open.cancel();
  assert.equal(second.asked.cancelled, false);
});

test("moving the cursor takes back the open question", () => {
  const open = new OneAtATime();
  const q = question();
  open.start(q.asked, () => {}, () => {});
  open.cancel();
  assert.equal(q.asked.cancelled, true);
});

test("only the open question's answer is shown: one taken back says nothing when it arrives, a failure is shown", async () => {
  const open = new OneAtATime();
  const shown: string[] = [];
  const first = question();
  const second = question();
  open.start(first.asked, (a) => shown.push(`first: ${a}`), () => shown.push("first failed"));
  open.start(second.asked, (a) => shown.push(`second: ${a}`), (e) => shown.push(`second failed: ${(e as Error).message}`));
  first.answer("late");
  await later(0);
  assert.deepEqual(shown, []);

  let fail!: (e: Error) => void;
  const third = { answer: new Promise<unknown>((_, r) => { fail = r; }), cancel() {} };
  open.start(third, () => shown.push("third"), (e) => shown.push(`third failed: ${(e as Error).message}`));
  fail(new Error("Code questions work inside the workspace"));
  second.answer("also late");
  await later(0);
  assert.deepEqual(shown, ["third failed: Code questions work inside the workspace"]);
});

test("the outline is read once, after typing stops, not once per key", async () => {
  let runs = 0;
  const outline = new AfterTyping(40, () => { runs++; });
  for (let i = 0; i < 6; i++) { outline.poke(); await later(10); }
  assert.equal(runs, 0);
  await later(80);
  assert.equal(runs, 1);
  outline.poke();
  outline.stop();
  await later(80);
  assert.equal(runs, 1);
});
