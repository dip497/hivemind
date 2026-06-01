/**
 * Native OS notifications for agents that need you.
 *
 * Signal source: the renderer's agent-status bus (agent-status-bus.ts), the
 * same state machine that already drives the in-app chips + toasts. It is
 * multi-agent (15 CLIs, not just claude), transition-deduped (only real state
 * changes emit), and detects "finished" (working→idle) immediately — none of
 * which a single claude `Notification` hook gives you. The renderer forwards
 * each notable transition over IPC; we turn it into a native popup.
 *
 * We only notify when the window is NOT focused. If you're looking at hivemind,
 * the in-app toast/dot already has it and a native popup would be noise. The
 * renderer sends every notable transition; the focus gate lives HERE so it sees
 * the real window state (a blurred window the renderer can't observe).
 *
 * backgroundThrottling:false (see index.ts) keeps the renderer's detection poll
 * alive while the window is unfocused/minimized, so transitions are still
 * detected and forwarded when you're away — which is exactly when you need this.
 */
import { Notification, app, ipcMain, type BrowserWindow } from "electron";
import type { AgentNotice } from "../shared/ipc.js";
import { composeNotice } from "./agent-notify-core.js";

export { composeNotice } from "./agent-notify-core.js";

/** Register the `notify:agent` IPC → native Notification bridge. `getWin` is
 *  read lazily so it survives window recreation. Returns a disposer. */
export function registerAgentNotifications(getWin: () => BrowserWindow | null): () => void {
  const onNotice = (_e: unknown, raw: unknown): void => {
    const rec = raw as AgentNotice | null;
    const win = getWin();
    const focused = !!(win && !win.isDestroyed() && win.isFocused());
    const composed = rec && composeNotice(rec, focused);
    if (!composed) return;
    if (!Notification.isSupported()) return;

    const needs = rec!.kind === "needs";
    const n = new Notification({ ...composed });
    n.on("click", () => {
      const w = getWin();
      if (!w || w.isDestroyed()) return;
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
      try { w.webContents.send("notify:focus-tile", rec!.tileId); } catch { /* mid-teardown */ }
    });
    n.show();
    // Persistent attention until the user looks (cleared on window 'focus').
    try { win?.flashFrame(true); } catch { /* unsupported DE */ }
    try { app.dock?.bounce?.(needs ? "critical" : "informational"); } catch { /* macOS only */ }
  };

  ipcMain.on("notify:agent", onNotice);
  return () => { ipcMain.removeListener("notify:agent", onNotice); };
}
