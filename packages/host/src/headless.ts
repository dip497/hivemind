/**
 * The headless host (R14; design §5.7): what `hive host` runs on a machine with no desktop — a
 * server, a VPS, a box in the office — so its workspaces stay reachable and the agents in them
 * keep running whatever the laptops do. It serves the workspace API the app serves (the same
 * domains, `domains.ts` and the rest of this package) from the data folder the app would use on
 * this machine: its keys, workspaces, access lists, network and audit log. Its terminals run in
 * the machine's PTY daemon, which keeps each agent's status (R6): the host mirrors it. Devices the
 * access lists admit reach it over hive-net. Its agents are driven by its control plane (`hive
 * ctl`, `control/plane.ts`), as the app's are: the daemon passes the machine's control-plane
 * socket on to it, and the host starts the sessions of the tiles it spawns itself.
 *
 * Nobody sits at it: someone asking to join is asked about at the owner's devices connected to it,
 * and declined when none is; an agent's approvals go to the agent that supervises it or
 * fall back to the agent's own prompt, answered by whoever drives it, and a verb that needs a
 * window (focus, a plan's review, a view) is refused. It becomes someone's by pairing with one of
 * their devices (spec/pairing.md): it takes their person, after which it is started again as them,
 * and each of their devices it was paired with is the owner of every workspace it holds.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";
import { DaemonEndpoint, REATTACH_RESET } from "@hivemind/agent-host/daemon-endpoint";
import { hcpSockPath } from "@hivemind/agent-host/hooks/token";
import { tileStatusOf } from "@hivemind/agent-host/tile-status";
import { agentForCmd, preferredAgent, setCatalog } from "@hivemind/agents";
import { findBin } from "@hivemind/agents/discover";
import { loadAgents, userAgentsDir } from "@hivemind/agents/load";
import { readSettings } from "@hivemind/core/settings";
import type { Settings } from "@hivemind/core/settings-schema";
import { AccessLists } from "@hivemind/workspace-host/access";
import { Devices, type PairedDevice } from "@hivemind/workspace-host/devices";
import { enterPairing, formatPairLink, offeringNearby, pairAnnouncement, PairingOffer, parseCode, parsePairLink, type Pairing, type PairingDevice } from "@hivemind/workspace-host/pairing";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import { Sharing } from "@hivemind/workspace-host/sharing";
import { HiveNet, type Link, type Ready } from "@hivemind/workspace-host/hive-net";
import { HostRecords, type Hosted } from "@hivemind/workspace-host/host-records";
import { idOf, workspaceSeed } from "@hivemind/workspace-host/identity";
import { Intents } from "@hivemind/workspace-host/intents";
import { adoptPerson, machineKeys } from "@hivemind/workspace-host/keyring";
import { NetworkProfiles } from "@hivemind/workspace-host/network-profile";
import { WorkspaceStore, type WorkspaceChange } from "@hivemind/workspace-host/store";
import { WorkspaceServer, type Connection } from "@hivemind/workspace-api/server";
import { toBareId } from "@hivemind/workspace-api/tile-id";
import { agents } from "./agents.js";
import { ControlPlane } from "./control/plane.js";
import { HcpError } from "./control/protocol.js";
import { daemonSessions } from "./daemon-sessions.js";
import { deviceSessions, onDevices, participantAt } from "./device-sessions.js";
import { Hosting } from "./hosting.js";
import { workspaceDomains } from "./domains.js";
import { HANDED_OFF, handOff } from "./hand-off.js";
import { answers } from "./answers.js";
import { PeerLinks } from "./peer-links.js";
import { People } from "./people.js";
import { Plans } from "./plans.js";
import { presence } from "./presence.js";
import { makeSpawnPacer } from "./spawn-pacer.js";
import { startSpawned } from "./spawned.js";
import { Layouts } from "./store.js";
import { Terminals, type SessionBackend } from "./terminals.js";

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

/** A socket of this host's: `file` in the data folder, unless the path is too long for a socket
 *  (then `hivemind-<tag>` in the temporary folder); a named pipe on Windows. */
function socketIn(dir: string, file: string, tag: string): string {
  const hash = createHash("sha256").update(dir).digest("hex").slice(0, 12);
  if (process.platform === "win32") return `\\\\.\\pipe\\hivemind-${tag}-${hash}`;
  const inData = path.join(dir, file);
  return inData.length < 100 ? inData : path.join(os.tmpdir(), `hivemind-${tag}-${hash}.sock`);
}

/** The agents this machine has and the person's settings for them, as the app reads them: read
 *  at the start, and again before a verb once an agent was installed or removed. */
function agentCatalog(settingsFile: string): { current(): Promise<void>; settings(): Settings } {
  let settings: Settings | null = null;
  let stamp: number | undefined;
  let reading: Promise<void> | null = null;
  const dirStamp = () => fs.statSync(userAgentsDir(), { throwIfNoEntry: false })?.mtimeMs;
  const read = async () => {
    stamp = dirStamp();
    settings = await readSettings(settingsFile);
    setCatalog((await loadAgents({ disabled: settings.agents.disabled })).defs);
  };
  return {
    current: () => (settings && dirStamp() === stamp ? Promise.resolve() : (reading ??= read().finally(() => { reading = null; }))),
    settings: () => settings ?? (() => { throw new Error("the agents are not read yet"); })(),
  };
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

  // What the daemon tells of its sessions: each one's status as it keeps it (R6), what their hooks
  // reported while no control plane held its socket, what it reads of their screens.
  const endpoint = new DaemonEndpoint({ connect: o.daemon, onEvent: (topic, data) => control.fromMachine(topic, data) });

  const nameOf = (person: string): string => {
    for (const ws of lists.workspaces()) {
      const found = lists.people(ws).find((p) => p.person === person);
      if (found?.name) return found.name;
    }
    return "";
  };
  const who = (c: Connection) => (c.actor.kind === "peer" ? { person: c.actor.person, name: nameOf(c.actor.person) } : { person: keys.personId, name: "" });
  // Frames on the person's other devices run their terminals there (M3), in each device's daemon.
  /** One of the person's devices, where it is said to be when it paired. */
  const dialDevice = async (device: string): Promise<Link> => {
    if (!net) throw new Error("this host is not on the network yet");
    const d = devices.list().find((x) => x.device === device);
    return net.dial(device, d ? { addrs: d.addrs, relay: d.relay } : undefined);
  };
  const mine = (device: string): boolean => devices.list().some((d) => d.device === device);
  const elsewhere = deviceSessions({
    dial: dialDevice,
    mine,
    // A participant's machine (M4): watched, as their app shows it here.
    shown: (device, tile) => peers.shownFrom(device, tile),
    onEvent: (topic, data) => control.fromMachine(topic, data),
  });
  const sessions = onDevices(keys.deviceId, daemonSessions({ endpoint, pace: makeSpawnPacer({ windowMs: 10_000, max: 24, queueMax: 128 }) }), elsewhere);
  const holds = (tile: string): boolean => endpoint.has(tile) || elsewhere.holds(tile);
  /** Type into a session held here now; false when none is. */
  const writeTile = (ptyId: string, data: string, paste?: boolean): boolean => {
    if (!holds(ptyId)) return false;
    sessions.write(ptyId, data, paste);
    return true;
  };
  // Every session as the control plane needs it: which agent runs in it, a supervised worker's
  // policy in its environment, its output for whoever streams it, its end, and a person's keys.
  const backend: SessionBackend = {
    ...sessions,
    start: (opts, out) => {
      const bare = toBareId(opts.tileId);
      const def = agentForCmd(opts.cmd);
      if (def) control.agentOf.set(bare, def.id);
      else control.agentOf.delete(bare);
      const supervise = control.supervise.get(bare);
      return sessions.start(supervise ? { ...opts, env: { ...opts.env, HIVE_SUPERVISE: supervise } } : opts, {
        data: (data, replay) => { control.output(bare, data); out.data(data, replay); },
        exit: (code, signal) => { out.exit(code, signal); control.exited(opts.tileId); },
        size: out.size,
      });
    },
    write: (tile, data, paste) => { control.status.input(toBareId(tile), data); sessions.write(tile, data, paste); },
    // A daemon tells its killer nothing of the exit: what waits on the session is answered now.
    kill: (tile) => { sessions.kill(tile); control.exited(tile); control.forget(tile); },
  };
  const terminals = new Terminals({
    intents,
    relay: { record: (tile, data) => control.recorder.record(tile, data), screenPrefix: REATTACH_RESET },
    askedByHost: (bare) => control.takeSpawned(bare),
    publish: (event, ...params) => api.publish(event, ...params),
    who,
    // A terminal on a participant's machine is typed into and sized there, by its person (M4).
    machineOf: (opts) => participantAt(opts, { self: keys.deviceId, mine, lists, nameOf, shown: (device, tile) => peers.shownFrom(device, tile) }),
    onError: o.onWarn,
    backend,
  });
  const plans = new Plans({ publish: (event, ...params) => api.publish(event, ...params), who, repoOf: (bare) => store.workspaceOf(bare) });
  // Who is in its workspaces: their owner manages them, and is asked about someone asking to join,
  // from any of their devices connected here.
  const peopleHere = new People({
    lists: () => lists,
    workspaceOf: (repo) => store.ownership(repo)?.workspaceId ?? null,
    connected: (workspace) => peers.connectedTo(workspace),
    disconnect: (workspace, person, reason) => peers.disconnect(workspace, person, reason),
    admit: () => net?.admit(lists.admitted()),
    network: async () => {
      if (!net || !profiles) throw new Error("this host is not on the network yet: is hive-net installed beside hive?");
      return { ready: net.ready, profiles };
    },
    owner: async () => catalog.settings().profile.name || deviceName(),
    keyOf: (workspace) => idOf(workspaceSeed(keys.person, workspace)),
    publishTo: (to, event, ...params) => api.publishTo(to, event, ...params),
    ownerHere: (workspace) => peers.connectedTo(workspace).has(keys.personId),
  });
  const sharing = new Sharing(lists, (request) => peopleHere.ask(request), (devices) => net?.admit(devices));
  const api: WorkspaceServer = new WorkspaceServer([
    ...workspaceDomains,
    layouts.domain,
    agents({ statuses: () => control.status.all(), links: () => control.links() }),
    terminals.domain,
    plans.domain,
    presence(() => api, () => keys.personId),
    peopleHere.domain,
    // A participant's branch, handed off from their machine (M4).
    handOff({ who, place: (repo, tile, name) => { store.addTile(repo, tile, { name }, HANDED_OFF); } }),
    // What an agent here waits on the person for, answered from another of their devices (M5).
    answers({ status: (bare) => control.status.get(bare), type: (bare, data) => writeTile(`hm:${bare}`, data), plans }),
  ], intents, o.onWarn);

  // The control plane (`hive ctl`): the verbs that need no window, for the agents here and for
  // whoever is at this machine. The agents and settings are the app's, read from this data folder.
  const catalog = agentCatalog(path.join(o.dir, "settings.json"));
  await catalog.current();
  const control: ControlPlane = new ControlPlane({
    dir: () => o.dir,
    publish: (event, ...params) => api.publish(event, ...params),
    write: writeTile,
    // Nobody lays a spawned tile out: the host starts it, once it is in its workspace.
    spawned: (spawn) => {
      control.takeSpawned(spawn.tileId);
      queueMicrotask(() => void startSpawned({
        store, terminals, holds,
        write: (ptyId, data, paste) => sessions.write(ptyId, data, paste),
        status: (bare) => { const s = control.status.get(bare); return s && tileStatusOf(s).status; },
        screen: (ptyId) => (endpoint.has(ptyId) ? endpoint.viewport(ptyId) : Promise.resolve(null)),
        onWarn: o.onWarn,
      }, spawn));
    },
    windowsUp: () => false,
    ready: () => catalog.current(),
    methods: () => ({
      callRenderer: () => Promise.reject(new HcpError("APP_NO_RENDERER", "there is no window here: hive host runs none")),
      reloadSettings: () => catalog.current().then(() => ({ ok: true })),
      defaultAgentId: () => preferredAgent(catalog.settings().agents.defaultAgent, (d) => !!findBin(d.bin))?.id,
      agentInstalled: (def) => !!findBin(def.bin),
      workspaces: store,
      // A caller in no tile acts on the one workspace this host serves, when it serves one.
      shownWorkspace: () => { const repos = store.repos(); return repos.length === 1 ? { repo: repos[0]!, frame: null } : null; },
      launchOptions: (agentId) => catalog.settings().agents.options[agentId] ?? {},
      endSession: (ptyId) => terminals.end(ptyId),
      sessionHeld: holds,
      intents,
    }),
  });
  // Connected now, so the statuses of the sessions already running arrive before anyone asks.
  await endpoint.sessions();
  // The machine's control-plane socket stays the daemon's, which passes each connection on to this
  // host's own. A daemon the app started serves none (nor does one from before this), and this host
  // serves the machine's itself.
  const hcpWarn = (e: Error) => o.onWarn(`the control plane is off: ${e.message}. \`hive ctl\` cannot reach this host`);
  const ownSocket = socketIn(o.dir, "hcp-host.sock", "hcp-host");
  let hcp = control.listen(ownSocket, hcpWarn);
  try {
    await endpoint.control(ownSocket);
  } catch (e) {
    o.onWarn(`the terminal daemon keeps no control-plane socket to hand over (${e instanceof Error ? e.message : String(e)}): serving the machine's here`);
    hcp.close();
    hcp = control.listen(hcpSockPath(o.dir), hcpWarn);
  }

  // On the network: hive-net admits the devices the access lists let in, and each is served the
  // workspace it names. hive-net that stops is started again, as is one whose network changed.
  // Workspaces the person's other devices hand over to be hosted here, and ask back (M3,
  // spec/hosting.md).
  const hosting = new Hosting({
    self: () => keys.deviceId,
    person: () => keys.personId,
    store,
    lists,
    dial: dialDevice,
    sign: async (workspace, seq, host) => {
      if (!net) throw new Error("this host is not on the network yet");
      return net.signHost(workspace, seq, host);
    },
    moved: (workspace, notice) => peers.moved(workspace, notice),
    took: () => {
      net?.admit(lists.admitted());
      void records?.start();
    },
    onWarn: o.onWarn,
  });
  const peers = new PeerLinks({
    store,
    changes: (listener) => { heard.add(listener); return () => { heard.delete(listener); }; },
    lists,
    server: api,
    // The person's devices run terminals here, in frames on this machine (M3).
    daemon: o.daemon,
    hosting,
    // A participant who lends their machine's keyboards, or keeps them again (M4).
    granted: (device) => terminals.machineChanged(`peer:${device}`),
    // What waits on the person here, for their devices to ask (M5).
    statuses: () => control.status.all(),
    plans: () => plans.reviews(),
    onWarn: o.onWarn,
  });
  /** The workspaces shared with someone that are hosted here, as their records are filed. */
  const hostedHere = (): Hosted[] => lists.workspaces().flatMap((workspace) => {
    const h = lists.hosting(workspace);
    if (h && h.host !== keys.deviceId) return [];
    return [{ workspace, key: idOf(workspaceSeed(keys.person, workspace)), ...(h ? { seq: h.seq } : {}) }];
  });
  let records: HostRecords | null = null;
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
        socket: socketIn(o.dir, "hive-net.sock", "net"),
        profile: profiles.arg(),
        onIncoming: (link) => peers.serve(link),
        // A device of a person entering the code offered here, or someone asking to join, whom the
        // owner is asked about at their devices connected here.
        onPairRequest: async (peer, hello) => ((hello as { pair?: unknown } | null)?.pair ? (offer ? offer.answer(peer, hello) : { ok: false, error: "declined" }) : sharing.answer(peer, hello)),
        onExit: (why) => {
          net = null;
          records?.stop();
          records = null;
          if (stopping) return;
          o.onWarn(`hive-net: ${why}; starting it again`);
          again = setTimeout(() => void startNet(), 2_000);
        },
      });
      if (stopping) return started.stop();
      started.admit(lists.admitted());
      net = started;
      // On a network with a lookup server, where the workspaces hosted here are; one taken over
      // while this host was away is handed to the device hosting it now.
      records = new HostRecords({
        net: started,
        hosted: hostedHere,
        elsewhere: (workspace, found) => void hosting.yieldTo(workspace, found).catch((e: unknown) => o.onWarn(`could not hand over workspace ${workspace.slice(0, 8)}…: ${e instanceof Error ? e.message : String(e)}`)),
        onWarn: o.onWarn,
      });
      void records.start();
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
      records?.stop();
      net?.stop();
      // The sessions stay in the daemons; only this host's connections to them go, and the daemon
      // answers on the control-plane socket again.
      hcp.close();
      endpoint.close();
      elsewhere.close();
      store.flush();
    },
  };
}
