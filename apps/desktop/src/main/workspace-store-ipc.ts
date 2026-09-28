/**
 * Main's side of the workspace store (docs/design/multiplayer-2026-09-28.md, R1): the app's one
 * `WorkspaceStore`, under `<userData>/workspaces`, and the synchronous IPC the window uses.
 *
 * Only transport lives here. The store checks every argument and writes each change through,
 * so a handler forwards what it was sent and always answers: a synchronous request left
 * unanswered would hang the window. `flushWorkspaceStore` retries failed writes on quit,
 * because `app.exit` skips every later handler.
 */
import path from "node:path";
import { app, ipcMain } from "electron";
import { WorkspaceStore, type LegacyLayout, type ViewLayout } from "@hivemind/workspace-host/store";

let store: WorkspaceStore | null = null;

/** Answer a synchronous request with what `run` returns, or null when it throws. */
function answer(channel: string, run: (...args: unknown[]) => unknown): void {
  ipcMain.on(channel, (e, ...args: unknown[]) => {
    try {
      e.returnValue = run(...args) ?? null;
    } catch (err) {
      console.warn(`[workspace-store] ${channel}:`, err);
      e.returnValue = null;
    }
  });
}

export function installWorkspaceStoreIpc(): void {
  const s = (store ??= new WorkspaceStore({
    dir: path.join(app.getPath("userData"), "workspaces"),
    onWarn: (m) => console.warn(`[workspace-store] ${m}`),
  }));
  // Cast, not checked: the store refuses a bad argument with a TypeError.
  answer("workspace:core-sync", (repo) => s.getCore(repo as string));
  answer("workspace:view-sync", (repo, viewId) => s.getView(repo as string, viewId as string));
  answer("workspace:set-core-sync", (repo, core) => s.setCore(repo as string, core));
  answer("workspace:set-view-sync", (repo, viewId, layout) => s.setView(repo as string, viewId as string, layout as ViewLayout));
  answer("workspace:import-sync", (repo, legacy) => s.importLegacy(repo as string, legacy as LegacyLayout));
}

/** Retry writes that failed. Safe to call more than once, and before the store exists. */
export function flushWorkspaceStore(): void {
  try { store?.flush(); } catch (err) { console.warn("[workspace-store] flush failed:", err); }
}
