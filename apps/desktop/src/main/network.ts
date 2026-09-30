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
import { AccessLists, LINK_ROLES, type LinkRole } from "@hivemind/workspace-host/access";
import { Sharing, type JoinRequest, type PairReply } from "@hivemind/workspace-host/sharing";
import { formatJoinLink, parseJoinLink } from "@hivemind/workspace-host/join-link";
import { JoinedList } from "@hivemind/workspace-host/joined";
import { handle, handleEffect, on } from "./app-ipc.js";
import { displayName, machineIdentity } from "./identity.js";
import { getSettings } from "./settings-store.js";
import { userWindow } from "./windows.js";
import { workspaceStore } from "./workspace-store-ipc.js";

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

/** This machine's daemon, started if it is not running. */
export function network(): Promise<HiveNet> {
  current ??= (async () => {
    const bin = hiveNetBin();
    if (!bin) throw new Error("hive-net is not installed here: reinstall hivemind to share or join workspaces");
    machineIdentity();
    const hn = await HiveNet.start({
      bin,
      identity: path.join(app.getPath("userData"), "identity"),
      socket: socketPath(),
      onIncoming: (link) => link.close(),
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

export function installNetworkIpc(): void {
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

  // Who is on the workspace `repo`'s list.
  handle("net:people", (_e, repo: unknown) => {
    const own = typeof repo === "string" ? workspaceStore().ownership(repo) : null;
    return own ? accessLists().people(own.workspaceId) : [];
  });

  // The workspaces this person joined elsewhere.
  handle("net:joined", () => joinedList().list());
}
