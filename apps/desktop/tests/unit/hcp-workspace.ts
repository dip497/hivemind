/**
 * The workspace side of the control plane's dependencies, for tests of its dispatch
 * (src/main/hcp/methods.ts): a real store with one workspace open and shown in the user's
 * window, a real status store, no saved launch options, and a record of every spawn the
 * windows would have been told of.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StatusStore } from "@hivemind/agent-host/status-store";
import { WorkspaceStore } from "@hivemind/workspace-host/store";
import type { HcpSpawnedEvent } from "../../src/shared/ipc.ts";

export const REPO = "/work/repo";

export function workspaceDeps() {
  const workspaces = new WorkspaceStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "hcp-ws-")) });
  workspaces.setCore(REPO, { frames: [{ id: "f1", title: "repo", workspacePath: REPO }], tiles: [] });
  const announced: HcpSpawnedEvent[] = [];
  return {
    workspaces,
    status: new StatusStore(),
    shownWorkspace: () => ({ repo: REPO, frame: null }),
    launchOptions: () => ({}),
    announceSpawn: (spawn: HcpSpawnedEvent) => void announced.push(spawn),
    endSession: () => {},
    announced,
  };
}
