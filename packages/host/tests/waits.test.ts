// What an agent waits on that an answer ends (waits.ts): its status says it waits while the wait
// lasts; the first answer is the one the agent gets, and a later one changes nothing and hears who
// was first; an answer to another wait answers nothing; a wait the agent stops on, or one another
// wait replaces, ends unanswered and its owner is told so; and an agent that goes is told its wait
// ended.
import { test } from "node:test";
import assert from "node:assert/strict";
import { StatusStore } from "@hivemind/agent-host/status-store";
import { Waits } from "../src/waits.ts";

const PRIYA = { person: "p".repeat(64), name: "Priya" };
const ADARSH = { person: "a".repeat(64), name: "Adarsh" };

function host() {
  let now = 1_790_000_000_000;
  const status = new StatusStore({ now: () => ++now });
  const waits = new Waits({ status });
  const replies: string[] = [];
  const ask = (tile = "t1") => waits.ask(tile, { kind: "plan", plan: "# Plan", cwd: "/work/api" }, (d, f) => replies.push(`${tile} ${d}${f ? ` ${f}` : ""}`));
  return { status, waits, replies, ask };
}

test("the agent waits while the wait lasts; the first answer is the one it gets, and a later one changes nothing and hears who was first", () => {
  const h = host();
  const wait = h.ask();
  const { state, kind, since } = h.status.get("t1")!;
  assert.deepEqual({ state, kind, since }, { state: "waiting", kind: "plan", since: wait.since });
  assert.equal(h.waits.of("t1")?.plan, "# Plan");
  assert.deepEqual(h.waits.answer("t1", wait.since, "deny", { feedback: "split step 2", by: PRIYA }), { answered: true });
  assert.deepEqual(h.waits.answer("t1", wait.since, "allow", { by: ADARSH }), { answered: false, by: PRIYA });
  assert.deepEqual(h.replies, ["t1 deny split step 2"]);
  assert.equal(h.status.get("t1")?.state, "working");
  assert.equal(h.waits.of("t1"), undefined);
  assert.deepEqual(h.waits.answerOf("t1", wait.since), { decision: "deny", by: PRIYA });
});

test("an answer to another wait, or another agent's, answers nothing", () => {
  const h = host();
  const wait = h.ask();
  assert.deepEqual(h.waits.answer("t1", wait.since - 1, "allow"), { answered: false });
  assert.deepEqual(h.waits.answer("t2", wait.since, "allow"), { answered: false });
  assert.deepEqual(h.replies, []);
  assert.equal(h.waits.named(wait.request)?.tile, "t1");
});

test("a wait the agent stops on ends unanswered: it waits no more, its owner is told once, and an answer after that is late", () => {
  const h = host();
  const wait = h.ask();
  h.waits.drop(wait.request);
  h.waits.drop(wait.request);
  assert.equal(h.status.get("t1")?.state, "working");
  assert.deepEqual(h.waits.answer("t1", wait.since, "allow", { by: PRIYA }), { answered: false });
  assert.deepEqual(h.replies, ["t1 null"]);
  assert.deepEqual(h.waits.all(), []);
});

test("a wait another replaces ends unanswered, and its owner is told so; the new one is what the agent waits on", () => {
  const h = host();
  const first = h.ask();
  const next = h.waits.ask("t1", { kind: "approval", tool: "Bash", summary: "make" }, (d) => h.replies.push(`next ${d}`));
  assert.deepEqual(h.replies, ["t1 null"]);
  assert.deepEqual(h.waits.answer("t1", first.since, "allow"), { answered: false });
  assert.deepEqual(h.waits.answer("t1", next.since, "allow"), { answered: true });
  assert.deepEqual(h.replies, ["t1 null", "next allow"]);
});

test("an agent that goes is told its wait ended, and nothing waits on it after", () => {
  const h = host();
  h.ask();
  h.waits.forget("t1");
  assert.deepEqual(h.replies, ["t1 deny the agent closed"]);
  assert.equal(h.waits.of("t1"), undefined);
});
