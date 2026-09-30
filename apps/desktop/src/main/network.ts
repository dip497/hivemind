/**
 * This machine on the network, for the app (M1): hive-net's daemon, started the first time
 * something is shared or joined (or at start when something already is), and what the app
 * decides on it. Sharing: a workspace's invite links, who asks to join and whom the person here
 * lets in (the access lists, `Sharing`); the daemon admits only the devices the lists do.
 * Joining: this person's joins elsewhere (`JoinedList`).
 */
import { app } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { HiveNet } from "@hivemind/workspace-host/hive-net";
import { AccessLists, LINK_ROLES, ROLES, type LinkRole, type Role } from "@hivemind/workspace-host/access";
import { Sharing, type JoinRequest, type PairReply } from "@hivemind/workspace-host/sharing";
import { formatJoinLink, parseJoinLink } from "@hivemind/workspace-host/join-link";
import { JoinedList } from "@hivemind/workspace-host/joined";
import { NetworkProfiles } from "@hivemind/workspace-host/network-profile";
import { handle, handleEffect, on } from "./app-ipc.js";
import { displayName, machineIdentity } from "./identity.js";
import { getSettings } from "./settings-store.js";
import { broadcast, userWindow } from "./windows.js";
import { workspaceStore } from "./workspace-store-ipc.js";
import { connectedTo, disconnect, servePeerLink } from "./peers-host.js";
import { leaveShared, openShared, sharedStatus, type SharedStatus } from "./shared-workspaces.js";
import type { WorkspaceServer } from "@hivemind/workspace-api/server";
import type { EventMessage } from "@hivemind/workspace-api/protocol";

/** The host's workspace API, which peers are served from: set when the IPC is installed. */
let apiServer: WorkspaceServer | null = null;

const exe = process.platform === "win32" ? "hive-net.exe" : "hive-net";

/** Where hive-net is: named by HIVEMIND_HIVE_NET, else where the installers put it, else on PATH,
 *  else (running from source) the crate's build. */
function hiveNetBin(): string | null {
  const candidates = [
    process.env.HIVEMIND_HIVE_NET,
    path.join(os.homedir(), ".hivemind-app", exe),
    ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((d) => path.join(d, exe)),
    ...(app.isPackaged ? [] : ["release", "debug"].map((p) => path.join(app.getAppPath(), "../../crates/hive-net/target", p, exe))),
  ];
  return candidates.find((c): c is string => !!c && fs.existsSync(c)) ?? null;
}

/** The daemon's socket: in the data folder, unless its path is too long for a socket. */
function socketPath(): string {
  const tag = createHash("sha256").update(app.getPath("userData")).digest("hex").slice(0, 12);
  if (process.platform === "win32") return `\\\\.\\pipe\\hivemind-net-${tag}`;
  const inData = path.join(app.getPath("userData"), "hive-net.sock");
  return inData.length < 100 ? inData : path.join(os.tmpdir(), `hivemind-net-${tag}.sock`);
}

let lists: AccessLists | null = null;
function accessLists(): AccessLists {
  return (lists ??= new AccessLists({
    dir: path.join(app.getPath("userData"), "access"),
    owner: machineIdentity().person,
    onWarn: (m) => console.warn(`[access] ${m}`),
  }));
}

let joined: JoinedList | null = null;
function joinedList(): JoinedList {
  return (joined ??= new JoinedList(path.join(app.getPath("userData"), "joined.json")));
}

/** Questions to the person here about someone asking to join, by request. */
const asking = new Map<number, (allow: boolean) => void>();
let nextAsk = 1;
/** How long the person here has to answer before the request is declined. */
const ANSWER_WITHIN_MS = 170_000;

function askPerson(request: JoinRequest): Promise<boolean> {
  const win = userWindow();
  if (!win) return Promise.resolve(false);
  const req = nextAsk++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { asking.delete(req); resolve(false); }, ANSWER_WITHIN_MS);
    asking.set(req, (allow) => { clearTimeout(timer); asking.delete(req); resolve(allow); });
    win.webContents.send("net:join-request", { req, profile: request.profile, role: request.role, workspace: path.basename(request.repo) });
  });
}

let sharing: Sharing | null = null;
function sharingOf(): Sharing {
  return (sharing ??= new Sharing(accessLists(), askPerson, (devices) => { void current?.then((n) => n.admit(devices)); }));
}

let current: Promise<HiveNet> | null = null;

/** hive-net's executable, or why there is none. */
function hiveNet(): string {
  const bin = hiveNetBin();
  if (!bin) throw new Error("hive-net is not installed here: reinstall hivemind to share or join workspaces");
  return bin;
}

let profiles: NetworkProfiles | null = null;
/** This device's network profile (R16), kept in `<userData>/network`. */
function networkProfiles(): NetworkProfiles {
  return (profiles ??= new NetworkProfiles({ dir: path.join(app.getPath("userData"), "network"), bin: hiveNet() }));
}

/** This machine's daemon, started if it is not running, on the network in use. */
export function network(): Promise<HiveNet> {
  current ??= (async () => {
    const bin = hiveNet();
    machineIdentity();
    const hn = await HiveNet.start({
      bin,
      identity: path.join(app.getPath("userData"), "identity"),
      socket: socketPath(),
      profile: networkProfiles().arg(),
      onIncoming: (link) => (apiServer ? servePeerLink(link, accessLists(), apiServer) : link.close()),
      onPairRequest: (peer, hello) => sharingOf().answer(peer, hello),
      onExit: (why) => { current = null; console.warn(`[network] ${why}`); },
    });
    hn.admit(accessLists().admitted());
    return hn;
  })().catch((e: unknown) => { current = null; throw e; });
  return current;
}

/** Stop the daemon (the app is quitting). */
export function stopNetwork(): void {
  void current?.then((n) => n.stop(), () => {});
  current = null;
}

/** The network in use changed: a running daemon starts again on it. Connections drop and come
 *  back by themselves (shared-workspaces.ts). */
function restartNetwork(): void {
  if (!current) return;
  stopNetwork();
  void network().catch((e: unknown) => console.warn(`[network] ${e instanceof Error ? e.message : String(e)}`));
}

/** Open the workspace `workspace` that this person joined: its host dialled, its replica kept in
 *  sync, its events published to the windows with `publish`. One they left, or were removed from,
 *  opens as the last copy kept here, and nothing is dialled. */
export async function openJoined(workspace: string, publish: (event: EventMessage) => void): Promise<void> {
  const joined = joinedList().list().find((j) => j.workspace === workspace);
  if (!joined) throw new Error("that workspace was not joined here: open its invite link");
  if (joined.ended) return;
  await network();
  await openShared(workspace, joined.role, {
    // The daemon in use when dialling: it starts again when the network changes.
    dial: async () => (await network()).dial(joined.host, joined.where),
    publish,
    told: (ws, status) => {
      if (status.state === "removed") joinedList().update(ws, { ended: "removed" });
      else if (status.state === "connected" && status.access !== "owner") joinedList().update(ws, { role: status.access });
      broadcast("net:shared-status", ws, status);
    },
  });
}

/** How a joined workspace is: whose it is, and where its connection is (or how it ended). */
function joinedStatus(workspace: string): ({ names: { workspace: string; host: string } } & SharedStatus) | null {
  const joined = joinedList().list().find((j) => j.workspace === workspace);
  if (!joined) return null;
  const live = joined.ended ? null : sharedStatus(workspace);
  return { names: joined.names, state: joined.ended ?? live?.state ?? "offline", access: live?.access ?? joined.role };
}

/** The workspace id of `repo` here, which this person owns: what the People panel manages. */
function ownedWorkspace(repo: unknown): string {
  const own = typeof repo === "string" ? workspaceStore().ownership(repo) : null;
  if (!own) throw new Error("people: this workspace is not shared from here");
  return own.workspaceId;
}

export function installNetworkIpc(server: WorkspaceServer): void {
  apiServer = server;
  // The network in use, changed here or by `hive network use`: the daemon starts again on it.
  try {
    fs.watchFile(networkProfiles().file, { interval: 2_000 }, (now, before) => { if (now.mtimeMs !== before.mtimeMs) restartNetwork(); });
  } catch { /* hive-net is not installed: there is no network to change */ }

  // This device's network (Settings → Network): which it is, whether its servers answer, and
  // another to use.
  handle("net:network", () => networkProfiles().active());
  handle("net:network-health", () => networkProfiles().health(path.join(app.getPath("userData"), "identity")));
  handleEffect("net:use-network", (given: unknown) => ({ detail: typeof given === "string" ? given.slice(0, 40) : undefined }), async (_e, given: unknown) => {
    if (typeof given !== "string" || !given.trim()) throw new Error("network: which one?");
    // The file changes, and the daemon starts again on it (watched above).
    return networkProfiles().use(given);
  });

  // Something is shared from here already: be where the people let in can reach it.
  if (accessLists().workspaces().some((ws) => accessLists().people(ws).length > 0)) {
    void network().catch((e: unknown) => console.warn(`[network] ${e instanceof Error ? e.message : String(e)}`));
  }
  // An invite link to the workspace `repo`, for `role`, for `expiresIn` ms, used once unless `reusable`.
  handleEffect("net:share", (repo: unknown) => ({ target: typeof repo === "string" ? repo : undefined }), async (_e, repo: unknown, role: unknown, expiresIn: unknown, reusable: unknown) => {
    if (typeof repo !== "string" || !repo) throw new Error("share: which workspace?");
    if (!LINK_ROLES.includes(role as LinkRole)) throw new Error(`share: a link cannot carry ${String(role)}`);
    const own = workspaceStore().ownership(repo);
    if (!own) throw new Error("share: this workspace does not say whose it is yet; change something in it first");
    const secret = accessLists().invite(own.workspaceId, repo, role as LinkRole, Number(expiresIn), reusable === true);
    const hn = await network();
    const host = await displayName(getSettings().profile.name);
    return formatJoinLink({ host: hn.ready.id, workspace: own.workspaceId, secret, where: { addrs: hn.ready.addrs, relay: hn.ready.relay }, names: { workspace: path.basename(repo), host } });
  });

  // What a link offers, to show before joining: null when it is not one.
  handle("net:join-preview", (_e, text: unknown) => {
    const link = typeof text === "string" ? parseJoinLink(text) : null;
    return link && { workspace: link.names.workspace, host: link.names.host };
  });

  // Ask the host a link names to let this person in.
  handleEffect("net:join", () => ({}), async (_e, text: unknown): Promise<PairReply> => {
    const link = typeof text === "string" ? parseJoinLink(text) : null;
    if (!link) throw new Error("join: that is not an invite link");
    const hn = await network();
    const { certificate } = machineIdentity();
    const profile = { name: await displayName(getSettings().profile.name), color: getSettings().profile.color };
    const reply = (await hn.pair(link.host, link.where, { v: 1, workspace: link.workspace, secret: link.secret, certificate, profile })) as PairReply;
    if (reply?.ok) {
      joinedList().add({ workspace: link.workspace, host: link.host, where: link.where, role: reply.role, names: link.names, joinedAt: Date.now() });
    }
    return reply;
  });

  // The person here answers someone asking to join.
  on("net:join-answer", (_e, req: unknown, allow: unknown) => asking.get(Number(req))?.(allow === true));

  // Who is on the workspace `repo`'s list, and whether each is connected now.
  handle("net:people", (_e, repo: unknown) => {
    const own = typeof repo === "string" ? workspaceStore().ownership(repo) : null;
    if (!own) return [];
    const here = connectedTo(own.workspaceId);
    return accessLists().people(own.workspaceId).map((p) => ({ ...p, present: here.has(p.person) }));
  });

  // Give someone on the list another role. They are reconnected, to work under it at once.
  // Driving agents runs commands on this machine: it is given only to someone connected now.
  handleEffect("net:set-role", (repo: unknown, person: unknown, role: unknown) => ({ target: typeof repo === "string" ? repo : undefined, detail: `${String(person).slice(0, 8)}… → ${String(role)}` }), (_e, repo: unknown, person: unknown, role: unknown) => {
    const ws = ownedWorkspace(repo);
    if (!ROLES.includes(role as Role)) throw new Error(`people: ${String(role)} is not a role`);
    const current = accessLists().people(ws).find((p) => p.person === person);
    if (!current) throw new Error("people: they are not on this workspace's list");
    if (role === "agents" && !connectedTo(ws).has(current.person)) throw new Error("people: Can drive agents is given only to someone here now");
    accessLists().grant(ws, current.person, role as Role, current.expires);
    disconnect(ws, current.person, "role changed");
  });

  // Take someone off the list: their connections close at once, and the link they came in by
  // lets nobody in again.
  handleEffect("net:remove", (repo: unknown, person: unknown) => ({ target: typeof repo === "string" ? repo : undefined, detail: String(person).slice(0, 8) }), async (_e, repo: unknown, person: unknown) => {
    const ws = ownedWorkspace(repo);
    if (typeof person !== "string" || !accessLists().revoke(ws, person)) throw new Error("people: they are not on this workspace's list");
    disconnect(ws, person, "removed");
    (await current)?.admit(accessLists().admitted());
  });

  // The workspaces this person joined elsewhere.
  handle("net:joined", () => joinedList().list());

  // How a workspace joined here is: whose, and where its connection is.
  handle("net:shared-status", (_e, workspace: unknown) => (typeof workspace === "string" ? joinedStatus(workspace) : null));

  // Leave a workspace joined here: its connection closes, and the last copy is kept, to read.
  handleEffect("net:leave", (workspace: unknown) => ({ target: typeof workspace === "string" ? `hive://${workspace}` : undefined }), (_e, workspace: unknown) => {
    if (typeof workspace !== "string" || !joinedStatus(workspace)) throw new Error("leave: that workspace was not joined here");
    leaveShared(workspace);
    joinedList().update(workspace, { ended: "left" });
    broadcast("net:shared-status", workspace, { state: "left", access: joinedStatus(workspace)!.access });
  });
}
