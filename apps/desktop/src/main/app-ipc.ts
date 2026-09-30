/**
 * The channels the app's windows call main on (R7). A call is answered only when it comes from the
 * main frame of one of the app's windows: never from a page a tile shows (a browser tile's
 * webview, a view's iframe) nor from any other window. Every channel main listens on is
 * registered through here.
 */
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { appWindowOf } from "./windows.js";

/** The call comes from the main frame of one of the app's windows. */
function fromAppWindow(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const win = appWindowOf(e.sender);
  return win !== null && e.senderFrame === win.webContents.mainFrame;
}

/** A request (`ipcRenderer.invoke`). One from anywhere else is rejected. */
export function handle<A extends unknown[]>(channel: string, fn: (e: IpcMainInvokeEvent, ...args: A) => unknown): void {
  ipcMain.handle(channel, (e, ...args) => {
    if (!fromAppWindow(e)) throw new Error(`${channel} answers the app's windows only`);
    return fn(e, ...(args as A));
  });
}

/** A message (`ipcRenderer.send`). One from anywhere else is dropped. */
export function on<A extends unknown[]>(channel: string, fn: (e: IpcMainEvent, ...args: A) => void): void {
  ipcMain.on(channel, (e, ...args) => {
    if (fromAppWindow(e)) fn(e, ...(args as A));
  });
}

/** A synchronous request (`ipcRenderer.sendSync`), answered with what `run` returns: null when
 *  it throws (which is logged), and for a call from anywhere else. */
export function answer<A extends unknown[]>(channel: string, run: (e: IpcMainEvent, ...args: A) => unknown): void {
  ipcMain.on(channel, (e, ...args) => {
    if (!fromAppWindow(e)) {
      e.returnValue = null;
      return;
    }
    try {
      e.returnValue = run(e, ...(args as A)) ?? null;
    } catch (err) {
      console.warn(`[ipc] ${channel}:`, err);
      e.returnValue = null;
    }
  });
}
