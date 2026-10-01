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
 *  3. Only the supervisor a question was asked of answers it, or a person: not the
 *     worker (which can read its supervisor's screen, and so the question's id).
 *  4. A question ends when the worker stops waiting, and a later answer says so: it
 *     used to be told it worked while the worker had already asked its own prompt.
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
import { workspaceDeps, PERSON, fromTile } from "./hcp-workspace.ts";

test("an approval for a BUSY supervisor is held, then delivered when it hits its prompt", async () => {
  // The screenshot bug, end to end: the parent was mid-turn, so the approval banner was
  // typed into its composer where it could never be read, and the worker blocked until
  // timeout. (Worker is claude here — pi can no longer be supervised at all.)
  const writes: string[] = [];
  const mailbox = new Mailbox((_id, d) => { writes.push(d); return true; }, 1);
  const { dispatch } = makeDispatch({
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
    awaitingApproval: () => {},
    ...workspaceDeps(),
  } as unknown as Parameters<typeof makeDispatch>[0]);

  const worker = ((await dispatch("tile.spawn_agent", { agent: "claude", callerTile: "hm:tile-parent", supervise: true }, PERSON)) as { tileId: string }).tileId;
  mailbox.setBusy("hm:tile-parent"); // parent is mid-turn — its TUI can't take input

  const asked = dispatch("agent.await_approval", {
    callerTile: `hm:${worker}`, tool_name: "write", tool_input: { path: "/x.java" },
  }, PERSON);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(writes, [], "nothing typed into the busy supervisor");

  mailbox.setIdle("hm:tile-parent"); // parent finishes its turn
  await new Promise((r) => setTimeout(r, 400));
  assert.match(writes.join(""), /APPROVAL — worker .*wants to run write/, "now it can actually be read");

  // The reqId the parent was told to answer with must be the one that resolves it.
  const reqId = /hive ctl approve (\S+) allow/.exec(writes.join(""))?.[1];
  assert.ok(reqId, "banner carries a reqId");
  await dispatch("agent.approve", { reqId, decision: "allow" }, PERSON);
  assert.deepEqual(await asked, { decision: "allow", reason: undefined });
});

test("approval with a dead supervisor resolves instead of hanging the worker", async () => {
  const { dispatch } = makeDispatch({
    turns: new TurnTracker(),
    recorder: new OutputRecorder(),
    callRenderer: async () => { throw new Error("no window"); },
    writeToTile: () => false,
    deliverToTile: () => false, // parent's pty is gone
    spawnAllowed: () => true,
    connect: () => true,
    disconnect: () => {},
    forgetPipes: () => {},
    spawnEdge: () => {},
    setSupervise: () => {},
    awaitingApproval: () => {},
    ...workspaceDeps(),
  } as unknown as Parameters<typeof makeDispatch>[0]);
  const worker = ((await dispatch("tile.spawn_agent", { agent: "claude", callerTile: "hm:tile-parent", supervise: true }, PERSON)) as { tileId: string }).tileId;
  const r = await dispatch("agent.await_approval", { callerTile: `hm:${worker}`, tool_name: "write", tool_input: {} }, PERSON);
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
    callRenderer: async () => { throw new Error("no window"); },
    writeToTile: () => true,
    deliverToTile: (id: string, t: string, onSent?: () => void) => mailbox.deliver(id, t, onSent),
    spawnAllowed: () => true,
    connect: () => true,
    disconnect: () => {},
    forgetPipes: () => {},
    spawnEdge: () => {},
    setSupervise: () => {},
    awaitingApproval: () => {},
    ...workspaceDeps(),
  } as unknown as Parameters<typeof makeDispatch>[0]);
  const worker = ((await dispatch("tile.spawn_agent", { agent: "claude", callerTile: "hm:tile-parent", supervise: true }, PERSON)) as { tileId: string }).tileId;

  const ask = () => dispatch("agent.await_approval", { callerTile: `hm:${worker}`, tool_name: "Edit", tool_input: { path: "/x.ts" } }, PERSON);
  const reqIdOf = () => [...writes.join("").matchAll(/hive ctl approve (\S+) allow/g)].at(-1)?.[1];

  const first = ask();
  await new Promise((r) => setTimeout(r, 300));
  await dispatch("agent.approve", { reqId: reqIdOf(), decision: "allow" }, PERSON);
  assert.deepEqual(await first, { decision: "allow", reason: undefined });

  // Same worker, same tool: it is asked again, because "allow" was about that one call.
  const before = writes.length;
  const second = ask();
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(writes.length > before, "the supervisor is asked a second time");
  await dispatch("agent.approve", { reqId: reqIdOf(), decision: "always" }, PERSON);
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
    callRenderer: async () => { throw new Error("no window"); },
    writeToTile: () => true,
    deliverToTile: () => true,
    spawnAllowed: () => true,
    connect: () => true,
    disconnect: () => {},
    forgetPipes: () => {},
    spawnEdge: () => {},
    setSupervise: () => {},
    awaitingApproval: () => {},
    ...workspaceDeps(),
  } as unknown as Parameters<typeof makeDispatch>[0]);

  await assert.rejects(
    () => dispatch("tile.spawn_agent", { agent: "pi", supervise: true, callerTile: "hm:tile-p" }, PERSON),
    /cannot be supervised/,
    "a caller must never believe it is supervising a pi worker when it isn't",
  );
  // Unsupervised pi spawns normally — pi's whole point is an autonomous worker.
  const r = await dispatch("tile.spawn_agent", { agent: "pi", callerTile: "hm:tile-p" }, PERSON);
  assert.match((r as { tileId: string }).tileId, /^tile-pi-/);
  // claude keeps supervise: its broker fails open to a real human permission prompt.
  const c = await dispatch("tile.spawn_agent", { agent: "claude", supervise: true, callerTile: "hm:tile-p" }, PERSON);
  assert.match((c as { tileId: string }).tileId, /^tile-claude-/);
});

/** A supervisor ("tile-lead") and what it has been asked, for the answering rules below. */
function supervised() {
  const writes: string[] = [];
  const waiting: Array<[string, boolean]> = [];
  const mailbox = new Mailbox((_id, d) => { writes.push(d); return true; }, 1);
  const { dispatch } = makeDispatch({
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
    awaitingApproval: (tile: string, on: boolean) => { waiting.push([tile, on]); },
    ...workspaceDeps(),
  } as unknown as Parameters<typeof makeDispatch>[0]);
  const spawnWorker = async () => ((await dispatch("tile.spawn_agent", { agent: "claude", supervise: true }, fromTile("tile-lead"))) as { tileId: string }).tileId;
  // The question the supervisor was asked last: its id is in what was typed to it.
  const asked = async (before: number) => {
    for (let i = 0; i < 100 && writes.length === before; i++) await new Promise((r) => setTimeout(r, 10));
    return [...writes.join("").matchAll(/hive ctl approve (\S+) allow/g)].at(-1)![1]!;
  };
  return { dispatch, writes, waiting, spawnWorker, asked };
}

test("an approval is answered by the supervisor it was asked of, or a person — never by the worker itself, nor by another worker", async () => {
  const { dispatch, writes, spawnWorker, asked } = supervised();
  const worker = await spawnWorker();
  const other = await spawnWorker();

  const question = dispatch("agent.await_approval", { tool_name: "Bash", tool_input: { command: "rm -rf build" } }, fromTile(worker));
  const reqId = await asked(0);
  await assert.rejects(dispatch("agent.approve", { reqId, decision: "allow" }, fromTile(worker)), { code: "UNAUTHORIZED" });
  await assert.rejects(dispatch("agent.approve", { reqId, decision: "always" }, fromTile(other)), { code: "UNAUTHORIZED" });
  // Refused answers change nothing: it is still the supervisor's to answer.
  await dispatch("agent.approve", { reqId, decision: "deny" }, fromTile("tile-lead"));
  assert.deepEqual(await question, { decision: "deny", reason: undefined });

  const again = dispatch("agent.await_approval", { tool_name: "Bash", tool_input: { command: "ls" } }, fromTile(worker));
  await dispatch("agent.approve", { reqId: await asked(writes.length), decision: "allow" }, PERSON);
  assert.deepEqual(await again, { decision: "allow", reason: undefined });
});

test("a question ends when the worker stops waiting for it, and an answer after that is told it came too late", async () => {
  const { dispatch, waiting, spawnWorker, asked } = supervised();
  const worker = await spawnWorker();
  const hook = new AbortController();
  const question = dispatch("agent.await_approval", { tool_name: "Bash", tool_input: { command: "make" } }, { ...fromTile(worker), signal: hook.signal });
  const reqId = await asked(0);
  hook.abort(); // the worker's hook gave up and asked the agent's own prompt
  assert.deepEqual(await question, { decision: "ask" });
  assert.deepEqual(waiting.at(-1), [worker, false], "the worker is no longer shown waiting");
  await assert.rejects(dispatch("agent.approve", { reqId, decision: "allow" }, fromTile("tile-lead")), (e: Error & { code?: string }) =>
    e.code === "BAD_REQUEST" && /stopped waiting/.test(e.message));
});

test("the hook of an answered question closing does not end the worker's next question", async () => {
  const { dispatch, writes, waiting, spawnWorker, asked } = supervised();
  const worker = await spawnWorker();
  const firstHook = new AbortController();
  const first = dispatch("agent.await_approval", { tool_name: "Edit", tool_input: { file_path: "/a.ts" } }, { ...fromTile(worker), signal: firstHook.signal });
  await dispatch("agent.approve", { reqId: await asked(0), decision: "allow" }, fromTile("tile-lead"));
  await first;
  const second = dispatch("agent.await_approval", { tool_name: "Edit", tool_input: { file_path: "/b.ts" } }, fromTile(worker));
  const reqId = await asked(writes.length);
  firstHook.abort(); // its hook lets go after its answer, while the next question waits
  assert.deepEqual(waiting.at(-1), [worker, true], "still shown waiting on the second");
  await dispatch("agent.approve", { reqId, decision: "deny" }, fromTile("tile-lead"));
  assert.deepEqual(await second, { decision: "deny", reason: undefined });
});
