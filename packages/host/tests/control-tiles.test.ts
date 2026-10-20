// A tile the person names to the control plane (control/methods.ts, plane.ts) that is not open,
// closed or never opened, over a real workspace store: every verb that names one says it is not
// found, rather than doing nothing or waiting on a window; a message to it is not sent. A read of
// one that is open says what it can now, instead of waiting out its time.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setCatalog } from "@hivemind/agents";
import { readAgentManifest } from "@hivemind/agents/load";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import { Intents } from "@hivemind/workspace-host/intents";
import { WorkspaceStore } from "@hivemind/workspace-host/store";
import { newSeed } from "@hivemind/workspace-host/identity";
import { ControlPlane, type ControlPlaneOptions } from "../src/control/plane.ts";

const REPO = "/work/api";
setCatalog([(await readAgentManifest(path.join(import.meta.dirname, "../../hive-agents/tests/fixtures/published-agents/claude/agent.yaml"), { source: "user", requireDirMatch: true })).def!]);
after(() => setCatalog([]));

async function controlOver(tiles: string[], others: Array<{ id: string; kind: string }> = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "control-tiles-"));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workspaces = new WorkspaceStore({ dir, person: newSeed() });
  workspaces.setCore(REPO, {
    frames: [{ id: "f1", title: "api", workspacePath: REPO }],
    tiles: [...tiles.map((id) => ({ id, kind: "claude", label: "claude", cmd: "claude" })), ...others.map((t) => ({ ...t, label: t.kind }))],
    frameOf: Object.fromEntries([...tiles, ...others.map((t) => t.id)].map((t) => [t, "f1"])),
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
  return { api: await p.api(), plane: p };
}

const failure = async (run: () => unknown): Promise<string> => {
  try { await run(); return "done"; } catch (e) { return (e as { code?: string }).code ?? String(e); }
};

test("a tile that is not open is not found by every verb that names it, at either end of a pipe; a message to it is not sent", async () => {
  const { api } = await controlOver(["a1", "a2"]);
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

test("read says an agent sent nothing since its last reply is idle at once, a busy one read without waiting is working, and a tile that runs no agent has none", async () => {
  const { api, plane } = await controlOver(["a1"], [{ id: "web", kind: "browser" }]);
  // The host's own waits hold no event loop open; a socket does, out of tests.
  const alive = setInterval(() => {}, 1000);
  after(() => clearInterval(alive));
  const hook = (event: string) => plane.event("agent.event", { tileId: "hm:a1", event });
  const replies = (text: string) => plane.event("agent.reply", { tileId: "hm:a1", text });
  const settle = () => new Promise((r) => setTimeout(r, 600));
  const said = async (wait: number) => {
    const began = Date.now();
    const r = await api.read("a1", wait);
    return { status: r.finalStatus, text: r.text, at_once: Date.now() - began < 1000 };
  };
  hook("turn.started");
  replies("ready");
  hook("turn.ended");
  await settle();
  assert.deepEqual(await said(3000), { status: "idle", text: null, at_once: true });

  assert.equal(api.send("a1", "add the tests"), true);
  await settle();
  hook("turn.started");
  assert.deepEqual(await said(0), { status: "working", text: null, at_once: true });
  assert.deepEqual(await said(50), { status: "timeout", text: null, at_once: true });
  replies("tests added");
  hook("turn.ended");
  assert.deepEqual(await said(3000), { status: "turn", text: "tests added", at_once: true });
  await settle();
  assert.deepEqual(await said(3000), { status: "idle", text: null, at_once: true });

  assert.equal(await failure(() => api.read("web", 3000)), "NO_AGENT");
});
