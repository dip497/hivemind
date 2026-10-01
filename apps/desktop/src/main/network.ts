/**
 * This machine on the network, for the app (M1): hive-net's daemon, started the first time
 * something is shared or joined (or at start when something already is), and what the app
 * decides on it. Sharing: a workspace's invite links, who asks to join and whom the person here
 * lets in (the access lists, `Sharing`); the daemon admits only the devices the lists do.
 * Joining: this person's joins elsewhere (`JoinedList`). Devices (R14, M3, spec/pairing.md): the
 * person's other devices this app paired with (hosts, and other computers), which this app lets in
 * as the owner of everything here, and whose workspaces it opens as this person's.
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
import { Devices, type PairedDevice } from "@hivemind/workspace-host/devices";
import { enterPairing, formatPairLink, offeringNearby, pairAnnouncement, PairingOffer, parseCode, parsePairLink, type PairingDevice } from "@hivemind/workspace-host/pairing";
import { heldWorkspaces } from "@hivemind/host/peer-links";
import { HostRecords, type Hosted } from "@hivemind/workspace-host/host-records";
import { handle, handleEffect, on } from "./app-ipc.js";
import { displayName, machineIdentity, takePerson } from "./identity.js";
import { idOf, workspaceSeed, type Seed } from "@hivemind/workspace-host/identity";
import { getSettings } from "./settings-store.js";
import { broadcast, userWindow } from "./windows.js";
import { onWorkspaceChange, workspaceStore } from "./workspace-store-ipc.js";
import { PeerLinks } from "@hivemind/host/peer-links";
import { leaveShared, openShared, sharedStatus, type SharedStatus } from "./shared-workspaces.js";
import type { WorkspaceServer } from "@hivemind/workspace-api/server";
import type { EventMessage } from "@hivemind/workspace-api/protocol";

/** The workspaces shared from here, served to peers from the host's workspace API: set when the
 *  IPC is installed. */
let peers: PeerLinks | null = null;

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
let paired: Devices | null = null;
/** The person's other devices this app paired with, kept beside its keys. */
function pairedDevices(): Devices {
  return (paired ??= new Devices(path.join(app.getPath("userData"), "identity", "devices.json")));
}

function accessLists(): AccessLists {
  return (lists ??= new AccessLists({
    dir: path.join(app.getPath("userData"), "access"),
    owner: machineIdentity().person,
    // The person's other devices are the owner of every workspace here.
    devices: () => pairedDevices().list().map((d) => d.certificate),
    onWarn: (m) => console.warn(`[access] ${m}`),
  }));
}

/** Let in, from now on, whom the access lists let in: someone added or removed, or a device paired
 *  or unpaired. */
function admitNow(): void {
  void current?.then((n) => n.admit(accessLists().admitted()), () => {});
}

/** Whether people know this app as its person: it let someone into a workspace of its own, or was
 *  let into someone else's. Then it does not take another person. */
const sharesWorkspaces = (): boolean =>
  accessLists().workspaces().some((ws) => accessLists().people(ws).length > 0)
  || joinedList().list().some((j) => j.role !== "owner" && !j.ended);

/** A workspace this person owns, as its host record is filed: its id, and its key. */
const hostedAs = (workspace: string): Hosted => ({ workspace, key: idOf(workspaceSeed(machineIdentity().person, workspace)) });

/** Where the workspaces shared from here say they are hosted, on a network with a lookup server
 *  (M3, spec/host-record.md): kept while the daemon runs. */
let records: HostRecords | null = null;

/** This app is the person `person` from now on: it entered another computer's code (spec/pairing.md).
 *  Its keys, its workspaces, and the access lists it keeps are that person's. */
function becomePerson(person: Seed): void {
  takePerson(person);
  workspaceStore().takePerson(person);
  accessLists().takePerson(person);
  admitNow();
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
  return (sharing ??= new Sharing(accessLists(), askPerson, (devices) => {
    void current?.then((n) => n.admit(devices));
    for (const device of devices) void vouchFor(device);
  }));
}

/** When this network has an access service that admits only who it is told to, the devices this
 *  person let in are vouched for on it, so they reach its relays; and again each day they
 *  connect, before it lapses (R16, §13.3 D). */
const MEMBER_FOR_S = 30 * 24 * 3600;
const vouched = new Map<string, number>();
async function vouchFor(device: string): Promise<void> {
  if (Date.now() - (vouched.get(device) ?? 0) < 24 * 3600_000) return;
  try {
    const access = (await networkProfiles().active()).profile.access;
    if (access?.policy !== "closed") return;
    await networkProfiles().vouch(access.url, await networkProfiles().voucher({ device, expiresIn: MEMBER_FOR_S, uses: 1 }));
    vouched.set(device, Date.now());
  } catch (e) {
    console.warn(`[network] could not vouch for ${device.slice(0, 8)}…: ${e instanceof Error ? e.message : String(e)}`);
  }
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
  return (profiles ??= new NetworkProfiles({
    dir: path.join(app.getPath("userData"), "network"),
    bin: hiveNet(),
    identity: path.join(app.getPath("userData"), "identity"),
  }));
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
      onIncoming: (link) => {
        if (!peers) return link.close();
        peers.serve(link);
        void vouchFor(link.peer);
      },
      // A host entering the code this app offers; anyone else asks to join.
      onPairRequest: async (peer, hello) => ((hello as { pair?: unknown } | null)?.pair
        ? (offered?.open() ? offered.answer(peer, hello) : { ok: false, error: "expired" })
        : sharingOf().answer(peer, hello)),
      onExit: (why) => { current = null; records?.stop(); records = null; console.warn(`[network] ${why}`); },
    });
    hn.admit(accessLists().admitted());
    records?.stop();
    records = new HostRecords({ net: hn, hosted: () => accessLists().workspaces().map(hostedAs), onWarn: (m) => console.warn(`[hosting] ${m}`) });
    records.start();
    return hn;
  })().catch((e: unknown) => { current = null; throw e; });
  return current;
}

/** The name `person` joined a workspace shared from here with; "" when there is none. */
export function personName(person: string): string {
  for (const ws of accessLists().workspaces()) {
    const found = accessLists().people(ws).find((p) => p.person === person);
    if (found?.name) return found.name;
  }
  return "";
}

/** Stop the daemon (the app is quitting). */
export function stopNetwork(): void {
  records?.stop();
  records = null;
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
    // The daemon in use when dialling (it starts again when the network changes), to the device
    // the workspace's host record names now (M3).
    dial: async () => {
      const hn = await network();
      const at = await joinedList().hostOf(workspace, hn);
      if (!at) throw new Error("that workspace is no longer joined here");
      return hn.dial(at.host, at.where);
    },
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

/** A code this app offers for one of the person's hosts to enter (Settings → Devices). */
let offered: PairingOffer | null = null;

/** This app, as pairing needs it: it gives the person it holds. */
async function pairingMe(): Promise<PairingDevice> {
  const hn = await network();
  const { deviceId, certificate, person } = machineIdentity();
  return { device: deviceId, name: os.hostname(), kind: "app", certificate, person, addrs: hn.ready.addrs, relay: hn.ready.relay };
}

/** A device, as Settings lists it. */
const summary = (d: PairedDevice) => ({ device: d.device, name: d.name, kind: d.kind, pairedAt: d.pairedAt });

/** Keep a device just paired with, let it in, and tell the windows. */
function keepPaired(device: PairedDevice): void {
  pairedDevices().add(device);
  admitNow();
  broadcast("net:devices-changed");
}

/** What asking to join answers: the host's reply, or that this device could not get onto the
 *  host network's relays. */
type JoinReply = PairReply | { ok: false; error: "not-admitted"; message: string };

export function installNetworkIpc(server: WorkspaceServer): void {
  peers = new PeerLinks({ store: workspaceStore(), changes: onWorkspaceChange, lists: accessLists(), server, onWarn: (m) => console.warn(`[peers] ${m}`) });
  // The network in use, changed here or by `hive network use`: the daemon starts again on it.
  try {
    fs.watchFile(networkProfiles().file, { interval: 2_000 }, (now, before) => { if (now.mtimeMs !== before.mtimeMs) restartNetwork(); });
  } catch { /* hive-net is not installed: there is no network to change */ }

  // This device's network (Settings → Network): which it is, whether its servers answer, and
  // another to use.
  handle("net:network", () => networkProfiles().active());
  handle("net:network-health", () => networkProfiles().health());
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
    // On a network whose relays admit only who they are told to, the link carries a voucher for
    // the guest's device, for as long as the link lasts; on an open one, where to register.
    const access = (await networkProfiles().active()).profile.access;
    const admission = !access ? null : {
      access: access.url,
      voucher: access.policy === "closed" ? await networkProfiles().voucher({ expiresIn: Number(expiresIn) / 1000, uses: reusable === true ? 100 : 1 }) : null,
    };
    // On a network with a lookup server, the link says where to look for the workspace's host
    // record: the guest finds its host there wherever it is by then. (The record is said when the
    // daemon starts and every hour; until the workspace moves, it names the device the link does.)
    const hosting = hn.ready.lookup ? { key: hostedAs(own.workspaceId).key, lookup: hn.ready.lookup } : null;
    return formatJoinLink({ host: hn.ready.id, workspace: own.workspaceId, secret, where: { addrs: hn.ready.addrs, relay: hn.ready.relay }, names: { workspace: path.basename(repo), host }, admission, hosting });
  });

  // What a link offers, to show before joining: null when it is not one.
  handle("net:join-preview", (_e, text: unknown) => {
    const link = typeof text === "string" ? parseJoinLink(text) : null;
    return link && { workspace: link.names.workspace, host: link.names.host };
  });

  // Ask the host a link names to let this person in.
  handleEffect("net:join", () => ({}), async (_e, text: unknown): Promise<JoinReply> => {
    const link = typeof text === "string" ? parseJoinLink(text) : null;
    if (!link) throw new Error("join: that is not an invite link");
    const hn = await network();
    // Onto the host network's relays first, as its link says.
    if (link.admission) {
      try {
        if (link.admission.voucher) await networkProfiles().redeem(link.admission.access, link.admission.voucher);
        else await networkProfiles().register(link.admission.access);
      } catch (e) {
        return { ok: false, error: "not-admitted", message: e instanceof Error ? e.message : String(e) };
      }
    }
    const { certificate } = machineIdentity();
    const profile = { name: await displayName(getSettings().profile.name), color: getSettings().profile.color };
    const reply = (await hn.pair(link.host, link.where, { v: 1, workspace: link.workspace, secret: link.secret, certificate, profile })) as PairReply;
    if (reply?.ok) {
      joinedList().add({
        workspace: link.workspace, host: link.host, where: link.where, role: reply.role, names: link.names, joinedAt: Date.now(),
        ...(link.hosting ? { hosting: link.hosting } : {}),
      });
    }
    return reply;
  });

  // The person here answers someone asking to join.
  on("net:join-answer", (_e, req: unknown, allow: unknown) => asking.get(Number(req))?.(allow === true));

  // Who is on the workspace `repo`'s list, and whether each is connected now.
  handle("net:people", (_e, repo: unknown) => {
    const own = typeof repo === "string" ? workspaceStore().ownership(repo) : null;
    if (!own) return [];
    const here = peers?.connectedTo(own.workspaceId) ?? new Set<string>();
    return accessLists().people(own.workspaceId).map((p) => ({ ...p, present: here.has(p.person) }));
  });

  // Give someone on the list another role. They are reconnected, to work under it at once.
  // Driving agents runs commands on this machine: it is given only to someone connected now.
  handleEffect("net:set-role", (repo: unknown, person: unknown, role: unknown) => ({ target: typeof repo === "string" ? repo : undefined, detail: `${String(person).slice(0, 8)}… → ${String(role)}` }), (_e, repo: unknown, person: unknown, role: unknown) => {
    const ws = ownedWorkspace(repo);
    if (!ROLES.includes(role as Role)) throw new Error(`people: ${String(role)} is not a role`);
    const current = accessLists().people(ws).find((p) => p.person === person);
    if (!current) throw new Error("people: they are not on this workspace's list");
    if (role === "agents" && !peers?.connectedTo(ws).has(current.person)) throw new Error("people: Can drive agents is given only to someone here now");
    accessLists().grant(ws, current.person, role as Role, current.expires);
    peers?.disconnect(ws, current.person, "role changed");
  });

  // Take someone off the list: their connections close at once, and the link they came in by
  // lets nobody in again.
  handleEffect("net:remove", (repo: unknown, person: unknown) => ({ target: typeof repo === "string" ? repo : undefined, detail: String(person).slice(0, 8) }), async (_e, repo: unknown, person: unknown) => {
    const ws = ownedWorkspace(repo);
    if (typeof person !== "string" || !accessLists().revoke(ws, person)) throw new Error("people: they are not on this workspace's list");
    peers?.disconnect(ws, person, "removed");
    admitNow();
  });

  // The workspaces this person joined elsewhere.
  handle("net:joined", () => joinedList().list());

  // How a workspace joined here is: whose, and where its connection is.
  handle("net:shared-status", (_e, workspace: unknown) => (typeof workspace === "string" ? joinedStatus(workspace) : null));

  // The person's devices this app paired with (Settings → Devices).
  handle("net:devices", () => pairedDevices().list().map(summary));

  // A code for another of the person's devices to enter (a host's `hive host pair <link>`, or
  // another computer's Settings → Devices): this app gives its person.
  handleEffect("net:pair-offer", () => ({}), async () => {
    const me = await pairingMe();
    const hn = await network();
    // Found from its words by the devices on this network, until it is used or expires.
    const withdraw = () => { if (offered !== offer) return; offered = null; hn.advertise(null); };
    const offer = new PairingOffer(me, ({ with: other }) => { withdraw(); keepPaired({ ...other, pairedAt: Date.now() }); });
    offered = offer;
    hn.advertise(pairAnnouncement(offer.code));
    setTimeout(withdraw, offer.expires - Date.now()).unref();
    return { code: offer.code, link: formatPairLink({ device: me.device, addrs: me.addrs, relay: me.relay, code: offer.code, name: me.name, kind: "app" }), expires: offer.expires };
  });

  // Enter the code or link another of the person's devices shows: a host (`hive host pair`) takes
  // this person; another computer gives its own, and this app becomes that person.
  handleEffect("net:pair-enter", () => ({}), async (_e, text: unknown) => {
    const link = typeof text === "string" ? parsePairLink(text) : null;
    const code = link?.code ?? (typeof text === "string" ? parseCode(text) : null);
    if (!code) throw new Error("pair: that is not a pairing code or link");
    const hn = await network();
    // From the words alone, the device offering them on this network; a link says where it is.
    const offering = link?.device ?? (await offeringNearby(code, () => hn.nearby()));
    const where = link ? { addrs: link.addrs, relay: link.relay } : { addrs: [], relay: null };
    const done = await enterPairing({ me: { ...(await pairingMe()), shares: sharesWorkspaces() }, code, offering, ask: (hello) => hn.pair(offering, where, hello) });
    if (done.person) becomePerson(done.person);
    const device = { ...done.with, pairedAt: Date.now() };
    keepPaired(device);
    return { ...summary(device), took: done.person !== null };
  });

  // Forget one of the person's devices: its workspaces are no longer listed here.
  handleEffect("net:unpair", (device: unknown) => ({ detail: String(device).slice(0, 8) }), (_e, device: unknown) => {
    if (typeof device !== "string" || !pairedDevices().remove(device)) throw new Error("unpair: that device is not paired with this one");
    admitNow();
    broadcast("net:devices-changed");
  });

  // The workspaces each of the person's other devices holds; null for one that does not answer.
  handle("net:device-workspaces", async () => {
    const hosts = pairedDevices().list();
    if (hosts.length === 0) return [];
    const hn = await network();
    return Promise.all(hosts.map(async (d) => {
      try {
        const link = await hn.dial(d.device, { addrs: d.addrs, relay: d.relay });
        try { return { device: d.device, name: d.name, workspaces: await heldWorkspaces(link) }; } finally { link.close(); }
      } catch {
        return { device: d.device, name: d.name, workspaces: null };
      }
    }));
  });

  // Open a workspace another of the person's devices holds: a joined workspace this person owns.
  handle("net:open-device-workspace", (_e, device: unknown, workspace: unknown, name: unknown) => {
    const host = pairedDevices().list().find((d) => d.device === device);
    if (!host || typeof workspace !== "string" || !/^[0-9a-f]{32}$/.test(workspace)) throw new Error("open: that is not a workspace of one of your devices");
    const names = { workspace: typeof name === "string" && name ? name.slice(0, 200) : "workspace", host: host.name };
    // The person's own: its key is theirs to derive, and its record is on their network.
    joinedList().add({ workspace, host: host.device, where: { addrs: host.addrs, relay: host.relay }, role: "owner", names, joinedAt: Date.now(), hosting: { key: hostedAs(workspace).key, lookup: null } });
    return `hive://${workspace}`;
  });

  // Leave a workspace joined here: its connection closes, and the last copy is kept, to read.
  handleEffect("net:leave", (workspace: unknown) => ({ target: typeof workspace === "string" ? `hive://${workspace}` : undefined }), (_e, workspace: unknown) => {
    if (typeof workspace !== "string" || !joinedStatus(workspace)) throw new Error("leave: that workspace was not joined here");
    leaveShared(workspace);
    joinedList().update(workspace, { ended: "left" });
    broadcast("net:shared-status", workspace, { state: "left", access: joinedStatus(workspace)!.access });
  });
}
