// Host records (host-records.ts, joined.ts; spec/host-record.md) with the real daemon and a real
// lookup server (crates/hive-net, built with `cargo build`): a device on a network with a lookup
// server says there that it hosts each workspace shared from it, and says it again as it is;
// someone with the invite, on a network of their own, finds the host there; a record another of
// the person's devices said is that device's, left alone, and a guest's joins list follows it
// there, and the device hears it is that device's; of two that took a workspace over at once the
// one with the lower id keeps it; a guest follows a workspace that moved as the record in its host's
// notice says, and an older record does not take it back; on a network without a lookup server
// nothing is said.
import { test, expect, afterEach, beforeEach } from "bun:test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HiveNet } from "../src/hive-net.ts";
import { HostRecords } from "../src/host-records.ts";
import { JoinedList } from "../src/joined.ts";
import { adoptPerson, machineKeys } from "../src/keyring.ts";
import { idOf, newWorkspaceId, workspaceSeed } from "../src/identity.ts";

const BIN = path.join(import.meta.dir, "../../../crates/hive-net/target/debug/hive-net");
const built = fs.existsSync(BIN);
if (!built) console.warn(`host-records.test.ts skipped: build the daemon first (cargo build in crates/hive-net)`);

let root: string;
const running: HiveNet[] = [];
const servers: ChildProcess[] = [];
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "host-records-")); });
afterEach(() => {
  for (const n of running.splice(0)) n.stop();
  for (const s of servers.splice(0)) s.kill();
  fs.rmSync(root, { recursive: true, force: true });
});

/** A network with a lookup server and no relays, its profile signed by its admin: the lookup
 *  server's URL, and the signed profile's file. */
async function network(): Promise<{ lookup: string; profile: string }> {
  const server = spawn(BIN, ["serve", "--lookup", "--data", path.join(root, "lookup-server"), "--bind", "127.0.0.1:0", "--lookup-limit", "off"], { stdio: ["ignore", "pipe", "ignore"] });
  servers.push(server);
  const lookup = await new Promise<string>((resolve) => {
    let out = "";
    server.stdout!.on("data", (d: Buffer) => {
      out += d.toString();
      const m = /lookup serving on (\S+)/.exec(out);
      if (m) resolve(m[1]!);
    });
  });
  const admin = path.join(root, "admin.key");
  fs.writeFileSync(admin, `${"ab".repeat(32)}\n`);
  const by = (JSON.parse(execFileSync(BIN, ["access", "voucher", "--kind", "enrol", "--admin", admin], { encoding: "utf8" })) as { by: string }).by;
  const text = path.join(root, "profile.json");
  fs.writeFileSync(text, JSON.stringify({ v: 1, name: "Test network", relays: [], lookup, admin: by, local: { mdns: true } }));
  const profile = path.join(root, "network.json");
  fs.writeFileSync(profile, execFileSync(BIN, ["profile", "sign", text, "--admin", admin], { encoding: "utf8" }));
  return { lookup, profile };
}

/** A device whose keys are in `root/name/identity` (made if they are not), on the network
 *  `profile` (none: the local network alone). */
async function device(name: string, profile?: string): Promise<HiveNet> {
  const dir = path.join(root, name);
  machineKeys(path.join(dir, "identity"));
  const n = await HiveNet.start({
    bin: BIN,
    identity: path.join(dir, "identity"),
    socket: path.join(dir, "net.sock"),
    ...(profile ? { profile } : {}),
    onIncoming: (link) => link.close(),
    onPairRequest: async () => ({ ok: false }),
  });
  running.push(n);
  return n;
}

test.skipIf(!built)("a device says at its network's lookup server that it hosts each workspace shared from it, again as it is; someone with the invite finds it there from a network of their own", async () => {
  const { lookup, profile } = await network();
  const keys = machineKeys(path.join(root, "desktop", "identity"));
  const desktop = await device("desktop", profile);
  expect(desktop.ready.lookup).toBe(lookup);
  const [one, two] = [newWorkspaceId(), newWorkspaceId()];
  const hosted = [one, two].map((workspace) => ({ workspace, key: idOf(workspaceSeed(keys.person, workspace)) }));
  const warned: string[] = [];
  const records = new HostRecords({ net: desktop, hosted: () => hosted, onWarn: (m) => warned.push(m) });
  try {
    await records.start();
    const guest = await device("guest");
    expect(guest.ready.lookup).toBeNull();
    for (const ws of hosted) expect(await guest.resolveHost(ws.key, lookup)).toMatchObject({ host: desktop.ready.id, seq: 1 });
    // Said again, a record of its own stays as it is: one from further on (the workspace moved
    // away and back) keeps its count.
    await desktop.publishHost(two, 3);
    await records.start();
    expect(await guest.resolveHost(hosted[0]!.key, lookup)).toMatchObject({ host: desktop.ready.id, seq: 1 });
    expect(await guest.resolveHost(hosted[1]!.key, lookup)).toMatchObject({ host: desktop.ready.id, seq: 3 });
    expect(warned).toEqual([]);
  } finally {
    records.stop();
  }
}, 60_000);

test.skipIf(!built)("a record another of the person's devices said is that device's, left alone, unless this one took the workspace later; a guest's next dial goes where it names", async () => {
  const { lookup, profile } = await network();
  const keys = machineKeys(path.join(root, "desktop", "identity"));
  machineKeys(path.join(root, "server", "identity"));
  adoptPerson(path.join(root, "server", "identity"), keys.person);
  const [desktop, server] = await Promise.all([device("desktop", profile), device("server", profile)]);
  const workspace = newWorkspaceId();
  const key = idOf(workspaceSeed(keys.person, workspace));
  // The workspace is on the person's server now, which said so: two moves on.
  await server.publishHost(workspace, 3);

  const warned: string[] = [];
  const elsewhere: Array<[string, unknown]> = [];
  await new HostRecords({ net: desktop, hosted: () => [{ workspace, key }], elsewhere: (ws, found) => elsewhere.push([ws, found]), onWarn: (m) => warned.push(m) }).start();
  const guest = await device("guest");
  const found = await guest.resolveHost(key, lookup);
  expect(found).toMatchObject({ host: server.ready.id, seq: 3 });
  expect(warned).toEqual([`workspace ${workspace.slice(0, 8)}… is hosted by ${server.ready.id.slice(0, 8)}… now`]);
  // The desktop hears it is the server's now, with the record the server said, to hand on.
  expect(elsewhere).toEqual([[workspace, found]]);
  expect(await guest.verifyHost(key, found!.record)).toEqual({ host: server.ready.id, seq: 3 });

  // Taken back by the desktop, a move later than the server's record knows, it says so over it.
  await new HostRecords({ net: desktop, hosted: () => [{ workspace, key, seq: 4 }], onWarn: (m) => warned.push(m) }).start();
  expect(await guest.resolveHost(key, lookup)).toMatchObject({ host: desktop.ready.id, seq: 4 });
  await server.publishHost(workspace, 3);

  // A guest who joined at the desktop dials the server, and keeps it so.
  const joins = new JoinedList(path.join(root, "guest", "joined.json"));
  const at = { workspace, host: desktop.ready.id, where: { addrs: desktop.ready.addrs, relay: null }, role: "edit" as const, names: { workspace: "api", host: "Adarsh" }, joinedAt: 1 };
  joins.add({ ...at, hosting: { key, lookup } });
  expect(await joins.hostOf(workspace, guest)).toEqual({ host: server.ready.id, where: { addrs: [], relay: null } });
  expect(joins.list()[0]).toMatchObject({ host: server.ready.id, where: { addrs: [], relay: null } });
  // One joined with no record to look for is where it was joined.
  const other = newWorkspaceId();
  joins.add({ ...at, workspace: other });
  expect(await joins.hostOf(other, guest)).toEqual({ host: desktop.ready.id, where: at.where });
  expect(await joins.hostOf(newWorkspaceId(), guest)).toBeNull();
}, 60_000);

test.skipIf(!built)("of two of the person's devices that took a workspace over at once, the one whose id is lower keeps it; the other hears it is that one's", async () => {
  const { lookup, profile } = await network();
  const keys = machineKeys(path.join(root, "desktop", "identity"));
  machineKeys(path.join(root, "server", "identity"));
  adoptPerson(path.join(root, "server", "identity"), keys.person);
  const [desktop, server, guest] = await Promise.all([device("desktop", profile), device("server", profile), device("guest", profile)]);
  const workspace = newWorkspaceId();
  const key = idOf(workspaceSeed(keys.person, workspace));
  const [lower, higher] = [desktop, server].sort((a, b) => (a.ready.id < b.ready.id ? -1 : 1));
  // Each took it over from the copy it had: one move later than the last both knew of, 2.
  const told = new Map<string, unknown[]>();
  const records = (net: HiveNet) => new HostRecords({ net, hosted: () => [{ workspace, key, seq: 3 }], elsewhere: (_ws, found) => { told.set(net.ready.id, [...(told.get(net.ready.id) ?? []), found]); } });
  // The higher said it first, the lower after; then each says it again, as every hour.
  for (const net of [higher!, lower!, higher!, lower!]) await records(net).start();
  expect(await guest.resolveHost(key, lookup)).toMatchObject({ host: lower!.ready.id, seq: 3 });
  expect(told.get(lower!.ready.id)).toBeUndefined();
  expect(told.get(higher!.ready.id)).toEqual([expect.objectContaining({ host: lower!.ready.id, seq: 3 })]);
}, 60_000);

test.skipIf(!built)("a guest follows a workspace that moved as the record its host's notice carries says, and no older record takes it back", async () => {
  const { lookup, profile } = await network();
  const keys = machineKeys(path.join(root, "desktop", "identity"));
  machineKeys(path.join(root, "server", "identity"));
  adoptPerson(path.join(root, "server", "identity"), keys.person);
  const [desktop, server, guest] = await Promise.all([device("desktop", profile), device("server", profile), device("guest", profile)]);
  const workspace = newWorkspaceId();
  const key = idOf(workspaceSeed(keys.person, workspace));
  // The desktop hosts it, and said so; it moves it to the server, the first move.
  await desktop.publishHost(workspace, 1);
  const notice = { t: "moved" as const, host: server.ready.id, seq: 2, record: await desktop.signHost(workspace, 2, server.ready.id) };
  const joins = new JoinedList(path.join(root, "guest", "joined.json"));
  const at = { workspace, host: desktop.ready.id, where: { addrs: desktop.ready.addrs, relay: null }, role: "edit" as const, names: { workspace: "api", host: "Adarsh" }, joinedAt: 1 };
  joins.add({ ...at, hosting: { key, lookup } });

  // A notice whose record is another workspace's, or names another device than it does, is not.
  expect(await joins.follow(workspace, { ...notice, record: await desktop.signHost(newWorkspaceId(), 2, server.ready.id) }, guest)).toBe(false);
  expect(await joins.follow(workspace, { ...notice, host: guest.ready.id }, guest)).toBe(false);
  expect(joins.list()[0]!.host).toBe(desktop.ready.id);
  // The one the workspace's key signed is: the server hosts it, after one move.
  expect(await joins.follow(workspace, notice, guest)).toBe(true);
  expect(joins.list()[0]).toMatchObject({ host: server.ready.id, where: { addrs: [], relay: null }, seq: 2 });
  // The desktop's record from before, at the lookup server still, does not take the guest back.
  expect(await guest.resolveHost(key, lookup)).toMatchObject({ host: desktop.ready.id, seq: 1 });
  expect(await joins.hostOf(workspace, guest)).toEqual({ host: server.ready.id, where: { addrs: [], relay: null } });

  // One joined before invites carried the key follows on its host's word.
  const before = newWorkspaceId();
  joins.add({ ...at, workspace: before });
  expect(await joins.follow(before, { ...notice, record: "" }, guest)).toBe(true);
  expect(joins.list().find((j) => j.workspace === before)!.host).toBe(server.ready.id);
}, 60_000);

test.skipIf(!built)("on a network without a lookup server nothing is said, and nothing goes wrong", async () => {
  const keys = machineKeys(path.join(root, "desktop", "identity"));
  const desktop = await device("desktop");
  const workspace = newWorkspaceId();
  const warned: string[] = [];
  await new HostRecords({ net: desktop, hosted: () => [{ workspace, key: idOf(workspaceSeed(keys.person, workspace)) }], onWarn: (m) => warned.push(m) }).start();
  expect(warned).toEqual([]);
});
