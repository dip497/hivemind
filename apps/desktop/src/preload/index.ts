/// <reference lib="dom" />
import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { HiveApi } from "../shared/ipc.js";
import { hiveOverIpc, workspaceOver, type IpcPort } from "../shared/hive-ipc.js";

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
};

// A native agent notification was clicked → focus that tile on the canvas.
// Bridge the IPC to the same CustomEvent the canvas already uses for fly-to.
ipcRenderer.on("notify:focus-tile", (_e, tileId: string) => {
  window.dispatchEvent(new CustomEvent<string>("hivemind:focus-tile", { detail: tileId }));
});

contextBridge.exposeInMainWorld("hive", api);
