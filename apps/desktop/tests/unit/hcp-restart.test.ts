/**
 * Restarting the app keeps who started each worker: it is still drawn and nested under the agent
 * that spawned it, still reports to it, still counts its spawn depth and still has its
 * supervision. A worker whose session ended is forgotten for good.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ControlPlane, type ControlPlaneOptions } from "@hivemind/host/control/plane";
import { ApiError } from "@hivemind/workspace-api/protocol";
import { useAuthoredAgents } from "./authored-agents.ts";
import { workspaceDeps, REPO } from "./hcp-workspace.ts";

useAuthoredAgents();

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hcp-restart-"));
const ws = workspaceDeps();
/** The app's control plane, as it starts over the same data folder. */
const start = () => new ControlPlane({
  dir: () => dir,
  publish: () => {},
  write: () => true,
  spawned: () => {},
  windowsUp: () => true,
  methods: () => ({ ...ws, spawnAllowed: () => true, callRenderer: async () => { throw new Error("no window"); } }),
} as unknown as ControlPlaneOptions);

test("a worker spawned before a restart is still its spawner's: wired, reporting, supervised, its depth counted", async () => {
  const before = start();
  const worker = await before.start(REPO, { program: "claude", parent: "tile-lead", supervise: "all" });
  const deep = await before.start(REPO, { program: "claude", parent: worker });
  const deeper = await before.start(REPO, { program: "claude", parent: deep });

  const after = start();
  assert.deepEqual(after.links().spawns, [
    { parent: "tile-lead", child: worker }, { parent: worker, child: deep }, { parent: deep, child: deeper },
  ]);
  assert.deepEqual(after.links().pipes, [
    { src: worker, dst: "tile-lead" }, { src: deep, dst: worker }, { src: deeper, dst: deep },
  ]);
  assert.equal(after.supervise.get(worker), "all");
  await after.agentChannel("agent.report", { callerTile: `hm:${worker}`, message: "auth reviewed" }, { actor: { kind: "tile", tile: worker } });
  const inbox = await after.agentChannel("agent.inbox", {}, { actor: { kind: "tile", tile: "tile-lead" } }) as { messages: Array<{ from: string; text: string }> };
  assert.deepEqual(inbox.messages.map((m) => [m.from, m.text]), [[worker, "auth reviewed"]]);
  await assert.rejects(after.start(REPO, { program: "claude", parent: deeper }), (e: unknown) => e instanceof ApiError && e.code === "DEPTH_EXCEEDED");

  // A worker whose session ended is not brought back by the next start.
  after.exited(`hm:${worker}`);
  assert.deepEqual(start().links().spawns, [{ parent: deep, child: deeper }]);
  assert.equal(start().supervise.get(worker), undefined);
  // Nor one whose session ended before anything was asked of the app after it started.
  start().exited(`hm:${deep}`);
  assert.deepEqual(start().links().spawns, []);
});
