import { app, type BrowserWindow } from "electron";

/** A window that loses its GPU or renderer process draws nothing and never recovers by itself (a
 *  laptop resumed from suspend can lose the GPU process). Reloading brings it back, and terminals
 *  live in the daemon, so nothing is lost. One reload at a time, at most `max` a minute, so a
 *  window that crashes as it loads cannot spin. */
export function recoverOnProcessLoss(win: BrowserWindow, max = 3): () => void {
  let pending = false;
  const recent: number[] = [];
  const reload = (why: string) => {
    if (win.isDestroyed() || pending) return;
    const now = Date.now();
    while (recent.length && now - recent[0]! > 60_000) recent.shift();
    if (recent.length >= max) { console.warn(`[recover] ${why}: not reloading again this minute`); return; }
    recent.push(now);
    pending = true;
    console.warn(`[recover] ${why}: reloading the window`);
    win.webContents.reload();
  };
  const onLoaded = () => { pending = false; };
  const onChild = (_e: Electron.Event, d: Electron.Details) => {
    if (d.type === "GPU" && d.reason !== "clean-exit") reload(`GPU process ${d.reason}`);
  };
  const onRender = (_e: Electron.Event, d: Electron.RenderProcessGoneDetails) => {
    if (d.reason !== "clean-exit") reload(`renderer ${d.reason}`);
  };
  app.on("child-process-gone", onChild);
  win.webContents.on("render-process-gone", onRender);
  win.webContents.on("did-finish-load", onLoaded);
  return () => {
    app.off("child-process-gone", onChild);
    if (win.isDestroyed()) return;
    win.webContents.off("render-process-gone", onRender);
    win.webContents.off("did-finish-load", onLoaded);
  };
}
