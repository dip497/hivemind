/**
 * Supervised-worker approval policy.
 *
 * Rules with teeth:
 *  1. A plain `allow` covers the call it answers. Only `always` is remembered.
 *  2. pi CANNOT be supervised at all — the spawn is refused. pi has no permission
 *     system, so any gate would be one we inject; with no native prompt to fall back
 *     to it must fail closed, and then any hiccup bricks the worker (that is exactly
 *     what shipped in v1.13.0 and refused every tool mid-task). Refusing loudly beats
 *     handing a caller a gate that isn't one.
 *  3. A question ends when the worker stops waiting, and a later answer answers
 *     nothing: it used to be told it worked while the worker had already asked its
 *     own prompt. (Who may answer is `agent.answer`'s rule: answers.test.ts.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDispatch } from "@hivemind/host/control/methods";
import { useAuthoredAgents } from "./authored-agents.ts";

// Spawn/supervise policy reads the live catalog: load the published fixtures.
useAuthoredAgents();
import { Mailbox } from "@hivemind/host/control/mailbox";
import { TurnTracker } from "@hivemind/host/control/turn-tracker";
import { OutputRecorder } from "@hivemind/host/control/output-recorder";
import { Inbox } from "@hivemind/host/control/inbox";
import type { Delivery } from "@hivemind/host/control/mailbox";
import { workspaceDeps, PERSON, REPO, fromTile } from "./hcp-workspace.ts";

/** The control plane, its approvals kept in the supervisor's inbox, which tells its terminal
 *  through `deliver` (default: a real mailbox whose writes are kept); `answer` answers one as
 *  `hive ctl approve` does (agent.answer). */
function plane(o: { deliver?: (id: string, text: string, onSent?: () => void, d?: Delivery) => boolean; reported?: (tile: string, message: string) => void } = {}) {
  const writes: string[] = [];
  const mailbox = new Mailbox((_id, d) => { writes.push(d); return true; }, 1);
  const deliver = o.deliver ?? ((id: string, t: string, onSent?: () => void, d?: Delivery) => mailbox.deliver(id, t, onSent, d));
  const inbox = new Inbox((to, wanted, rung) => deliver(`hm:${to}`, "[hive] inbox", rung, { wanted, atPrompt: true }));
  const deps = workspaceDeps();
  const made = makeDispatch({
    turns: new TurnTracker(),
    recorder: new OutputRecorder(),
    callRenderer: async () => { throw new Error("no window"); },
    writeToTile: () => true,
    deliverToTile: deliver,
    inbox,
    waitingOf: () => undefined,
    spawnAllowed: () => true,
    connect: () => true,
    disconnect: () => {},
    forgetPipes: () => {},
    spawnEdge: () => {},
    ...(o.reported ? { reported: o.reported } : {}),
    ...deps,
  } as unknown as Parameters<typeof makeDispatch>[0]);
  const answer = (reqId: string, decision: "allow" | "deny", always = false) => {
    const wait = deps.waits.named(reqId);
    return wait ? deps.waits.answer(wait.tile, wait.since, decision, { always }) : { answered: false };
  };
  /** The question `parent` was asked last, read from its inbox: its id. */
  const asked = async (parent: string) => {
    for (let i = 0; i < 100; i++) {
      const last = inbox.take(parent).messages.filter((m) => m.kind === "approval").at(-1);
      if (last) return /hive ctl approve (\S+) allow/.exec(last.text)![1]!;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`${parent} was asked nothing`);
  };
  const supervisedBy = (parent: string, agent = "claude") => made.spawn({ agent, repo: REPO, supervise: true, parent });
  return { ...made, deps, mailbox, inbox, writes, answer, asked, supervisedBy };
}

test("an approval for a BUSY supervisor waits in its inbox; its terminal is told once it is at its prompt, never what is asked", async () => {
  // A message typed into a mid-turn composer is never read, and the worker blocks until
  // timeout. (Worker is claude here — pi can no longer be supervised at all.)
  const { agentChannel, mailbox, inbox, writes, answer, supervisedBy } = plane();
  const worker = await supervisedBy("tile-parent");
  mailbox.setBusy("hm:tile-parent"); // parent is mid-turn — its TUI can't take input

  const asked = agentChannel("agent.await_approval", {
    callerTile: `hm:${worker}`, tool_name: "write", tool_input: { path: "/x.java" },
  }, PERSON);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(writes, [], "nothing typed into the busy supervisor");

  mailbox.setIdle("hm:tile-parent"); // parent finishes its turn
  await new Promise((r) => setTimeout(r, 400));
  assert.match(writes.join(""), /\[hive\] inbox/, "now it is told to read its inbox");
  assert.doesNotMatch(writes.join(""), /x\.java/, "what the worker would do is never typed");

  // The reqId the parent reads is the one that resolves it.
  const [message] = inbox.take("tile-parent").messages;
  assert.match(message!.text, /wants to run write: .*\/x\.java/);
  const reqId = /hive ctl approve (\S+) allow/.exec(message!.text)?.[1];
  assert.ok(reqId, "it carries a reqId");
  assert.deepEqual(answer(reqId, "allow"), { answered: true });
  assert.deepEqual(await asked, { decision: "allow" });
});

test("approval with a dead supervisor resolves instead of hanging the worker", async () => {
  const { agentChannel, supervisedBy } = plane({ deliver: () => false }); // parent's pty is gone
  const worker = await supervisedBy("tile-parent");
  const r = await agentChannel("agent.await_approval", { callerTile: `hm:${worker}`, tool_name: "write", tool_input: {} }, PERSON);
  assert.deepEqual(r, { decision: "ask" }, "resolves immediately — never blocks for 9 minutes on a corpse");
});

test("a plain allow covers THIS call; only `always` is remembered", async () => {
  // The supervisor's own words decide. Nothing upgrades "allow" into "always" on its
  // behalf — not for a tool that writes files, not for any tool.
  const { agentChannel, inbox, answer, asked, supervisedBy } = plane();
  const worker = await supervisedBy("tile-parent");
  const ask = () => agentChannel("agent.await_approval", { callerTile: `hm:${worker}`, tool_name: "Edit", tool_input: { path: "/x.ts" } }, PERSON);

  const first = ask();
  answer(await asked("tile-parent"), "allow");
  assert.deepEqual(await first, { decision: "allow" });

  // Same worker, same tool: it is asked again, because "allow" was about that one call.
  const second = ask();
  answer(await asked("tile-parent"), "allow", true);
  assert.deepEqual(await second, { decision: "allow" });

  // Now it is remembered: the third call resolves without troubling the supervisor.
  assert.deepEqual(await ask(), { decision: "allow" });
  assert.deepEqual(inbox.take("tile-parent").messages, [], "nothing was asked");
});

test("spawning a pi worker with supervise is REFUSED — never silently ungated", async () => {
  const { spawn, supervisedBy } = plane();
  await assert.rejects(
    () => supervisedBy("tile-p", "pi"),
    /cannot be supervised/,
    "a caller must never believe it is supervising a pi worker when it isn't",
  );
  // Unsupervised pi spawns normally — pi's whole point is an autonomous worker.
  assert.match(await spawn({ agent: "pi", repo: REPO, parent: "tile-p" }), /^tile-pi-/);
  // claude keeps supervise: its broker fails open to a real human permission prompt.
  assert.match(await supervisedBy("tile-p"), /^tile-claude-/);
});

test("a question ends when the worker stops waiting for it, and an answer after that answers nothing", async () => {
  const { agentChannel, deps, answer, asked, supervisedBy } = plane();
  const worker = await supervisedBy("tile-lead");
  const hook = new AbortController();
  const question = agentChannel("agent.await_approval", { tool_name: "Bash", tool_input: { command: "make" } }, { ...fromTile(worker), signal: hook.signal });
  const reqId = await asked("tile-lead");
  hook.abort(); // the worker's hook gave up and asked the agent's own prompt
  assert.deepEqual(await question, { decision: "ask" });
  assert.notEqual(deps.status.get(worker)?.state, "waiting", "the worker is no longer shown waiting");
  assert.deepEqual(answer(reqId, "allow"), { answered: false });
});

test("the hook of an answered question closing does not end the worker's next question", async () => {
  const { agentChannel, deps, answer, asked, supervisedBy } = plane();
  const worker = await supervisedBy("tile-lead");
  const firstHook = new AbortController();
  const first = agentChannel("agent.await_approval", { tool_name: "Edit", tool_input: { file_path: "/a.ts" } }, { ...fromTile(worker), signal: firstHook.signal });
  answer(await asked("tile-lead"), "allow");
  await first;
  const second = agentChannel("agent.await_approval", { tool_name: "Edit", tool_input: { file_path: "/b.ts" } }, fromTile(worker));
  const reqId = await asked("tile-lead");
  firstHook.abort(); // its hook lets go after its answer, while the next question waits
  assert.equal(deps.status.get(worker)?.state, "waiting", "still shown waiting on the second");
  answer(reqId, "deny");
  assert.deepEqual(await second, { decision: "deny" });
});

test("a program supervises the workers it starts: nothing is typed anywhere, its wait says the tool and what it would do, its answer resolves it, and it hears their reports", async () => {
  const typed: string[] = [];
  const reports: Array<[string, string]> = [];
  const made = plane({ deliver: (_id, t) => { typed.push(t); return true; }, reported: (tile, message) => { reports.push([tile, message]); } });
  const { deps } = made;
  const worker = await made.supervisedBy("client:g1");
  assert.equal(made.parentOf(worker), "client:g1");

  const asked = made.agentChannel("agent.await_approval", { callerTile: `hm:${worker}`, tool_name: "Bash", tool_input: { command: "rm -rf dist" } }, PERSON);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(typed, [], "a program is asked by its wait, not a banner");
  assert.equal(deps.status.get(worker)?.kind, "approval", "shown waiting on its starter");
  const wait = deps.waits.of(worker)!;
  assert.deepEqual({ tool: wait.tool, summary: wait.summary, answerer: wait.answerer }, { tool: "Bash", summary: "rm -rf dist", answerer: "client:g1" });
  assert.ok(wait.expiresAt! > Date.now());
  assert.deepEqual(deps.waits.answer(worker, wait.since, "deny"), { answered: true });
  assert.deepEqual(await asked, { decision: "deny" });
  assert.equal(deps.waits.of(worker), undefined);
  assert.deepEqual(deps.waits.answer(worker, wait.since, "allow"), { answered: false }, "answered once");

  await made.agentChannel("agent.report", { callerTile: `hm:${worker}`, message: "done: 3 files" }, fromTile(worker));
  assert.deepEqual(reports, [[worker, "done: 3 files"]]);
  assert.deepEqual(typed, []);
});
