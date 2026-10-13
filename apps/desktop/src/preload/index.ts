/// <reference lib="dom" />
import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { HiveApi, HcpCommand, AppErrorEvent } from "../shared/ipc.js";
import { hiveOverWorkspace } from "../shared/hive-over-workspace.js";
import { WorkspaceClient } from "@hivemind/workspace-api/client";
import type { Answer, EventMessage } from "@hivemind/workspace-api/protocol";

/** The workspace API (R8): this window's connection to main, which answers its calls on one
 *  channel, takes its notices on another, and sends it events on a third. */
const workspace = new WorkspaceClient({
  call: (method, params) => ipcRenderer.invoke("workspace", method, params) as Promise<Answer>,
  notice: (method, params) => ipcRenderer.send("workspace:notice", method, params),
  events: (listener) => { ipcRenderer.on("workspace:event", (_e, message: EventMessage) => listener(message)); },
});


const api: HiveApi = {
  ...hiveOverWorkspace(workspace),
  resolveProject: (rootHint) => ipcRenderer.invoke("resolveProject", rootHint),
  pickProjectFolder: () => ipcRenderer.invoke("pickProjectFolder"),
  initWorkspace: (dir, prefix) => ipcRenderer.invoke("initWorkspace", dir, prefix),
  installAgentic: (dir) => ipcRenderer.invoke("installAgentic", dir),

  listWorkspaces: () => ipcRenderer.invoke("listWorkspaces"),
  workspaceSummaries: () => ipcRenderer.invoke("workspaceSummaries"),
  resolveIssueRoot: (id) => ipcRenderer.invoke("resolveIssueRoot", id),



  openPathInApp: (cwd, target) => ipcRenderer.invoke("openPathInApp", cwd, target),

  diagLog: (line) => ipcRenderer.invoke("diagLog", line),

  machinesGet: () => ipcRenderer.invoke("machines:get"),
  onMachines: (cb) => {
    const listener = (_e: unknown, snap: Parameters<typeof cb>[0]) => cb(snap);
    ipcRenderer.on("machines:changed", listener);
    return () => ipcRenderer.removeListener("machines:changed", listener);
  },
  machineAdd: (req) => ipcRenderer.invoke("machines:add", req),
  machineCheck: (id) => ipcRenderer.invoke("machines:check", id),
  machineInstall: (id) => ipcRenderer.invoke("machines:install", id),
  machineUpdate: (id, patch) => ipcRenderer.invoke("machines:update", id, patch),
  machineEdit: (id, patch) => ipcRenderer.invoke("machines:edit", id, patch),
  viewLedgerAppend: (lines) => ipcRenderer.send("viewLedger:append", lines),
  viewLedgerSnapshot: () => ipcRenderer.invoke("viewLedger:snapshot"),
  viewHistory: (layoutKey, day) => ipcRenderer.invoke("viewLedger:history", layoutKey, day),
  presenceNow: () => ipcRenderer.invoke("presence:now"),
  onPresence: (cb) => {
    const listener = (_e: unknown, p: Parameters<typeof cb>[0]) => cb(p);
    ipcRenderer.on("presence:changed", listener);
    return () => ipcRenderer.removeListener("presence:changed", listener);
  },
  viewSharePrepare: (png) => ipcRenderer.invoke("viewShare:prepare", png),
  viewShareCommit: (token, action, suggestedName) => ipcRenderer.invoke("viewShare:commit", token, action, suggestedName),

  machineRemove: (id) => ipcRenderer.invoke("machines:remove", id),
  machineSetPassword: (id, password) => ipcRenderer.invoke("machines:set-password", id, password),
  machineSessions: (uri) => ipcRenderer.invoke("machines:sessions", uri),
  machineReconnect: (hostId) => ipcRenderer.invoke("machines:reconnect", hostId),
  sshListDir: (uri, dir) => ipcRenderer.invoke("sshListDir", uri, dir),



  notifyAgent: (notice) => ipcRenderer.send("notify:agent", notice),
  layersShown: (repo, shown) => ipcRenderer.send("layers:shown", repo, shown),
  recentFolders: (folders) => ipcRenderer.send("recent:folders", folders),

  getNotificationSettings: () => ipcRenderer.invoke("getNotificationSettings"),
  setNotificationSettings: (s) => ipcRenderer.invoke("setNotificationSettings", s),

  browserRegister: (tileId, webContentsId, frameId, url) =>
    ipcRenderer.send("browser:register", tileId, webContentsId, frameId, url),
  browserCdp: (tileId, method, params) =>
    ipcRenderer.invoke("browserCdp", tileId, method, params),
  getBrowserSettings: () => ipcRenderer.invoke("getBrowserSettings"),
  setBrowserCdpEnabled: (enabled) => ipcRenderer.invoke("setBrowserCdpEnabled", enabled),
  relaunchApp: () => ipcRenderer.invoke("relaunchApp"),
  identity: () => ipcRenderer.invoke("identity:get"),
  joinPreview: (text) => ipcRenderer.invoke("net:join-preview", text),
  join: (text) => ipcRenderer.invoke("net:join", text),
  joined: () => ipcRenderer.invoke("net:joined"),
  sharedStatus: (workspace) => ipcRenderer.invoke("net:shared-status", workspace),
  onSharedStatus: (cb) => {
    const h = (_e: Electron.IpcRendererEvent, workspace: string, status: Parameters<typeof cb>[1]) => cb(workspace, status);
    ipcRenderer.on("net:shared-status", h);
    return () => { ipcRenderer.removeListener("net:shared-status", h); };
  },
  sharedLooks: (workspace) => ipcRenderer.invoke("net:shared-looks", workspace),
  onSharedLooks: (cb) => {
    const h = (_e: Electron.IpcRendererEvent, workspace: string, appearance: Parameters<typeof cb>[1]) => cb(workspace, appearance);
    ipcRenderer.on("net:shared-looks", h);
    return () => { ipcRenderer.removeListener("net:shared-looks", h); };
  },
  leave: (workspace) => ipcRenderer.invoke("net:leave", workspace),
  machineGrant: (workspace) => ipcRenderer.invoke("net:machine-grant", workspace),
  setMachineGrant: (workspace, grant) => ipcRenderer.invoke("net:set-machine-grant", workspace, grant),
  handOff: (workspace, uri) => ipcRenderer.invoke("net:hand-off", workspace, uri),
  browserAppStatus: () => ipcRenderer.invoke("browserApp:status"),
  onBrowserAppChanged: (cb) => {
    const h = (_e: Electron.IpcRendererEvent, status: Parameters<typeof cb>[0]) => cb(status);
    ipcRenderer.on("browserApp:changed", h);
    return () => { ipcRenderer.removeListener("browserApp:changed", h); };
  },
  devices: () => ipcRenderer.invoke("net:devices"),
  onDevicesChanged: (cb) => {
    const h = () => cb();
    ipcRenderer.on("net:devices-changed", h);
    return () => { ipcRenderer.removeListener("net:devices-changed", h); };
  },
  pairOffer: () => ipcRenderer.invoke("net:pair-offer"),
  phonePage: (page) => ipcRenderer.invoke("net:phone-page", page),
  pairEnter: (text) => ipcRenderer.invoke("net:pair-enter", text),
  unpair: (device) => ipcRenderer.invoke("net:unpair", device),
  deviceWorkspaces: () => ipcRenderer.invoke("net:device-workspaces"),
  openDeviceWorkspace: (device, workspace, name) => ipcRenderer.invoke("net:open-device-workspace", device, workspace, name),
  moveHosting: (repo, device) => ipcRenderer.invoke("net:move-hosting", repo, device),
  folderHere: (workspace) => ipcRenderer.invoke("net:folder-here", workspace),
  moveHostingHere: (workspace) => ipcRenderer.invoke("net:move-hosting-here", workspace),
  takeOver: (workspace) => ipcRenderer.invoke("net:take-over", workspace),
  network: () => ipcRenderer.invoke("net:network"),
  networkHealth: () => ipcRenderer.invoke("net:network-health"),
  useNetwork: (given) => ipcRenderer.invoke("net:use-network", given),
  getAppVersion: () => ipcRenderer.invoke("getAppVersion"),
  settingsSync: () => ipcRenderer.sendSync("settings:get-sync"),
  workspaceCoreSync: (repo) => ipcRenderer.sendSync("workspace:core-sync", repo),
  workspaceViewSync: (repo, viewId) => ipcRenderer.sendSync("workspace:view-sync", repo, viewId),
  workspaceSetCoreSync: (repo, core, base) => { ipcRenderer.sendSync("workspace:set-core-sync", repo, core, base); },
  workspaceSetViewSync: (repo, viewId, layout, base) => { ipcRenderer.sendSync("workspace:set-view-sync", repo, viewId, layout, base); },
  workspaceImportSync: (repo, legacy) => { ipcRenderer.sendSync("workspace:import-sync", repo, legacy); },
  workspaceObjectsSync: (repo) => ipcRenderer.sendSync("workspace:objects-sync", repo),
  workspaceSetObjectsSync: (repo, objects, base) => { ipcRenderer.sendSync("workspace:set-objects-sync", repo, objects, base); },
  workspaceUndoSync: (repo) => ipcRenderer.sendSync("workspace:undo-sync", repo),
  workspaceRedoSync: (repo) => ipcRenderer.sendSync("workspace:redo-sync", repo),
  settingsGet: () => ipcRenderer.invoke("settings:get"),
  settingsSet: (p, v) => ipcRenderer.invoke("settings:set", p, v),
  settingsPatch: (patches) => ipcRenderer.invoke("settings:patch", patches),
  settingsReplace: (next) => ipcRenderer.invoke("settings:replace", next),
  settingsPath: () => ipcRenderer.invoke("settings:path"),
  onSettingsChanged: (cb) => {
    const listener = (_e: unknown, s: Parameters<typeof cb>[0]) => cb(s);
    ipcRenderer.on("settings:changed", listener);
    return () => ipcRenderer.removeListener("settings:changed", listener);
  },
  listViews: (repoRoot) => ipcRenderer.invoke("views:list", repoRoot),
  listAgents: (repoRoot) => ipcRenderer.invoke("agents:list", repoRoot),
  agentOptionChoices: (id) => ipcRenderer.invoke("agents:option-choices", id),
  agentPresence: () => ipcRenderer.invoke("agents:presence"),
  verifyAgent: (id) => ipcRenderer.invoke("agents:verify", id),
  previewViewInstall: () => ipcRenderer.invoke("views:preview-install"),
  pluginCatalog: () => ipcRenderer.invoke("plugins:catalog"),
  pluginReadme: (from) => ipcRenderer.invoke("plugins:readme", from),
  listWidgets: () => ipcRenderer.invoke("widgets:list"),
  installWidget: () => ipcRenderer.invoke("widgets:install"),
  removeWidget: (id) => ipcRenderer.invoke("widgets:remove", id),
  onWidgetsChanged: (cb) => {
    const listener = () => cb();
    ipcRenderer.on("widgets:changed", listener);
    return () => ipcRenderer.removeListener("widgets:changed", listener);
  },
  toolPackages: () => ipcRenderer.invoke("tools:list"),
  toolHostExports: (map) => ipcRenderer.invoke("tools:host-exports", map),
  installToolPackage: () => ipcRenderer.invoke("tools:install"),
  removeToolPackage: (id) => ipcRenderer.invoke("tools:remove", id),
  toolRun: (call) => ipcRenderer.invoke("tools:run", call),
  onToolsChanged: (cb) => {
    const listener = () => cb();
    ipcRenderer.on("tools:changed", listener);
    return () => ipcRenderer.removeListener("tools:changed", listener);
  },
  services: () => ipcRenderer.invoke("services:list"),
  serviceLog: (plugin) => ipcRenderer.invoke("services:log", plugin),
  onServicesChanged: (cb) => {
    const listener = () => cb();
    ipcRenderer.on("services:changed", listener);
    return () => ipcRenderer.removeListener("services:changed", listener);
  },
  outdatedAgents: () => ipcRenderer.invoke("plugins:outdated"),
  reviewCatalogPlugin: (type, id) => ipcRenderer.invoke("plugins:review", type, id),
  installCatalogAgent: (token) => ipcRenderer.invoke("plugins:install-agent", token),
  installCatalogWidget: (token) => ipcRenderer.invoke("plugins:install-widget", token),
  removeAgent: (id) => ipcRenderer.invoke("agents:remove", id),
  autoInstallAgents: () => ipcRenderer.invoke("agents:auto-install"),
  installViewPackage: (token) => ipcRenderer.invoke("views:install", token),
  removeViewPackage: (id) => ipcRenderer.invoke("views:remove", id),
  onViewRunaway: (cb) => {
    const listener = (_e: unknown, ev: { id: string; cpuPct: number }) => cb(ev);
    ipcRenderer.on("views:runaway", listener);
    return () => ipcRenderer.removeListener("views:runaway", listener);
  },
  checkForUpdate: () => ipcRenderer.invoke("checkForUpdate"),
  runUpgrade: () => ipcRenderer.invoke("runUpgrade"),
  onUpdateProgress: (cb) => {
    const listener = (_e: unknown, line: string) => cb(line);
    ipcRenderer.on("update:progress", listener);
    return () => ipcRenderer.removeListener("update:progress", listener);
  },
  onBrowserPopup: (cb) => {
    const listener = (_e: unknown, p: { fromId: number; url: string }) => cb(p);
    ipcRenderer.on("browser:popup", listener);
    return () => ipcRenderer.removeListener("browser:popup", listener);
  },


  // Global accelerator bridge — main intercepts ⌘B before the DOM (xterm would otherwise eat it)
  // and re-emits as IPC.
  onMenuToggleLayers: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on("menu:toggle-layers", listener);
    return () => ipcRenderer.removeListener("menu:toggle-layers", listener);
  },
  // Tile-scaling accelerators (xterm eats the keys when focused, so main forwards
  // the intent over IPC and the renderer re-dispatches as the matching CustomEvent).
  onMenuFitOverlay: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on("menu:fit-overlay", listener);
    return () => ipcRenderer.removeListener("menu:fit-overlay", listener);
  },
  onMenuResetScale: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on("menu:reset-scale", listener);
    return () => ipcRenderer.removeListener("menu:reset-scale", listener);
  },
  /** A VS Code-style app shortcut main intercepted before the focused tile saw it. */
  onMenuShortcut: (cb: (action: string) => void) => {
    const listener = (_e: unknown, action: string) => cb(action);
    ipcRenderer.on("menu:shortcut", listener);
    return () => ipcRenderer.removeListener("menu:shortcut", listener);
  },
  onMenuFocusTile: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on("menu:focus-tile", listener);
    return () => ipcRenderer.removeListener("menu:focus-tile", listener);
  },

  getLaunchTarget: () => ipcRenderer.invoke("getLaunchTarget"),
  newWindow: () => ipcRenderer.invoke("window:new"),
  onOpenProject: (cb: (path: string) => void) => {
    const listener = (_e: unknown, p: string) => cb(p);
    ipcRenderer.on("open-project", listener);
    return () => ipcRenderer.removeListener("open-project", listener);
  },


  // HCP control plane: main pushes a canvas verb → renderer executes → replies.
  hcpResult: (id, ok, result, errorMessage) =>
    ipcRenderer.invoke("hcp:result", id, ok, result, errorMessage),
  onHcpCommand: (cb: (cmd: HcpCommand) => void) => {
    const listener = (_e: unknown, cmd: HcpCommand) => cb(cmd);
    ipcRenderer.on("hcp:command", listener);
    return () => ipcRenderer.removeListener("hcp:command", listener);
  },
  onAppError: (cb: (e: AppErrorEvent) => void) => {
    const listener = (_e: unknown, ev: AppErrorEvent) => cb(ev);
    ipcRenderer.on("app:error", listener);
    return () => ipcRenderer.removeListener("app:error", listener);
  },
  platform: process.platform,
  // webUtils.getPathForFile is the supported way to get a dropped/picked File's
  // absolute path under contextIsolation (File.path was removed). Used to build
  // the persistent hm-media:// video-wallpaper URL.
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  importWallpaper: (srcPath: string) => ipcRenderer.invoke("wallpaper:import", srcPath) as Promise<string | null>,
  pickMedia: (slot: string) =>
    ipcRenderer.invoke("media:pick", slot) as Promise<{ url: string; kind: "video" | "image"; name: string } | null>,
};

// A native agent notification was clicked → focus that tile on the canvas.
// Bridge the IPC to the same CustomEvent the canvas already uses for fly-to.
ipcRenderer.on("notify:focus-tile", (_e, tileId: string) => {
  window.dispatchEvent(new CustomEvent<string>("hivemind:focus-tile", { detail: tileId }));
});

contextBridge.exposeInMainWorld("hive", api);
