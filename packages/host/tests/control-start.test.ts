// Agents started through the control plane (control/methods.ts, plane.ts): each caller has its own
// limit of starts a minute, so one program at its limit leaves the person and other programs free,
// and a start refused for what it asks uses none of it.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENT_MANIFEST_VERSION, defFromManifest, setCatalog } from "@hivemind/agents";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import { Intents } from "@hivemind/workspace-host/intents";
import { WorkspaceStore } from "@hivemind/workspace-host/store";
import { newSeed } from "@hivemind/workspace-host/identity";
import { ControlPlane, type ControlPlaneOptions } from "../src/control/plane.ts";

const caps = { promptDelivery: "typed", turnSignal: false, resume: "none", supervise: "human", blockedDetection: false } as const;
setCatalog([defFromManifest({ manifestVersion: AGENT_MANIFEST_VERSION, id: "acme", label: "Acme", bin: "acme", enabled: true, caps })]);
after(() => setCatalog([]));

const REPO = "/work/api";

function plane() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "control-start-"));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workspaces = new WorkspaceStore({ dir, person: newSeed() });
  workspaces.setCore(REPO, { frames: [{ id: "f1", title: "api", workspacePath: REPO }], tiles: [], tileNames: {}, editorTabs: {}, frameOf: {} });
  return new ControlPlane({
    dir: () => dir,
    publish: () => {},
    spawned: () => {},
    windowsUp: () => false,
    write: () => true,
    signalsTurns: () => true,
    methods: () => ({
      workspaces,
      shownWorkspace: () => null,
      launchOptions: () => ({}),
      intents: new Intents(new AuditLog({ file: path.join(dir, "audit.jsonl") })),
      callRenderer: async () => { throw new Error("no window"); },
      reloadSettings: async () => ({}),
    }),
  } as unknown as ControlPlaneOptions);
}

const code = (p: Promise<unknown>) => p.then(() => "started", (e: { code?: string }) => e.code ?? String(e));

test("a program at its limit of 16 starts a minute is refused, while the person and another program still start agents", async () => {
  const p = plane();
  for (let i = 0; i < 16; i++) assert.equal(await code(p.start(REPO, { program: "acme", parent: "client:busy" })), "started");
  assert.equal(await code(p.start(REPO, { program: "acme", parent: "client:busy" })), "RATE_LIMITED");
  assert.equal(await code(p.start(REPO, { program: "acme" })), "started");
  assert.equal(await code(p.start(REPO, { program: "acme", parent: "client:other" })), "started");
});

test("a start refused for what it asks uses none of the caller's limit", async () => {
  const p = plane();
  for (let i = 0; i < 20; i++) assert.equal(await code(p.start(REPO, { program: "nothing-installed", parent: "client:typo" })), "BAD_REQUEST");
  assert.equal(await code(p.start(REPO, { program: "acme", parent: "client:typo" })), "started");
});
