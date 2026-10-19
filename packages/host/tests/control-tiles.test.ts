// A tile the person names to the control plane (control/methods.ts, plane.ts) that is not open,
// closed or never opened, over a real workspace store: every verb that names one says it is not
// found, rather than doing nothing or waiting on a window; a message to it is not sent.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import { Intents } from "@hivemind/workspace-host/intents";
import { WorkspaceStore } from "@hivemind/workspace-host/store";
import { newSeed } from "@hivemind/workspace-host/identity";
import { ControlPlane, type ControlPlaneOptions } from "../src/control/plane.ts";

const REPO = "/work/api";

async function controlOver(tiles: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "control-tiles-"));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workspaces = new WorkspaceStore({ dir, person: newSeed() });
  workspaces.setCore(REPO, {
    frames: [{ id: "f1", title: "api", workspacePath: REPO }],
    tiles: tiles.map((id) => ({ id, kind: "claude", label: "claude", cmd: "claude" })),
    frameOf: Object.fromEntries(tiles.map((t) => [t, "f1"])),
  });
  const running = new Set(tiles.map((t) => `hm:${t}`));
  const p = new ControlPlane({
    dir: () => dir,
    publish: () => {},
    spawned: () => {},
    windowsUp: () => true,
    write: (to) => running.has(to),
    signalsTurns: () => true,
    methods: () => ({
      workspaces,
      shownWorkspace: () => null,
      launchOptions: () => ({}),
      sessionHeld: (pty: string) => running.has(pty),
      intents: new Intents(new AuditLog({ file: path.join(dir, "audit.jsonl") })),
      callRenderer: async () => ({}),
      reloadSettings: async () => ({}),
    }),
  } as unknown as ControlPlaneOptions);
  return p.api();
}

const failure = async (run: () => unknown): Promise<string> => {
  try { await run(); return "done"; } catch (e) { return (e as { code?: string }).code ?? String(e); }
};

test("a tile that is not open is not found by every verb that names it, at either end of a pipe; a message to it is not sent", async () => {
  const api = await controlOver(["a1", "a2"]);
  const verbs: Array<[string, () => unknown]> = [
    ["keys", () => api.keys("gone", ["Enter"])],
    ["read", () => api.read("gone", 10)],
    ["output", () => api.output("gone")],
    ["rename", () => api.rename("gone", "x")],
    ["connect from it", () => api.connect("gone", "a1")],
    ["connect to it", () => api.connect("a1", "gone")],
    ["disconnect", () => api.disconnect("gone")],
    ["focus", () => api.focus("gone")],
  ];
  for (const [verb, run] of verbs) assert.deepEqual([verb, await failure(run)], [verb, "NOT_FOUND"]);
  assert.equal(api.send("gone", "hi"), false);
  // The same verbs on open tiles go through.
  assert.equal(await failure(() => api.connect("a1", "a2")), "done");
  assert.equal(await failure(() => api.focus("a1")), "done");
});
