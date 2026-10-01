// Answering what an agent waits on the person for, from another of their devices (answers.ts,
// spec/needs.md "Answering"): a line is typed into the agent's terminal, Enter after it, and a plan
// is decided as at the desktop, only while the agent still waits on that wait (its tile, and when
// it began) and once: an answer that comes late, or again, does nothing and says so. One waiting
// on its supervisor, or on nothing, is not answered; and an answer is one line of text, or a plan's
// decision.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Connection } from "@hivemind/workspace-api/server";
import { ApiError } from "@hivemind/workspace-api/protocol";
import type { PlanDecided, PlanReview } from "@hivemind/workspace-api/plans";
import { answers, ANSWER_MAX } from "../src/answers.ts";
import { Plans } from "../src/plans.ts";

const T = 1_790_000_000_000;
const phone: Connection = { actor: { kind: "peer", person: "p".repeat(64), device: "d".repeat(64), access: "owner" }, send: () => {}, closed: new AbortController().signal };

/** A computer whose agent in `t1` has `status`: what is typed into each terminal, the plans told
 *  decided, and its `agent.answer`. */
function computer(status: { state: string; kind?: "permission" | "question" | "plan" | "approval" | "other"; since: number }) {
  const statuses = new Map([["t1", status]]);
  const typed: string[] = [];
  const decided: PlanDecided[] = [];
  const plans = new Plans({
    publish: (event, ...params) => { if (event === "plan.decided") decided.push(params[0] as PlanDecided); },
    who: () => ({ person: "p".repeat(64), name: "Priya" }) as never,
    repoOf: () => "/work/api",
  });
  const domain = answers({ status: (tile) => statuses.get(tile), type: (tile, data) => { typed.push(`${tile}:${JSON.stringify(data)}`); return tile === "t1"; }, plans });
  const answer = (tile: string, since: number, a: unknown) => domain.answers["agent.answer"]!(phone, tile, since, a) as { answered: boolean };
  return { statuses, typed, decided, plans, answer };
}
const code = (f: () => unknown): string => { try { f(); return "ok"; } catch (e) { return e instanceof ApiError ? e.code : "thrown"; } };

test("an answer is typed into the agent's terminal, Enter after it, once: again, or for a wait that has passed, it does nothing", () => {
  const c = computer({ state: "waiting", kind: "permission", since: T });
  assert.deepEqual(c.answer("hm:t1", T, { text: "1" }), { answered: true });
  assert.deepEqual(c.typed, ['t1:"1\\r"']);
  assert.deepEqual(c.answer("t1", T, { text: "1" }), { answered: false }, "again");
  // It waits anew: the earlier wait's answer is late, the new one's lands.
  c.statuses.set("t1", { state: "waiting", kind: "question", since: T + 5_000 });
  assert.deepEqual(c.answer("t1", T, { text: "yes" }), { answered: false }, "late");
  assert.deepEqual(c.answer("t1", T + 5_000, { text: "yes" }), { answered: true });
  assert.deepEqual(c.typed, ['t1:"1\\r"', 't1:"yes\\r"']);

  // Unanswered, it moved on to another wait: an answer to the first, from a list read before, is late.
  const later = computer({ state: "waiting", kind: "permission", since: T });
  later.statuses.set("t1", { state: "waiting", kind: "permission", since: T + 9_000 });
  assert.deepEqual(later.answer("t1", T, { text: "1" }), { answered: false }, "late, never answered");
  assert.deepEqual(later.typed, []);
});

test("a plan is decided as at the desktop: the agent gets the first answer, and everyone is told who gave it", () => {
  const c = computer({ state: "waiting", kind: "plan", since: T });
  const replies: string[] = [];
  const review: PlanReview = { requestId: "r1", tileId: "hm:t1", plan: "1. Split it", cwd: "/work/api" };
  c.plans.ask(review, (decision, feedback) => replies.push(`${decision} ${feedback ?? ""}`.trim()));
  assert.deepEqual(c.answer("t1", T, { decision: "deny", feedback: "smaller steps" }), { answered: true });
  assert.deepEqual(replies, ["deny smaller steps"]);
  assert.deepEqual(c.decided, [{ requestId: "r1", tileId: "hm:t1", decision: "deny", by: { person: "p".repeat(64), name: "Priya" } }]);
  assert.deepEqual(c.answer("t1", T, { decision: "allow" }), { answered: false });
  assert.deepEqual(replies, ["deny smaller steps"]);
  assert.deepEqual(c.typed, [], "nothing typed for a plan");
});

test("an agent that does not wait on the person is not answered: working, waiting on its supervisor's approval, or unknown", () => {
  for (const status of [{ state: "working", since: T }, { state: "waiting", kind: "approval" as const, since: T }]) {
    const c = computer(status);
    assert.deepEqual(c.answer("t1", T, { text: "1" }), { answered: false }, status.state);
    assert.deepEqual(c.typed, []);
  }
  const c = computer({ state: "waiting", kind: "permission", since: T });
  assert.deepEqual(c.answer("t2", T, { text: "1" }), { answered: false }, "no such agent");
});

test("an answer is one line of text, or a plan's decision; anything else is a bad request, and nothing is typed", () => {
  const c = computer({ state: "waiting", kind: "question", since: T });
  for (const a of [{ text: "two\nlines" }, { text: "\u001b[2J" }, { text: "" }, { text: "x".repeat(ANSWER_MAX + 1) }, { decision: "allow" }, null]) {
    assert.equal(code(() => c.answer("t1", T, a)), "BAD_REQUEST", JSON.stringify(a));
  }
  assert.equal(code(() => c.answer("t1", "soon" as never, { text: "1" })), "BAD_REQUEST");
  assert.deepEqual(c.typed, []);
  const plan = computer({ state: "waiting", kind: "plan", since: T });
  assert.equal(code(() => plan.answer("t1", T, { text: "ok" })), "BAD_REQUEST");
});
