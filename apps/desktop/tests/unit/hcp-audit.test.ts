/**
 * The control plane's verbs with effects go through the host's intents (R7): each leaves one line
 * in the audit log, naming who asked (the tile the call comes from, or a person at a terminal),
 * what it acted on, and how it ended. Verbs that only read, a hook reporting, and a view moving
 * leave none. Checked against the real dispatch and a real audit file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDispatch } from "../../src/main/hcp/methods.ts";
import { useAuthoredAgents } from "./authored-agents.ts";

// Spawn reads the live catalog: load the published fixtures.
useAuthoredAgents();
import { Mailbox } from "../../src/main/hcp/mailbox.ts";
import { TurnTracker } from "../../src/main/hcp/turn-tracker.ts";
import { OutputRecorder } from "../../src/main/hcp/output-recorder.ts";
import type { AuditRecord } from "@hivemind/workspace-host/intents";
import { workspaceDeps } from "./hcp-workspace.ts";

function dispatcher() {
  const writes: string[] = [];
  const write = (_id: string, d: string) => { writes.push(d); return true; };
  const mailbox = new Mailbox(write, 1);
  const turns = new TurnTracker();
  const ws = workspaceDeps();
  const { dispatch } = makeDispatch({
    turns,
    recorder: new OutputRecorder(),
    callRenderer: async () => { throw new Error("no window"); },
    reloadSettings: async () => ({ ok: true }),
    toolsSettings: () => ({ enabledPlugins: ["hivemind/web"], disabledTools: [] }),
    writeToTile: write,
    deliverToTile: (id: string, t: string, onSent?: () => void) => mailbox.deliver(id, t, onSent),
    spawnAllowed: () => true,
    defaultAgentId: async () => "claude",
    connect: () => true,
    disconnect: () => {},
    forgetPipes: () => {},
    spawnEdge: () => {},
    setSupervise: () => {},
    awaitingApproval: () => {},
    ...ws,
  });
  // A line without its time, which the next test checks on its own.
  const lines = () => ws.audited().map(({ at, ...rest }) => { assert.ok(!Number.isNaN(Date.parse(at))); return rest; });
  return { dispatch, turns, ws, writes, lines };
}

const lead = { kind: "tile", tile: "tile-lead" } as const;
const person = { kind: "person" } as const;
const until = async (ok: () => boolean) => { for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(ok()); };

test("each verb with an effect is recorded with who asked, what, of what and how it ended; reads, focus and view events are not", async () => {
  const { dispatch, lines } = dispatcher();
  const { tileId: w } = (await dispatch("tile.spawn_agent", { agent: "claude", callerTile: "hm:tile-lead" })) as { tileId: string };
  const { tileId: browser } = (await dispatch("tool.open", { tool: "hivemind/web/browser", url: "about:blank" })) as { tileId: string };
  await dispatch("agent.send", { tileId: w, text: "hello" });
  await dispatch("agent.send_keys", { tileId: w, keys: ["Enter"], callerTile: "hm:tile-lead" });
  await dispatch("agent.report", { callerTile: `hm:${w}`, message: "done" });
  await dispatch("tile.rename", { tileId: w, name: "worker", callerTile: "hm:tile-lead" });
  await dispatch("tile.connect", { srcTileId: w, dstTileId: "tile-lead" });
  await dispatch("tile.disconnect", { srcTileId: w });
  await dispatch("settings.reload", {});
  // With no window to carry them out these fail, and are recorded as asked all the same.
  await assert.rejects(dispatch("views.rescan", {}));
  await assert.rejects(dispatch("agents.rescan", {}));
  await assert.rejects(dispatch("review.open", { plan: "ship it" }));
  // Reads, a window's focus, a view's event and a hook's reply change nothing here.
  await dispatch("tile.list", { callerTile: "hm:tile-lead" });
  await dispatch("tile.list_frames", {});
  await dispatch("agent.read", { tileId: w, timeoutMs: 0 });
  await dispatch("agent.reply", { tileId: w, text: "done" });
  await assert.rejects(dispatch("tile.focus", { tileId: w }));
  await assert.rejects(dispatch("view.emit", { name: "ci.build" }));
  await dispatch("tile.close", { tileId: w, callerTile: "hm:tile-lead" });
  // One that fails is recorded too, with its error's code.
  await assert.rejects(dispatch("tile.close", { tileId: "tile-ghost" }), { code: "TILE_NOT_FOUND" });

  assert.deepEqual(lines(), [
    { actor: lead, verb: "tile.spawn_agent", target: w, outcome: "ok" },
    { actor: person, verb: "tool.open", target: browser, outcome: "ok" },
    { actor: person, verb: "agent.send", target: w, outcome: "ok" },
    { actor: lead, verb: "agent.send_keys", target: w, outcome: "ok" },
    { actor: { kind: "tile", tile: w }, verb: "agent.report", target: "tile-lead", outcome: "ok" },
    { actor: lead, verb: "tile.rename", target: w, outcome: "ok" },
    { actor: person, verb: "tile.connect", target: `${w}->tile-lead`, outcome: "ok" },
    { actor: person, verb: "tile.disconnect", target: `${w}->*`, outcome: "ok" },
    { actor: person, verb: "settings.reload", outcome: "ok" },
    { actor: person, verb: "views.rescan", outcome: "error" },
    { actor: person, verb: "agents.rescan", outcome: "error" },
    { actor: person, verb: "review.open", outcome: "error" },
    { actor: lead, verb: "tile.close", target: w, outcome: "ok" },
    { actor: person, verb: "tile.close", target: "tile-ghost", outcome: "error", code: "TILE_NOT_FOUND" },
  ]);
});

test("a supervised worker's question and its supervisor's answer are recorded; one the worker's standing answer settles is not", async () => {
  const { dispatch, writes, lines } = dispatcher();
  const { tileId: worker } = (await dispatch("tile.spawn_agent", { agent: "claude", callerTile: "hm:tile-lead", supervise: true })) as { tileId: string };
  const ask = () => dispatch("agent.await_approval", { callerTile: `hm:${worker}`, tool_name: "Edit", tool_input: { file_path: "/x.ts" } });

  const asked = ask();
  await until(() => /hive ctl approve (\S+) allow/.test(writes.join("")));
  const reqId = /hive ctl approve (\S+) allow/.exec(writes.join(""))![1];
  await dispatch("agent.approve", { reqId, decision: "always", callerTile: "hm:tile-lead" });
  assert.deepEqual(await asked, { decision: "allow", reason: undefined });
  // Remembered: this one asks nobody, so nothing happened to record.
  assert.deepEqual(await ask(), { decision: "allow" });
  // An answer to a question nobody is waiting on is recorded as the failure it is.
  await assert.rejects(dispatch("agent.approve", { reqId, decision: "deny", callerTile: "hm:tile-lead" }), { code: "BAD_REQUEST" });

  const recorded = lines();
  assert.deepEqual(recorded.filter((l) => l.verb !== "tile.spawn_agent").sort((a, b) => a.verb.localeCompare(b.verb) || a.outcome.localeCompare(b.outcome)), [
    { actor: lead, verb: "agent.approve", detail: "deny", outcome: "error", code: "BAD_REQUEST" },
    { actor: lead, verb: "agent.approve", target: worker, detail: "always", outcome: "ok" },
    { actor: { kind: "tile", tile: worker }, verb: "agent.await_approval", target: "tile-lead", detail: "Edit", outcome: "ok" },
  ]);
});

test("a workflow's spawns and closes are recorded as its caller's, one by one, and so is the workflow", async () => {
  const { dispatch, turns, ws, lines } = dispatcher();
  const run = dispatch("workflow.run", { shape: "fanout", items: ["a", "b"], prompt: "do {item}", close_when_done: true, callerTile: "hm:tile-lead", timeout_ms: 5000 });
  await until(() => ws.announced.length === 2);
  // Each worker finishes its turn once it is running.
  for (const { tileId } of ws.announced) { turns.recordReply(`hm:${tileId}`, `did ${tileId}`); turns.recordTurn(`hm:${tileId}`); }
  await run;

  const workers = ws.announced.map((s) => s.tileId).sort();
  const recorded = lines();
  const of = (verb: string) => recorded.filter((l) => l.verb === verb);
  assert.deepEqual(of("tile.spawn_agent").map((l) => l.target).sort(), workers);
  assert.deepEqual(of("tile.close").map((l) => l.target).sort(), workers);
  assert.ok(recorded.every((l) => l.outcome === "ok" && l.actor.kind === "tile" && l.actor.tile === "tile-lead"));
  assert.deepEqual(recorded.at(-1), { actor: lead, verb: "workflow.run", outcome: "ok" } satisfies Omit<AuditRecord, "at">);
});
