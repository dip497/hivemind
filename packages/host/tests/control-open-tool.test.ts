// `hive ctl open-tool` (the API's `tool.open`) picks a tool by its id, or by its plugin's id: a plugin
// of one tool opens that tool, one of several opens the tool it marks main, and one of several with no
// main one is refused with the ids to name. Code is such a plugin: Code is its main tool, beside Files
// and Changes (docs/design/code-tools-2026-11-02.md §3.1), so `open-tool @hivemind/code` keeps opening
// Code as it did when it was the plugin's only tool.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import { Intents } from "@hivemind/workspace-host/intents";
import { WorkspaceStore } from "@hivemind/workspace-host/store";
import { newSeed } from "@hivemind/workspace-host/identity";
import type { ToolPluginContribution } from "@hivemind/core/tool-registry";
import { ControlPlane, type ControlPlaneOptions } from "../src/control/plane.ts";

const REPO = "/work/shop";

function plane(added: ToolPluginContribution[] = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "control-open-tool-"));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workspaces = new WorkspaceStore({ dir, person: newSeed() });
  workspaces.setCore(REPO, { frames: [{ id: "f1", title: "shop", workspacePath: REPO }], tiles: [], tileNames: {}, editorTabs: {}, frameOf: {} });
  const p = new ControlPlane({
    dir: () => dir,
    publish: () => {},
    spawned: () => {},
    windowsUp: () => false,
    write: () => false,
    signalsTurns: () => true,
    methods: () => ({
      workspaces,
      shownWorkspace: () => null,
      launchOptions: () => ({}),
      intents: new Intents(new AuditLog({ file: path.join(dir, "audit.jsonl") })),
      callRenderer: async () => { throw new Error("no window"); },
      reloadSettings: async () => ({}),
      addedTools: async () => added,
      // Every plugin on: what is refused here is refused for its id, not for being off.
      toolsSettings: (installed: readonly ToolPluginContribution[]) => ({ enabledPlugins: installed.map((x) => x.id), disabledTools: [] }),
    }),
  } as unknown as ControlPlaneOptions);
  const kindOf = (tile: string) => workspaces.getCore(REPO)?.tiles.find((t) => t.id === tile)?.kind;
  return { p, kindOf };
}

test("a plugin's own id opens its main tool, a tool's id that tool, and a plugin of several with none marked main is refused with the ids", async () => {
  const several: ToolPluginContribution = { id: "@acme/ci", tools: [{ key: "runs", label: "Runs", tileKind: "acme-runs" }, { key: "logs", label: "Logs", tileKind: "acme-logs" }] };
  const { p, kindOf } = plane([several]);
  const api = await p.api();
  assert.equal(kindOf(await api.openTool(undefined, REPO, "@hivemind/code", { frame: "f1" })), "editor");
  assert.equal(kindOf(await api.openTool(undefined, REPO, "@hivemind/code/files", { frame: "f1" })), "files");
  assert.equal(kindOf(await api.openTool(undefined, REPO, "@hivemind/code/changes", { frame: "f1" })), "changes");
  await assert.rejects(api.openTool(undefined, REPO, "@acme/ci", { frame: "f1" }), /@acme\/ci has 2 tools; name one: @acme\/ci\/runs, @acme\/ci\/logs/);
  assert.equal(kindOf(await api.openTool(undefined, REPO, "@acme/ci/logs", { frame: "f1" })), "acme-logs");
});
