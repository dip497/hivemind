/// <reference lib="dom" />
/**
 * The dev-bridge's page side: `window.hive` for the renderer in a plain browser, over the
 * dev-bridge's HTTP (server.ts), bundled when the bridge starts and served as /hive-bridge.js
 * before the renderer's own bundle. The workspace API goes through a `WorkspaceClient` whose
 * connection is this page's event stream. The store's layouts are held by a `StoreReplica`, so
 * the renderer's synchronous reads answer at once; the project's layouts are opened as the
 * project resolves, before the renderer first reads them. Notices go out one after another, so
 * keystrokes reach the host in the order they were typed. What only the machine at hand answers
 * (which project a folder is) is a plain RPC.
 */
import { WorkspaceClient } from "@hivemind/workspace-api/client";
import { StoreReplica } from "@hivemind/workspace-api/store-replica";
import type { Answer, EventMessage } from "@hivemind/workspace-api/protocol";
import type { HiveIpc } from "../shared/ipc";
import type {} from "../renderer/src/preload-types";
import { DEFAULT_NOTIFICATION_SETTINGS } from "../shared/notification-settings";

/** What the renderer is given as `window.hive` (the preload's, in the app). */
type Hive = Window["hive"];

const BRIDGE = window.location.origin;
// Same-origin only: another site's page cannot read this (the bridge answers loopback origins).
const token: Promise<string> = fetch(`${BRIDGE}/auth-token`, { credentials: "omit" })
  .then((r) => r.json() as Promise<{ token: string }>)
  .then((d) => d.token);
let deliver: (message: EventMessage) => void = () => {};
const connection: Promise<string> = token.then((t) => new Promise<string>((resolve) => {
  const events = new EventSource(`${BRIDGE}/workspace/events?token=${encodeURIComponent(t)}`);
  events.addEventListener("connection", (ev) => resolve((JSON.parse((ev as MessageEvent<string>).data) as { id: string }).id));
  events.onmessage = (ev: MessageEvent<string>) => deliver(JSON.parse(ev.data) as EventMessage);
}));
const headers = async (): Promise<Record<string, string>> =>
  ({ "content-type": "application/json", "x-hive-token": await token, "x-hive-connection": await connection });

async function post(path: string, body: unknown): Promise<Response> {
  const r = await fetch(`${BRIDGE}${path}`, { method: "POST", headers: await headers(), body: JSON.stringify(body) });
  if (!r.ok) throw new Error(await r.text());
  return r;
}
let notices: Promise<unknown> = Promise.resolve();
const workspace = new WorkspaceClient({
  call: async (method, params) => (await (await post("/workspace", { method, params })).json()) as Answer,
  notice: (method, params) => {
    notices = notices.then(() => post("/workspace/notice", { method, params })).catch((e: unknown) => console.error(`[workspace] ${method}:`, e));
  },
  events: (listener) => { deliver = listener; },
});
const store = new StoreReplica(workspace);

/** Listeners for an event about one terminal or repo, by its name. */
function about<P>(event: "terminal.data" | "terminal.exit" | "file.changed") {
  return (key: string, cb: (value: P) => void): (() => void) =>
    workspace.on(event, ((k: string, value: P) => { if (k === key) cb(value); }) as never);
}

const hive: Partial<Hive> = {
  resolveProject: async (hint) => {
    const r = await post("/rpc/resolveProject", [hint]);
    const project = (await r.json()) as Awaited<ReturnType<HiveIpc["resolveProject"]>>;
    const key = project.repoPath ?? project.cwd;
    if (key) await store.open(key);
    return project;
  },
  listIssues: (r) => workspace.call("issue.list", r),
  readIssue: (r, i) => workspace.call("issue.read", r, i),
  updateIssueState: (r, i, s, n) => workspace.call("issue.setState", r, i, s, n),
  createIssue: (r, o) => workspace.call("issue.create", r, o),
  updateIssue: (r, i, p) => workspace.call("issue.update", r, i, p),
  commentOnIssue: (r, i, m) => workspace.call("issue.comment", r, i, m),
  deleteIssue: (r, i) => workspace.call("issue.delete", r, i),
  linkIssue: (r, i, o, t) => workspace.call("issue.link", r, i, o, t),
  unlinkIssue: (r, i, o) => workspace.call("issue.unlink", r, i, o),
  moveIssue: (r, i, p, m) => workspace.call("issue.move", r, i, p, m),
  reviewList: (r) => workspace.call("review.list", r),
  reviewSave: (r, c) => workspace.call("review.save", r, c),
  fileRead: (r, f) => workspace.call("file.read", r, f),
  fileWrite: (r, f, c) => workspace.call("file.write", r, f, c),
  hcpStatusAll: () => workspace.call("status.all"),
  hcpLinks: () => workspace.call("link.list"),
  onHcpStatus: (cb) => workspace.on("status.changed", cb),
  onHcpPipe: (cb) => workspace.on("link.pipe", cb),
  onHcpSpawn: (cb) => workspace.on("link.spawn", cb),
  onHcpSpawned: (cb) => workspace.on("tile.opened", cb),
  gitStatus: (r) => workspace.call("git.status", r),
  gitListFiles: (r) => workspace.call("git.listFiles", r),
  gitListBranches: (r) => workspace.call("git.listBranches", r),
  gitDiff: (r, s, f) => workspace.call("git.diff", r, s, f),
  gitFileContents: (r, f, v) => workspace.call("git.fileContents", r, f, v),
  gitStage: (r, f) => workspace.call("git.stage", r, f),
  gitUnstage: (r, f) => workspace.call("git.unstage", r, f),
  gitDiscard: (r, f) => workspace.call("git.discard", r, f),
  gitCommit: (r, m, a) => workspace.call("git.commit", r, m, a),
  gitPush: (r, u) => workspace.call("git.push", r, u),
  gitPull: (r) => workspace.call("git.pull", r),
  gitConflictedFile: (r, f) => workspace.call("git.conflictedFile", r, f),
  gitWriteResolved: (r, f, c) => workspace.call("git.writeResolved", r, f, c),
  worktreeList: (r) => workspace.call("worktree.list", r),
  worktreeCreate: (r, o) => workspace.call("worktree.create", r, o),
  worktreeRemove: (r, p, f) => workspace.call("worktree.remove", r, p, f),
  worktreePrune: (r) => workspace.call("worktree.prune", r),
  ptySpawn: (o) => workspace.call("terminal.open", o),
  ptyWrite: (t, d, p) => workspace.notice("terminal.write", t, d, p),
  ptyInterest: (t, s) => workspace.notice("terminal.show", t, s),
  ptyResize: (t, c, r) => workspace.notice("terminal.resize", t, c, r),
  ptyKill: (t) => workspace.notice("terminal.close", t),
  ptyDetach: (t) => workspace.notice("terminal.detach", t),
  ptyFlow: (t, p) => workspace.notice("terminal.flow", t, p),
  keyboardAsk: (t) => workspace.notice("terminal.keyboard.ask", t),
  keyboardGive: (t, to) => workspace.notice("terminal.keyboard.give", t, to),
  keyboardTake: (t) => workspace.notice("terminal.keyboard.take", t),
  onKeyboard: (cb) => workspace.on("terminal.keyboard", cb),
  onKeyboardAsked: (cb) => workspace.on("terminal.keyboard.asked", cb),
  onTerminalSize: (cb) => workspace.on("terminal.size", cb),
  ptyActivityWatch: (ts) => workspace.notice("terminal.watchActivity", ts),
  onPtyActivity: (cb) => workspace.on("terminal.activity", cb),
  workspaceCoreSync: (repo) => store.core(repo),
  workspaceViewSync: (repo, viewId) => store.view(repo, viewId),
  workspaceSetCoreSync: (repo, core, base) => store.setCore(repo, core, base),
  workspaceSetViewSync: (repo, viewId, layout, base) => store.setView(repo, viewId, layout, base),
  workspaceImportSync: (repo, legacy) => store.import(repo, legacy),
  workspaceObjectsSync: (repo) => store.objects(repo),
  workspaceSetObjectsSync: (repo, objects, base) => store.setObjects(repo, objects, base),
  workspaceUndoSync: (repo) => store.undo(repo),
  workspaceRedoSync: (repo) => store.redo(repo),
  onWorkspaceChanged: (cb) => store.onChange(cb),
  workspaceShown: (repo, frame) => workspace.notice("store.shown", repo, frame),
};
/** What only the app's own machine answers (its settings, installs, machines, updates, windows),
 *  answered as a machine with nothing configured: this page is no machine's window. Anything else
 *  not listed answers nothing, and a subscription to it hears nothing. */
const machine: Partial<Hive> = {
  platform: "linux",
  persistentPty: false,
  getNotificationSettings: async () => DEFAULT_NOTIFICATION_SETTINGS,
  setNotificationSettings: async () => ({ ok: true }),
  getBrowserSettings: async () => ({ active: false, enabled: false, port: "" }),
  setBrowserCdpEnabled: async () => ({ ok: true }),
  getLaunchTarget: async () => null,
  listWorkspaces: async () => [],
  resolveIssueRoot: async () => ({ root: null }),
  listViews: async () => [],
  listAgents: async () => ({ agents: [], shadowed: [] }),
  agentPresence: async () => ({}),
  agentOptionChoices: async () => ({}),
  autoInstallAgents: async () => ({ added: [], updated: [] }),
  outdatedAgents: async () => [],
  pluginCatalog: async () => [],
  checkForUpdate: async () => ({ current: "dev", latest: null, updateAvailable: false, ok: false, staged: null }),
  machinesGet: async () => ({ machines: [], status: {} }),
  machineSessions: async () => [],
  presenceNow: async () => ({ state: "active", since: Date.now(), focused: document.hasFocus() }),
  viewLedgerSnapshot: async () => [],
  viewSessions: async () => [],
};
const nothing = (name: string): unknown => (/^on[A-Z]/.test(name) ? () => () => {} : /Sync$/.test(name) ? () => null : async () => null);
const all: Record<string, unknown> = {
  ...machine,
  ...hive,
  onPtyData: about<string>("terminal.data"),
  onPtyExit: about<{ code: number; signal?: number }>("terminal.exit"),
  onFsChanged: about<{ paths: string[] }>("file.changed"),
};
(window as unknown as { hive: unknown }).hive = new Proxy(all, {
  get: (target, name) => (typeof name !== "string" || name in target ? target[name as string] : nothing(name)),
});
console.info(`[hivemind] dev-bridge installed at ${BRIDGE}`);
