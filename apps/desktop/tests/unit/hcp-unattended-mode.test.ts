// A delegated worker has no human at its tile, so it launches in the mode its
// agent declares as `unattended` — never a mode borrowed from another agent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDispatch } from "../../src/main/hcp/methods.js";
import { useAuthoredAgents } from "./authored-agents.ts";

// Unattended modes are a catalog capability: load the published fixtures.
useAuthoredAgents();
import { TurnTracker } from "../../src/main/hcp/turn-tracker.js";
import { OutputRecorder } from "../../src/main/hcp/output-recorder.js";
import { REPO, workspaceDeps } from "./hcp-workspace.ts";

/** What the worker a spawn with `params` opens runs with: its arguments, as written into the
 *  workspace. */
async function spawnedArgs(params: Record<string, unknown>, agentInstalled?: () => boolean): Promise<string[] | undefined> {
  const ws = workspaceDeps();
  const { dispatch } = makeDispatch({
    agentInstalled,
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
    ...ws,
  } as unknown as Parameters<typeof makeDispatch>[0]);
  const { tileId } = (await dispatch("tile.spawn_agent", { callerTile: "hm:tile-p", ...params })) as { tileId: string };
  return (ws.workspaces.getCore(REPO)?.tiles.find((t) => t.id === tileId) as { args?: string[] } | undefined)?.args;
}

test("each agent's worker runs in that agent's own unattended mode", async () => {
  assert.deepEqual(await spawnedArgs({ agent: "claude" }), ["--dangerously-skip-permissions"]);
  assert.deepEqual(await spawnedArgs({ agent: "codex" }), ["--ask-for-approval", "on-request", "--sandbox", "workspace-write"], "codex declares none, so it keeps its own posture");
});

test("an explicit mode wins, and a supervised worker keeps its prompts", async () => {
  assert.deepEqual(await spawnedArgs({ agent: "claude", mode: "plan" }), ["--permission-mode", "plan"]);
  assert.deepEqual(await spawnedArgs({ agent: "claude", supervise: "all" }), []);
});

test("an agent whose CLI is not installed is refused with where to get it, and no tile is made", async () => {
  await assert.rejects(spawnedArgs({ agent: "claude" }, () => false), (e: Error & { code?: string }) =>
    e.code === "UNSUPPORTED" && /not installed/.test(e.message) && /https:\/\/code\.claude\.com/.test(e.message));
});
