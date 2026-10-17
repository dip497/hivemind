/**
 * What the agent channel carries out goes through the host's intents (R7): each leaves one line
 * in the audit log, naming who asked (the tile whose token the call came with, or a person at
 * this machine), what it acted on, and how it ended. A hook handing over a reply leaves none. A
 * tile speaks only for itself. Checked against the real control plane and a real audit file. (The
 * workspace API records its own: control-api.test.ts.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDispatch } from "@hivemind/host/control/methods";
import { useAuthoredAgents } from "./authored-agents.ts";

// Spawn reads the live catalog: load the published fixtures.
useAuthoredAgents();
import { Mailbox } from "@hivemind/host/control/mailbox";
import { Inbox } from "@hivemind/host/control/inbox";
import { TurnTracker } from "@hivemind/host/control/turn-tracker";
import { OutputRecorder } from "@hivemind/host/control/output-recorder";
import type { AuditRecord } from "@hivemind/workspace-host/intents";
import { PERSON, REPO, fromTile, workspaceDeps } from "./hcp-workspace.ts";

function dispatcher() {
  const writes: string[] = [];
  const write = (_id: string, d: string) => { writes.push(d); return true; };
  const mailbox = new Mailbox(write, 1);
  const inbox = new Inbox((to, wanted, rung) => mailbox.deliver(`hm:${to}`, "[hive] inbox", rung, { wanted, atPrompt: true }));
  const turns = new TurnTracker();
  const ws = workspaceDeps();
  const made = makeDispatch({
    turns,
    recorder: new OutputRecorder(),
    callRenderer: async () => { throw new Error("no window"); },
    reloadSettings: async () => ({ ok: true }),
    toolsSettings: () => ({ enabledPlugins: ["hivemind/web"], disabledTools: [] }),
    writeToTile: write,
    deliverToTile: (id: string, t: string, onSent?: () => void) => mailbox.deliver(id, t, onSent),
    inbox,
    waitingOf: () => undefined,
    spawnAllowed: () => true,
    defaultAgentId: async () => "claude",
    connect: () => true,
    disconnect: () => {},
    forgetPipes: () => {},
    spawnEdge: () => {},
    ...ws,
  });
  // A line without its time, which the next test checks on its own.
  const lines = () => ws.audited().map(({ at, ...rest }) => { assert.ok(!Number.isNaN(Date.parse(at))); return rest; });
  const worker = (opts: { supervise?: true } = {}) => made.spawn({ agent: "claude", parent: "tile-lead", repo: REPO, ...opts });
  return { ...made, turns, ws, inbox, writes, lines, worker };
}

const person = { kind: "person" } as const;
const until = async (ok: () => boolean) => { for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(ok()); };

test("a report, a question and a review are recorded with who asked, of what and how it ended; a hook's reply is not", async () => {
  const { agentChannel, ws, lines, worker } = dispatcher();
  const w = await worker();
  await agentChannel("agent.report", { message: "done" }, fromTile(w));
  // The worker waits on a review of its plan, which a person allows.
  const reviewed = agentChannel("review.open", { plan: "ship it" }, fromTile(w));
  ws.waits.answer(w, ws.waits.of(w)!.since, "allow");
  await reviewed;
  await agentChannel("agent.reply", { tileId: w, text: "done" }, PERSON);
  // One that fails is recorded too, with its error's code.
  await assert.rejects(agentChannel("agent.report", { message: "done" }, fromTile("tile-orphan")), { code: "NOT_FOUND" });

  assert.deepEqual(lines(), [
    { actor: { kind: "tile", tile: w }, verb: "agent.report", target: "tile-lead", outcome: "ok" },
    { actor: { kind: "tile", tile: w }, verb: "review.open", detail: "allow", outcome: "ok" },
    { actor: { kind: "tile", tile: "tile-orphan" }, verb: "agent.report", outcome: "error", code: "NOT_FOUND" },
  ]);
});

test("a supervised worker's question is recorded; one the worker's standing answer settles is not", async () => {
  const { agentChannel, ws, lines, worker } = dispatcher();
  const w = await worker({ supervise: true });
  const ask = () => agentChannel("agent.await_approval", { tool_name: "Edit", tool_input: { file_path: "/x.ts" } }, fromTile(w));

  const asked = ask();
  await until(() => !!ws.waits.of(w));
  const wait = ws.waits.of(w)!;
  ws.waits.answer(w, wait.since, "allow", { always: true });
  assert.deepEqual(await asked, { decision: "allow" });
  // Remembered: this one asks nobody, so nothing happened to record.
  assert.deepEqual(await ask(), { decision: "allow" });

  assert.deepEqual(lines(), [
    { actor: { kind: "tile", tile: w }, verb: "agent.await_approval", target: "tile-lead", detail: "Edit", outcome: "ok" },
  ]);
});

test("a tile that names another as its caller, or hands over another's reply, is refused, which is recorded, and nothing happens; a person may act for any tile", async () => {
  const { agentChannel, ws, inbox, writes, lines, worker, turns } = dispatcher();
  const w = await worker();
  const other = fromTile("tile-other");
  await assert.rejects(agentChannel("agent.report", { callerTile: `hm:${w}`, message: "forged" }, other), { code: "FORBIDDEN" });
  await assert.rejects(agentChannel("review.open", { callerTile: w, plan: "forged" }, other), { code: "FORBIDDEN" });
  await assert.rejects(agentChannel("agent.reply", { tileId: `hm:${w}`, text: "forged" }, other), { code: "FORBIDDEN" });
  turns.recordTurn(`hm:${w}`);
  assert.equal(turns.lastReply(`hm:${w}`), null, "its turn ended with no reply");
  assert.equal(ws.waits.of(w), undefined, "nothing waits");
  assert.deepEqual(writes, [], "nothing was typed");
  assert.deepEqual(inbox.take("tile-lead").messages, [], "nothing was sent");
  // Its own id, however it is spelled, is itself.
  await agentChannel("agent.report", { callerTile: `hm:${w}`, message: "mine" }, fromTile(w));
  await agentChannel("agent.report", { callerTile: w, message: "for it" }, PERSON);
  await agentChannel("agent.reply", { tileId: w, text: "its own" }, fromTile(w));
  turns.recordTurn(`hm:${w}`);
  assert.equal(turns.lastReply(`hm:${w}`), "its own");

  assert.deepEqual(lines(), [
    { actor: other.actor, verb: "agent.report", target: w, outcome: "refused" },
    { actor: other.actor, verb: "review.open", target: w, outcome: "refused" },
    { actor: other.actor, verb: "agent.reply", target: w, outcome: "refused" },
    { actor: { kind: "tile", tile: w }, verb: "agent.report", target: "tile-lead", outcome: "ok" },
    { actor: person, verb: "agent.report", target: "tile-lead", outcome: "ok" },
  ]);
});
