// Answering what an agent waits on, from another of the person's devices or a program
// (answers.ts, spec/needs.md "Answering"): a line is typed into the agent's terminal, Enter after
// it, and a plan or a supervised tool use is decided (waits.ts), only while the agent still waits
// on that wait (its tile, and when it began) and once: an answer that comes late, or again, does
// nothing and says so, a decided one saying who was first. One waiting on nothing is not
// answered; and an answer is one line of text, or a decision. A permission is allowed or denied
// with the keys its agent says do that on its screen (0.5). A supervised tool use is answered by
// the agent or program that started the agent, or the person. Typed as the person types (0.7): the
// agent's status hears the answer and no longer waits; not while its screen shows its prompt or
// another wait, nor while another answer is going into that terminal; and the audit records the
// decision, never a reply's words.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import { Intents } from "@hivemind/workspace-host/intents";
import { WorkspaceServer, type Connection } from "@hivemind/workspace-api/server";
import type { ToolAsked } from "@hivemind/workspace-api/agents";
import { ApiError } from "@hivemind/workspace-api/protocol";
import { AGENT_MANIFEST_VERSION, defFromManifest, setCatalog, type AnswerKeys, type InputKind } from "@hivemind/agents";
import { StatusStore } from "@hivemind/agent-host/status-store";
import { KEY_GAP_MS } from "@hivemind/agent-host/keys";
import { answers, ANSWER_MAX, TAKEN_MS } from "../src/answers.ts";
import { ControlPlane, type ControlPlaneOptions } from "../src/control/plane.ts";
import { Waits } from "../src/waits.ts";
import { waitOn } from "../src/needs.ts";
import { readAgentManifest } from "@hivemind/agents/load";
import { hookAnswerOf } from "@hivemind/agents/node";

const PRIYA = { person: "p".repeat(64), name: "Priya" };
const phone: Connection = { actor: { kind: "peer", person: PRIYA.person, device: "d".repeat(64), access: "owner" }, send: () => {}, closed: new AbortController().signal };

/** A computer whose agent is in `t1`, and says `keys` allow and deny what it waits on, by the
 *  wait's name: what is typed into each terminal, and its `agent.answer`. */
function computer(keys?: Record<string, AnswerKeys>, { asking, choose }: { asking?: ToolAsked; choose?: string[] } = {}) {
  let now = 1_790_000_000_000;
  const status = new StatusStore({ now: () => (now += 1_000) });
  const waits = new Waits({ status });
  const typed: string[] = [];
  // Typing itself, and the terminal it holds, are the control plane's: tested below on a real one.
  const typeIn = (ptyId: string, parts: readonly string[]): boolean => {
    if (ptyId !== "hm:t1") return false;
    for (const p of parts) typed.push(`t1:${JSON.stringify(p)}`);
    return true;
  };
  const domain = answers({
    plane: () => ({ status, waits, answer: typeIn }) as never,
    answerKeys: (tile, status) => (tile === "t1" ? keys?.[(status.says ?? status.kind)!] : undefined),
    asking: (tile) => (tile === "t1" ? asking : undefined),
    chooseKeys: (tile) => (tile === "t1" ? choose : undefined),
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
  return { status, waits, typed, waitOn, screenSays, answer };
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

test("a permission is allowed or denied with the keys its agent says do that, once: again, or for a wait that has passed, nothing", () => {
  const keys = { allow: ["y", "Enter"], deny: ["Escape"] };
  const c = computer({ permission: keys });
  const first = c.waitOn("permission");
  assert.deepEqual(c.answer("hm:t1", first, { decision: "allow" }), { answered: true });
  assert.deepEqual(c.typed, ['t1:"y"', 't1:"\\r"']);
  assert.deepEqual(c.answer("t1", first, { decision: "deny" }), { answered: false }, "again");
  // It asks again: the earlier wait's decision is late, the new one's lands.
  const next = c.waitOn("permission");
  assert.deepEqual(c.answer("t1", first, { decision: "deny" }), { answered: false }, "late");
  assert.deepEqual(c.answer("t1", next, { decision: "deny" }), { answered: true });
  assert.deepEqual(c.typed, ['t1:"y"', 't1:"\\r"', 't1:"\\u001b"']);
});

test("a screen that says what it is is decided with the keys its agent says for that screen, not a permission's", () => {
  const c = computer({ permission: { allow: ["1"], deny: ["escape"] }, trust: { allow: ["down", "enter"], deny: ["escape"] } });
  const trust = c.screenSays("trust");
  assert.deepEqual(c.answer("t1", trust, { decision: "allow" }), { answered: true });
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

test("a supervised tool use an agent's worker asks is answered by the agent that started it, or the person; not by the worker itself, nor another worker", () => {
  const c = computer();
  const answered: string[] = [];
  const agentAt = (tile: string): Connection => ({ actor: { kind: "peer", person: tile, device: tile, access: "agents", client: tile, tile }, send: () => {}, closed: new AbortController().signal });
  const ask = () => c.waits.ask("t1", { kind: "approval", tool: "Bash", summary: "rm -rf build", expiresAt: 0, answerer: "tile-lead" }, (d) => answered.push(d));
  const first = ask();
  assert.equal(code(() => c.answer("t1", first.since, { decision: "allow" }, agentAt("t1"))), "FORBIDDEN", "the worker itself");
  assert.equal(code(() => c.answer("t1", first.since, { decision: "allow", always: true }, agentAt("t2"))), "FORBIDDEN", "another worker");
  assert.deepEqual(c.answer("t1", first.since, { decision: "deny" }, agentAt("tile-lead")), { answered: true });
  const second = ask();
  assert.deepEqual(c.answer("t1", second.since, { decision: "allow" }, { actor: { kind: "person" }, send: () => {}, closed: new AbortController().signal }), { answered: true });
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

/** A real control plane, its agent in t1 says `1` allows and Esc denies what it asks, answered
 *  through the workspace API, which records each answer: what goes into each terminal, at once.
 *  Watched, its answers wait on what its screen reads. */
function plane(watched = false, methods?: () => unknown) {
  const writes: string[] = [];
  const p = new ControlPlane({
    dir: () => "/nowhere",
    publish: () => {},
    write: (ptyId, data) => { writes.push(`${ptyId}:${JSON.stringify(data)}`); return ptyId === "hm:t1"; },
    spawned: () => {},
    methods: methods ?? (() => { throw new Error("no methods here"); }),
    windowsUp: () => false,
  } as unknown as ControlPlaneOptions);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "answers-")), "audit.jsonl");
  after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  let asking: ToolAsked | undefined;
  const server = new WorkspaceServer([answers({ plane: () => p, answerKeys: () => ({ allow: ["1"], deny: ["escape"] }), asking: () => asking, chooseKeys: () => ["{n}"], who: () => PRIYA, watched: () => watched })], new Intents(new AuditLog({ file })));
  const answer = async (since: number, a: unknown) => {
    const r = await server.answer("agent.answer", ["hm:t1", since, a], phone);
    if ("error" in r) throw new ApiError(r.error.code, r.error.message);
    return r.result;
  };
  /** Its hooks say it waits on a permission: when the wait began. */
  const asks = (): number => {
    p.event("agent.event", { tileId: "hm:t1", event: "input.requested", kind: "permission" });
    return p.status.get("t1")!.since;
  };
  const audited = () => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { const { verb, target, detail, outcome } = JSON.parse(l); return `${verb} ${target} ${detail} ${outcome}`; });
  return { p, writes, answer, asks, audited, ask: (a: ToolAsked | undefined) => { asking = a; } };
}

test("allowed from a phone on a fresh chooser, its keys go in as the person's: the agent waits on them no more, and a second Allow naming that wait types nothing; denied, the same; the audit records each decision", async () => {
  const c = plane();
  const asked = c.asks();
  assert.deepEqual(await c.answer(asked, { decision: "allow" }), { answered: true });
  assert.deepEqual(c.writes, ['hm:t1:"1"']);
  assert.equal(c.p.status.get("t1")!.state, "working", "it runs what was allowed");
  assert.deepEqual(await c.answer(asked, { decision: "allow" }), { answered: false }, "the old wait, again");
  assert.deepEqual(c.writes, ['hm:t1:"1"']);
  const again = c.asks();
  assert.deepEqual(await c.answer(again, { decision: "deny" }), { answered: true });
  assert.deepEqual(c.writes, ['hm:t1:"1"', 'hm:t1:"\\u001b"']);
  assert.notEqual(c.p.status.get("t1")!.state, "waiting", "denied, it waits no more");
  c.ask({ name: "AskUserQuestion", asks: [{ question: "Which color?", options: ["Red", "Blue"] }] });
  assert.deepEqual(await c.answer(c.asks(), { answers: [{ chosen: [1] }] }), { answered: true });
  assert.notEqual(c.p.status.get("t1")!.state, "waiting", "chosen, it waits no more");
  c.ask(undefined);
  assert.deepEqual(await c.answer(c.asks(), { text: "use the staging database" }), { answered: true });
  assert.deepEqual(c.audited(), [
    "agent.answer t1 allow ok", "agent.answer t1 allow, not answered ok", "agent.answer t1 deny ok", "agent.answer t1 choice 2 ok", "agent.answer t1 reply ok",
  ]);
});

test("an Allow whose keys went in is not confirmed while its screen has not moved on, and is never typed again: the screen is read every 1.2 s and reports a change only, so the reading that it moved on may come seconds late", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const c = plane(true);
  const since = c.asks();
  c.p.event("agent.screen", { tileId: "hm:t1", state: "permission" });
  const allowed = c.answer(since, { decision: "allow" }).catch((e: ApiError) => e);
  await new Promise(setImmediate);
  assert.deepEqual(c.writes, ['hm:t1:"1"']);
  t.mock.timers.tick(TAKEN_MS);
  const late = await allowed;
  assert.ok(late instanceof ApiError);
  assert.equal(late.code, "TIMEOUT", "not confirmed, never failed: the keys went in");
  const now = c.p.status.get("t1")!;
  assert.notEqual(now.state, "waiting", "it waits on the person no more");
  for (const at of [since, now.since]) assert.deepEqual(await c.answer(at, { decision: "allow" }), { answered: false });
  t.mock.timers.tick(1_200);
  c.p.event("agent.screen", { tileId: "hm:t1", state: "working" });
  assert.deepEqual(c.writes, ['hm:t1:"1"'], "typed once");
  assert.equal(c.p.status.get("t1")!.state, "working");
  // A line typed leaves its status on the wait: that wait is still answered already.
  const asked = c.asks();
  c.p.event("agent.screen", { tileId: "hm:t1", state: "permission" });
  const replied = c.answer(asked, { text: "use the staging database" }).catch((e: ApiError) => e);
  await new Promise(setImmediate);
  t.mock.timers.tick(TAKEN_MS);
  assert.equal(((await replied) as ApiError).code, "TIMEOUT");
  assert.equal(c.p.status.get("t1")!.since, asked, "still that wait");
  const again = c.answer(asked, { text: "use the staging database" }).catch((e: ApiError) => e);
  await new Promise(setImmediate);
  assert.equal(c.writes.length, 2, "typed once");
  t.mock.timers.tick(TAKEN_MS);
  assert.deepEqual(await again, { answered: false });
});

test("an answer holds its terminal until its last key is in: another answer then types nothing, and a program's message goes in after it, never held as a draft of the person's", async () => {
  const c = plane();
  assert.equal(c.p.answer("hm:t1", ["\x1b[B", "\r"]), true);
  assert.equal(c.p.answer("hm:t1", ["1"]), false, "while the first is going in");
  c.p.mailbox.deliver("hm:t1", "hello");
  assert.deepEqual(c.writes, ['hm:t1:"\\u001b[B"'], "the first key at once");
  await new Promise((resolve) => setTimeout(resolve, KEY_GAP_MS * 3));
  assert.deepEqual(c.writes.slice(0, 3), ['hm:t1:"\\u001b[B"', 'hm:t1:"\\r"', 'hm:t1:"hello"']);
  assert.equal(c.p.answer("hm:t1", ["1"]), true, "free again");
  c.p.mailbox.deliver("hm:t1", "next");
  assert.ok(c.writes.includes('hm:t1:"next"'), "an answer's key is no draft of the person's: a message after it goes in at once");
  assert.equal(c.p.answer("hm:t2", ["1"]), false, "no session there");
});

test("an answer is not typed while the screen, read since the wait began, shows the agent's prompt or another screen; one its rules cannot place, or another chooser, does not stop it", () => {
  const c = computer();
  const at = (state: Parameters<typeof c.status.screen>[1], says?: string) => {
    const since = c.waitOn("permission");
    c.status.screen("t1", state, says);
    return c.answer("t1", since, { text: "1" }).answered;
  };
  assert.equal(at("idle"), false, "its prompt");
  assert.equal(at("permission", "trust"), false, "its trust prompt");
  assert.deepEqual(c.typed, []);
  assert.equal(at("working"), true, "a screen its rules cannot place");
  assert.equal(at("question"), true, "a chooser its rules read as a question");
  c.status.screen("t1", "idle");
  assert.equal(c.answer("t1", c.waitOn("permission"), { text: "1" }).answered, true, "its prompt, read before it asked");
});

test("a question its tool asks is answered by choosing an option, with the keys its agent says choose, never allowed or denied; one it cannot choose from here takes a line", () => {
  const color = { name: "AskUserQuestion", asks: [{ question: "Which color?", options: ["Red", "Blue"] }] };
  const keys = { permission: { allow: ["1"], deny: ["escape"] } };
  // Its hooks call it a permission; its tool asks a question.
  const c = computer(keys, { asking: color, choose: ["{n}"] });
  const asked = c.waitOn("permission");
  assert.equal(code(() => c.answer("t1", asked, { decision: "allow" })), "BAD_REQUEST", "allowed, it would choose the first");
  const bad = [[{ chosen: [2] }], [{ chosen: [-1] }], [{ chosen: [0.5] }], [{ chosen: ["1"] }], [{ chosen: [] }], [{ chosen: [0, 1] }], [], [{ chosen: [0] }, { chosen: [0] }], [{ text: "Red" }]];
  for (const answers of bad) assert.equal(code(() => c.answer("t1", asked, { answers })), "BAD_REQUEST", JSON.stringify(answers));
  assert.deepEqual(c.typed, []);
  assert.deepEqual(c.answer("t1", asked, { answers: [{ chosen: [1] }] }), { answered: true });
  assert.deepEqual(c.typed, ['t1:"2"']);
  const cannot: Array<[string, ToolAsked | undefined, string[] | undefined]> = [
    ["two questions", { name: "AskUserQuestion", asks: [color.asks[0]!, { question: "Which size?", options: ["S", "M"] }] }, ["{n}"]],
    ["several answers", { name: "AskUserQuestion", asks: [{ ...color.asks[0]!, many: true }] }, ["{n}"]],
    ["no keys that choose", color, undefined],
    ["no question", { name: "Bash", about: "npm test" }, ["{n}"]],
  ];
  for (const [why, asking, choose] of cannot) {
    const d = computer(keys, { asking, choose });
    const since = d.waitOn("permission");
    assert.equal(code(() => d.answer("t1", since, { answers: [{ chosen: [0] }] })), "BAD_REQUEST", why);
    assert.deepEqual(d.answer("t1", since, { text: "Red" }), { answered: true }, why);
  }
});

/** Claude Code's PermissionRequest entry, as its manifest declares that its hook carries the answer. */
const ANSWER = {
  allow: { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } },
  deny: { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "{message}" } } },
  choose: { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: "{input}" } } },
  asks: { list: "questions", question: "question", options: "options", label: "label" },
  chosen: "answers",
  leave: ["ExitPlanMode"],
};
const COLOR = { questions: [{ question: "Which color?", header: "Color", options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "cool" }], multiSelect: false }] };

/** `plane()`, its agent in t1 one whose PermissionRequest hook carries the answer (`answers`: the
 *  entry's, none for an agent whose hook does not), and that hook as the generic script runs it:
 *  it reports the wait, then asks for the answer, as its tile. What the hook prints, once it
 *  stops holding. */
function hooked(answer: Record<string, unknown> | null = ANSWER) {
  setCatalog([defFromManifest({
    manifestVersion: AGENT_MANIFEST_VERSION, id: "acme", label: "Acme", bin: "acme",
    caps: { promptDelivery: "typed", turnSignal: false, resume: "none", supervise: "human", blockedDetection: false },
    answer: { permission: { allow: ["1"], deny: ["escape"] } },
    launch: { hcp: true },
    hooks: { arg: "--settings", events: { PermissionRequest: { emit: "input.requested", kind: "permission", timeout: 3600, ...(answer ? { answer } : {}) } } },
    session: {
      resume: { args: ["--resume", "{id}"], exists: "{home}/.acme/{id}.jsonl" },
      transcript: { id: "uuid", at: "timestamp", said: [{ each: "content", item: { type: "tool_use" }, tool: { id: "id", name: "name", about: ["input.command", "input.file_path"], input: "input" } }] },
    },
  })]);
  after(() => setCatalog([]));
  // The agent channel needs nothing of a window here.
  const c = plane(false, () => ({}));
  c.p.agentOf.set("t1", "acme");
  const hook = async (tool: string, input: unknown, more: Record<string, unknown> = {}, signal?: AbortSignal) => {
    c.p.event("agent.event", { tileId: "hm:t1", event: "input.requested", kind: "permission", ...more });
    const printed = c.p.agentChannel("agent.await_answer", { callerTile: "hm:t1", hook: "PermissionRequest", tool, input, ...more }, { actor: { kind: "tile", tile: "t1" }, signal })
      .then((r) => (r as { stdout?: string }).stdout);
    await new Promise(setImmediate);
    return { since: c.p.status.get("t1")!.since, printed };
  };
  return { ...c, hook };
}
const out = (o: unknown) => JSON.stringify(o);

test("an Allow for an agent whose hook carries the answer is printed by that hook, held since it asked, and nothing is typed; a Deny prints its deny, with the line typed as its reason; that wait answered again does nothing", async () => {
  const c = hooked();
  const asked = await c.hook("Bash", { command: "npm test" });
  assert.deepEqual(await c.answer(asked.since, { decision: "allow" }), { answered: true });
  assert.equal(await asked.printed, out(ANSWER.allow));
  assert.equal(c.p.status.get("t1")!.state, "working", "it runs what was allowed");
  assert.equal((await c.answer(asked.since, { decision: "allow" }) as { answered: boolean }).answered, false);
  const denied = await c.hook("Bash", { command: "rm -rf build" });
  assert.deepEqual(await c.answer(denied.since, { text: "use the staging database" }), { answered: true });
  assert.equal(await denied.printed, out({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "use the staging database" } } }));
  const plain = await c.hook("Bash", { command: "rm -rf dist" });
  assert.deepEqual(await c.answer(plain.since, { decision: "deny" }), { answered: true });
  assert.equal(await plain.printed, out({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny" } } }), "no reason given: no message");
  assert.deepEqual(c.writes, [], "nothing typed");
  assert.deepEqual(c.audited(), ["agent.answer t1 allow ok", "agent.answer t1 allow, not answered ok", "agent.answer t1 reply ok", "agent.answer t1 deny ok"]);
});

test("a wait its hook holds says what the tool use is about as the hook gives it, whole: its session file records the use only once it has run", async () => {
  const c = hooked();
  await c.hook("Bash", { command: "rm -rf build \\\n  dist" });
  assert.equal(c.p.waits.of("t1")?.about, "rm -rf build \\\n  dist");
  const agent = await c.hook("Agent", { prompt: "look around" });
  assert.equal(c.p.waits.of("t1")?.about, undefined, "nothing its transcript would name");
  const need = waitOn("t1", { kind: "permission", since: agent.since }, { decides: () => true, wait: (t) => c.p.waits.of(t) });
  assert.deepEqual(need.tool, { name: "Agent" }, "about nothing, it still names its tool");
});

test("a question its tool asks, held by its hook, is answered by the option's label set in the tool's input under its question's text, or by the line typed; never allowed", async () => {
  const c = hooked();
  const color = await c.hook("AskUserQuestion", COLOR);
  await assert.rejects(c.answer(color.since, { decision: "allow" }), (e: ApiError) => e.code === "BAD_REQUEST");
  await assert.rejects(c.answer(color.since, { answers: [{ chosen: [2] }] }), (e: ApiError) => e.code === "BAD_REQUEST", "no third option");
  assert.deepEqual(await c.answer(color.since, { answers: [{ chosen: [1] }] }), { answered: true });
  const chosen = (answers: Record<string, string>) => out({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: { ...COLOR, answers } } } });
  assert.equal(await color.printed, chosen({ "Which color?": "Blue" }));
  const again = await c.hook("AskUserQuestion", COLOR);
  assert.deepEqual(await c.answer(again.since, { text: "Green" }), { answered: true });
  assert.equal(await again.printed, chosen({ "Which color?": "Green" }));
  assert.deepEqual(c.writes, []);
});

// What Claude's AskUserQuestion gave its PermissionRequest hook (claude 2.1.296, from a real session).
const NEXT_LINE = { questions: [{ question: "Which line should I add to hello.txt next?", header: "Next line", multiSelect: false, options: [
  { label: "Nothing", description: "Leave hello.txt as it is" },
  { label: "A timestamp", description: "Add today's date and time as a new line" },
  { label: "\"test passed\"", description: "Add the line \"test passed\"" },
] }] };

test("Claude's question held by its permission hook is a question with each option and what it means, never a permission; an option is answered as its label under the question", async () => {
  const claude = (await readAgentManifest(path.join(import.meta.dirname, "../../hive-agents/tests/fixtures/published-agents/claude/agent.yaml"), { source: "user", requireDirMatch: true })).def!;
  const c = hooked(hookAnswerOf(claude, "PermissionRequest") as unknown as Record<string, unknown>);
  const asked = await c.hook("AskUserQuestion", NEXT_LINE);
  const need = waitOn("t1", { kind: "permission", since: asked.since }, { decides: () => true, wait: (t) => c.p.waits.of(t) });
  assert.deepEqual(need, { kind: "question", choose: true, asks: [{
    question: "Which line should I add to hello.txt next?",
    options: ["Nothing", "A timestamp", "\"test passed\""],
    descriptions: ["Leave hello.txt as it is", "Add today's date and time as a new line", "Add the line \"test passed\""],
  }] });
  assert.deepEqual(await c.answer(asked.since, { answers: [{ chosen: [1] }] }), { answered: true });
  const printed = JSON.parse((await asked.printed)!);
  assert.deepEqual(printed.hookSpecificOutput.decision.updatedInput.answers, { "Which line should I add to hello.txt next?": "A timestamp" });
  assert.deepEqual(c.writes, [], "nothing typed: the hook gives the answer");
  const several = await c.hook("AskUserQuestion", { questions: [{ ...NEXT_LINE.questions[0]!, multiSelect: true }] });
  const many = waitOn("t1", { kind: "permission", since: several.since }, { decides: () => true, wait: (t) => c.p.waits.of(t) });
  assert.equal(many.asks?.[0]?.many, true);
  assert.equal(many.choose, true, "its hook sets several as well as one");
});

// Claude's AskUserQuestion with two questions, the second several may be chosen of.
const TWO = { questions: [
  { question: "Which fruit?", header: "Fruit", multiSelect: false, options: [{ label: "Apple", description: "" }, { label: "Banana", description: "" }, { label: "Mango", description: "" }] },
  { question: "Which colours?", header: "Colour", multiSelect: true, options: [{ label: "Red", description: "" }, { label: "Green", description: "" }, { label: "Blue", description: "" }] },
] };

test("two questions held by Claude's hook are chosen from, each answered by its place: an answer that leaves one out, names an option either does not list, or several of the one that takes one is refused; the whole is printed and recorded", async () => {
  const claude = (await readAgentManifest(path.join(import.meta.dirname, "../../hive-agents/tests/fixtures/published-agents/claude/agent.yaml"), { source: "user", requireDirMatch: true })).def!;
  const c = hooked(hookAnswerOf(claude, "PermissionRequest") as unknown as Record<string, unknown>);
  const asked = await c.hook("AskUserQuestion", TWO);
  const need = waitOn("t1", { kind: "permission", since: asked.since }, { decides: () => true, wait: (t) => c.p.waits.of(t) });
  assert.equal(need.choose, true);
  assert.deepEqual(need.asks?.map((q) => q.many ?? false), [false, true]);
  const refused = [
    [{ chosen: [0] }],
    [{ chosen: [0] }, { chosen: [0] }, { chosen: [0] }],
    [{ chosen: [3] }, { chosen: [0] }],
    [{ chosen: [0] }, { chosen: [0, 3] }],
    [{ chosen: [0, 1] }, { chosen: [0] }],
    [{ chosen: [0] }, { chosen: [] }],
    [{ chosen: [0] }, { chosen: [1, 1] }],
    [{ chosen: [0] }, { text: "" }],
  ];
  for (const answers of refused) await assert.rejects(c.answer(asked.since, { answers }), (e: ApiError) => e.code === "BAD_REQUEST", JSON.stringify(answers));
  assert.deepEqual(await c.answer(asked.since, { answers: [{ chosen: [2] }, { chosen: [0, 2] }] }), { answered: true });
  assert.deepEqual(JSON.parse((await asked.printed)!).hookSpecificOutput.decision.updatedInput.answers, { "Which fruit?": "Mango", "Which colours?": "Red, Blue" });
  const typed = await c.hook("AskUserQuestion", TWO);
  assert.deepEqual(await c.answer(typed.since, { answers: [{ text: "Durian" }, { chosen: [1] }] }), { answered: true });
  assert.deepEqual(JSON.parse((await typed.printed)!).hookSpecificOutput.decision.updatedInput.answers, { "Which fruit?": "Durian", "Which colours?": "Green" });
  assert.deepEqual(c.audited().filter((l) => l.endsWith(" ok")), ["agent.answer t1 choice 3, 1+3 ok", "agent.answer t1 choice reply, 2 ok"]);
});

test("the agent's own prompt answered first, its hook is let go, printing nothing, and an answer after does nothing: a key typed there, Esc, its tool run, its hook gone", async () => {
  const c = hooked();
  const ends: Array<[string, (since: number) => void]> = [
    ["a key at its chooser", () => c.p.typed("hm:t1", "1")],
    ["Esc", () => c.p.typed("hm:t1", "\x1b")],
    ["its tool ran", () => c.p.event("agent.event", { tileId: "hm:t1", event: "input.resolved" })],
  ];
  for (const [why, end] of ends) {
    const asked = await c.hook("Bash", { command: "npm test" });
    end(asked.since);
    assert.equal(await asked.printed, undefined, why);
    assert.deepEqual(await c.answer(asked.since, { decision: "allow" }), { answered: false }, why);
  }
  const gone = new AbortController();
  const asked = await c.hook("Bash", { command: "npm test" }, {}, gone.signal);
  gone.abort();
  assert.equal(await asked.printed, undefined);
  assert.equal(c.p.status.get("t1")!.state, "waiting", "its own prompt still asks");
  assert.equal(c.p.waits.of("t1"), undefined);
  assert.deepEqual(c.writes, ['hm:t1:"1"', 'hm:t1:"\\u001b"'], "only the person's keys");
});

test("not held, the agent's own prompt deciding: a subagent's, a tool its entry leaves to it, and any for an agent whose hook does not carry the answer", async () => {
  for (const [why, answer, tool, more] of [
    ["a subagent's", ANSWER, "Bash", { agentId: "a1" }],
    ["a tool it leaves", ANSWER, "ExitPlanMode", {}],
    ["no answer declared", null, "Bash", {}],
  ] as const) {
    const c = hooked(answer);
    const asked = await c.hook(tool, { command: "npm test" }, more);
    assert.equal(await asked.printed, undefined, why);
    assert.equal(c.p.waits.of("t1"), undefined, why);
    assert.equal(c.p.status.get("t1")!.state, "waiting", why);
  }
});
