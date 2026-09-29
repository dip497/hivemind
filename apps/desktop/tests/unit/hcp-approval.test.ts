/**
 * Supervised-worker approval policy.
 *
 * Two rules with teeth:
 *  1. A plain `allow` STICKS for file-touching tools, but NEVER for bash — caching
 *     an allow on bash would hand the worker a blanket shell for the rest of its life.
 *  2. pi CANNOT be supervised at all — the spawn is refused. pi has no permission
 *     system, so any gate would be one we inject; with no native prompt to fall back
 *     to it must fail closed, and then any hiccup bricks the worker (that is exactly
 *     what shipped in v1.13.0 and refused every tool mid-task). Refusing loudly beats
 *     handing a caller a gate that isn't one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDispatch } from "../../src/main/hcp/methods.js";
import { useAuthoredAgents } from "./authored-agents.ts";

// Spawn/supervise policy reads the live catalog: load the published fixtures.
useAuthoredAgents();
import { Mailbox } from "../../src/main/hcp/mailbox.js";
import { TurnTracker } from "../../src/main/hcp/turn-tracker.js";
import { OutputRecorder } from "../../src/main/hcp/output-recorder.js";
import os from "node:os";
import path from "node:path";
import { StatusStore } from "@hivemind/agent-host/status-store";
import { WorkspaceStore } from "@hivemind/workspace-host/store";

// No workspace is open and no session known: a banner names its worker by id.
const NOTHING_OPEN = { workspaces: new WorkspaceStore({ dir: path.join(os.tmpdir(), "hcp-no-workspace") }), status: new StatusStore(), shownWorkspace: () => null };

test("an approval for a BUSY supervisor is held, then delivered when it hits its prompt", async () => {
  // The screenshot bug, end to end: the parent was mid-turn, so the approval banner was
  // typed into its composer where it could never be read, and the worker blocked until
  // timeout. (Worker is claude here — pi can no longer be supervised at all.)
  const writes: string[] = [];
  const mailbox = new Mailbox((_id, d) => { writes.push(d); return true; }, 1);
  const { dispatch } = makeDispatch({
    turns: new TurnTracker(),
    recorder: new OutputRecorder(),
    callRenderer: async () => ({ tileId: "tile-w" }),
    writeToTile: () => true,
    deliverToTile: (id: string, t: string, onSent?: () => void) => mailbox.deliver(id, t, onSent),
    spawnAllowed: () => true,
    connect: () => true,
    disconnect: () => {},
    forgetPipes: () => {},
    spawnEdge: () => {},
    setSupervise: () => {},
    awaitingApproval: () => {},
    ...NOTHING_OPEN,
  } as unknown as Parameters<typeof makeDispatch>[0]);

  await dispatch("tile.spawn_agent", { agent: "claude", callerTile: "hm:tile-parent", supervise: true });
  mailbox.setBusy("hm:tile-parent"); // parent is mid-turn — its TUI can't take input

  const asked = dispatch("agent.await_approval", {
    callerTile: "hm:tile-w", tool_name: "write", tool_input: { path: "/x.java" },
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(writes, [], "nothing typed into the busy supervisor");

  mailbox.setIdle("hm:tile-parent"); // parent finishes its turn
  await new Promise((r) => setTimeout(r, 400));
  assert.match(writes.join(""), /APPROVAL — worker .*wants to run write/, "now it can actually be read");

  // The reqId the parent was told to answer with must be the one that resolves it.
  const reqId = /hive ctl approve (\S+) allow/.exec(writes.join(""))?.[1];
  assert.ok(reqId, "banner carries a reqId");
  await dispatch("agent.approve", { reqId, decision: "allow" });
  assert.deepEqual(await asked, { decision: "allow", reason: undefined });
});

test("approval with a dead supervisor resolves instead of hanging the worker", async () => {
  const { dispatch } = makeDispatch({
    turns: new TurnTracker(),
    recorder: new OutputRecorder(),
    callRenderer: async () => ({ tileId: "tile-w" }),
    writeToTile: () => false,
    deliverToTile: () => false, // parent's pty is gone
    spawnAllowed: () => true,
    connect: () => true,
    disconnect: () => {},
    forgetPipes: () => {},
    spawnEdge: () => {},
    setSupervise: () => {},
    awaitingApproval: () => {},
    ...NOTHING_OPEN,
  } as unknown as Parameters<typeof makeDispatch>[0]);
  await dispatch("tile.spawn_agent", { agent: "claude", callerTile: "hm:tile-parent", supervise: true });
  const r = await dispatch("agent.await_approval", { callerTile: "hm:tile-w", tool_name: "write", tool_input: {} });
  assert.deepEqual(r, { decision: "ask" }, "resolves immediately — never blocks for 9 minutes on a corpse");
});

test("a plain allow covers THIS call; only `always` is remembered", async () => {
  // The supervisor's own words decide. Nothing upgrades "allow" into "always" on its
  // behalf — not for a tool that writes files, not for any tool.
  const writes: string[] = [];
  const mailbox = new Mailbox((_id, d) => { writes.push(d); return true; }, 1);
  const { dispatch } = makeDispatch({
    turns: new TurnTracker(),
    recorder: new OutputRecorder(),
    callRenderer: async () => ({ tileId: "tile-w" }),
    writeToTile: () => true,
    deliverToTile: (id: string, t: string, onSent?: () => void) => mailbox.deliver(id, t, onSent),
    spawnAllowed: () => true,
    connect: () => true,
    disconnect: () => {},
    forgetPipes: () => {},
    spawnEdge: () => {},
    setSupervise: () => {},
    awaitingApproval: () => {},
    ...NOTHING_OPEN,
  } as unknown as Parameters<typeof makeDispatch>[0]);
  await dispatch("tile.spawn_agent", { agent: "claude", callerTile: "hm:tile-parent", supervise: true });

  const ask = () => dispatch("agent.await_approval", { callerTile: "hm:tile-w", tool_name: "Edit", tool_input: { path: "/x.ts" } });
  const reqIdOf = () => [...writes.join("").matchAll(/hive ctl approve (\S+) allow/g)].at(-1)?.[1];

  const first = ask();
  await new Promise((r) => setTimeout(r, 300));
  await dispatch("agent.approve", { reqId: reqIdOf(), decision: "allow" });
  assert.deepEqual(await first, { decision: "allow", reason: undefined });

  // Same worker, same tool: it is asked again, because "allow" was about that one call.
  const before = writes.length;
  const second = ask();
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(writes.length > before, "the supervisor is asked a second time");
  await dispatch("agent.approve", { reqId: reqIdOf(), decision: "always" });
  assert.deepEqual(await second, { decision: "allow", reason: undefined });

  // Now it is remembered: the third call resolves without troubling the supervisor.
  const quiet = writes.length;
  assert.deepEqual(await ask(), { decision: "allow" });
  assert.equal(writes.length, quiet, "nothing was asked");
});

test("spawning a pi worker with supervise is REFUSED — never silently ungated", async () => {
  const { dispatch } = makeDispatch({
    turns: new TurnTracker(),
    recorder: new OutputRecorder(),
    callRenderer: async () => ({ tileId: "tile-w" }),
    writeToTile: () => true,
    deliverToTile: () => true,
    spawnAllowed: () => true,
    connect: () => true,
    disconnect: () => {},
    forgetPipes: () => {},
    spawnEdge: () => {},
    setSupervise: () => {},
    awaitingApproval: () => {},
    ...NOTHING_OPEN,
  } as unknown as Parameters<typeof makeDispatch>[0]);

  await assert.rejects(
    () => dispatch("tile.spawn_agent", { agent: "pi", supervise: true, callerTile: "hm:tile-p" }),
    /cannot be supervised/,
    "a caller must never believe it is supervising a pi worker when it isn't",
  );
  // Unsupervised pi spawns normally — pi's whole point is an autonomous worker.
  const r = await dispatch("tile.spawn_agent", { agent: "pi", callerTile: "hm:tile-p" });
  assert.deepEqual(r, { tileId: "tile-w" });
  // claude keeps supervise: its broker fails open to a real human permission prompt.
  const c = await dispatch("tile.spawn_agent", { agent: "claude", supervise: true, callerTile: "hm:tile-p" });
  assert.deepEqual(c, { tileId: "tile-w" });
});
