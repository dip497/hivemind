/**
 * A tile the control plane spawns is started by its host, with its first task: a window that shows
 * it only joins it. The windows are told the tile opened, never what it was asked to do, so no
 * window can start it first without its task.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ControlPlane, type ControlPlaneOptions } from "@hivemind/host/control/plane";
import { useAuthoredAgents } from "./authored-agents.ts";
import { workspaceDeps, REPO } from "./hcp-workspace.ts";

useAuthoredAgents();

test("a spawned tile's task goes to the host that starts it, and to no window", async () => {
  const told: Array<{ event: string; params: unknown[] }> = [];
  const started: Array<{ tileId: string; prompt?: string }> = [];
  const p = new ControlPlane({
    dir: () => "/nowhere",
    publish: (event: string, ...params: unknown[]) => void told.push({ event, params }),
    write: () => true,
    spawned: (spawn) => void started.push(spawn),
    windowsUp: () => true,
    methods: () => ({ ...workspaceDeps(), spawnAllowed: () => true, callRenderer: async () => { throw new Error("no window"); } }),
  } as unknown as ControlPlaneOptions);

  const tile = await p.start(REPO, { program: "claude", prompt: "Review the auth module" });

  assert.deepEqual(started.map((s) => [s.tileId, s.prompt]), [[tile, "Review the auth module"]]);
  const opened = told.filter((t) => t.event === "tile.opened").map((t) => t.params[0]);
  assert.deepEqual(opened, [{ tileId: tile, repo: REPO, background: false, by: "person" }]);
});
