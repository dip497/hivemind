import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { HiveIpc, DiffScope, WorktreeCreateOpts, PlanReviewOpen, HcpCommand, HcpPipeEvent, HcpWaitEvent, HcpSubagentEvent, HcpNotifyEvent, HcpTurnStateEvent } from "../shared/ipc.js";

const api: HiveIpc & {
  /** Resolve a picked File's real filesystem path (for the persistent video wallpaper). */
  getPathForFile: (file: File) => string;
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
  getLaunchTarget: () => Promise<string | null>;
  onOpenProject: (cb: (path: string) => void) => () => void;
  onBrowserPopup: (cb: (p: { fromId: number; url: string }) => void) => () => void;
  onPlanReviewOpen: (cb: (p: PlanReviewOpen) => void) => () => void;
  onPlanReviewAbort: (cb: (requestId: string) => void) => () => void;
  onHcpCommand: (cb: (cmd: HcpCommand) => void) => () => void;
  onHcpPipe: (cb: (e: HcpPipeEvent) => void) => () => void;
  onHcpWait: (cb: (e: HcpWaitEvent) => void) => () => void;
  onHcpSubagent: (cb: (e: HcpSubagentEvent) => void) => () => void;
  onHcpNotify: (cb: (e: HcpNotifyEvent) => void) => () => void;
  onHcpTurnState: (cb: (e: HcpTurnStateEvent) => void) => () => void;
} = {
  resolveProject: (rootHint) => ipcRenderer.invoke("resolveProject", rootHint),
  pickProjectFolder: () => ipcRenderer.invoke("pickProjectFolder"),
  initWorkspace: (dir, prefix) => ipcRenderer.invoke("initWorkspace", dir, prefix),
  installAgentic: (dir) => ipcRenderer.invoke("installAgentic", dir),
  listIssues: (root) => ipcRenderer.invoke("listIssues", root),
  readIssue: (root, id) => ipcRenderer.invoke("readIssue", root, id),
  updateIssueState: (root, id, state, note) =>
    ipcRenderer.invoke("updateIssueState", root, id, state, note),
  createIssue: (root, opts) => ipcRenderer.invoke("createIssue", root, opts),
  updateIssue: (root, id, patch) => ipcRenderer.invoke("updateIssue", root, id, patch),
  commentOnIssue: (root, id, message) =>
    ipcRenderer.invoke("commentOnIssue", root, id, message),
  deleteIssue: (root, id) => ipcRenderer.invoke("deleteIssue", root, id),

  listWorkspaces: () => ipcRenderer.invoke("listWorkspaces"),
  resolveIssueRoot: (id) => ipcRenderer.invoke("resolveIssueRoot", id),
  moveIssue: (root, id, destPrefix, mode) =>
    ipcRenderer.invoke("moveIssue", root, id, destPrefix, mode),
  linkIssue: (root, id, otherId, type) =>
    ipcRenderer.invoke("linkIssue", root, id, otherId, type),
  unlinkIssue: (root, id, otherId) =>
    ipcRenderer.invoke("unlinkIssue", root, id, otherId),

  gitStatus: (repoPath) => ipcRenderer.invoke("gitStatus", repoPath),
  gitListFiles: (repoPath) => ipcRenderer.invoke("gitListFiles", repoPath),
  gitListBranches: (repoPath) => ipcRenderer.invoke("gitListBranches", repoPath),
  gitDiff: (repoPath, scope: DiffScope, file?: string) =>
    ipcRenderer.invoke("gitDiff", repoPath, scope, file),
  gitFileContents: (repoPath, file, rev) =>
    ipcRenderer.invoke("gitFileContents", repoPath, file, rev),
  gitStage: (repoPath, files) => ipcRenderer.invoke("gitStage", repoPath, files),
  gitUnstage: (repoPath, files) => ipcRenderer.invoke("gitUnstage", repoPath, files),
  gitDiscard: (repoPath, files) => ipcRenderer.invoke("gitDiscard", repoPath, files),
  gitCommit: (repoPath, message, allowEmpty) =>
    ipcRenderer.invoke("gitCommit", repoPath, message, allowEmpty),
  gitPush: (repoPath, setUpstream) =>
    ipcRenderer.invoke("gitPush", repoPath, setUpstream),
  gitConflictedFile: (repoPath, file) =>
    ipcRenderer.invoke("gitConflictedFile", repoPath, file),
  gitWriteResolved: (repoPath, file, contents) =>
    ipcRenderer.invoke("gitWriteResolved", repoPath, file, contents),

  fileRead: (repoPath, relPath) => ipcRenderer.invoke("fileRead", repoPath, relPath),
  fileWrite: (repoPath, relPath, contents) =>
    ipcRenderer.invoke("fileWrite", repoPath, relPath, contents),
  openPathInApp: (cwd, target) => ipcRenderer.invoke("openPathInApp", cwd, target),

  diagLog: (line) => ipcRenderer.invoke("diagLog", line),

  sshConnect: (uri, auth, remember) => ipcRenderer.invoke("sshConnect", uri, auth, remember),
  sshListDir: (uri, dir) => ipcRenderer.invoke("sshListDir", uri, dir),
  sshSavedHosts: () => ipcRenderer.invoke("sshSavedHosts"),
  sshConnectSaved: (hostId) => ipcRenderer.invoke("sshConnectSaved", hostId),
  sshForgetHost: (hostId) => ipcRenderer.invoke("sshForgetHost", hostId),

  worktreeList: (repoPath) => ipcRenderer.invoke("worktreeList", repoPath),
  worktreeCreate: (repoPath, opts: WorktreeCreateOpts) =>
    ipcRenderer.invoke("worktreeCreate", repoPath, opts),
  worktreeRemove: (repoPath, wtPath, force) =>
    ipcRenderer.invoke("worktreeRemove", repoPath, wtPath, force),
  worktreePrune: (repoPath) => ipcRenderer.invoke("worktreePrune", repoPath),

  ptySpawn: (opts) => ipcRenderer.invoke("ptySpawn", opts),
  ptyWrite: (tileId, data) => ipcRenderer.send("ptyWrite", tileId, data),
  ptyResize: (tileId, cols, rows) => ipcRenderer.send("ptyResize", tileId, cols, rows),
  ptyKill: (tileId) => ipcRenderer.send("ptyKill", tileId),
  ptyDetach: (tileId) => ipcRenderer.send("ptyDetach", tileId),
  persistentPty: process.env.HIVEMIND_PTY_DAEMON !== "0",

  notifyAgent: (notice) => ipcRenderer.send("notify:agent", notice),

  browserRegister: (tileId, webContentsId, frameId, url) =>
    ipcRenderer.send("browser:register", tileId, webContentsId, frameId, url),
  browserUnregister: (tileId) => ipcRenderer.send("browser:unregister", tileId),
  browserCdp: (tileId, method, params) =>
    ipcRenderer.invoke("browserCdp", tileId, method, params),
  getBrowserSettings: () => ipcRenderer.invoke("getBrowserSettings"),
  setBrowserCdpEnabled: (enabled) => ipcRenderer.invoke("setBrowserCdpEnabled", enabled),
  relaunchApp: () => ipcRenderer.invoke("relaunchApp"),
  onBrowserPopup: (cb) => {
    const listener = (_e: unknown, p: { fromId: number; url: string }) => cb(p);
    ipcRenderer.on("browser:popup", listener);
    return () => ipcRenderer.removeListener("browser:popup", listener);
  },

  onPtyData: (tileId, cb) => {
    const ch = `pty:data:${tileId}`;
    const listener = (_e: unknown, data: string) => cb(data);
    ipcRenderer.on(ch, listener);
    return () => ipcRenderer.removeListener(ch, listener);
  },
  onPtyExit: (tileId, cb) => {
    const ch = `pty:exit:${tileId}`;
    const listener = (_e: unknown, info: { code: number; signal?: number }) => cb(info);
    ipcRenderer.on(ch, listener);
    return () => ipcRenderer.removeListener(ch, listener);
  },
  onFsChanged: (repoPath, cb) => {
    const ch = `fs:changed:${repoPath}`;
    const listener = (_e: unknown, info: { paths: string[] }) => cb(info);
    ipcRenderer.on(ch, listener);
    return () => ipcRenderer.removeListener(ch, listener);
  },

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

  getLaunchTarget: () => ipcRenderer.invoke("getLaunchTarget"),
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
  onHcpPipe: (cb: (e: HcpPipeEvent) => void) => {
    const listener = (_e: unknown, ev: HcpPipeEvent) => cb(ev);
    ipcRenderer.on("hcp:pipe", listener);
    return () => ipcRenderer.removeListener("hcp:pipe", listener);
  },
  onHcpWait: (cb: (e: HcpWaitEvent) => void) => {
    const listener = (_e: unknown, ev: HcpWaitEvent) => cb(ev);
    ipcRenderer.on("hcp:wait", listener);
    return () => ipcRenderer.removeListener("hcp:wait", listener);
  },
  onHcpSubagent: (cb: (e: HcpSubagentEvent) => void) => {
    const listener = (_e: unknown, ev: HcpSubagentEvent) => cb(ev);
    ipcRenderer.on("hcp:subagent", listener);
    return () => ipcRenderer.removeListener("hcp:subagent", listener);
  },
  onHcpNotify: (cb: (e: HcpNotifyEvent) => void) => {
    const listener = (_e: unknown, ev: HcpNotifyEvent) => cb(ev);
    ipcRenderer.on("hcp:notify", listener);
    return () => ipcRenderer.removeListener("hcp:notify", listener);
  },
  onHcpTurnState: (cb: (e: HcpTurnStateEvent) => void) => {
    const listener = (_e: unknown, ev: HcpTurnStateEvent) => cb(ev);
    ipcRenderer.on("hcp:turnstate", listener);
    return () => ipcRenderer.removeListener("hcp:turnstate", listener);
  },
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
