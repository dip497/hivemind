/// <reference lib="dom" />
/**
 * The dev-bridge's page side: `window.hive` for the renderer in a plain browser, over the
 * dev-bridge's HTTP (server.ts), bundled when the bridge starts and served as /hive-bridge.js
 * before the renderer's own bundle. The workspace API is the app's own (`hiveOverWorkspace`), over a
 * `WorkspaceClient` whose connection is this page's event stream. The store's layouts are held by a `StoreReplica`, so
 * the renderer's synchronous reads answer at once; the project's layouts are opened as the
 * project resolves, before the renderer first reads them. Notices go out one after another, so
 * keystrokes reach the host in the order they were typed. What only the machine at hand answers
 * (which project a folder is) is a plain RPC.
 */
import { WorkspaceClient } from "@hivemind/workspace-api/client";
import { StoreReplica } from "@hivemind/workspace-api/store-replica";
import type { Answer, EventMessage } from "@hivemind/workspace-api/protocol";
import type { HiveApi as Hive, HiveIpc } from "../shared/ipc";
import { hiveOverWorkspace } from "../shared/hive-over-workspace";
import { DEFAULT_NOTIFICATION_SETTINGS } from "../shared/notification-settings";

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

const hive: Partial<Hive> = {
  ...hiveOverWorkspace(workspace),
  resolveProject: async (hint) => {
    const r = await post("/rpc/resolveProject", [hint]);
    const project = (await r.json()) as Awaited<ReturnType<HiveIpc["resolveProject"]>>;
    const key = project.repoPath ?? project.cwd;
    if (key) await store.open(key);
    return project;
  },
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
};
/** What only the app's own machine answers (its settings, installs, machines, updates, windows),
 *  answered as a machine with nothing configured: this page is no machine's window. A call to
 *  anything else fails, so its caller's own failure path runs; a subscription to it hears nothing. */
const machine: Partial<Hive> = {
  platform: "linux",
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
  pluginReadme: async () => null,
  listWidgets: async () => [],
  toolPackages: async () => ({ packages: [], safeMode: false }),
  toolHostExports: async () => {},
  installToolPackage: async () => null,
  removeToolPackage: async () => {},
  toolRun: async () => { throw new Error("programs run in the app"); },
  onToolsChanged: () => () => {},
  checkForUpdate: async () => ({ current: "dev", latest: null, updateAvailable: false, ok: false, staged: null }),
  machinesGet: async () => ({ machines: [], status: {} }),
  machineSessions: async () => [],
  presenceNow: async () => ({ state: "active", since: Date.now(), focused: document.hasFocus() }),
  viewLedgerSnapshot: async () => [],
};
const nothing = (name: string): unknown => (/^on[A-Z]/.test(name) ? () => () => {} : /Sync$/.test(name) ? () => null : async () => { throw new Error(`${name} is answered only in the app`); });
const all: Record<string, unknown> = { ...machine, ...hive };
(window as unknown as { hive: unknown }).hive = new Proxy(all, {
  get: (target, name) => (typeof name !== "string" || name in target ? target[name as string] : nothing(name)),
});
console.info(`[hivemind] dev-bridge installed at ${BRIDGE}`);
