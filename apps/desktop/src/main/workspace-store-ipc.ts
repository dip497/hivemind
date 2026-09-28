/**
 * Main's side of the workspace store (docs/design/multiplayer-2026-09-28.md, R1): the one
 * `WorkspaceStore` for this app, its IPC, and a flush on every way the app can exit.
 *
 * The window reads a workspace's layout synchronously when it builds its first state, and
 * writes debounced snapshots; both use `sendSync`, so a write made while the window unloads
 * is stored before the window goes away. The store writes to disk on its own debounce, and
 * `flushWorkspaceStore` is called on quit, because `app.exit` skips every later handler.
 */
import path from "node:path";
import { app, ipcMain, type WebContents } from "electron";
import { WorkspaceStore, type ViewEnvelope } from "@hivemind/workspace-host/store";
import type { WorkspaceImportResult, WorkspaceLegacyLayout } from "../shared/ipc.js";

let store: WorkspaceStore | null = null;

/** The app's workspace store, created on first use under `<userData>/workspaces`. */
export function workspaceStore(): WorkspaceStore {
  store ??= new WorkspaceStore({
    dir: path.join(app.getPath("userData"), "workspaces"),
    onWarn: (m) => console.warn(`[workspace-store] ${m}`),
  });
  return store;
}

/** Which window wrote a change, so a second window can mirror it without an echo (R5). */
const originOf = (sender: WebContents): string => `window:${sender.id}`;

const validRepo = (repo: unknown): repo is string => typeof repo === "string" && repo.length > 0;

export function installWorkspaceStoreIpc(): void {
  const s = workspaceStore();
  ipcMain.on("workspace:core-sync", (e, repo: unknown) => {
    try { e.returnValue = validRepo(repo) ? s.getCore(repo) : null; } catch (err) {
      console.warn("[workspace-store] core read failed:", err);
      e.returnValue = null;
    }
  });
  ipcMain.on("workspace:view-sync", (e, repo: unknown, viewId: unknown) => {
    try { e.returnValue = validRepo(repo) && typeof viewId === "string" ? s.getView(repo, viewId) : null; } catch (err) {
      console.warn("[workspace-store] view read failed:", err);
      e.returnValue = null;
    }
  });
  ipcMain.on("workspace:set-core-sync", (e, repo: unknown, core: unknown) => {
    try { if (validRepo(repo)) s.setCore(repo, core, originOf(e.sender)); } catch (err) {
      console.warn("[workspace-store] core write failed:", err);
    }
    e.returnValue = true;
  });
  ipcMain.on("workspace:set-view-sync", (e, repo: unknown, viewId: unknown, env: unknown) => {
    try { if (validRepo(repo) && typeof viewId === "string") s.setView(repo, viewId, env as ViewEnvelope, originOf(e.sender)); } catch (err) {
      console.warn("[workspace-store] view write failed:", err);
    }
    e.returnValue = true;
  });
  ipcMain.on("workspace:import-sync", (e, repo: unknown, legacy: unknown) => {
    const none: WorkspaceImportResult = { core: false, views: [] };
    try {
      e.returnValue = validRepo(repo) && legacy && typeof legacy === "object"
        ? s.importLegacy(repo, legacy as WorkspaceLegacyLayout, originOf(e.sender))
        : none;
    } catch (err) {
      console.warn("[workspace-store] import failed:", err);
      e.returnValue = none;
    }
  });
}

/** Write everything pending now. Safe to call more than once and before the store exists. */
export function flushWorkspaceStore(): void {
  try { store?.flush(); } catch (err) { console.warn("[workspace-store] flush failed:", err); }
}
