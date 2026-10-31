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
  assert.equal(api.send("gone", "hi").sent, false);
  // The same verbs on open tiles go through.
  assert.equal(await failure(() => api.connect("a1", "a2")), "done");
  assert.equal(await failure(() => api.focus("a1")), "done");
});

test("read gives a turn's reply when the turn ends, though work it started goes on, says so, and the next read waits for what comes of it", async () => {
  const { api, plane } = await controlOver(["a1"]);
  const alive = setInterval(() => {}, 1000);
  after(() => clearInterval(alive));
  const hook = (event: string, more: object = {}) => plane.event("agent.event", { tileId: "hm:a1", event, ...more });
  const replies = (text: string) => plane.event("agent.reply", { tileId: "hm:a1", text });
  const settle = () => new Promise((r) => setTimeout(r, 600));
  assert.equal(api.send("a1", "run the workflow").sent, true);
  await settle();
  hook("turn.started");
  const reading = api.read("a1", 3000);
  replies("started a workflow");
  hook("turn.ended", { background: 1, awaiting: 1 });
  const first = await reading;
  assert.deepEqual([first.finalStatus, first.text, first.awaiting], ["turn", "started a workflow", 1]);
  assert.match(first.note ?? "", /still waiting on 1 background task/);

  const without = await api.read("a1", 0);
  assert.deepEqual([without.finalStatus, without.text, without.awaiting], ["working", null, undefined], "not idle: more is coming");

  const next = api.read("a1", 3000);
  hook("turn.started");
  replies("the workflow found 3 bugs");
  hook("turn.ended");
  const second = await next;
  assert.deepEqual([second.finalStatus, second.text, second.awaiting, second.note], ["turn", "the workflow found 3 bugs", undefined, undefined]);
});

test("read says what the turn's end said of the work left, though its host's status comes on another connection, later", async () => {
  const { api, plane } = await controlOver(["a1"]);
  const alive = setInterval(() => {}, 1000);
  after(() => clearInterval(alive));
  const status = (state: string, more: object = {}) => plane.fromMachine("agent.status", { tileId: "hm:a1", status: { state, subagents: [], background: 0, compacting: false, source: "hooks", since: 1, ...more } });
  status("working");
  const reading = api.read("a1", 3000);
  plane.event("agent.reply", { tileId: "hm:a1", text: "started a workflow" });
  plane.event("agent.event", { tileId: "hm:a1", event: "turn.ended", awaiting: 2 });
  const read = await reading;
  status("working", { awaiting: 2 });
  assert.deepEqual([read.text, read.awaiting], ["started a workflow", 2]);
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

  assert.equal(api.send("a1", "add the tests").sent, true);
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
