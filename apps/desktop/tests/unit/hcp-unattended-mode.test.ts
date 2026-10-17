// An agent's worker has no human at its tile, so it launches in the mode its agent declares as
// `unattended` — never a mode borrowed from another agent; one the person starts keeps its prompts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDispatch } from "@hivemind/host/control/methods";
import { useAuthoredAgents } from "./authored-agents.ts";

// Unattended modes are a catalog capability: load the published fixtures.
useAuthoredAgents();
import { TurnTracker } from "@hivemind/host/control/turn-tracker";
import { OutputRecorder } from "@hivemind/host/control/output-recorder";
import { REPO, workspaceDeps } from "./hcp-workspace.ts";

/** The control plane over a real workspace store, and that store. */
function dispatcher(agentInstalled?: (def: unknown, where: { callerTile?: string; folder?: string }) => boolean) {
  const ws = workspaceDeps();
  return {
    ws,
    ...makeDispatch({
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
      ...ws,
    } as unknown as Parameters<typeof makeDispatch>[0]),
  };
}

/** What the worker an agent starts with `params` runs with: its arguments, as written into the
 *  workspace. */
async function spawnedArgs(params: { agent: string; mode?: string; supervise?: string }, agentInstalled?: () => boolean): Promise<string[] | undefined> {
  const { ws, spawn } = dispatcher(agentInstalled);
  const tileId = await spawn({ parent: "tile-p", repo: REPO, ...params });
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

test("an agent the person, or a program, starts opens in the workspace they name, not the one the window shows, and keeps its prompts: never its unattended mode unless asked", async () => {
  const { ws, spawn } = dispatcher();
  const other = "/work/other";
  ws.workspaces.setCore(other, { frames: [{ id: "f9", title: "other", workspacePath: other }], tiles: [] });
  const tile = await spawn({ agent: "claude", repo: other });
  const opened = ws.workspaces.getCore(other)?.tiles.find((t) => t.id === tile) as { args?: string[] } | undefined;
  assert.deepEqual(opened?.args, [], "claude's own posture: it asks before it acts");
  assert.equal(ws.workspaces.getCore(REPO)?.tiles.length, 0, "nothing opened where the window is");
  const planned = await spawn({ agent: "claude", repo: other, mode: "plan" });
  assert.deepEqual((ws.workspaces.getCore(other)?.tiles.find((t) => t.id === planned) as { args?: string[] }).args, ["--permission-mode", "plan"]);
  const programs = await spawn({ agent: "claude", repo: other, parent: "client:g1" });
  assert.deepEqual((ws.workspaces.getCore(other)?.tiles.find((t) => t.id === programs) as { args?: string[] }).args, [], "a program's worker keeps its prompts too");
});

test("whether an agent is installed is asked of where it would run: the folder of the frame it opens in, or the agent that starts it", async () => {
  const asked: Array<{ callerTile?: string; folder?: string }> = [];
  const { ws, spawn } = dispatcher((_def, where) => { asked.push(where); return true; });
  const other = "/work/remote";
  ws.workspaces.setCore(other, { frames: [
    { id: "f-box", title: "box", workspacePath: "machine://box1/srv/api" },
    { id: "f-wt", title: "fix", worktreePath: "/work/remote-fix", workspacePath: "/work/remote" },
  ], tiles: [] });
  await spawn({ agent: "claude", repo: other, frame: "f-box" });
  await spawn({ agent: "claude", repo: other, frame: "f-wt" });
  await spawn({ agent: "claude", parent: "tile-p", repo: REPO });
  assert.deepEqual(asked, [{ folder: "machine://box1/srv/api" }, { folder: "/work/remote-fix" }, { callerTile: "hm:tile-p", folder: REPO }]);
});
