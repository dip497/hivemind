/**
 * Main's side of the workspace store (docs/design/multiplayer-2026-09-28.md, R1, R5, R15): the
 * app's one `WorkspaceStore`, under `<userData>/workspaces`, the synchronous IPC the window uses,
 * telling each window what another writer changed, and knowing which workspace each window
 * shows (for the control plane, when its caller is in no tile).
 *
 * Only transport lives here. The store checks every argument and writes each change through,
 * so a handler forwards what it was sent and always answers: a synchronous request left
 * unanswered would hang the window. A window writes as `window:<its web contents' id>`, and
 * main's own writers (the control plane) as themselves; every window but the writer hears of a
 * change, and one not showing that workspace ignores it. `flushWorkspaceStore` retries failed
 * writes on quit, because `app.exit` skips every later handler.
 */
import path from "node:path";
import { app, BrowserWindow, ipcMain, type IpcMainEvent, type WebContents } from "electron";
import { WorkspaceStore, type LegacyLayout, type ViewLayout } from "@hivemind/workspace-host/store";

let store: WorkspaceStore | null = null;
/** The workspace each window shows, and the frame the user is in there, by its web contents' id. */
const shown = new Map<number, { repo: string; frame: string | null }>();

const writerOf = (wc: WebContents): string => `window:${wc.id}`;

/** The app's one store: the window's, through the IPC below, and main's own writers'. */
export function workspaceStore(): WorkspaceStore {
  return (store ??= new WorkspaceStore({
    dir: path.join(app.getPath("userData"), "workspaces"),
    onWarn: (m) => console.warn(`[workspace-store] ${m}`),
    onChange: ({ repo, part, writer }) => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (w.isDestroyed() || writerOf(w.webContents) === writer) continue;
        try { w.webContents.send("workspace:changed", { repo, part }); } catch { /* torn down */ }
      }
    },
  }));
}

/** Answer a synchronous request with what `run` returns, or null when it throws. */
function answer(channel: string, run: (e: IpcMainEvent, ...args: unknown[]) => unknown): void {
  ipcMain.on(channel, (e, ...args: unknown[]) => {
    try {
      e.returnValue = run(e, ...args) ?? null;
    } catch (err) {
      console.warn(`[workspace-store] ${channel}:`, err);
      e.returnValue = null;
    }
  });
}

export function installWorkspaceStoreIpc(): void {
  const s = workspaceStore();
  const from = (e: IpcMainEvent) => ({ writer: writerOf(e.sender) });
  // Cast, not checked: the store refuses a bad argument with a TypeError.
  answer("workspace:core-sync", (_e, repo) => s.getCore(repo as string));
  answer("workspace:view-sync", (_e, repo, viewId) => s.getView(repo as string, viewId as string));
  answer("workspace:set-core-sync", (e, repo, core, base) => s.setCore(repo as string, core, { ...from(e), base }));
  answer("workspace:set-view-sync", (e, repo, viewId, layout) => s.setView(repo as string, viewId as string, layout as ViewLayout, from(e)));
  answer("workspace:import-sync", (_e, repo, legacy) => s.importLegacy(repo as string, legacy as LegacyLayout));
  answer("workspace:objects-sync", (_e, repo) => s.getObjects(repo as string));
  answer("workspace:set-objects-sync", (e, repo, objects) => s.setObjects(repo as string, objects, from(e)));
  answer("workspace:undo-sync", (e, repo) => s.undo(repo as string, from(e)));
  answer("workspace:redo-sync", (e, repo) => s.redo(repo as string, from(e)));
  ipcMain.on("workspace:shown", (e, repo: unknown, frame: unknown) => {
    const id = e.sender.id;
    if (!shown.has(id)) e.sender.once("destroyed", () => shown.delete(id));
    if (typeof repo === "string" && repo) shown.set(id, { repo, frame: typeof frame === "string" && frame ? frame : null });
    else shown.delete(id);
  });
}

/** The workspace the window the user is at shows, and the frame the user is in there: the
 *  focused window's, else any window's. */
export function shownWorkspace(): { repo: string; frame: string | null } | null {
  const focused = BrowserWindow.getFocusedWindow();
  const mine = focused ? shown.get(focused.webContents.id) : undefined;
  return mine ?? shown.values().next().value ?? null;
}

/** Retry writes that failed. Safe to call more than once, and before the store exists. */
export function flushWorkspaceStore(): void {
  try { store?.flush(); } catch (err) { console.warn("[workspace-store] flush failed:", err); }
}
