/**
 * The workspace side of the control plane's dependencies, for tests of its dispatch
 * (src/main/hcp/methods.ts): a real store with one workspace open and shown in the user's
 * window, a real status store, no saved launch options, a record of every spawn the windows
 * would have been told of, and the host's intents writing a real audit log (`audited()` reads
 * it back).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StatusStore } from "@hivemind/agent-host/status-store";
import { WorkspaceStore } from "@hivemind/workspace-host/store";
import { Intents, type AuditRecord } from "@hivemind/workspace-host/intents";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import type { HcpSpawnedEvent } from "../../src/shared/ipc.ts";

export const REPO = "/work/repo";

export function workspaceDeps() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hcp-ws-"));
  const workspaces = new WorkspaceStore({ dir });
  const audit = path.join(dir, "audit.jsonl");
  workspaces.setCore(REPO, { frames: [{ id: "f1", title: "repo", workspacePath: REPO }], tiles: [] });
  const announced: HcpSpawnedEvent[] = [];
  return {
    workspaces,
    status: new StatusStore(),
    shownWorkspace: () => ({ repo: REPO, frame: null }),
    launchOptions: () => ({}),
    announceSpawn: (spawn: HcpSpawnedEvent) => void announced.push(spawn),
    endSession: () => {},
    sessionHeld: () => false,
    intents: new Intents(new AuditLog({ file: audit })),
    announced,
    audited: (): AuditRecord[] =>
      fs.existsSync(audit) ? fs.readFileSync(audit, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [],
  };
}
