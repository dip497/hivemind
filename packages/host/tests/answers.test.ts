// Answering what an agent waits on, from another of the person's devices or a program
// (answers.ts, spec/needs.md "Answering"): a line is typed into the agent's terminal, Enter after
// it, and a plan or a supervised tool use is decided (waits.ts), only while the agent still waits
// on that wait (its tile, and when it began) and once: an answer that comes late, or again, does
// nothing and says so, a decided one saying who was first. One waiting on nothing is not
// answered; and an answer is one line of text, or a decision. A permission is allowed or denied
// with the keys its agent says do that on its screen (0.5). A supervised tool use is answered by
// the program that started the agent, or the person. And a message to an agent, whatever it is
// doing: one line, handed to it as its next prompt (spec/needs.md "Sending").
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Connection } from "@hivemind/workspace-api/server";
import { ApiError } from "@hivemind/workspace-api/protocol";
import type { AnswerKeys, InputKind } from "@hivemind/agents";
import { StatusStore } from "@hivemind/agent-host/status-store";
import { KEY_GAP_MS } from "@hivemind/agent-host/keys";
import { answers, ANSWER_MAX } from "../src/answers.ts";
import { Waits } from "../src/waits.ts";

const PRIYA = { person: "p".repeat(64), name: "Priya" };
const phone: Connection = { actor: { kind: "peer", person: PRIYA.person, device: "d".repeat(64), access: "owner" }, send: () => {}, closed: new AbortController().signal };

/** A computer whose agent is in `t1`, and says `keys` allow and deny what it waits on, by the
 *  wait's name: what is typed into each terminal, what is handed to an agent as its next prompt,
 *  and its `agent.answer`. */
function computer(keys?: Record<string, AnswerKeys>) {
  let now = 1_790_000_000_000;
  const status = new StatusStore({ now: () => (now += 1_000) });
  const waits = new Waits({ status });
  const typed: string[] = [];
  const delivered: string[] = [];
  const domain = answers({
    status: (tile) => status.get(tile),
    type: (tile, data) => { typed.push(`${tile}:${JSON.stringify(data)}`); return tile === "t1"; },
    answerKeys: (tile, status) => (tile === "t1" ? keys?.[(status.says ?? status.kind)!] : undefined),
    deliver: (tile, text) => { delivered.push(`${tile}:${text}`); return tile === "t1"; },
    waits,
    who: () => PRIYA,
  });
  /** The agent in t1 waits anew on `kind`, on its screen: when the wait began. */
  const waitOn = (kind: InputKind): number => {
    status.event("t1", { event: "input.resolved" });
    status.event("t1", { event: "input.requested", kind });
    return status.get("t1")!.since;
  };
  /** The agent in t1 shows a screen its manifest says is `says`, asking a permission: when the wait
   *  began. */
  const screenSays = (says: string): number => {
    status.screen("t1", "permission", says);
    return status.get("t1")!.since;
  };
  const answer = (tile: string, since: number, a: unknown, from = phone) => domain.answers["agent.answer"]!(from, tile, since, a) as { answered: boolean };
  const send = (tile: string, text: unknown) => domain.answers["agent.send"]!(phone, tile, text) as { sent: boolean };
  return { status, waits, typed, delivered, waitOn, screenSays, answer, send, effect: domain.effects!["agent.send"]! };
}
const code = (f: () => unknown): string => { try { f(); return "ok"; } catch (e) { return e instanceof ApiError ? e.code : "thrown"; } };

test("an answer is typed into the agent's terminal, Enter after it, once: again, or for a wait that has passed, it does nothing", () => {
  const c = computer();
  const first = c.waitOn("permission");
  assert.deepEqual(c.answer("hm:t1", first, { text: "1" }), { answered: true });
  assert.deepEqual(c.typed, ['t1:"1\\r"']);
  assert.deepEqual(c.answer("t1", first, { text: "1" }), { answered: false }, "again");
  // It waits anew: the earlier wait's answer is late, the new one's lands.
  const next = c.waitOn("question");
  assert.deepEqual(c.answer("t1", first, { text: "yes" }), { answered: false }, "late");
  assert.deepEqual(c.answer("t1", next, { text: "yes" }), { answered: true });
  assert.deepEqual(c.typed, ['t1:"1\\r"', 't1:"yes\\r"']);

  // Unanswered, it moved on to another wait: an answer to the first, from a list read before, is late.
  const later = computer();
  const read = later.waitOn("permission");
  later.waitOn("permission");
  assert.deepEqual(later.answer("t1", read, { text: "1" }), { answered: false }, "late, never answered");
  assert.deepEqual(later.typed, []);
});

test("a plan is decided: the agent gets the first answer, and a later one hears who gave it", () => {
  const c = computer();
  const replies: string[] = [];
  const asked = c.waitOn("question");
  const wait = c.waits.ask("t1", { kind: "plan", plan: "1. Split it", cwd: "/work/api" }, (decision, feedback) => replies.push(`${decision} ${feedback ?? ""}`.trim()));
  assert.deepEqual(c.answer("t1", asked, { text: "yes" }), { answered: false }, "the question it waited on before is late");
  assert.deepEqual(c.answer("t1", wait.since, { decision: "deny", feedback: "smaller steps" }), { answered: true });
  assert.deepEqual(replies, ["deny smaller steps"]);
  assert.deepEqual(c.answer("t1", wait.since, { decision: "allow" }), { answered: false, by: PRIYA });
  assert.deepEqual(replies, ["deny smaller steps"]);
  assert.deepEqual(c.typed, [], "nothing typed for a plan");
});

test("a permission is allowed or denied with the keys its agent says do that, each a moment after the last, once: again, or for a wait that has passed, nothing", async () => {
  const keys = { allow: ["y", "Enter"], deny: ["Escape"] };
  const settle = () => new Promise((resolve) => setTimeout(resolve, KEY_GAP_MS * 2 + 50));
  const c = computer({ permission: keys });
  const first = c.waitOn("permission");
  assert.deepEqual(c.answer("hm:t1", first, { decision: "allow" }), { answered: true });
  assert.deepEqual(c.typed, ['t1:"y"'], "the first key at once");
  await settle();
  assert.deepEqual(c.typed, ['t1:"y"', 't1:"\\r"']);
  assert.deepEqual(c.answer("t1", first, { decision: "deny" }), { answered: false }, "again");
  // It asks again: the earlier wait's decision is late, the new one's lands.
  const next = c.waitOn("permission");
  assert.deepEqual(c.answer("t1", first, { decision: "deny" }), { answered: false }, "late");
  assert.deepEqual(c.answer("t1", next, { decision: "deny" }), { answered: true });
  await settle();
  assert.deepEqual(c.typed, ['t1:"y"', 't1:"\\r"', 't1:"\\u001b"']);
});

test("a screen that says what it is is decided with the keys its agent says for that screen, not a permission's", async () => {
  const c = computer({ permission: { allow: ["1"], deny: ["escape"] }, trust: { allow: ["down", "enter"], deny: ["escape"] } });
  const trust = c.screenSays("trust");
  assert.deepEqual(c.answer("t1", trust, { decision: "allow" }), { answered: true });
  await new Promise((resolve) => setTimeout(resolve, KEY_GAP_MS * 2 + 50));
  assert.deepEqual(c.typed, ['t1:"\\u001b[B"', 't1:"\\r"']);
  const settings = c.screenSays("settings");
  assert.equal(code(() => c.answer("t1", settings, { decision: "allow" })), "BAD_REQUEST", "it says no keys for this screen");
  assert.deepEqual(c.typed, ['t1:"\\u001b[B"', 't1:"\\r"']);
});

test("an agent that says no keys for what it asks is answered on its screen: a decision for it, or for a question, is a bad request and types nothing", () => {
  const c = computer();
  const since = c.waitOn("permission");
  assert.equal(code(() => c.answer("t1", since, { decision: "allow" })), "BAD_REQUEST");
  assert.deepEqual(c.typed, []);
  assert.deepEqual(c.answer("t1", since, { text: "1" }), { answered: true }, "a line it still takes");
  const question = computer({ permission: { allow: ["y"], deny: ["n"] } });
  const asked = question.waitOn("question");
  assert.equal(code(() => question.answer("t1", asked, { decision: "allow" })), "BAD_REQUEST");
  assert.equal(code(() => question.answer("t1", asked, { decision: "maybe" })), "BAD_REQUEST");
  assert.deepEqual(question.typed, []);
});

test("an agent that waits on nothing is not answered: working, or unknown", () => {
  const c = computer();
  c.status.event("t1", { event: "turn.started" });
  const since = c.status.get("t1")!.since;
  assert.deepEqual(c.answer("t1", since, { text: "1" }), { answered: false }, "working");
  assert.deepEqual(c.answer("t2", since, { text: "1" }), { answered: false }, "no such agent");
  assert.deepEqual(c.typed, []);
});

test("an answer is one line of text, or a decision; anything else is a bad request, and nothing is typed", () => {
  const c = computer();
  const since = c.waitOn("question");
  for (const a of [{ text: "two\nlines" }, { text: "\u001b[2J" }, { text: "" }, { text: "x".repeat(ANSWER_MAX + 1) }, { decision: "allow" }, null]) {
    assert.equal(code(() => c.answer("t1", since, a)), "BAD_REQUEST", JSON.stringify(a));
  }
  assert.equal(code(() => c.answer("t1", "soon" as never, { text: "1" })), "BAD_REQUEST");
  assert.deepEqual(c.typed, []);
  const plan = computer();
  const wait = plan.waits.ask("t1", { kind: "plan", plan: "1. Split it" }, () => {});
  assert.equal(code(() => plan.answer("t1", wait.since, { text: "ok" })), "BAD_REQUEST");
});

test("a message is handed to the agent as its next prompt, whatever it is doing, to be typed once it is at its prompt; to no agent, it is not sent", () => {
  const c = computer();
  c.status.event("t1", { event: "turn.started" });
  assert.deepEqual(c.send("hm:t1", "also add tests"), { sent: true });
  assert.deepEqual(c.send("t2", "hello"), { sent: false }, "no such agent");
  assert.deepEqual(c.delivered, ["t1:also add tests", "t2:hello"]);
  assert.deepEqual(c.typed, [], "nothing typed past the agent's prompt");
  // Recorded against the agent it went to.
  assert.deepEqual(c.effect("hm:t1", "also add tests"), { target: "t1" });
});

test("a message is one line of text: anything else is a bad request, and nothing is handed on", () => {
  const c = computer();
  for (const text of ["two\nlines", "\u001b[2J", "", "x".repeat(ANSWER_MAX + 1), null, 7]) {
    assert.equal(code(() => c.send("t1", text)), "BAD_REQUEST", JSON.stringify(text));
  }
  assert.deepEqual(c.delivered, []);
});

test("a supervised tool use is answered by the program that started the agent, or the person, once; not by a guest or another program", () => {
  const c = computer();
  const answered: string[] = [];
  const ask = () => c.waits.ask("t1", { kind: "approval", tool: "Bash", summary: "rm -rf dist", expiresAt: 0, answerer: "client:g1" }, (d) => answered.push(d));
  const as = (actor: Connection["actor"]): Connection => ({ actor, send: () => {}, closed: new AbortController().signal });
  const starter = as({ kind: "peer", person: "client:g1", device: "client:g1", access: "agents", client: "bot" });
  const other = as({ kind: "peer", person: "client:g2", device: "client:g2", access: "agents", client: "other" });
  const guest = as({ kind: "peer", person: "q".repeat(64), device: "e".repeat(64), access: "agents" });
  const first = ask();
  assert.equal(code(() => c.answer("t1", first.since, { decision: "allow" }, other)), "FORBIDDEN");
  assert.equal(code(() => c.answer("t1", first.since, { decision: "allow" }, guest)), "FORBIDDEN");
  assert.equal(code(() => c.answer("t1", first.since, { text: "yes" }, starter)), "BAD_REQUEST", "an approval is a decision");
  assert.deepEqual(c.answer("t1", first.since + 1, { decision: "allow" }, starter), { answered: false }, "another wait");
  assert.deepEqual(c.answer("t1", first.since, { decision: "deny" }, starter), { answered: true });
  assert.deepEqual(answered, ["deny"]);
  assert.equal(c.answer("t1", first.since, { decision: "allow" }, as({ kind: "person" })).answered, false, "answered already");
  const second = ask();
  assert.deepEqual(c.answer("t1", second.since, { decision: "allow" }, as({ kind: "person" })), { answered: true });
  assert.deepEqual(answered, ["deny", "allow"]);
});

test("a supervised tool use answered always is decided so for every later use of that tool by that agent, until it goes; always answers nothing else", () => {
  const c = computer();
  const ask = (tool: string) => c.waits.ask("t1", { kind: "approval", tool, summary: "", expiresAt: 0 }, () => {});
  assert.deepEqual(c.answer("t1", ask("Bash").since, { decision: "deny", always: true }), { answered: true });
  assert.deepEqual([c.waits.ruled("t1", "Bash"), c.waits.ruled("t1", "Edit"), c.waits.ruled("t2", "Bash")], ["deny", undefined, undefined]);
  c.answer("t1", ask("Edit").since, { decision: "allow" });
  assert.equal(c.waits.ruled("t1", "Edit"), undefined, "this use alone");
  const plan = c.waits.ask("t1", { kind: "plan", plan: "1. Split it" }, () => {});
  for (const a of [{ decision: "allow", always: true }, { decision: "allow", always: "yes" }]) assert.equal(code(() => c.answer("t1", plan.since, a)), "BAD_REQUEST", JSON.stringify(a));
  c.waits.forget("t1");
  assert.equal(c.waits.ruled("t1", "Bash"), undefined, "until it goes");
});
