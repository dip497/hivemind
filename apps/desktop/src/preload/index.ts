/// <reference lib="dom" />
import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { HiveApi } from "../shared/ipc.js";
import { hiveOverIpc, workspaceOver, type IpcPort } from "../shared/hive-ipc.js";
import { APP_PAGE_ARG, isAppPage } from "../shared/app-page.js";

/** Main's channels over Electron IPC: a window is answered on every one of them. */
const port: IpcPort = {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  sendSync: (channel, ...args) => ipcRenderer.sendSync(channel, ...args),
  on: (channel, listener) => {
    const h = (_e: Electron.IpcRendererEvent, ...args: unknown[]) => listener(...args);
    ipcRenderer.on(channel, h);
    return () => { ipcRenderer.removeListener(channel, h); };
  },
  serves: () => true,
};

const api: HiveApi = {
  ...hiveOverIpc(port, workspaceOver(port)),
  platform: process.platform,
  // webUtils.getPathForFile is the supported way to get a dropped/picked File's
  // absolute path under contextIsolation (File.path was removed). Used to build
  // the persistent hm-media:// video-wallpaper URL.
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  resourceUrl: (url) => url,
};

// Only the app's own page gets the bridge: any other document in this window gets nothing.
const appPage = process.argv.find((a) => a.startsWith(APP_PAGE_ARG))?.slice(APP_PAGE_ARG.length);
if (appPage && isAppPage(location.href, appPage)) {
  // A native agent notification was clicked → focus that tile on the canvas.
  // Bridge the IPC to the same CustomEvent the canvas already uses for fly-to.
  ipcRenderer.on("notify:focus-tile", (_e, tileId: string) => {
    window.dispatchEvent(new CustomEvent<string>("hivemind:focus-tile", { detail: tileId }));
  });

  // An error crossing to the page keeps only its message, so a call's promise crosses settled and the
  // page throws it again there with its `code` (NOT_FOUND, UNSUPPORTED …), which callers decide on.
  const settled = (out: unknown): unknown => (out instanceof Promise
    ? out.then((value: unknown) => ({ value }), (e: unknown) => {
      const code = (e as { code?: unknown } | null)?.code;
      return { failed: { message: e instanceof Error ? e.message : String(e), ...(typeof code === "string" ? { code } : {}) } };
    })
    : out);
  const bridged = Object.fromEntries(Object.entries(api).map(([k, v]) => [k, typeof v === "function" ? (...a: unknown[]) => settled((v as (...a: unknown[]) => unknown)(...a)) : v]));
  contextBridge.executeInMainWorld({
    func: (bridge: Record<string, unknown>) => {
      type Settled = { value?: unknown; failed?: { message: string; code?: string } };
      const hive: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(bridge)) {
        hive[k] = typeof v !== "function" ? v : (...a: unknown[]) => {
          const out = (v as (...a: unknown[]) => unknown)(...a);
          if (!out || typeof (out as Promise<unknown>).then !== "function") return out;
          return (out as Promise<Settled>).then((s) => {
            if (s.failed) throw Object.assign(new Error(s.failed.message), s.failed.code ? { code: s.failed.code } : {});
            return s.value;
          });
        };
      }
      Object.defineProperty(window, "hive", { value: Object.freeze(hive), enumerable: true });
    },
    args: [bridged],
  });
}
