// `hive host` (R14): the headless host is this machine's device, the one the app is here (its keys
// are the app's, in the app's data folder), on the network as that device; it is the only host on
// the machine — a second one, or one while the app runs, is refused and the first keeps serving;
// and it stops when asked. A laptop pairs with it (spec/pairing.md), after which the host is the
// laptop's person, the workspaces it held moving with it, lists them to the laptop and opens one to
// it as its owner; a terminal the laptop starts there runs on after the laptop is gone. The laptop
// moves a workspace it shares to the host (spec/hosting.md): the host takes it, says so at the
// network's lookup server, and the guest in it follows; then it asks for it back, and the guest
// follows it home; moved there again and the host gone, the laptop hosts it from the copy it kept,
// and the host, back, hands over what it had. Its owner, at the laptop, manages who is in a
// workspace it hosts (the workspace API's people.*), is asked there about someone joining, and
// keeps its list in step. Here the laptop is this test, with keys and a hive-net of its own. With
// no window, its person shares from the command line: `hive share` makes the link, another host
// asks with `hive join`, and `hive people` answers, at another role if they choose; a workspace
// that lets in anyone with a valid link asks nobody.
// Needs crates/hive-net's build.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { cmd, hive, hiveAsync } from "./helpers.js";
import { idOf, newSeed, workspaceSeed, type DeviceCertificate } from "@hivemind/workspace-host/identity";
import { machineKeys } from "@hivemind/workspace-host/keyring";
import { HiveNet, type Where } from "@hivemind/workspace-host/hive-net";
import { enterPairing, pairAnnouncement, PairingOffer, parsePairLink, type Pairing } from "@hivemind/workspace-host/pairing";
import { WorkspaceStore, type WorkspaceChange } from "@hivemind/workspace-host/store";
import { replicate } from "@hivemind/workspace-host/doc-sync";
import { followList } from "@hivemind/workspace-host/list-sync";
import { parseJoinLink } from "@hivemind/workspace-host/join-link";
import type { JoinQuestion, JoinRequests, PersonHere } from "@hivemind/workspace-api/people";
import type { Access } from "@hivemind/workspace-host/access";
import { peerTransport, workspaceUrl } from "@hivemind/workspace-api/peers";
import { WorkspaceClient } from "@hivemind/workspace-api/client";
import { heldWorkspaces, streamOf } from "@hivemind/host/peer-links";
import { deviceSessions } from "@hivemind/host/device-sessions";
import { Hosting } from "@hivemind/host/hosting";
import { PeerLinks } from "@hivemind/host/peer-links";
import { machineUri } from "@hivemind/core/remote-uri";
import { AccessLists } from "@hivemind/workspace-host/access";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import { Intents } from "@hivemind/workspace-host/intents";
import type { Moved } from "@hivemind/workspace-host/doc-sync";
import { WorkspaceServer } from "@hivemind/workspace-api/server";

setDefaultTimeout(90_000);
const HIVE_NET = path.resolve(import.meta.dir, "../../../crates/hive-net/target/debug/hive-net");
const unix = process.platform !== "win32";
const built = unix && fs.existsSync(HIVE_NET);

// sun_path is ~108 bytes; os.tmpdir() can be deep, /tmp is not.
const dir = unix ? fs.mkdtempSync("/tmp/hive-host-") : "";
const appData = path.join(dir, "data");
const env = { HIVEMIND_APP_DATA: appData, HIVEMIND_HIVE_NET: HIVE_NET, HIVEMIND_PTY_SOCK: path.join(dir, "d.sock"), HIVEMIND_SHELL_ENV: "0" };
const data = <T>(r: ReturnType<typeof hive>) => (r.json as { data: T }).data;
const running: ChildProcess[] = [];

function runHost(on: Record<string, string> = env): ChildProcess {
  const c = spawn(...cmd(["host", "run"]), { env: { ...process.env, ...on }, stdio: "ignore" });
  running.push(c);
  return c;
}
async function until<T>(get: () => T | null | undefined | false | Promise<T | null | undefined | false>, what: string, ms = 30_000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) {
    const v = await get();
    if (v) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
}

afterAll(() => {
  for (const c of running) c.kill("SIGKILL");
  if (unix) hive(["daemon", "stop"], { env });
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Status {
  running: boolean;
  pid: number;
  device: string;
  person: string;
  network: { id: string } | null;
  devices: Array<{ device: string; name: string; kind: string }>;
  workspaces: Array<{ repo: string; workspace: string | null }>;
}
/** The host's status; undefined while it is starting. */
const status = (on: Record<string, string> = env) => data<Status | undefined>(hive(["host", "status", "--json"], { env: on }));

/** A network with a lookup server and no relays, as its admin signed it, its files in `at`: the
 *  signed profile's file. */
async function lookupNetwork(at: string): Promise<string> {
  fs.mkdirSync(at, { recursive: true });
  const server = spawn(HIVE_NET, ["serve", "--lookup", "--data", path.join(at, "lookup"), "--bind", "127.0.0.1:0", "--lookup-limit", "off"], { stdio: ["ignore", "pipe", "ignore"] });
  running.push(server);
  const lookup = await new Promise<string>((resolve) => {
    let out = "";
    server.stdout!.on("data", (d: Buffer) => {
      out += d.toString();
      const m = /lookup serving on (\S+)/.exec(out);
      if (m) resolve(m[1]!);
    });
  });
  const admin = path.join(at, "admin.key");
  fs.writeFileSync(admin, `${"ab".repeat(32)}\n`);
  const by = (JSON.parse(execFileSync(HIVE_NET, ["access", "voucher", "--kind", "enrol", "--admin", admin], { encoding: "utf8" })) as { by: string }).by;
  const text = path.join(at, "profile.json");
  fs.writeFileSync(text, JSON.stringify({ v: 1, name: "Test network", relays: [], lookup, admin: by, local: { mdns: true } }));
  const profile = path.join(at, "network.json");
  fs.writeFileSync(profile, execFileSync(HIVE_NET, ["profile", "sign", text, "--admin", admin], { encoding: "utf8" }));
  return profile;
}

/** The lines a process prints, one at a time. */
function lines(stream: NodeJS.ReadableStream): () => Promise<string> {
  const ready: string[] = [];
  const waiting: Array<(line: string) => void> = [];
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (d: string) => {
    buffer += d;
    for (let nl = buffer.indexOf("\n"); nl !== -1; nl = buffer.indexOf("\n")) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const w = waiting.shift();
      if (w) w(line); else ready.push(line);
    }
  });
  return () => new Promise((resolve) => { const l = ready.shift(); if (l !== undefined) resolve(l); else waiting.push(resolve); });
}

describe.skipIf(!built)("hive host", () => {
  test("serves as this machine's device, on the network; the only host here; stops when asked", async () => {
    const first = runHost();
    const status = await until(() => {
      const s = data<Status | undefined>(hive(["host", "status", "--json"], { env }));
      return s?.running ? s : null;
    }, "the host to answer");
    // The app's keys, in the app's data folder: the host and the app are one device here.
    const deviceKey = fs.readFileSync(path.join(appData, "identity", "device.key"), "utf8").trim();
    expect(status.device).toBe(idOf(new Uint8Array(Buffer.from(deviceKey, "hex"))));
    expect(status.pid).toBe(first.pid!);
    expect(status.network?.id).toBe(status.device);

    // A second host is refused, and the first keeps serving.
    const second = hive(["host", "run", "--json"], { env });
    expect(second.code).toBe(3);
    expect(second.json).toMatchObject({ ok: false, code: "already_running" });
    expect(data<Status>(hive(["host", "status", "--json"], { env })).pid).toBe(first.pid!);

    expect(data<{ stopped: boolean }>(hive(["host", "stop", "--json"], { env })).stopped).toBe(true);
    expect(data<Status>(hive(["host", "status", "--json"], { env })).running).toBe(false);
    await until(() => first.exitCode !== null || first.signalCode !== null, "the host to exit");
    expect(first.exitCode).toBe(0);
  });

  test("a laptop pairs with it, finds the workspace it holds and opens it as the owner; a terminal started there runs on after the laptop goes", async () => {
    const repo = path.join(dir, "api");
    fs.mkdirSync(repo);
    runHost();
    await until(() => status()?.running || null, "the host to answer");
    const added = data<{ repo: string; workspace: string }>(hive(["host", "add", repo, "--json"], { env }));
    expect(added.repo).toBe(repo);

    // The laptop: keys and a hive-net of its own.
    const identity = path.join(dir, "laptop", "identity");
    const keys = machineKeys(identity);
    const laptop = await HiveNet.start({
      bin: HIVE_NET, identity, socket: path.join(dir, "l.sock"),
      onIncoming: (link) => link.close(), onPairRequest: async () => ({ ok: false, error: "declined" }),
    });
    try {
      // The host shows a code; the laptop enters its link.
      const pairing = spawn(...cmd(["host", "pair", "--json"]), { env: { ...process.env, ...env } });
      running.push(pairing);
      const printed = lines(pairing.stdout!);
      const offer = (JSON.parse(await printed()) as { data: { offer: { link: string } } }).data.offer;
      const link = parsePairLink(offer.link)!;
      const where = { addrs: link.addrs, relay: link.relay };
      const paired = await enterPairing({
        me: { device: keys.deviceId, name: "laptop", kind: "app", certificate: keys.certificate, person: keys.person, addrs: laptop.ready.addrs, relay: laptop.ready.relay },
        code: link.code, offering: link.device, ask: (hello) => laptop.pair(link.device, where, hello),
      });
      expect(paired.with).toMatchObject({ device: link.device, kind: "host" });
      expect(JSON.parse(await printed())).toMatchObject({ ok: true, data: { paired: { device: keys.deviceId, name: "laptop", kind: "app" } } });

      // The host is the laptop's person now, and knows the laptop.
      const now = await until(() => { const s = status(); return s?.running && s.person === keys.personId ? s : null; }, "the host to be the laptop's person");
      expect(now.devices).toEqual([{ device: keys.deviceId, name: "laptop", kind: "app" }]);

      // It tells the laptop which workspaces it holds.
      const asking = await laptop.dial(link.device, where);
      expect(await heldWorkspaces(asking)).toEqual([{ workspace: added.workspace, name: "api", repo }]);
      asking.close();

      // The laptop opens it, as its owner.
      const heard = new Set<(change: WorkspaceChange) => void>();
      const replicas = new WorkspaceStore({ dir: path.join(dir, "laptop", "shared"), onChange: (c) => { for (const l of heard) l(c); } });
      const url = workspaceUrl(added.workspace);
      const opened = await laptop.dial(link.device, where);
      const access = await new Promise<Access>((resolve) => {
        replicate(replicas, url, streamOf(opened, "sync"), {
          workspace: added.workspace,
          changes: (l) => { heard.add(l); return () => { heard.delete(l); }; },
          onWelcome: resolve,
        });
      });
      expect(access).toBe("owner");
      // Added before the host was the laptop's person, it moved with the host: its document says so.
      expect(replicas.ownership(url)).toEqual({ workspaceId: added.workspace, owner: keys.personId, workspacePublicKey: idOf(workspaceSeed(keys.person, added.workspace)) });

      // A shell in it, started on the host, outlives the laptop's connection.
      replicas.addTile(url, { id: "t-sh", kind: "shell", label: "sh", cmd: "sh" });
      const client = new WorkspaceClient(peerTransport(streamOf(opened, "api")));
      const start = () => client.call("terminal.open", { tileId: "hm:t-sh", cwd: url, cmd: "sh", args: ["-c", "sleep 2; pwd > ran.txt"], cols: 80, rows: 24 });
      await until(async () => (await start().then(() => true, () => false)) || null, "the host to start the shell");
      opened.close();
      laptop.stop();
      expect(await until(() => fs.existsSync(path.join(repo, "ran.txt")) && fs.readFileSync(path.join(repo, "ran.txt"), "utf8").trim(), "the shell to run on")).toBe(repo);
    } finally {
      laptop.stop();
      hive(["host", "stop"], { env });
    }
  });

  test("the app shows a code and the host enters its six words: found on this network, the host becomes the app's person", async () => {
    // A host of its own, with its own data and daemon.
    const own = { ...env, HIVEMIND_APP_DATA: path.join(dir, "data2"), HIVEMIND_PTY_SOCK: path.join(dir, "d2.sock") };
    runHost(own);
    await until(() => status(own)?.running || null, "the host to answer");
    // The laptop shows a code, and announces it on this network.
    const identity = path.join(dir, "laptop2", "identity");
    const keys = machineKeys(identity);
    let offer: PairingOffer | null = null;
    const laptop = await HiveNet.start({
      bin: HIVE_NET, identity, socket: path.join(dir, "l2.sock"),
      onIncoming: (link) => link.close(), onPairRequest: async (peer, hello) => offer!.answer(peer, hello),
    });
    try {
      const settled: Pairing[] = [];
      offer = new PairingOffer(
        { device: keys.deviceId, name: "laptop", kind: "app", certificate: keys.certificate, person: keys.person, addrs: laptop.ready.addrs, relay: laptop.ready.relay },
        (p) => settled.push(p),
      );
      laptop.advertise(pairAnnouncement(offer.code));
      // The host enters the words, as a person reads them (the laptop answers it from this process).
      const entered = await hiveAsync(["host", "pair", offer.code.split("-").join(" "), "--json"], { env: own });
      expect(entered.json).toMatchObject({ ok: true, data: { paired: { device: keys.deviceId, name: "laptop", kind: "app" } } });
      expect(settled[0]?.with).toMatchObject({ kind: "host", certificate: { person: keys.personId } });
      const now = await until(() => { const s = status(own); return s?.running && s.person === keys.personId ? s : null; }, "the host to be the laptop's person");
      expect(now.devices).toEqual([{ device: keys.deviceId, name: "laptop", kind: "app" }]);
    } finally {
      laptop.stop();
      hive(["host", "stop"], { env: own });
      hive(["daemon", "stop"], { env: own });
    }
  });

  test("runs terminals for the person's devices in frames on its folders: a shell a laptop starts there runs here, on after the laptop goes; a device not paired cannot", async () => {
    const own = { ...env, HIVEMIND_APP_DATA: path.join(dir, "data3"), HIVEMIND_PTY_SOCK: path.join(dir, "d3.sock") };
    runHost(own);
    await until(() => status(own)?.running || null, "the host to answer");
    const builds = path.join(dir, "builds");
    fs.mkdirSync(builds);
    const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "");
    const standIn = async (name: string) => {
      const identity = path.join(dir, name, "identity");
      return { keys: machineKeys(identity), net: await HiveNet.start({ bin: HIVE_NET, identity, socket: path.join(dir, `${name}.sock`), onIncoming: (l) => l.close(), onPairRequest: async () => ({ ok: false, error: "declined" }) }) };
    };
    const { keys, net: laptop } = await standIn("laptop3");
    const { net: stranger } = await standIn("stranger3");
    try {
      // Paired by the host's link, as above.
      const pairing = spawn(...cmd(["host", "pair", "--json"]), { env: { ...process.env, ...own } });
      running.push(pairing);
      const printed = lines(pairing.stdout!);
      const link = parsePairLink((JSON.parse(await printed()) as { data: { offer: { link: string } } }).data.offer.link)!;
      const where = { addrs: link.addrs, relay: link.relay };
      await enterPairing({
        me: { device: keys.deviceId, name: "laptop", kind: "app", certificate: keys.certificate, person: keys.person, addrs: laptop.ready.addrs, relay: laptop.ready.relay },
        code: link.code, offering: link.device, ask: (hello) => laptop.pair(link.device, where, hello),
      });
      await until(() => status(own)?.person === keys.personId || null, "the host to be the laptop's person");

      // A shell in a frame on the host's folder, started from the laptop: it runs on the host.
      const frame = machineUri(link.device, builds);
      const sessions = deviceSessions({ dial: (device) => laptop.dial(device, where), mine: () => true });
      // What it is given to run with goes along, but never this machine's control-plane credentials.
      const shell = {
        tileId: "hm:t-build", cwd: frame, cmd: "sh", args: ["-c", 'pwd > ran.txt; echo "$HCP_TOKEN|$HIVE_HCP_SOCK|$BUILD" > env.txt; sleep 2; echo finished > after.txt; sleep 30'], cols: 80, rows: 24,
        env: { HCP_TOKEN: "secret", HIVE_HCP_SOCK: "/laptop/hcp.sock", BUILD: "release" },
      };
      const started = await sessions.start(shell, { data: () => {}, exit: () => {} });
      expect(started.pid).toBeGreaterThan(0);
      expect(sessions.holds("hm:t-build")).toBe(true);
      expect(await until(() => read(path.join(builds, "ran.txt")), "the shell to run on the host")).toBe(builds);
      expect(await until(() => read(path.join(builds, "env.txt")), "the shell's environment")).toBe("||release");
      // The laptop goes; the shell does not.
      sessions.close();
      laptop.stop();
      expect(await until(() => read(path.join(builds, "after.txt")), "the shell to run on")).toBe("finished");

      // A device that is not the person's is not let in to start one.
      const theirs = deviceSessions({ dial: (device) => stranger.dial(device, where), mine: () => true });
      await expect(theirs.start({ ...shell, tileId: "hm:t-theirs", args: ["-c", "touch theirs.txt"] }, { data: () => {}, exit: () => {} })).rejects.toThrow();
      expect(fs.existsSync(path.join(builds, "theirs.txt"))).toBe(false);
      theirs.close();
    } finally {
      laptop.stop();
      stranger.stop();
      hive(["host", "stop"], { env: own });
      hive(["daemon", "stop"], { env: own });
    }
  });

  test("takes a workspace a laptop moves to it: the guest in it is told where, by the workspace's key, and follows here; one who comes back to the laptop is told too; hands it back when the laptop asks; and, gone while the laptop took it over, hands over what it had", async () => {
    const own = { ...env, HIVEMIND_APP_DATA: path.join(dir, "data4"), HIVEMIND_PTY_SOCK: path.join(dir, "d4.sock") };
    // All three on a network with a lookup server, where a workspace's host says it hosts it.
    const profile = await lookupNetwork(path.join(dir, "network4"));
    fs.mkdirSync(path.join(own.HIVEMIND_APP_DATA, "network"), { recursive: true });
    fs.copyFileSync(profile, path.join(own.HIVEMIND_APP_DATA, "network", "profile"));
    runHost(own);
    await until(() => status(own)?.running || null, "the host to answer");
    const repo = path.join(dir, "moving");
    fs.mkdirSync(repo);

    // The laptop: its workspace, with a frame and a shell, shared with a guest, served on its hive-net.
    const laptopDir = path.join(dir, "laptop4");
    const keys = machineKeys(path.join(laptopDir, "identity"));
    const heard = new Set<(change: WorkspaceChange) => void>();
    const changes = (l: (change: WorkspaceChange) => void) => { heard.add(l); return () => { heard.delete(l); }; };
    const store = new WorkspaceStore({ dir: path.join(laptopDir, "workspaces"), person: keys.person, onChange: (c) => { for (const l of heard) l(c); } });
    store.setCore(repo, { frames: [{ id: "f1", title: "moving", workspacePath: repo }], tiles: [{ id: "t1", kind: "shell", label: "sh", cmd: "sh" }], frameOf: { t1: "f1" } });
    const workspace = store.ownership(repo)!.workspaceId as string;
    let hostCert: DeviceCertificate | null = null;
    const lists = new AccessLists({ dir: path.join(laptopDir, "access"), owner: keys.person, devices: () => (hostCert ? [hostCert] : []) });
    const guestKeys = machineKeys(path.join(dir, "guest4", "identity"));
    lists.invite(workspace, repo, "edit", 60_000);
    lists.grant(workspace, guestKeys.personId, "edit");
    lists.addDevice(workspace, guestKeys.certificate);
    // Where the host is, once it has paired; how the laptop signs a record of where its workspace is.
    let where: Where | undefined;
    let sign = (w: string, seq: number, host: string) => laptop.signHost(w, seq, host);
    const hosting = new Hosting({
      self: () => keys.deviceId, person: () => keys.personId, store, lists,
      dial: (device) => laptop.dial(device, where), sign: (w, seq, host) => sign(w, seq, host), moved: (w, notice) => peers.moved(w, notice),
      took: () => laptop.admit(lists.admitted()),
    });
    const server = new WorkspaceServer([], new Intents(new AuditLog({ file: path.join(laptopDir, "audit.jsonl") })));
    const peers = new PeerLinks({ store, changes, lists, server, hosting });
    const laptop = await HiveNet.start({ bin: HIVE_NET, identity: path.join(laptopDir, "identity"), socket: path.join(dir, "l4.sock"), profile, onIncoming: (l) => peers.serve(l), onPairRequest: async () => ({ ok: false }) });
    const guest = await HiveNet.start({ bin: HIVE_NET, identity: path.join(dir, "guest4", "identity"), socket: path.join(dir, "g4.sock"), profile, onIncoming: (l) => l.close(), onPairRequest: async () => ({ ok: false }) });
    try {
      // Paired with the host by its link: the host is the laptop's person.
      const pairing = spawn(...cmd(["host", "pair", "--json"]), { env: { ...process.env, ...own } });
      running.push(pairing);
      const offered = parsePairLink((JSON.parse(await lines(pairing.stdout!)()) as { data: { offer: { link: string } } }).data.offer.link)!;
      where = { addrs: offered.addrs, relay: offered.relay };
      const paired = await enterPairing({
        me: { device: keys.deviceId, name: "laptop", kind: "app", certificate: keys.certificate, person: keys.person, addrs: laptop.ready.addrs, relay: laptop.ready.relay },
        code: offered.code, offering: offered.device, ask: (hello) => laptop.pair(offered.device, where, hello),
      });
      hostCert = paired.with.certificate;
      await until(() => status(own)?.person === keys.personId || null, "the host to be the laptop's person");
      laptop.admit(lists.admitted());

      // The guest is in, on the laptop. Each connection keeps a copy of its own, and is told where
      // the workspace went when it moves.
      const follow = (at: string, addrs: string[]) => new Promise<{ moved: Moved | null; access: string | null; why: Promise<string>; told: Promise<Moved>; replica: WorkspaceStore }>((resolve) => {
        const edits = new Set<(change: WorkspaceChange) => void>();
        const replica = new WorkspaceStore({ dir: path.join(dir, "guest4", `shared-${at.slice(0, 6)}-${Date.now()}`), onChange: (c) => { for (const l of edits) l(c); } });
        let tell!: (moved: Moved) => void;
        const told = new Promise<Moved>((r) => { tell = r; });
        void guest.dial(at, { addrs, relay: null }).then((link) => {
          replicate(replica, workspaceUrl(workspace), streamOf(link, "sync"), {
            workspace, changes: (l) => { edits.add(l); return () => { edits.delete(l); }; },
            onWelcome: (access) => resolve({ moved: null, access, why: link.closed, told, replica }),
            onMoved: (moved) => { tell(moved); resolve({ moved, access: null, why: link.closed, told, replica }); },
          });
        });
      });
      const there = guest.dial(keys.deviceId, { addrs: laptop.ready.addrs, relay: null });
      let told: Moved | null = null;
      const onLaptop = await new Promise<{ closed: Promise<string> }>((resolve) => {
        void there.then((link) => {
          replicate(new WorkspaceStore({ dir: path.join(dir, "guest4", "shared") }), workspaceUrl(workspace), streamOf(link, "sync"), {
            workspace, changes: () => () => {},
            onWelcome: (access) => { expect(access).toBe("edit"); resolve({ closed: link.closed }); },
            onMoved: (moved) => { told = moved; },
          });
        });
      });

      // A workspace that is not the person's is not taken, whichever of their devices hands it over,
      // and stays as it was: its frame is a folder here still.
      const theirs = path.join(dir, "theirs");
      fs.mkdirSync(theirs);
      new WorkspaceStore({ dir: path.join(laptopDir, "workspaces"), person: newSeed() }).setCore(theirs, { frames: [{ id: "f9", title: "theirs", workspacePath: theirs }], tiles: [] });
      await expect(hosting.moveTo(theirs, offered.device)).rejects.toThrow(/not a workspace of this device's person/);
      expect(status(own)?.workspaces.some((w) => w.repo.endsWith(theirs))).toBe(false);
      expect(store.getCore(theirs)!.frames[0]!.workspacePath).toBe(theirs);

      // The laptop moves it to the host. A move it cannot sign is not made: nothing is handed over,
      // and the frame is its own folder still.
      const signing = sign;
      sign = () => Promise.reject(new Error("no key to sign with"));
      await expect(hosting.moveTo(repo, offered.device)).rejects.toThrow(/no key to sign with/);
      sign = signing;
      expect(store.getCore(repo)!.frames[0]!.workspacePath).toBe(repo);
      const notice = await hosting.moveTo(repo, offered.device);
      expect(notice).toMatchObject({ host: offered.device, seq: 2 });
      // The guest is told where it is now, and the connection to the laptop closes.
      expect(await onLaptop.closed).toContain("moved");
      expect(told).toEqual(notice);
      const key = idOf(workspaceSeed(keys.person, workspace));
      expect(await guest.verifyHost(key, notice.record)).toEqual({ host: offered.device, seq: 2 });
      expect(lists.hosting(workspace)).toEqual({ host: offered.device, seq: 2, record: notice.record });
      // The host says at the lookup server that it hosts it now, for whoever looks there later.
      expect(await until(() => guest.resolveHost(key).then((r) => r?.host === offered.device && r), "the host to say it hosts it")).toMatchObject({ host: offered.device, seq: 2 });
      // The frame stays on the laptop, named by it; the host keeps the workspace under the laptop's folder for it.
      expect(store.getCore(repo)!.frames[0]!.workspacePath).toBe(machineUri(keys.deviceId, repo));
      expect(await until(() => status(own)?.workspaces.find((w) => w.workspace === workspace) ?? null, "the host to hold it")).toEqual({ workspace, repo: machineUri(keys.deviceId, repo) });

      // The guest follows it to the host, as the role they had; the frame says where it runs.
      const followed = await until(() => follow(offered.device, offered.addrs).then((r) => (r.access ? r : null)), "the guest to be let in at the host");
      expect(followed.access).toBe("edit");
      expect(followed.replica.getCore(workspaceUrl(workspace))!.frames[0]!.workspacePath).toBe(machineUri(keys.deviceId, repo));
      // Whoever comes back to the laptop for it is told where it is.
      const back = await follow(keys.deviceId, laptop.ready.addrs);
      expect(back.moved).toEqual(notice);
      expect(await back.why).toContain("moved");

      // The guest changes it at the host.
      const atHost = followed.replica.getCore(workspaceUrl(workspace))!;
      followed.replica.setCore(workspaceUrl(workspace), { ...atHost, frames: atHost.frames.map((f) => ({ ...f, title: "built at the host" })) }, { base: atHost });
      await until(() => follow(offered.device, offered.addrs).then((r) => r.replica.getCore(workspaceUrl(workspace))?.frames[0]?.title === "built at the host"), "the host to have the guest's change");

      // Only the owner's devices ask for it: the guest, who is in it, is refused.
      const asking = await guest.dial(offered.device, where);
      const refusal = await new Promise<unknown>((resolve) => {
        asking.on("hosting", (text) => resolve(JSON.parse(text)));
        asking.send("hosting", JSON.stringify({ t: "move", workspace }));
      });
      asking.close();
      expect(refusal).toEqual({ ok: false, error: expect.stringMatching(/owner's devices/) });

      // The laptop asks for it back: hosted there again, at its own folder, with what was done at the
      // host; its frame is plainly the laptop's again.
      await hosting.moveHere(workspace, offered.device);
      expect(store.getCore(repo)!.frames[0]).toMatchObject({ workspacePath: repo, title: "built at the host" });
      // The guest at the host is told where it went, by the workspace's key, and follows it home;
      // the laptop keeps that record, which the host handed over with it.
      const home = await followed.told;
      expect(home).toMatchObject({ host: keys.deviceId, seq: 3 });
      expect(await guest.verifyHost(key, home.record)).toEqual({ host: keys.deviceId, seq: 3 });
      expect(lists.hosting(workspace)).toEqual({ host: keys.deviceId, seq: 3, record: home.record });
      const again = await until(() => follow(keys.deviceId, laptop.ready.addrs).then((r) => (r.access ? r : null)), "the guest to be let in at the laptop again");
      expect(again.access).toBe("edit");
      expect(again.replica.getCore(workspaceUrl(workspace))!.frames[0]!.workspacePath).toBe(repo);

      // At the host again, the fourth move. The laptop keeps a copy, as one of the owner's devices
      // with it open does, until it is away; the guest, at the host, changes it meanwhile.
      expect((await hosting.moveTo(repo, offered.device)).seq).toBe(4);
      const kept = new WorkspaceStore({ dir: path.join(laptopDir, "shared") });
      const keeping = await laptop.dial(offered.device, where);
      expect(await new Promise<string>((resolve) => {
        replicate(kept, workspaceUrl(workspace), streamOf(keeping, "sync"), { workspace, changes: () => () => {}, onWelcome: resolve });
      })).toBe("owner");
      keeping.close();
      const there2 = await until(() => follow(offered.device, offered.addrs).then((r) => (r.access ? r : null)), "the guest to be let in at the host again");
      const was = there2.replica.getCore(workspaceUrl(workspace))!;
      there2.replica.setCore(workspaceUrl(workspace), { ...was, frames: was.frames.map((f) => ({ ...f, title: "changed while the laptop was away" })) }, { base: was });
      await until(() => follow(offered.device, offered.addrs).then((r) => r.replica.getCore(workspaceUrl(workspace))?.frames[0]?.title === "changed while the laptop was away"), "the host to have the guest's change");

      // The host goes. The laptop hosts it again from the copy it kept, one move later, its frame
      // plainly its own, and says so at the lookup server; the guest finds it there and is let in.
      expect(data<{ stopped: boolean }>(hive(["host", "stop", "--json"], { env: own })).stopped).toBe(true);
      expect(hosting.takeOver(workspace, repo, kept.exportSince(workspaceUrl(workspace), null))).toBe(5);
      expect(lists.hosting(workspace)).toEqual({ host: keys.deviceId, seq: 5, record: null });
      expect(store.getCore(repo)!.frames[0]).toMatchObject({ workspacePath: repo, title: "built at the host" });
      await laptop.publishHost(workspace, 5);
      expect(await guest.resolveHost(key)).toMatchObject({ host: keys.deviceId, seq: 5 });
      expect((await until(() => follow(keys.deviceId, laptop.ready.addrs).then((r) => (r.access ? r : null)), "the guest to be let in at the laptop")).access).toBe("edit");

      // The host, back, finds the later record: it hands over what it had, which the laptop merges,
      // and tells whoever comes to it where the workspace is now.
      runHost(own);
      await until(() => store.getCore(repo)?.frames[0]?.title === "changed while the laptop was away", "the host to hand over what it had");
      expect(store.getCore(repo)!.frames[0]!.workspacePath).toBe(repo);
      const late = await until(() => follow(offered.device, offered.addrs).then((r) => r.moved), "the host to say where it is now");
      expect(late).toMatchObject({ host: keys.deviceId, seq: 5 });
      expect(await guest.verifyHost(key, late.record)).toEqual({ host: keys.deviceId, seq: 5 });
    } finally {
      laptop.stop();
      guest.stop();
      hive(["host", "stop"], { env: own });
      hive(["daemon", "stop"], { env: own });
    }
  });

  test("its owner, at the laptop it moved a workspace from, sees who is in it there, makes a link, is asked about someone joining and lets them in, changes a role and takes someone off; the laptop keeps the list in step, and still tells whoever comes to it where the workspace is", async () => {
    const own = { ...env, HIVEMIND_APP_DATA: path.join(dir, "data5"), HIVEMIND_PTY_SOCK: path.join(dir, "d5.sock") };
    runHost(own);
    await until(() => status(own)?.running || null, "the host to answer");
    const repo = path.join(dir, "team");
    fs.mkdirSync(repo);

    // The laptop's workspace, shared with a guest, with a link out to it.
    const laptopDir = path.join(dir, "laptop5");
    const keys = machineKeys(path.join(laptopDir, "identity"));
    const store = new WorkspaceStore({ dir: path.join(laptopDir, "workspaces"), person: keys.person });
    store.setCore(repo, { frames: [{ id: "f1", title: "team", workspacePath: repo }], tiles: [] });
    const workspace = store.ownership(repo)!.workspaceId as string;
    const url = workspaceUrl(workspace);
    let hostCert: DeviceCertificate | null = null;
    const lists = new AccessLists({ dir: path.join(laptopDir, "access"), owner: keys.person, devices: () => (hostCert ? [hostCert] : []) });
    const standIn = async (name: string) => {
      const identity = path.join(dir, name, "identity");
      return { keys: machineKeys(identity), net: await HiveNet.start({ bin: HIVE_NET, identity, socket: path.join(dir, `${name}.sock`), onIncoming: (l) => l.close(), onPairRequest: async () => ({ ok: false, error: "declined" }) }) };
    };
    const { keys: guestKeys, net: guest } = await standIn("guest5");
    const { keys: newKeys, net: newcomer } = await standIn("new5");
    lists.grant(workspace, guestKeys.personId, "edit");
    lists.addDevice(workspace, guestKeys.certificate);
    const early = lists.invite(workspace, repo, "view", 600_000);
    let where: Where | undefined;
    const hosting = new Hosting({
      self: () => keys.deviceId, person: () => keys.personId, store, lists,
      dial: (device) => laptop.dial(device, where), sign: (w, seq, host) => laptop.signHost(w, seq, host), moved: (w, notice) => peers.moved(w, notice),
      took: () => laptop.admit(lists.admitted()),
    });
    const server = new WorkspaceServer([], new Intents(new AuditLog({ file: path.join(laptopDir, "audit.jsonl") })));
    const peers = new PeerLinks({ store, changes: () => () => {}, lists, server, hosting });
    const laptop = await HiveNet.start({ bin: HIVE_NET, identity: path.join(laptopDir, "identity"), socket: path.join(dir, "l5.sock"), onIncoming: (l) => peers.serve(l), onPairRequest: async () => ({ ok: false }) });
    let made = 0;
    /** Into the workspace at `device`, from `net`: the role let in as, or where it is now; how the
     *  connection ends; and what came on its `list` stream, which it asks for as any device may. */
    const enter = (net: HiveNet, device: string, addrs: string[]) => new Promise<{ access: string | null; moved: Moved | null; closed: Promise<string>; listed: string[] }>((resolve) => {
      net.dial(device, { addrs, relay: null }).then((link) => {
        const listed: string[] = [];
        streamOf(link, "list").on((text) => listed.push(text));
        void link.closed.then(() => resolve({ access: null, moved: null, closed: link.closed, listed }));
        replicate(new WorkspaceStore({ dir: path.join(dir, "replicas5", String(made++)) }), url, streamOf(link, "sync"), {
          workspace, changes: () => () => {},
          onWelcome: (access) => {
            link.send("list", JSON.stringify({ t: "follow", workspace }));
            resolve({ access, moved: null, closed: link.closed, listed });
          },
          onMoved: (moved) => resolve({ access: null, moved, closed: link.closed, listed }),
        });
      }, (e: unknown) => resolve({ access: null, moved: null, closed: Promise.resolve(String(e)), listed: [] }));
    });
    try {
      // Paired with the host by its link, as above, and the workspace moved there.
      const pairing = spawn(...cmd(["host", "pair", "--json"]), { env: { ...process.env, ...own } });
      running.push(pairing);
      const offered = parsePairLink((JSON.parse(await lines(pairing.stdout!)()) as { data: { offer: { link: string } } }).data.offer.link)!;
      where = { addrs: offered.addrs, relay: offered.relay };
      hostCert = (await enterPairing({
        me: { device: keys.deviceId, name: "laptop", kind: "app", certificate: keys.certificate, person: keys.person, addrs: laptop.ready.addrs, relay: laptop.ready.relay },
        code: offered.code, offering: offered.device, ask: (hello) => laptop.pair(offered.device, where, hello),
      })).with.certificate;
      await until(() => status(own)?.person === keys.personId || null, "the host to be the laptop's person");
      laptop.admit(lists.admitted());
      const notice = await hosting.moveTo(repo, offered.device);
      const atHost = await until(() => enter(guest, offered.device, offered.addrs).then((r) => (r.access ? r : null)), "the guest to be let in at the host");
      expect(atHost.access).toBe("edit");

      // Someone with a link asks to join while none of the owner's devices is connected there: the
      // host has no window, so the question waits for its person at its command line, who says no.
      const ask = (secret: string) => newcomer.pair(offered.device, where!, { v: 1, workspace, secret, certificate: newKeys.certificate, profile: { name: "Noor", color: "#22aa66" } });
      const turnedAway = ask(early);
      const waiting = await until(() => data<JoinRequests>(hive(["people", "requests", "-w", "team", "--json"], { env: own })).asking[0], "the question at the host");
      expect(waiting).toMatchObject({ workspace: "team", profile: { name: "Noor" }, role: "view" });
      expect(hive(["people", "deny", String(waiting.req), "-w", "team"], { env: own }).code).toBe(0);
      expect(await turnedAway).toEqual({ ok: false, error: "declined" });

      // The laptop opens it from the host as its owner, keeping its list in step, and sees who is in it.
      const opened = await laptop.dial(offered.device, where);
      expect(await new Promise<string>((resolve) => {
        replicate(new WorkspaceStore({ dir: path.join(laptopDir, "shared") }), url, streamOf(opened, "sync"), {
          workspace, changes: () => () => {},
          onWelcome: (access) => { followList(lists, workspace, streamOf(opened, "list")); resolve(access); },
        });
      })).toBe("owner");
      const client = new WorkspaceClient(peerTransport(streamOf(opened, "api")));
      expect((await client.call("people.list", url)).map((p) => [p.person, p.role, p.present])).toEqual([[guestKeys.personId, "edit", true]]);

      // A link it makes there names the host, the workspace and its key.
      const link = parseJoinLink(await client.call("people.invite", url, "view", 600_000, false))!;
      expect(link).toMatchObject({ host: offered.device, workspace, names: { workspace: "team" }, hosting: { key: idOf(workspaceSeed(keys.person, workspace)) } });

      // Someone asks to join with it: the laptop is asked, and lets them in.
      const asked = new Promise<[string, JoinQuestion]>((resolve) => client.on("people.asked", (about, question) => resolve([about, question])));
      const settled = new Promise<[string, number]>((resolve) => client.on("people.answered", (about, req) => resolve([about, req])));
      const joining = ask(link.secret);
      const [about, question] = await asked;
      expect(about).toBe(url);
      expect(question).toMatchObject({ workspace: "team", profile: { name: "Noor", color: "#22aa66" }, role: "view" });
      expect(await client.call("people.answer", url, question.req, true)).toEqual({ answered: true });
      expect(await joining).toEqual({ ok: true, role: "view", workspace });
      expect(await settled).toEqual([url, question.req]);
      const joined = await until(() => enter(newcomer, offered.device, offered.addrs).then((r) => (r.access ? r : null)), "the newcomer to be let in");
      expect(joined.access).toBe("view");

      // A new role for the guest, and the newcomer taken off: each one's connection closes.
      await client.call("people.role", url, guestKeys.personId, "terminals");
      expect(await atHost.closed).toContain("role changed");
      await client.call("people.remove", url, newKeys.personId);
      expect(await joined.closed).toContain("removed");
      // Nor are they let in again: the host's network turns them away at the door.
      expect(await (await enter(newcomer, offered.device, offered.addrs)).closed).toContain("not admitted");

      // The laptop's list is the host's, the workspace's folder on the laptop its own; only the
      // owner's devices are sent it, the guest asking too.
      await until(() => lists.people(workspace).map((p) => `${p.person} ${p.role}`).join() === `${guestKeys.personId} terminals`, "the laptop's list to be the host's");
      expect(lists.repoOf(workspace)).toBe(repo);
      expect(atHost.listed).toEqual([]);
      // Whoever comes back to the laptop for it is told where it is still.
      expect((await enter(guest, keys.deviceId, laptop.ready.addrs)).moved).toEqual(notice);
      opened.close();
    } finally {
      laptop.stop();
      guest.stop();
      newcomer.stop();
      hive(["host", "stop"], { env: own });
      hive(["daemon", "stop"], { env: own });
    }
  });

  test("shares from the command line with no window: `hive share` makes a link, another host asks with `hive join`, `hive people` lets it in at another role; with the rule `invite` a link lets in at once; each answer is audited", async () => {
    const own = { ...env, HIVEMIND_APP_DATA: path.join(dir, "data6"), HIVEMIND_PTY_SOCK: path.join(dir, "d6.sock") };
    const other = { ...env, HIVEMIND_APP_DATA: path.join(dir, "data7"), HIVEMIND_PTY_SOCK: path.join(dir, "d7.sock") };
    runHost(own);
    runHost(other);
    const owner = await until(() => status(own)?.network && status(own), "the owner's host on the network");
    const guest = await until(() => status(other)?.network && status(other), "the guest's host on the network");
    const repo = path.join(dir, "shared6");
    fs.mkdirSync(repo);
    expect(hive(["host", "add", repo], { env: own }).code).toBe(0);
    try {
      const shared = data<{ link: string; role: string; answering: string }>(hive(["share", "shared6", "--role", "terminals", "--expires", "1h", "--json"], { env: own }));
      expect(shared).toMatchObject({ role: "terminals", answering: "ask" });
      expect(parseJoinLink(shared.link)).toMatchObject({ host: owner.device, names: { workspace: "shared6" } });

      const joining = hiveAsync(["join", shared.link, "--json"], { env: other });
      const asking = await until(() => data<JoinRequests>(hive(["people", "requests", "-w", "shared6", "--json"], { env: own })).asking[0], "the request at the owner's host");
      expect(asking).toMatchObject({ workspace: "shared6", role: "terminals" });
      expect(hive(["people", "allow", String(asking.req), "--role", "view", "-w", "shared6", "--json"], { env: own }).json).toMatchObject({ ok: true });
      expect((await joining).json).toMatchObject({ ok: true, data: { ok: true, role: "view" } });
      expect(data<PersonHere[]>(hive(["people", "list", "-w", "shared6", "--json"], { env: own })).map((p) => [p.person, p.role])).toEqual([[guest.person, "view"]]);
      // Kept in the guest's joined list, as the app keeps a workspace it joined.
      expect(JSON.parse(fs.readFileSync(path.join(other.HIVEMIND_APP_DATA, "joined.json"), "utf8"))).toMatchObject([{ host: owner.device, role: "view", names: { workspace: "shared6" } }]);

      // Anyone with a valid link let in at once: nobody is asked.
      expect(hive(["people", "rule", "invite", "-w", "shared6"], { env: own }).code).toBe(0);
      const again = data<{ link: string }>(hive(["share", "shared6", "--json"], { env: own }));
      expect(hive(["join", again.link, "--json"], { env: other }).json).toMatchObject({ ok: true, data: { role: "edit" } });
      // Unknown answers say so, and a link never lets in to drive agents.
      expect(hive(["people", "allow", "99", "-w", "shared6", "--json"], { env: own }).json).toMatchObject({ ok: false, code: "not_waiting" });
      expect(hive(["share", "shared6", "--role", "agents"], { env: own }).code).toBe(2);

      const audited = fs.readFileSync(path.join(own.HIVEMIND_APP_DATA, "audit.jsonl"), "utf8").split("\n").filter(Boolean)
        .map((l) => JSON.parse(l) as { verb: string; detail?: string; outcome: string })
        .filter((e) => e.verb.startsWith("people.")).map((e) => `${e.verb} ${e.detail ?? ""} ${e.outcome}`);
      expect(audited).toEqual(["people.invite terminals ok", "people.answer allow as view ok", "people.answering invite ok", "people.invite edit ok", "people.answer allow ok"]);
    } finally {
      for (const on of [own, other]) {
        hive(["host", "stop"], { env: on });
        hive(["daemon", "stop"], { env: on });
      }
    }
  });

  test("is refused while the app runs here, which serves this machine's workspaces itself", () => {
    // Electron's single-instance lock, as the app holds it: `<host>-<pid>` of a live process.
    fs.mkdirSync(appData, { recursive: true });
    const lock = path.join(appData, "SingletonLock");
    fs.symlinkSync(`${os.hostname()}-${process.pid}`, lock);
    try {
      const r = hive(["host", "run", "--json"], { env });
      expect(r.code).toBe(3);
      expect(r.json).toMatchObject({ ok: false, code: "app_running" });
    } finally {
      fs.rmSync(lock);
    }
  });
});
