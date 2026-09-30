/**
 * The workspace store on Electron (docs/design/multiplayer-2026-09-28.md, R1, R5, R15, R8): the
 * app's one `WorkspaceStore`, under `<userData>/workspaces`, and the synchronous channels a
 * window reads and writes it on, so it builds its first state in one pass and a save made while
 * it unloads is kept. What each channel answers is the workspace API's (`workspace/store.ts`), as
 * the window's own connection: a window writes as itself, and every other window is told of its
 * change (`store.changed`). A channel always answers, null for what the API refuses, because a
 * synchronous request left unanswered would hang the window. `flushWorkspaceStore` retries failed
 * writes on quit, because `app.exit` skips every later handler.
 */
import path from "node:path";
import { app, type IpcMainEvent, type WebContents } from "electron";
import type { Connection } from "@hivemind/workspace-api/server";
import { WorkspaceStore, type WorkspaceChange } from "@hivemind/workspace-host/store";
import { answer } from "./app-ipc.js";
import type { Layouts } from "./workspace/store.js";

let store: WorkspaceStore | null = null;
/** Who hears of each change: set when the channels are installed. */
let tell: (change: WorkspaceChange) => void = () => {};

/** The app's one store: the windows', and main's own writers' (the control plane). */
export function workspaceStore(): WorkspaceStore {
  return (store ??= new WorkspaceStore({
    dir: path.join(app.getPath("userData"), "workspaces"),
    onWarn: (m) => console.warn(`[workspace-store] ${m}`),
    onChange: (change) => tell(change),
  }));
}

/** Serve the store's synchronous channels from `layouts`, each window as its `connection`, and
 *  hand each change the store makes to `changed`. */
export function installWorkspaceStoreIpc(layouts: Layouts, connection: (window: WebContents) => Connection, changed: (change: WorkspaceChange) => void): void {
  tell = changed;
  const { answers } = layouts.domain;
  const as = (e: IpcMainEvent) => connection(e.sender);
  answer("workspace:core-sync", (e, repo) => answers["store.core"](as(e), repo));
  answer("workspace:view-sync", (e, repo, viewId) => answers["store.view"](as(e), repo, viewId));
  answer("workspace:objects-sync", (e, repo) => answers["store.objects"](as(e), repo));
  answer("workspace:set-core-sync", (e, repo, core, base) => answers["store.setCore"](as(e), repo, core, base));
  answer("workspace:set-view-sync", (e, repo, viewId, layout, base) => answers["store.setView"](as(e), repo, viewId, layout, base));
  answer("workspace:set-objects-sync", (e, repo, objects, base) => answers["store.setObjects"](as(e), repo, objects, base));
  answer("workspace:import-sync", (e, repo, legacy) => answers["store.import"](as(e), repo, legacy));
  answer("workspace:undo-sync", (e, repo) => answers["store.undo"](as(e), repo));
  answer("workspace:redo-sync", (e, repo) => answers["store.redo"](as(e), repo));
}

/** Retry writes that failed. Safe to call more than once, and before the store exists. */
export function flushWorkspaceStore(): void {
  try { store?.flush(); } catch (err) { console.warn("[workspace-store] flush failed:", err); }
}
