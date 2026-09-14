// A delegated worker has no human at its tile, so it launches in the mode its
// agent declares as `unattended` — never a mode borrowed from another agent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDispatch } from "../../src/main/hcp/methods.js";
import { TurnTracker } from "../../src/main/hcp/turn-tracker.js";
import { OutputRecorder } from "../../src/main/hcp/output-recorder.js";

async function spawnedMode(params: Record<string, unknown>, agentInstalled?: () => boolean): Promise<unknown> {
  const seen: Array<Record<string, unknown>> = [];
  const { dispatch } = makeDispatch({
    agentInstalled,
    turns: new TurnTracker(),
    recorder: new OutputRecorder(),
    callRenderer: async (_m: string, p: unknown) => { seen.push(p as Record<string, unknown>); return { tileId: "tile-w" }; },
    writeToTile: () => true,
    deliverToTile: () => true,
    spawnAllowed: () => true,
    connect: () => true,
    disconnect: () => {},
    forgetPipes: () => {},
    spawnEdge: () => {},
    setSupervise: () => {},
    pushWait: () => {},
  } as unknown as Parameters<typeof makeDispatch>[0]);
  await dispatch("tile.spawn_agent", { callerTile: "hm:tile-p", ...params });
  return seen[0]?.mode;
}

test("each agent's worker runs in that agent's own unattended mode", async () => {
  assert.equal(await spawnedMode({ agent: "claude" }), "bypassPermissions");
  assert.equal(await spawnedMode({ agent: "codex" }), undefined, "codex declares none, so it keeps its own posture");
});

test("an explicit mode wins, and a supervised worker keeps its prompts", async () => {
  assert.equal(await spawnedMode({ agent: "claude", mode: "plan" }), "plan");
  assert.equal(await spawnedMode({ agent: "claude", supervise: "all" }), undefined);
});

test("an agent whose CLI is not installed is refused with where to get it, and no tile is made", async () => {
  await assert.rejects(spawnedMode({ agent: "claude" }, () => false), (e: Error & { code?: string }) =>
    e.code === "UNSUPPORTED" && /not installed/.test(e.message) && /https:\/\/code\.claude\.com/.test(e.message));
});
