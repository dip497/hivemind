/**
 * A worker spawned through `hive ctl` that stops to wait for input (a question picker, a
 * permission prompt) is reported to the agent that spawned it. Without this, an
 * unsupervised worker sits at its picker and the leader never hears about it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDispatch } from "@hivemind/host/control/methods";
import { Mailbox } from "@hivemind/host/control/mailbox";
import { TurnTracker } from "@hivemind/host/control/turn-tracker";
import { OutputRecorder } from "@hivemind/host/control/output-recorder";
import { useAuthoredAgents } from "./authored-agents.ts";
import { workspaceDeps, PERSON, REPO } from "./hcp-workspace.ts";

useAuthoredAgents();

function fleet() {
  const writes: Array<{ to: string; text: string }> = [];
  const mailbox = new Mailbox((to, text) => { writes.push({ to, text }); return true; }, 1);
  const deps = workspaceDeps();
  const status = deps.status;
  const made = makeDispatch({
    turns: new TurnTracker(),
    recorder: new OutputRecorder(),
    callRenderer: async () => { throw new Error("no window"); },
    writeToTile: () => true,
    deliverToTile: (id: string, t: string, onSent?: () => void) => mailbox.deliver(id, t, onSent),
    spawnAllowed: () => true,
    connect: () => true,
    disconnect: () => {},
    forgetPipes: () => {},
    spawnEdge: () => {},
    setSupervise: () => {},
    ...deps,
  } as unknown as Parameters<typeof makeDispatch>[0]);
  status.subscribe((c) => made.onStatus(c.tileId, c.status));
  const told = () => writes.filter((w) => /is waiting for/.test(w.text));
  const spawn = (o: { supervise?: true } = {}) => made.spawn({ agent: "claude", repo: REPO, parent: "tile-leader", prompt: "ask", ...o });
  return { made, status, told, spawn };
}

const settle = () => new Promise((r) => setTimeout(r, 50));

test("a worker's question reaches its leader once per wait, with how to see and answer it", async () => {
  const { status, told, spawn } = fleet();
  const w = await spawn();
  status.event(w, { event: "turn.started" });
  status.event(w, { event: "input.requested", kind: "question" });
  await settle();
  assert.equal(told().length, 1);
  assert.equal(told()[0]!.to, "hm:tile-leader");
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
  assert.equal(told().length, 0, "the APPROVAL banner is the leader's message");

  status.event("tile-user", { event: "input.requested", kind: "question" });
  await settle();
  assert.equal(told().length, 0);

  made.forgetTile(w);
  await asked;
});
