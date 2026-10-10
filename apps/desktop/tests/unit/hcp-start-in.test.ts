// Starting an agent in a named workspace (`agent.start`, a program or an agent on the drive
// socket): a workspace the store holds is open even before its window first lays it out, and one
// it does not hold is refused; an agent that starts one is its parent, as with `hive ctl spawn`.
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
  const wires: string[] = [];
  const pipes: string[] = [];
  const dispatch = makeDispatch({
    turns: new TurnTracker(),
    recorder: new OutputRecorder(),
    callRenderer: async () => { throw new Error("no window"); },
    writeToTile: () => true,
    deliverToTile: () => true,
    spawnAllowed: () => true,
    connect: (src: string, dst: string) => { pipes.push(`${src}->${dst}`); return true; },
    disconnect: () => {},
    forgetPipes: () => {},
    spawnEdge: (child: string, parent: string | null, on: boolean) => { if (on) wires.push(`${parent}->${child}`); },
    setSupervise: () => {},
    ...deps,
  } as unknown as Parameters<typeof makeDispatch>[0]);
  return { deps, dispatch, wires, pipes };
}

test("an agent started in a workspace whose window has not laid it out yet lands there", async () => {
  const { deps, dispatch } = made();
  const fresh = "/work/fresh";
  // The window opening it reads its layout first, and finds none.
  assert.equal(deps.workspaces.getCore(fresh), null);
  const tile = await dispatch.spawn({ agent: "claude", repo: fresh });
  assert.equal(deps.workspaces.workspaceOf(tile), fresh);
  assert.deepEqual(deps.workspaces.getCore(fresh)!.tiles.map((t) => t.id), [tile]);
});

test("an agent started in a workspace the store does not hold is refused", async () => {
  const { deps, dispatch } = made();
  await assert.rejects(dispatch.spawn({ agent: "claude", repo: "/work/never-opened" }), { code: "NOT_FOUND" });
  assert.equal(deps.workspaces.repos().includes("/work/never-opened"), false);
});

test("an agent that starts one is its parent: wired to it on the board, reporting to it, a level below it, and three levels deep at most", async () => {
  const { dispatch, wires, pipes } = made();
  const start = (parent: string, report?: boolean) => dispatch.spawn({ agent: "claude", repo: "/work/repo", parent, ...(report === false ? { report } : {}) });
  const first = await start("client:g1");
  const second = await start(first);
  const third = await start(second, false);
  assert.deepEqual([dispatch.parentOf(second), dispatch.parentOf(third)], [first, second]);
  assert.deepEqual(wires, [`${first}->${second}`, `${second}->${third}`]);
  assert.deepEqual(pipes, [`${second}->${first}`], "one that reports to it, not one gathered");
  await assert.rejects(start(third), { code: "DEPTH_EXCEEDED" });
});
