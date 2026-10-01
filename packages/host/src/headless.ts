/**
 * The headless host (R14; design §5.7): what `hive host` runs on a machine with no desktop — a
 * server, a VPS, a box in the office — so its workspaces stay reachable and the agents in them
 * keep running whatever the laptops do. It serves the workspace API the app serves (the same
 * domains, `domains.ts` and the rest of this package) from the data folder the app would use on
 * this machine: its keys, workspaces, access lists, network and audit log. Its terminals run in
 * the machine's PTY daemon, which keeps each agent's status (R6): the host mirrors it. Devices the
 * access lists admit reach it over hive-net.
 *
 * Nobody sits at it, so it asks nobody anything: someone asking to join is declined (the owner
 * invites from one of their devices), and an agent's approvals fall back to the agent's own
 * prompt, answered by whoever drives it. It becomes someone's by pairing with one of their
 * devices (spec/pairing.md): it takes their person, after which it is started again as them, and
 * each of their devices it was paired with is the owner of every workspace it holds.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";
import { DaemonEndpoint, REATTACH_RESET } from "@hivemind/agent-host/daemon-endpoint";
import { StatusStore, isSessionStatus } from "@hivemind/agent-host/status-store";
import { AccessLists } from "@hivemind/workspace-host/access";
import { Devices, type PairedDevice } from "@hivemind/workspace-host/devices";
import { enterPairing, formatPairLink, offeringNearby, pairAnnouncement, PairingOffer, parseCode, parsePairLink, type Pairing, type PairingDevice } from "@hivemind/workspace-host/pairing";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import { HiveNet, type Ready } from "@hivemind/workspace-host/hive-net";
import { Intents } from "@hivemind/workspace-host/intents";
import { adoptPerson, machineKeys } from "@hivemind/workspace-host/keyring";
import { NetworkProfiles } from "@hivemind/workspace-host/network-profile";
import { WorkspaceStore, type WorkspaceChange } from "@hivemind/workspace-host/store";
import { WorkspaceServer, type Connection } from "@hivemind/workspace-api/server";
import { toBareId } from "@hivemind/workspace-api/tile-id";
import { agents } from "./agents.js";
import { daemonSessions } from "./daemon-sessions.js";
import { workspaceDomains } from "./domains.js";
import { PeerLinks } from "./peer-links.js";
import { Plans } from "./plans.js";
import { presence } from "./presence.js";
import { makeSpawnPacer } from "./spawn-pacer.js";
import { Layouts } from "./store.js";
import { Terminals } from "./terminals.js";

export interface HeadlessHostOptions {
  /** The data folder, laid out as the app's on this machine. */
  dir: string;
  /** This machine's PTY daemon: a connection to it, started if it is not running. */
  daemon(): Promise<Duplex>;
  /** hive-net's executable; null keeps the host off the network (nobody else reaches it). */
  hiveNet: string | null;
  onWarn(message: string): void;
}

export interface HeadlessHost {
  /** This device's key: its id on the network. */
  readonly device: string;
  /** The person it is. */
  readonly person: string;
  /** Where it is reached now; null while it is not on the network. */
  where(): Ready | null;
  /** The workspaces it holds, by folder, with their ids once they say whose they are. */
  workspaces(): Array<{ repo: string; workspace: string | null }>;
  /** Serve the folder `repo` on this machine as one of its workspaces, made if it is new. */
  add(repo: string): { repo: string; workspace: string };
  /** The person's other devices it was paired with. */
  devices(): PairedDevice[];
  /** Offer a code for one of a person's devices to enter (this host takes the person). `paired`
   *  resolves with that device once it has, when the host must be started again, as that person;
   *  it rejects when the code expires first. */
  offerPairing(): { code: string; link: string; expires: number; paired: Promise<PairedDevice> };
  /** Enter the code or link another device offers. Resolves with that device once paired, when the
   *  host must be started again, as that person. */
  enterPairing(text: string): Promise<PairedDevice>;
  stop(): Promise<void>;
}

/** This machine's name, as the person's other devices list it. */
const deviceName = (): string => os.hostname() || "host";

/** hive-net's socket: in the data folder, unless the path is too long for a socket. */
function netSocket(dir: string): string {
  const tag = createHash("sha256").update(dir).digest("hex").slice(0, 12);
  if (process.platform === "win32") return `\\\\.\\pipe\\hivemind-net-${tag}`;
  const inData = path.join(dir, "hive-net.sock");
  return inData.length < 100 ? inData : path.join(os.tmpdir(), `hivemind-net-${tag}.sock`);
}

export async function startHeadlessHost(o: HeadlessHostOptions): Promise<HeadlessHost> {
  const identity = path.join(o.dir, "identity");
  const keys = machineKeys(identity, o.onWarn);
  const intents = new Intents(new AuditLog({ file: path.join(o.dir, "audit.jsonl"), onWarn: o.onWarn }));
  const devices = new Devices(path.join(identity, "devices.json"));
  const lists = new AccessLists({
    dir: path.join(o.dir, "access"),
    owner: keys.person,
    devices: () => devices.list().map((d) => d.certificate),
    onWarn: o.onWarn,
  });
  const heard = new Set<(change: WorkspaceChange) => void>();
  const workspacesDir = path.join(o.dir, "workspaces");
  // A change is made by a client, so after the server below is there to tell the others.
  const store = new WorkspaceStore({
    dir: workspacesDir,
    person: keys.person,
    onWarn: o.onWarn,
    onChange: (change) => {
      api.publishTo((c) => !layouts.made(c, change), "store.changed", { repo: change.repo, part: change.part });
      for (const l of heard) l(change);
    },
  });
  const layouts = new Layouts(() => store);

  // Each session's status as the daemon that runs it keeps it (R6).
  const statuses = new StatusStore();
  const endpoint = new DaemonEndpoint({
    connect: o.daemon,
    onEvent: (topic, data) => {
      if (topic !== "agent.status") return;
      const r = data as { tileId?: unknown; status?: unknown };
      if (typeof r.tileId === "string" && isSessionStatus(r.status)) statuses.mirror(toBareId(r.tileId), r.status);
    },
  });
  // Connected now, so the statuses of the sessions already running arrive before anyone asks.
  await endpoint.sessions();

  const nameOf = (person: string): string => {
    for (const ws of lists.workspaces()) {
      const found = lists.people(ws).find((p) => p.person === person);
      if (found?.name) return found.name;
    }
    return "";
  };
  const who = (c: Connection) => (c.actor.kind === "peer" ? { person: c.actor.person, name: nameOf(c.actor.person) } : { person: keys.personId, name: "" });
  const terminals = new Terminals({
    intents,
    relay: { record: () => {}, screenPrefix: REATTACH_RESET },
    publish: (event, ...params) => api.publish(event, ...params),
    who,
    onError: o.onWarn,
    backend: daemonSessions({
      endpoint,
      pace: makeSpawnPacer({ windowMs: 10_000, max: 24, queueMax: 128 }),
      ended: (tile) => statuses.forget(toBareId(tile)),
    }),
  });
  const plans = new Plans({ publish: (event, ...params) => api.publish(event, ...params), who, repoOf: (bare) => store.workspaceOf(bare) });
  const api: WorkspaceServer = new WorkspaceServer([
    ...workspaceDomains,
    layouts.domain,
    agents({ statuses: () => statuses.all(), links: () => ({ pipes: [], spawns: [] }) }),
    terminals.domain,
    plans.domain,
    presence(() => api, () => keys.personId),
  ], intents, o.onWarn);
  statuses.subscribe((change) => api.publish("status.changed", change));

  // On the network: hive-net admits the devices the access lists let in, and each is served the
  // workspace it names. hive-net that stops is started again, as is one whose network changed.
  const peers = new PeerLinks({
    store,
    changes: (listener) => { heard.add(listener); return () => { heard.delete(listener); }; },
    lists,
    server: api,
    onWarn: o.onWarn,
  });
  let net: HiveNet | null = null;
  let stopping = false;
  let again: ReturnType<typeof setTimeout> | null = null;
  const profiles = o.hiveNet ? new NetworkProfiles({ dir: path.join(o.dir, "network"), bin: o.hiveNet, identity }) : null;
  const startNet = async (): Promise<void> => {
    again = null;
    if (!o.hiveNet || !profiles || stopping) return;
    try {
      const started = await HiveNet.start({
        bin: o.hiveNet,
        identity,
        socket: netSocket(o.dir),
        profile: profiles.arg(),
        onIncoming: (link) => peers.serve(link),
        // A device of a person entering the code offered here; nobody here can let anyone else in.
        onPairRequest: async (peer, hello) => ((hello as { pair?: unknown } | null)?.pair && offer ? offer.answer(peer, hello) : { ok: false, error: "declined" }),
        onExit: (why) => {
          net = null;
          if (stopping) return;
          o.onWarn(`hive-net: ${why}; starting it again`);
          again = setTimeout(() => void startNet(), 2_000);
        },
      });
      if (stopping) return started.stop();
      started.admit(lists.admitted());
      net = started;
    } catch (e) {
      o.onWarn(`hive-net did not start: ${e instanceof Error ? e.message : String(e)}; trying again`);
      again = setTimeout(() => void startNet(), 5_000);
    }
  };
  await startNet();
  // The network in use changed (`hive network use`): on it from now.
  const watching = profiles?.file;
  if (watching) {
    fs.watchFile(watching, { interval: 2_000 }, (now, before) => {
      if (now.mtimeMs === before.mtimeMs || !net) return;
      const was = net;
      net = null;
      was.stop();
      void startNet();
    });
  }

  // Pairing (spec/pairing.md): this host takes the person, and keeps the device it paired with.
  const me = (): PairingDevice => ({
    device: keys.deviceId, name: deviceName(), kind: "host", certificate: keys.certificate, person: keys.person,
    addrs: net?.ready.addrs ?? [], relay: net?.ready.relay ?? null,
  });
  const mayTake = (): void => {
    if (lists.workspaces().some((ws) => lists.people(ws).length > 0)) {
      throw new Error("this host already has workspaces others were let into: pairing would make them no longer their owner's");
    }
  };
  const keep = (pairing: Pairing): PairedDevice => {
    if (pairing.person) {
      adoptPerson(identity, pairing.person, o.onWarn);
      // Its workspaces are the person's now: their documents name them, and their keys derive from them.
      store.takePerson(pairing.person);
    }
    const paired: PairedDevice = { ...pairing.with, pairedAt: Date.now() };
    devices.add(paired);
    return paired;
  };
  let offer: PairingOffer | null = null;

  return {
    device: keys.deviceId,
    person: keys.personId,
    where: () => net?.ready ?? null,
    workspaces: () => store.repos().map((repo) => ({ repo, workspace: store.ownership(repo)?.workspaceId ?? null })),
    add: (repo) => {
      if (!path.isAbsolute(repo) || !fs.statSync(repo, { throwIfNoEntry: false })?.isDirectory()) {
        throw new Error(`${repo} is not a folder on this machine`);
      }
      if (!store.getCore(repo)) store.setCore(repo, { frames: [], tiles: [] });
      return { repo, workspace: store.ownership(repo)!.workspaceId as string };
    },
    devices: () => devices.list(),
    offerPairing: () => {
      mayTake();
      const ready = net?.ready;
      if (!ready) throw new Error("this host is not on the network yet: is hive-net installed beside hive?");
      let settle!: (pairing: Pairing) => void;
      const settled = new Promise<Pairing>((resolve) => { settle = resolve; });
      const made = new PairingOffer(me(), (pairing) => settle(pairing));
      offer = made;
      // Found from its words by the devices on this network, while the code is open.
      net?.advertise(pairAnnouncement(made.code));
      const paired = new Promise<PairedDevice>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("the code expired before a device entered it")), made.expires - Date.now());
        void settled.then((pairing) => { clearTimeout(timer); resolve(keep(pairing)); });
      }).finally(() => {
        if (offer !== made) return;
        offer = null;
        net?.advertise(null);
      });
      const link = formatPairLink({ device: keys.deviceId, addrs: ready.addrs, relay: ready.relay, code: made.code, name: deviceName(), kind: "host" });
      return { code: made.code, link, expires: made.expires, paired };
    },
    enterPairing: async (text) => {
      mayTake();
      const link = parsePairLink(text);
      const code = link?.code ?? parseCode(text);
      if (!code) throw new Error("that is not a pairing code or link");
      if (!net) throw new Error("this host is not on the network yet: is hive-net installed beside hive?");
      const on = net;
      // From the words alone, the device offering them on this network; a link says where it is.
      const offering = link?.device ?? (await offeringNearby(code, () => on.nearby()));
      const where = link ? { addrs: link.addrs, relay: link.relay } : { addrs: [], relay: null };
      return keep(await enterPairing({ me: me(), code, offering, ask: (hello) => on.pair(offering, where, hello) }));
    },
    stop: async () => {
      stopping = true;
      if (again) clearTimeout(again);
      if (watching) fs.unwatchFile(watching);
      net?.stop();
      // The sessions stay in the daemon; only this host's connection to it goes.
      endpoint.close();
      store.flush();
    },
  };
}
