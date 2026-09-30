/// <reference lib="dom" />
import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { HiveIpc, PlanReviewOpen, HcpCommand, HcpPipeEvent, HcpSpawnEvent, HcpSpawnedEvent, HcpStatusEvent, AppErrorEvent } from "../shared/ipc.js";
import { WorkspaceClient } from "@hivemind/workspace-api/client";
import type { Answer, EventMessage } from "@hivemind/workspace-api/protocol";

/** The workspace API (R8): this window's connection to main, which answers its calls on one
 *  channel, takes its notices on another, and sends it events on a third. */
const workspace = new WorkspaceClient({
  call: (method, params) => ipcRenderer.invoke("workspace", method, params) as Promise<Answer>,
  notice: (method, params) => ipcRenderer.send("workspace:notice", method, params),
  events: (listener) => { ipcRenderer.on("workspace:event", (_e, message: EventMessage) => listener(message)); },
});

/** Listeners for an event that names what it is about first (a terminal, a repo), by that name:
 *  one listener on the client for each, however many tiles listen. */
function byKey<E extends "terminal.data" | "terminal.exit" | "file.changed">(event: E) {
  type Rest = E extends "terminal.data" ? string : E extends "terminal.exit" ? { code: number; signal?: number } : { paths: string[] };
  const listeners = new Map<string, Set<(value: Rest) => void>>();
  workspace.on(event, ((key: string, value: Rest) => {
    for (const cb of listeners.get(key) ?? []) cb(value);
  }) as never);
  return {
    on: (key: string, cb: (value: Rest) => void): (() => void) => {
      let set = listeners.get(key);
      if (!set) listeners.set(key, (set = new Set()));
      set.add(cb);
      return () => {
        set!.delete(cb);
        if (set!.size === 0 && listeners.get(key) === set) listeners.delete(key);
      };
    },
  };
}
const terminalData = byKey("terminal.data");
const terminalExit = byKey("terminal.exit");
const fileChanged = byKey("file.changed");

const api: HiveIpc & {
  /** The host OS, so the renderer can pick a default shell without an IPC
   *  round-trip (it needs this while building the very first canvas). */
  platform: NodeJS.Platform;
  /** Resolve a picked File's real filesystem path (for the persistent video wallpaper). */
  getPathForFile: (file: File) => string;
  /** Copy a picked media file into the sandboxed wallpaper dir → its hm-media:// URL. */
  importWallpaper: (srcPath: string) => Promise<string | null>;
  /** Pick a custom media file for a canvas layer → copied into userData/media,
   *  served via the sandboxed hivemedia:// protocol. Null if the user cancels. */
  pickMedia: (slot: string) => Promise<{ url: string; kind: "video" | "image"; name: string } | null>;
  onPtyData: (tileId: string, cb: (data: string) => void) => () => void;
  onPtyExit: (
    tileId: string,
    cb: (info: { code: number; signal?: number }) => void
  ) => () => void;
  onFsChanged: (
    repoPath: string,
    cb: (info: { paths: string[] }) => void
  ) => () => void;
  onMenuNewIssue: (cb: () => void) => () => void;
  onMenuToggleLayers: (cb: () => void) => () => void;
  onMenuFitOverlay: (cb: () => void) => () => void;
  onMenuResetScale: (cb: () => void) => () => void;
  onMenuFocusTile: (cb: () => void) => () => void;
  onMenuShortcut: (cb: (action: string) => void) => () => void;
  getLaunchTarget: () => Promise<string | null>;
  /** Another window, on the workspace this one shows. */
  newWindow: () => Promise<void>;
  onOpenProject: (cb: (path: string) => void) => () => void;
  onBrowserPopup: (cb: (p: { fromId: number; url: string }) => void) => () => void;
  onPlanReviewOpen: (cb: (p: PlanReviewOpen) => void) => () => void;
  onPlanReviewAbort: (cb: (requestId: string) => void) => () => void;
  onHcpCommand: (cb: (cmd: HcpCommand) => void) => () => void;
  onHcpPipe: (cb: (e: HcpPipeEvent) => void) => () => void;
  onHcpSpawn: (cb: (e: HcpSpawnEvent) => void) => () => void;
  onHcpSpawned: (cb: (e: HcpSpawnedEvent) => void) => () => void;
  onHcpStatus: (cb: (e: HcpStatusEvent) => void) => () => void;
  hcpStatusAll: () => Promise<Array<{ tileId: string; status: HcpStatusEvent["status"] }>>;
  hcpLinks: () => Promise<{ pipes: Array<{ src: string; dst: string }>; spawns: Array<{ parent: string; child: string }> }>;
  onAppError: (cb: (e: AppErrorEvent) => void) => () => void;
} = {
  resolveProject: (rootHint) => ipcRenderer.invoke("resolveProject", rootHint),
  pickProjectFolder: () => ipcRenderer.invoke("pickProjectFolder"),
  initWorkspace: (dir, prefix) => ipcRenderer.invoke("initWorkspace", dir, prefix),
  installAgentic: (dir) => ipcRenderer.invoke("installAgentic", dir),
  listIssues: (root) => workspace.call("issue.list", root),
  readIssue: (root, id) => workspace.call("issue.read", root, id),
  updateIssueState: (root, id, state, note) => workspace.call("issue.setState", root, id, state, note),
  createIssue: (root, opts) => workspace.call("issue.create", root, opts),
  updateIssue: (root, id, patch) => workspace.call("issue.update", root, id, patch),
  commentOnIssue: (root, id, message) => workspace.call("issue.comment", root, id, message),
  deleteIssue: (root, id) => workspace.call("issue.delete", root, id),

  listWorkspaces: () => ipcRenderer.invoke("listWorkspaces"),
  resolveIssueRoot: (id) => ipcRenderer.invoke("resolveIssueRoot", id),
  moveIssue: (root, id, destPrefix, mode) => workspace.call("issue.move", root, id, destPrefix, mode),
  linkIssue: (root, id, otherId, type) => workspace.call("issue.link", root, id, otherId, type),
  unlinkIssue: (root, id, otherId) => workspace.call("issue.unlink", root, id, otherId),

  reviewList: (repo) => workspace.call("review.list", repo),
  reviewSave: (repo, comments) => workspace.call("review.save", repo, comments),

  gitStatus: (repo) => workspace.call("git.status", repo),
  gitListFiles: (repo) => workspace.call("git.listFiles", repo),
  gitListBranches: (repo) => workspace.call("git.listBranches", repo),
  gitDiff: (repo, scope, file) => workspace.call("git.diff", repo, scope, file),
  gitFileContents: (repo, file, rev) => workspace.call("git.fileContents", repo, file, rev),
  gitStage: (repo, files) => workspace.call("git.stage", repo, files),
  gitUnstage: (repo, files) => workspace.call("git.unstage", repo, files),
  gitDiscard: (repo, files) => workspace.call("git.discard", repo, files),
  gitCommit: (repo, message, allowEmpty) => workspace.call("git.commit", repo, message, allowEmpty),
  gitPush: (repo, setUpstream) => workspace.call("git.push", repo, setUpstream),
  gitPull: (repo) => workspace.call("git.pull", repo),
  gitConflictedFile: (repo, file) => workspace.call("git.conflictedFile", repo, file),
  gitWriteResolved: (repo, file, contents) => workspace.call("git.writeResolved", repo, file, contents),

  fileRead: (repo, file) => workspace.call("file.read", repo, file),
  fileWrite: (repo, file, contents) => workspace.call("file.write", repo, file, contents),
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
  viewSessions: (agent, cwd) => ipcRenderer.invoke("view:sessions", agent, cwd),
  viewPrompt: (tileId, text) => ipcRenderer.invoke("view:prompt", tileId, text),
  ptyActivityWatch: (tiles) => workspace.notice("terminal.watchActivity", tiles),
  onPtyActivity: (cb) => workspace.on("terminal.activity", cb),
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

  worktreeList: (repo) => workspace.call("worktree.list", repo),
  worktreeCreate: (repo, opts) => workspace.call("worktree.create", repo, opts),
  worktreeRemove: (repo, worktree, force) => workspace.call("worktree.remove", repo, worktree, force),
  worktreePrune: (repo) => workspace.call("worktree.prune", repo),

  ptySpawn: (opts) => workspace.call("terminal.open", opts),
  ptyWrite: (tile, data, paste) => workspace.notice("terminal.write", tile, data, paste),
  ptyInterest: (tile, shown) => workspace.notice("terminal.show", tile, shown),
  ptyResize: (tile, cols, rows) => workspace.notice("terminal.resize", tile, cols, rows),
  ptyKill: (tile) => workspace.notice("terminal.close", tile),
  ptyDetach: (tile) => workspace.notice("terminal.detach", tile),
  ptyFlow: (tile, paused) => workspace.notice("terminal.flow", tile, paused),
  persistentPty: process.env.HIVEMIND_PTY_DAEMON !== "0",

  notifyAgent: (notice) => ipcRenderer.send("notify:agent", notice),

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
  onWorkspaceChanged: (cb) => workspace.on("store.changed", cb),
  workspaceShown: (repo, frame) => workspace.notice("store.shown", repo, frame),
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
  outdatedAgents: () => ipcRenderer.invoke("plugins:outdated"),
  reviewCatalogPlugin: (type, id) => ipcRenderer.invoke("plugins:review", type, id),
  installCatalogAgent: (token) => ipcRenderer.invoke("plugins:install-agent", token),
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

  onPtyData: terminalData.on,
  onPtyExit: terminalExit.on,
  onFsChanged: fileChanged.on,

  // Global accelerator bridge — main intercepts Ctrl+N before the DOM (xterm
  // would otherwise eat it) and re-emits as IPC. Renderer re-dispatches as the
  // same CustomEvent the regular keydown listener uses.
  onMenuNewIssue: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on("menu:new-issue", listener);
    return () => ipcRenderer.removeListener("menu:new-issue", listener);
  },
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

  // Plan review: an agent handed off a plan → open the in-canvas review.
  planReviewDecide: (requestId, decision, feedback) =>
    ipcRenderer.invoke("plan-review:decide", requestId, decision, feedback),
  onPlanReviewOpen: (cb: (p: PlanReviewOpen) => void) => {
    const listener = (_e: unknown, p: PlanReviewOpen) => cb(p);
    ipcRenderer.on("plan-review:open", listener);
    return () => ipcRenderer.removeListener("plan-review:open", listener);
  },
  onPlanReviewAbort: (cb: (requestId: string) => void) => {
    const listener = (_e: unknown, id: string) => cb(id);
    ipcRenderer.on("plan-review:abort", listener);
    return () => ipcRenderer.removeListener("plan-review:abort", listener);
  },

  // HCP control plane: main pushes a canvas verb → renderer executes → replies.
  hcpResult: (id, ok, result, errorMessage) =>
    ipcRenderer.invoke("hcp:result", id, ok, result, errorMessage),
  onHcpCommand: (cb: (cmd: HcpCommand) => void) => {
    const listener = (_e: unknown, cmd: HcpCommand) => cb(cmd);
    ipcRenderer.on("hcp:command", listener);
    return () => ipcRenderer.removeListener("hcp:command", listener);
  },
  onHcpSpawn: (cb) => workspace.on("link.spawn", cb),
  onHcpSpawned: (cb) => workspace.on("tile.opened", cb),
  onHcpPipe: (cb) => workspace.on("link.pipe", cb),
  hcpStatusAll: () => workspace.call("status.all"),
  hcpLinks: () => workspace.call("link.list"),
  onHcpStatus: (cb) => workspace.on("status.changed", cb),
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
