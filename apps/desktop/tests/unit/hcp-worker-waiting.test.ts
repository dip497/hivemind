/**
 * A worker spawned through `hive ctl` that stops to wait for input (a question picker, a
 * permission prompt) is reported to the agent that spawned it, in its inbox. Without this, an
 * unsupervised worker sits at its picker and the leader never hears about it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDispatch } from "@hivemind/host/control/methods";
import { Mailbox } from "@hivemind/host/control/mailbox";
import { Inbox, type InboxMessage } from "@hivemind/host/control/inbox";
import { TurnTracker } from "@hivemind/host/control/turn-tracker";
import { OutputRecorder } from "@hivemind/host/control/output-recorder";
import type { AgentItem } from "@hivemind/workspace-api/agents";
import { useAuthoredAgents } from "./authored-agents.ts";
import { workspaceDeps, PERSON, REPO } from "./hcp-workspace.ts";

useAuthoredAgents();

function fleet(waitingOf: (bare: string) => AgentItem["waiting"] = () => undefined) {
  const writes: Array<{ to: string; text: string }> = [];
  const mailbox = new Mailbox((to, text) => { writes.push({ to, text }); return true; }, 1);
  const inbox = new Inbox((to, wanted, rung) => mailbox.deliver(`hm:${to}`, "[hive] inbox", rung, { wanted, atPrompt: true }));
  const deps = workspaceDeps();
  const status = deps.status;
  const made = makeDispatch({
    turns: new TurnTracker(),
    recorder: new OutputRecorder(),
    callRenderer: async () => { throw new Error("no window"); },
    writeToTile: () => true,
    deliverToTile: (id: string, t: string, onSent?: () => void) => mailbox.deliver(id, t, onSent),
    inbox,
    waitingOf,
    spawnAllowed: () => true,
    connect: () => true,
    disconnect: () => {},
    forgetPipes: () => {},
    spawnEdge: () => {},
    ...deps,
  } as unknown as Parameters<typeof makeDispatch>[0]);
  status.subscribe((c) => made.onStatus(c.tileId, c.status));
  const read: InboxMessage[] = [];
  /** Every wait the leader has read of, so far. */
  const told = () => {
    read.push(...inbox.take("tile-leader").messages.filter((m) => m.kind === "waiting"));
    return read;
  };
  const spawn = (o: { supervise?: true } = {}) => made.spawn({ agent: "claude", repo: REPO, parent: "tile-leader", prompt: "ask", ...o });
  return { made, status, inbox, writes, told, spawn };
}

const settle = () => new Promise((r) => setTimeout(r, 50));

test("a worker's question reaches its leader's inbox once per wait, with how to see and answer it", async () => {
  const { status, told, spawn } = fleet();
  const w = await spawn();
  status.event(w, { event: "turn.started" });
  status.event(w, { event: "input.requested", kind: "question" });
  await settle();
  assert.equal(told().length, 1);
  assert.equal(told()[0]!.from, w);
  assert.match(told()[0]!.text, new RegExp(`${w}.*is waiting for an answer to its question`));
  assert.match(told()[0]!.text, new RegExp(`hive ctl keys ${w} `));

  // Still the same wait: the agent's permission dialog for that question tells no one again.
  status.event(w, { event: "input.requested", kind: "permission" });
  await settle();
  assert.equal(told().length, 1);

  // Answered, then a new wait later in the turn: told again.
  status.event(w, { event: "input.resolved" });
  status.event(w, { event: "input.requested", kind: "permission" });
  await settle();
  assert.equal(told().length, 2);
  assert.match(told()[1]!.text, /is waiting for permission to go on/);
});

test("a question its hooks report as a permission is told as the question it is, with its options", async () => {
  const { status, told, spawn } = fleet(() => ({ kind: "question", since: 0, asks: [{ question: "Ship it?", options: ["Yes", "No"] }] }));
  const w = await spawn();
  status.event(w, { event: "turn.started" });
  status.event(w, { event: "input.requested", kind: "permission" });
  await settle();
  assert.match(told()[0]!.text, /is waiting for an answer to its question\.\n {2}Ship it\?\n {4}1\. Yes\n {4}2\. No/);
});

test("a wait answered before the leader reads of it is not told", async () => {
  const { status, inbox, spawn } = fleet();
  const w = await spawn();
  status.event(w, { event: "turn.started" });
  status.event(w, { event: "input.requested", kind: "question" });
  status.event(w, { event: "input.resolved" });
  assert.deepEqual(inbox.take("tile-leader").messages, []);
});

test("an agent with no hooks is reported from its screen the same way", async () => {
  const { status, told, spawn } = fleet();
  const w = await spawn();
  status.screen(w, "working");
  status.screen(w, "question");
  await settle();
  assert.equal(told().length, 1);
});

test("a supervised approval is not reported twice, and a tile nobody spawned tells no one", async () => {
  const { made, status, told, spawn } = fleet();
  const w = await spawn({ supervise: true });
  const asked = made.agentChannel("agent.await_approval", { callerTile: `hm:${w}`, tool_name: "AskUserQuestion", tool_input: {} }, PERSON);
  await settle();
  assert.equal(told().length, 0, "the approval is the leader's message");

  status.event("tile-user", { event: "input.requested", kind: "question" });
  await settle();
  assert.equal(told().length, 0);

  made.forgetTile(w);
  await asked;
});
