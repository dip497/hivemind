/**
 * The channels the app's windows call main on (R7). A call is answered only when it comes from the
 * main frame of one of the app's windows, or from a browser tab signed in to the browser server
 * (docs/design/browser-app-2026-10-13.md): never from a page a tile shows (a browser tile's
 * webview, a view's iframe) nor from any other window. Every channel main listens on is
 * registered through here, and a tab may use every one but those registered `local`: what only a
 * window on this machine can do. One with an effect on the workspace or the machine (tiles, files,
 * git, issues, settings, installs, machines) is carried out through the host's intents, as the
 * person at the window, and recorded in the audit log.
 */
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from "electron";
import type { Actor, Intent } from "@hivemind/workspace-host/intents";
import type { Asks } from "@hivemind/workspace-api/server";
import type { Tab, TabChannels } from "./browser-server.js";
import { appWindowOf } from "./windows.js";
import { hostIntents } from "./audit.js";

/** Who calls from the app's windows. */
export const PERSON: Actor = { kind: "person" };

/** The call comes from the main frame of one of the app's windows. */
function fromAppWindow(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const win = appWindowOf(e.sender);
  return win !== null && e.senderFrame === win.webContents.mainFrame;
}

/** Who a channel's call came from: one of the app's windows, or a browser tab. */
export interface Caller { sender: WebContents | Tab }

/** Only a window on this machine may use the channel. */
interface Local { local: true }

const served = new Map<string, { invoke?: (e: Caller, args: unknown[]) => unknown; send?: (e: Caller, args: unknown[]) => void }>();

/** The channels a browser tab may use, answered by the same handlers as a window's. */
export const tabChannels: TabChannels = {
  served: () => [...served.keys()],
  invoke: (channel, tab, args) => {
    const run = served.get(channel)?.invoke;
    if (!run) throw new Error(`${channel} is not a request`);
    return run({ sender: tab }, args);
  },
  send: (channel, tab, args) => served.get(channel)?.send?.({ sender: tab }, args),
};

/** A request (`ipcRenderer.invoke`). One from anywhere else is rejected. */
export function handle<A extends unknown[]>(channel: string, fn: (e: Caller, ...args: A) => unknown): void;
export function handle<A extends unknown[]>(channel: string, fn: (e: IpcMainInvokeEvent, ...args: A) => unknown, only: Local): void;
export function handle<A extends unknown[]>(channel: string, fn: (e: IpcMainInvokeEvent, ...args: A) => unknown, only?: Local): void {
  ipcMain.handle(channel, (e, ...args) => {
    if (!fromAppWindow(e)) throw new Error(`${channel} answers the app's windows only`);
    return fn(e, ...(args as A));
  });
  if (!only) served.set(channel, { invoke: (e, args) => (fn as (e: Caller, ...args: A) => unknown)(e, ...(args as A)) });
}

/** A message (`ipcRenderer.send`). One from anywhere else is dropped. */
export function on<A extends unknown[]>(channel: string, fn: (e: Caller, ...args: A) => void): void;
export function on<A extends unknown[]>(channel: string, fn: (e: IpcMainEvent, ...args: A) => void, only: Local): void;
export function on<A extends unknown[]>(channel: string, fn: (e: IpcMainEvent, ...args: A) => void, only?: Local): void {
  ipcMain.on(channel, (e, ...args) => {
    if (fromAppWindow(e)) fn(e, ...(args as A));
  });
  if (!only) served.set(channel, { send: (e, args) => (fn as (e: Caller, ...args: A) => void)(e, ...(args as A)) });
}

/** A request with an effect: carried out through the host's intents and recorded, as `asks`
 *  names it. */
export function handleEffect<A extends unknown[]>(channel: string, asks: (...args: any[]) => Asks, fn: (e: Caller, ...args: A) => unknown): void;
export function handleEffect<A extends unknown[]>(channel: string, asks: (...args: any[]) => Asks, fn: (e: IpcMainInvokeEvent, ...args: A) => unknown, only: Local): void;
export function handleEffect<A extends unknown[]>(channel: string, asks: (...args: any[]) => Asks, fn: (e: IpcMainInvokeEvent, ...args: A) => unknown, only?: Local): void {
  const run = (e: IpcMainInvokeEvent, ...args: A) => hostIntents().perform(PERSON, { verb: channel, ...asks(...args) }, () => fn(e, ...args));
  if (only) handle<A>(channel, run, only);
  else handle<A>(channel, run as (e: Caller, ...args: A) => unknown);
}

/** An effect a channel carries out only in some calls (a session a window starts rather than
 *  joins, one it ends rather than follows another's end of): through the host's intents and
 *  recorded, as the person at the window. */
export function performed<R>(intent: Intent<R>, run: () => R | Promise<R>): Promise<R> {
  return hostIntents().perform(PERSON, intent, run);
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
