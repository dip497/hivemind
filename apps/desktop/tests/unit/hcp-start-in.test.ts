// Starting an agent in a named workspace (`agent.start`, a program on the drive socket): a
// workspace the store holds is open even before its window first lays it out, and one it does
// not hold is refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDispatch } from "@hivemind/host/control/methods";
import { TurnTracker } from "@hivemind/host/control/turn-tracker";
import { OutputRecorder } from "@hivemind/host/control/output-recorder";
import { useAuthoredAgents } from "./authored-agents.ts";
import { workspaceDeps } from "./hcp-workspace.ts";

useAuthoredAgents();

function made() {
  const deps = workspaceDeps();
  const dispatch = makeDispatch({
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
    ...deps,
  } as unknown as Parameters<typeof makeDispatch>[0]);
  return { deps, dispatch };
}

test("an agent started in a workspace whose window has not laid it out yet lands there", async () => {
  const { deps, dispatch } = made();
  const fresh = "/work/fresh";
  // The window opening it reads its layout first, and finds none.
  assert.equal(deps.workspaces.getCore(fresh), null);
  const tile = await dispatch.spawn({ agent: "claude", repo: fresh, attended: true });
  assert.equal(deps.workspaces.workspaceOf(tile), fresh);
  assert.deepEqual(deps.workspaces.getCore(fresh)!.tiles.map((t) => t.id), [tile]);
});

test("an agent started in a workspace the store does not hold is refused", async () => {
  const { deps, dispatch } = made();
  await assert.rejects(dispatch.spawn({ agent: "claude", repo: "/work/never-opened", attended: true }), { code: "NOT_FOUND" });
  assert.equal(deps.workspaces.repos().includes("/work/never-opened"), false);
});
