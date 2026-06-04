import { contextBridge, ipcRenderer } from "electron";
import type { HiveIpc, DiffScope, WorktreeCreateOpts } from "../shared/ipc.js";

const api: HiveIpc & {
  onPtyData: (tileId: string, cb: (data: string) => void) => () => void;
  onPtyExit: (
    tileId: string,
    cb: (info: { code: number; signal?: number }) => void
  ) => () => void;
  onFsChanged: (
    repoPath: string,
    cb: (info: { paths: string[] }) => void
  ) => () => void;
  onMenuPalette: (cb: () => void) => () => void;
  onMenuNewIssue: (cb: () => void) => () => void;
  onMenuOpenFolder: (cb: () => void) => () => void;
  onMenuOpenRecent: (cb: () => void) => () => void;
  onMenuToggleLayers: (cb: () => void) => () => void;
  getLaunchTarget: () => Promise<string | null>;
  onOpenProject: (cb: (path: string) => void) => () => void;
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

  // Global accelerator bridge — main intercepts Ctrl+K / Ctrl+N before the
  // DOM (xterm would otherwise eat them) and re-emits as IPC. Renderer
  // re-dispatches as the same CustomEvent the regular keydown listeners use,
  // so palette/new-issue logic is unchanged.
  onMenuPalette: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on("menu:open-palette", listener);
    return () => ipcRenderer.removeListener("menu:open-palette", listener);
  },
  onMenuNewIssue: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on("menu:new-issue", listener);
    return () => ipcRenderer.removeListener("menu:new-issue", listener);
  },
  onMenuOpenFolder: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on("menu:open-folder", listener);
    return () => ipcRenderer.removeListener("menu:open-folder", listener);
  },
  onMenuOpenRecent: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on("menu:open-recent", listener);
    return () => ipcRenderer.removeListener("menu:open-recent", listener);
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
};

// A native agent notification was clicked → focus that tile on the canvas.
// Bridge the IPC to the same CustomEvent the canvas already uses for fly-to.
ipcRenderer.on("notify:focus-tile", (_e, tileId: string) => {
  window.dispatchEvent(new CustomEvent<string>("hivemind:focus-tile", { detail: tileId }));
});

contextBridge.exposeInMainWorld("hive", api);
