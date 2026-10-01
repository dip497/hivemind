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
import type { Duplex } from "node:stream";
import { HiveNet, type Link } from "@hivemind/workspace-host/hive-net";
import { AccessLists } from "@hivemind/workspace-host/access";
import { Sharing, type PairReply } from "@hivemind/workspace-host/sharing";
import { parseJoinLink } from "@hivemind/workspace-host/join-link";
import { JoinedList } from "@hivemind/workspace-host/joined";
import { NetworkProfiles } from "@hivemind/workspace-host/network-profile";
import { Devices, type PairedDevice } from "@hivemind/workspace-host/devices";
import { enterPairing, formatPairLink, offeringNearby, pairAnnouncement, PairingOffer, parseCode, parsePairLink, type PairingDevice } from "@hivemind/workspace-host/pairing";
import { heldWorkspaces } from "@hivemind/host/peer-links";
import { HostRecords, type Hosted } from "@hivemind/workspace-host/host-records";
import { Hosting } from "@hivemind/host/hosting";
import { People } from "@hivemind/host/people";
import { handle, handleEffect } from "./app-ipc.js";
import { displayName, machineIdentity, takePerson } from "./identity.js";
import { idOf, workspaceSeed, type Seed } from "@hivemind/workspace-host/identity";
import { getSettings } from "./settings-store.js";
import { broadcast, userWindow } from "./windows.js";
import { onWorkspaceChange, sharedStore, workspaceStore } from "./workspace-store-ipc.js";
import { PeerLinks } from "@hivemind/host/peer-links";
import { forgetShared, leaveShared, openShared, sharedStatus, type SharedStatus } from "./shared-workspaces.js";
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

/** A workspace this person owns, as its host record is filed: its id, its key, and the moves that
 *  brought it here (M3). */
const hostedAs = (workspace: string): Hosted => {
  const moved = accessLists().hosting(workspace);
  return { workspace, key: idOf(workspaceSeed(machineIdentity().person, workspace)), ...(moved ? { seq: moved.seq } : {}) };
};
/** The workspaces shared from here that are hosted here still, not moved to another device. */
const hostedHere = (): Hosted[] => accessLists().workspaces()
  .filter((ws) => { const h = accessLists().hosting(ws); return !h || h.host === machineIdentity().deviceId; })
  .map(hostedAs);

let hosting: Hosting | null = null;
/** Moving the workspaces hosted here to another of the person's devices, and taking them back
 *  (M3, spec/hosting.md). */
function hostingHere(): Hosting {
  return (hosting ??= new Hosting({
    self: () => machineIdentity().deviceId,
    person: () => machineIdentity().personId,
    store: workspaceStore(),
    lists: accessLists(),
    dial: dialDevice,
    sign: async (workspace, seq, host) => (await network()).signHost(workspace, seq, host),
    moved: (workspace, notice) => peers?.moved(workspace, notice),
    // Hosted here again: opened from its folder, not from where it was.
    took: (workspace) => {
      admitNow();
      void records?.start();
      forgetShared(workspace);
      joinedList().remove(workspace);
    },
    onWarn: (m) => console.warn(`[hosting] ${m}`),
  }));
}

/** This computer's folder of `workspace`, when it was moved from here to another of the person's
 *  devices (M3): where it is kept again once it moves back. Null for any other. */
function folderHere(workspace: string): string | null {
  const folder = workspaceStore().repoOf(workspace);
  const h = accessLists().hosting(workspace);
  return folder?.startsWith("/") && h && h.host !== machineIdentity().deviceId ? folder : null;
}

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

let sharing: Sharing | null = null;
function sharingOf(): Sharing {
  // The person is asked at this app's windows, or at another of their devices connected to it.
  return (sharing ??= new Sharing(accessLists(), (request) => peopleHere.ask(request), (devices) => {
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
    records = new HostRecords({
      net: hn,
      hosted: hostedHere,
      // Taken over while this computer was away: what it has goes to the device hosting it now.
      elsewhere: (workspace, found) => void hostingHere().yieldTo(workspace, found).catch((e: unknown) => console.warn(`[hosting] could not hand over ${workspace.slice(0, 8)}…: ${e instanceof Error ? e.message : String(e)}`)),
      onWarn: (m) => console.warn(`[hosting] ${m}`),
    });
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

/** The `hive://` name of the workspace at `repo` when it was moved to another of the person's
 *  devices (M3): it is opened from there, as its owner; null while it is hosted here. */
export function movedAway(repo: string): string | null {
  if (!workspaceStore().repos().includes(repo)) return null;
  const workspace = workspaceStore().ownership(repo)?.workspaceId;
  if (typeof workspace !== "string" || !accessLists().workspaces().includes(workspace)) return null;
  const h = accessLists().hosting(workspace);
  return h && h.host !== machineIdentity().deviceId && joinedList().list().some((j) => j.workspace === workspace) ? `hive://${workspace}` : null;
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
    // A workspace of the person's hosted on another of their devices: its list, kept in step (M3).
    lists: accessLists(),
    // The workspace moved to another of its owner's devices (M3): where it is now, as the record
    // its key signed says, is where the next dial goes.
    moved: async (notice) => joinedList().follow(workspace, notice, await network()),
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

/** Connect to one of the person's devices, where it said it is reached when it paired. */
export async function dialDevice(device: string): Promise<Link> {
  const d = pairedDevices().list().find((x) => x.device === device);
  if (!d) throw new Error("that device is not one of yours: pair it under Settings → Devices");
  return (await network()).dial(device, { addrs: d.addrs, relay: d.relay });
}

/** Serve this computer's workspaces to whom the access lists let in. `daemon`: this computer's PTY
 *  daemon, where the person's other devices run terminals in frames here (none without one). */
/** Who is in the workspaces hosted here (`people.*`): the People panel and Share, at a window of
 *  this app's, or on another of the person's devices while a workspace of theirs is hosted here. */
export const peopleHere = new People({
  lists: accessLists,
  workspaceOf: (repo) => workspaceStore().ownership(repo)?.workspaceId ?? null,
  connected: (workspace) => peers?.connectedTo(workspace) ?? new Set<string>(),
  disconnect: (workspace, person, reason) => peers?.disconnect(workspace, person, reason),
  admit: admitNow,
  network: async () => ({ ready: (await network()).ready, profiles: networkProfiles() }),
  owner: () => displayName(getSettings().profile.name),
  // Until the workspace moves, the record of where it is hosted names the device the link does.
  keyOf: (workspace) => hostedAs(workspace).key,
  publishTo: (to, event, ...params) => apiServer?.publishTo(to, event, ...params),
  ownerHere: (workspace) => !!userWindow() || (peers?.connectedTo(workspace).has(machineIdentity().personId) ?? false),
});
/** The workspace API every window and device is answered by, once it is set up. */
let apiServer: WorkspaceServer | null = null;

export function installNetworkIpc(server: WorkspaceServer, daemon?: () => Promise<Duplex>): void {
  apiServer = server;
  peers = new PeerLinks({ store: workspaceStore(), changes: onWorkspaceChange, lists: accessLists(), server, daemon, hosting: hostingHere(), onWarn: (m) => console.warn(`[peers] ${m}`) });
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
  // The person's workspaces hosted on another of their devices: their documents and lists are kept
  // in step while this app is online, whether a window shows them or not (M3, design §5.8), so
  // the one taken over carries what was done meanwhile and who was let in.
  for (const j of joinedList().list()) {
    if (j.role !== "owner" || j.ended) continue;
    void openJoined(j.workspace, (event) => server.relay(event)).catch((e: unknown) => console.warn(`[network] ${j.workspace.slice(0, 8)}…: ${e instanceof Error ? e.message : String(e)}`));
  }
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

  // Move the workspace `repo`, hosted here, to another of the person's devices (M3, spec/hosting.md):
  // whoever is in it follows; its frames here stay here. Its `hive://` name, which this computer
  // opens it by from now on, as its owner, from the device it is on.
  handleEffect("net:move-hosting", (repo: unknown) => ({ target: typeof repo === "string" ? repo : undefined }), async (_e, repo: unknown, device: unknown) => {
    const to = pairedDevices().list().find((d) => d.device === device);
    if (typeof repo !== "string" || !repo || repo.startsWith("hive://")) throw new Error("move: only a workspace hosted here moves from here");
    if (!to) throw new Error("move: that is not one of your devices");
    const notice = await hostingHere().moveTo(repo, to.device);
    const workspace = workspaceStore().ownership(repo)!.workspaceId as string;
    joinedList().add({
      workspace, host: to.device, where: { addrs: to.addrs, relay: to.relay }, role: "owner",
      names: { workspace: path.basename(repo), host: to.name }, joinedAt: Date.now(), hosting: { key: hostedAs(workspace).key, lookup: null }, seq: notice.seq,
    });
    return `hive://${workspace}`;
  });

  // This computer's folder of a workspace moved from here, which it moves back to (M3).
  handle("net:folder-here", (_e, workspace: unknown) => (typeof workspace === "string" ? folderHere(workspace) : null));

  // Ask the device hosting `workspace`, moved from here, to hand it back (M3, spec/hosting.md):
  // whoever is in it follows. Its folder, which this computer opens it by again.
  handleEffect("net:move-hosting-here", (workspace: unknown) => ({ target: typeof workspace === "string" ? `hive://${workspace}` : undefined }), async (_e, workspace: unknown) => {
    const folder = typeof workspace === "string" ? folderHere(workspace) : null;
    const host = folder ? accessLists().hosting(workspace as string)!.host : null;
    if (!folder || !host) throw new Error("move: only a workspace moved from this computer moves back to it");
    await hostingHere().moveHere(workspace as string, host);
    return folder;
  });

  // Host a workspace moved from here again, from the copy kept here, while the device hosting it
  // cannot be reached (M3, §5.7 E): whoever is in it finds it here by its record. Its folder.
  handleEffect("net:take-over", (workspace: unknown) => ({ target: typeof workspace === "string" ? `hive://${workspace}` : undefined }), (_e, workspace: unknown) => {
    const folder = typeof workspace === "string" ? folderHere(workspace) : null;
    if (!folder) throw new Error("take over: only a workspace moved from this computer is hosted here again");
    if (sharedStatus(workspace as string)?.state === "connected") throw new Error("take over: its host answers; move it here instead");
    hostingHere().takeOver(workspace as string, folder, sharedStore().exportSince(`hive://${workspace as string}`, null));
    return folder;
  });

  // Leave a workspace joined here: its connection closes, and the last copy is kept, to read.
  handleEffect("net:leave", (workspace: unknown) => ({ target: typeof workspace === "string" ? `hive://${workspace}` : undefined }), (_e, workspace: unknown) => {
    if (typeof workspace !== "string" || !joinedStatus(workspace)) throw new Error("leave: that workspace was not joined here");
    leaveShared(workspace);
    joinedList().update(workspace, { ended: "left" });
    broadcast("net:shared-status", workspace, { state: "left", access: joinedStatus(workspace)!.access });
  });
}
