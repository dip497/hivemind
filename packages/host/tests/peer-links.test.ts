// One of the owner's phones on the links a device serves (peer-links.ts, spec/pairing.md 0.3): let
// in as the person's device, it is answered which workspaces the device holds and what waits on
// the person there (spec/needs.md), gives where it is told what happens there (spec/push.md),
// unpairs itself (spec/pairing.md), and may open workspaces to watch and type into their
// terminals and answer and message their agents, as the owner's device, each `api` stream it opens
// on its one connection served as its own; it is served nothing else the owner's computers are: no
// terminals started or sized, no keyboards given or taken, no workspace's board, files or other
// calls, no hosting. The owner's laptop, on the same links, is served each of them, and is told
// nothing on a phone's behalf, nor unpaired by asking.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createECDH } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { inflateRawSync } from "node:zlib";
import { AccessLists } from "@hivemind/workspace-host/access";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import { certifyDevice, idOf, newSeed } from "@hivemind/workspace-host/identity";
import { Intents, type Actor } from "@hivemind/workspace-host/intents";
import type { Link, Stream } from "@hivemind/workspace-host/hive-net";
import { WorkspaceStore } from "@hivemind/workspace-host/store";
import { WorkspaceServer, type Connection } from "@hivemind/workspace-api/server";
import { workspaceDomains } from "../src/domains.ts";
import { TileLines } from "../src/tile-lines.ts";
import { PeerLinks } from "../src/peer-links.ts";
import { Terminals, type SessionOutput } from "../src/terminals.ts";
import type { WaitingStatus } from "../src/needs.ts";
import type { LayersShown } from "../src/home.ts";
import type { HomeMessage } from "@hivemind/workspace-api/home";
import { appearance } from "../src/appearance.ts";
import { DEFAULT_APPEARANCE, PRESETS, type SharedAppearance } from "@hivemind/core/settings-schema";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hm-peer-links-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let made = 0;
const T = 1_790_000_000_000;

/** Two ends of one connection, as on hive-net: the device dialled it, and opens its streams, as
 *  many of a name as it likes. Frames arrive in order, a moment after they are sent; what was sent
 *  before a stream ended, or the connection closed, arrives before that. The device sends on, and
 *  hears, one stream of each name it sends on (as the app's daemon opens them), or a stream it opens
 *  itself (`open`, as a phone does); the computer is told of each stream as it opens, hears each
 *  by its name, and answers on each, or on the newest of a name. */
function linkPair(device: string, computer: string) {
  let close!: (why: string) => void;
  const closed = new Promise<string>((r) => { close = r; });
  const later = (f: () => void) => void setImmediate(f);
  // The computer's room to send on the link, and who waits for it.
  let room = true;
  const roomFor = new Set<() => void>();
  const hasRoom = () => room;
  const tell = () => later(() => { if (room) for (const f of [...roomFor]) { roomFor.delete(f); f(); } });
  const whenRoom = (l: () => void) => {
    roomFor.add(l);
    if (room) tell();
    return () => { roomFor.delete(l); };
  };
  /** A stream, as each end hears it. */
  interface Both { name: string; open: boolean; atDevice: Set<(t: string) => void>; atComputer: Set<(t: string) => void>; end(why: string): void; closed: Promise<string> }
  const all: Both[] = [];
  const newest = new Map<string, Both>();
  const named = new Map<string, Set<(t: string) => void>>();
  const accepting = new Map<string, Set<(s: Stream) => void>>();
  const listen = <T>(map: Map<string, Set<T>>, name: string, l: T) => {
    const set = map.get(name) ?? new Set<T>();
    map.set(name, set.add(l));
    return () => { set.delete(l); };
  };
  const answering = (b: Both): Stream => ({
    send: (data) => later(() => { if (b.open) for (const l of b.atDevice) l(data); }),
    on: (l) => { b.atComputer.add(l); return () => { b.atComputer.delete(l); }; },
    closed: b.closed,
    hasRoom,
    whenRoom,
  });
  /** The device opens a stream named `name`: told to the computer, then its frames. */
  const opening = (name: string): Both => {
    let end!: (why: string) => void;
    const b: Both = { name, open: true, atDevice: new Set(), atComputer: new Set(), end: (why) => end(why), closed: new Promise((r) => { end = r; }) };
    all.push(b);
    later(() => {
      newest.set(name, b);
      const s = answering(b);
      for (const l of accepting.get(name) ?? []) l(s);
    });
    return b;
  };
  const sendOn = (b: Both, data: string) => later(() => {
    if (!b.open) return;
    for (const l of b.atComputer) l(data);
    for (const l of named.get(b.name) ?? []) l(data);
  });
  void closed.then((why) => { for (const b of all) { b.open = false; b.end(why); } });
  /** The streams the device sends on by name, one of each, opened as it first sends. */
  const own = new Map<string, Both>();
  const heard = new Map<string, Set<(t: string) => void>>();
  const ownStream = (name: string): Both => {
    let b = own.get(name);
    if (!b) {
      own.set(name, (b = opening(name)));
      b.atDevice.add((t) => { for (const l of heard.get(name) ?? []) l(t); });
    }
    return b;
  };
  const computerEnd: Link = {
    peer: device,
    send: (name, data) => { const b = newest.get(name); if (b) answering(b).send(data); },
    on: (name, l) => listen(named, name, l),
    streams: (name, l) => listen(accepting, name, l),
    close: (why = "closed") => later(() => close(why)),
    closed,
    hasRoom,
    whenRoom,
  };
  const deviceEnd = {
    peer: computer,
    send: (name: string, data: string) => sendOn(ownStream(name), data),
    on: (name: string, l: (t: string) => void) => listen(heard, name, l),
    /** A stream of its own, named `name`: what is sent on it, what it hears, and its end. */
    open: (name: string) => {
      const b = opening(name);
      return {
        send: (data: string) => sendOn(b, data),
        on: (l: (t: string) => void) => { b.atDevice.add(l); },
        end: () => later(() => {
          b.open = false;
          if (newest.get(name) === b) newest.delete(name);
          b.end("ended");
        }),
      };
    },
    close: (why = "closed") => later(() => close(why)),
    closed,
    /** Whether the computer has room to send to it: as when its network stops taking, and starts again. */
    room: (has: boolean) => { room = has; if (has) tell(); },
  };
  return [computerEnd, deviceEnd] as const;
}

/** The person's computer, holding the workspace `api`, with their phone and laptop paired. */
/** The person's computer, holding the workspace `api` with two agents' tiles. `lines`: each tile's
 *  last line, in place of a map the test sets. */
function computer(o: { lines?: Pick<TileLines, "get" | "followAll">; look?: SharedAppearance } = {}) {
  const dir = path.join(tmp, String(made++));
  const repo = path.join(dir, "api");
  const person = newSeed();
  const store = new WorkspaceStore({ dir: path.join(dir, "workspaces"), person });
  store.setCore(repo, { v: 1, frames: [], tiles: [{ id: "t1", kind: "claude", label: "Claude" }, { id: "t2", kind: "claude", label: "Claude" }] });
  const workspace = store.ownership(repo)!.workspaceId as string;
  const [phone, laptop, self] = [idOf(newSeed()), idOf(newSeed()), idOf(newSeed())];
  const lists = new AccessLists({ dir: path.join(dir, "access"), owner: person, devices: () => [certifyDevice(person, phone), certifyDevice(person, laptop)] });
  /** Each terminal a connection opened, and as whom: what the host's terminals would show; and the
   *  connections that opened one. */
  const watched: Array<{ by: Actor; opts: unknown }> = [];
  const watching: Connection[] = [];
  /** What was typed into a terminal, and by whom; each agent answered, and sent a message, and by
   *  whom; and what else reached a terminal's keyboard or size. */
  const typed: Array<{ by: Actor; tile: unknown }> = [];
  const answered: Array<{ by: Actor; tile: unknown }> = [];
  const sent: Array<{ by: Actor; tile: unknown }> = [];
  const keyed: Array<{ what: string; by: Actor; tile: unknown }> = [];
  /** What starting, interrupting, closing an agent or reading its changes reached, and by whom. */
  const driven: Array<{ what: string; by: Actor; at: unknown }> = [];
  /** What showing a community view reached, by whom, and what a view opened may do there. */
  const viewed: Array<{ what: string; by: Actor; at: unknown[]; may?: string[] }> = [];
  /** Where each device is told what happens here; each device forgotten; the phones each device
   *  said it paired with. */
  const subscribed: Array<{ device: string; sub: unknown }> = [];
  const unpaired: string[] = [];
  const introduced: Array<{ by: string; phones: unknown[] }> = [];
  const forgot: Array<{ by: string; device: string }> = [];
  /** Where each computer said it is a guest. */
  const guests: Array<{ by: string; workspaces: unknown[] }> = [];
  /** The owner's devices a phone may reach through this one. */
  const box = idOf(newSeed());
  const host = { device: box, name: "build-box", kind: "host" as const, certificate: certifyDevice(person, box), addrs: ["10.0.0.5:4433"], relay: null };
  const terminals = {
    answers: {
      "terminal.open": (from: Connection, opts: unknown) => { watched.push({ by: from.actor, opts }); watching.push(from); return { pid: 1, joined: true }; },
      "agent.answer": (from: Connection, tile: unknown) => { answered.push({ by: from.actor, tile }); return { answered: true }; },
      "agent.send": (from: Connection, tile: unknown) => { sent.push({ by: from.actor, tile }); return { sent: true }; },
      ...Object.fromEntries(["agent.startable", "agent.start", "agent.interrupt", "agent.close", "agent.diff"].map((what) => [
        what, (from: Connection, at: unknown) => { driven.push({ what, by: from.actor, at }); return {}; },
      ])),
      ...Object.fromEntries(["view.list", "view.file", "view.close"].map((what) => [
        what, (from: Connection, ...at: unknown[]) => { viewed.push({ what, by: from.actor, at }); return {}; },
      ])),
      "view.open": (from: Connection, ...at: unknown[]) => {
        viewed.push({ what: "view.open", by: from.actor, at, may: ["agent.start", "agent.close", "store.setCore", "widget.press"].filter((m) => from.may?.(m)) });
        return { session: "s1" };
      },
    },
    effects: {},
    notices: {
      ...Object.fromEntries(["view.post", "view.screen"].map((what) => [
        what, (from: Connection, ...at: unknown[]) => { viewed.push({ what, by: from.actor, at }); },
      ])),
      "terminal.write": (from: Connection, tile: unknown) => { typed.push({ by: from.actor, tile }); },
      ...Object.fromEntries(["terminal.resize", "terminal.keyboard.ask", "terminal.keyboard.give", "terminal.keyboard.take"].map((what) => [
        what, (from: Connection, tile: unknown) => { keyed.push({ what, by: from.actor, tile }); },
      ])),
    },
  };
  // How this computer looks, told to its guests as its settings change (`appearance.ts`).
  let look = o.look;
  let recoloured: ((a: SharedAppearance) => void) | null = null;
  const looks = look ? [appearance({ current: () => look!, onChange: (l) => { recoloured = l; }, server: () => server })] : [];
  const recolour = (a: SharedAppearance) => { look = a; recoloured?.(a); };
  const server = new WorkspaceServer([...workspaceDomains, terminals, ...looks], new Intents(new AuditLog({ file: path.join(dir, "audit.jsonl") })));
  // The agent of t1 waits on the person; t2's works.
  let statuses: WaitingStatus[] = [
    { tileId: "t1", status: { state: "waiting", kind: "permission", since: T, title: "Editing Nav.tsx" } },
    { tileId: "t2", status: { state: "working", since: T } },
  ];
  /** An agent's status changes, and the workspace API tells its clients so, as the control plane
   *  does. */
  /** The terminal of `tile` prints `data`: sent to the connections that opened a terminal, as the
   *  host's terminals send a session's output to those that show it. */
  const output = (tile: string, data: string) => server.publishTo((to) => watching.includes(to), "terminal.data", tile, data);
  /** Another workspace on this computer, `name`, with agents in `tiles`. */
  const another = (name: string, tiles: string[]) => {
    const at = path.join(dir, name);
    store.setCore(at, { v: 1, frames: [], tiles: tiles.map((id) => ({ id, kind: "claude", label: "Claude" })) });
    return { repo: at, workspace: store.ownership(at)!.workspaceId as string };
  };
  const statusChanged = (tileId: string, status: WaitingStatus["status"]) => {
    statuses = statuses.map((s) => (s.tileId === tileId ? { tileId, status } : s));
    server.publish("status.changed", { tileId, ...status } as never);
  };
  /** The connections made to this machine's terminal daemon: each echoes what it is sent. */
  const daemons: PassThrough[] = [];
  /** What the window's Layers panel shows of each workspace, and what each tile last printed. */
  const shown = new Map<string, LayersShown>();
  const lines = new Map<string, string>();
  const links = new PeerLinks({
    store, changes: () => () => {}, lists, server,
    daemon: async () => { const d = new PassThrough(); daemons.push(d); return d; },
    phone: (device) => device === phone,
    statuses: () => statuses,
    // The agent of t1 is Claude Code, and says which of its keys allow and deny what it asks; t2's
    // says which interrupt its turn.
    facts: () => ({
      program: (tile) => (tile === "t1" ? { id: "claude", label: "Claude Code" } : undefined),
      decides: (tile, status) => tile === "t1" && status.kind === "permission",
      interrupts: (tile) => tile === "t2",
      converses: () => false,
    }),
    // Each agent here runs on this computer.
    machines: { self: () => ({ device: self, name: "desk" }), mine: () => undefined, whose: () => undefined, saved: () => undefined },
    subscribe: (device, sub) => subscribed.push({ device, sub }),
    unpair: (device) => unpaired.push(device),
    introduced: (by, phones) => introduced.push({ by, phones }),
    forget: (by, device) => { forgot.push({ by, device }); return device === phone; },
    guestOf: (by, workspaces) => { guests.push({ by, workspaces }); return true; },
    devices: () => [host],
    profile: async () => ({ name: "Priya", color: "#3b82f6" }),
    shown: (at) => shown.get(at),
    lines: o.lines ?? { get: (tile) => lines.get(tile), followAll: () => {} },
  });
  /** `device` connects: what it hears on each stream, and its end of the link; and a stream of its
   *  own, opened beside them (`open`): what is sent on it, what it hears, and its end. */
  const connect = (device: string) => {
    const [computerEnd, deviceEnd] = linkPair(device, self);
    links.serve(computerEnd);
    const heard = new Map<string, string[]>();
    for (const stream of ["device", "pty", "sync", "api", "files", "hosting", "agents", "home"]) {
      heard.set(stream, []);
      deviceEnd.on(stream, (t) => heard.get(stream)!.push(t));
    }
    const open = (name: string) => {
      const s = deviceEnd.open(name);
      const said: string[] = [];
      s.on((t) => said.push(t));
      return { send: (m: unknown) => s.send(JSON.stringify(m)), heard: said, end: s.end };
    };
    return { heard, send: (stream: string, m: unknown) => deviceEnd.send(stream, JSON.stringify(m)), open, closed: computerEnd.closed, hangUp: () => deviceEnd.close("done"), room: deviceEnd.room };
  };
  return { repo, workspace, phone, laptop, person: idOf(person), daemons, links, shown, lines, watched, typed, answered, sent, keyed, driven, viewed, subscribed, unpaired, introduced, forgot, guests, host, connect, statusChanged, output, another, recolour };
}
const until = async (done: () => boolean) => { for (let t = 0; t < 5_000 && !done(); t += 20) await wait(20); };

test("a phone is answered which workspaces its computer holds and what waits on the person there, and served nothing else an owner's computer is: no terminals started, board, files or hosting", async () => {
  const c = computer();
  /** Ask on each stream what an owner's computer asks. */
  const askEverything = (d: ReturnType<typeof c.connect>) => {
    d.send("device", { t: "workspaces" });
    d.send("device", { t: "needs" });
    d.send("pty", { t: "attach", reqId: 1, id: "hm:t1", spec: { cwd: c.repo, cmd: "/bin/sh", args: [], cols: 80, rows: 24 } });
    d.send("sync", { t: "hello", workspace: c.workspace, seen: null });
    d.send("files", { id: 1, method: "file.read", params: [c.repo, "README.md"] });
    d.send("hosting", { t: "take", workspace: c.workspace });
  };
  // The owner's laptop is served each.
  const laptop = c.connect(c.laptop);
  askEverything(laptop);
  await until(() => [...laptop.heard].every(([s, h]) => s === "api" || s === "agents" || s === "home" || h.length > 0));
  assert.deepEqual([...laptop.heard].filter(([s, h]) => s !== "api" && s !== "agents" && s !== "home" && h.length === 0).map(([s]) => s), [], "the laptop hears on every stream");
  assert.equal(c.daemons.length, 1);

  const phone = c.connect(c.phone);
  askEverything(phone);
  await until(() => phone.heard.get("device")!.length >= 2);
  assert.deepEqual(phone.heard.get("device")!.map((m) => JSON.parse(m) as unknown), [
    { t: "workspaces", workspaces: [{ workspace: c.workspace, name: "api", repo: c.repo }] },
    { t: "needs", needs: [{ workspace: c.workspace, name: "api", tile: "t1", agent: "Editing Nav.tsx", kind: "permission", since: 1_790_000_000_000, machine: "desk", decide: true }], working: 1 },
  ]);
  await wait(200);
  assert.deepEqual([...phone.heard].filter(([s, h]) => s !== "device" && h.length > 0).map(([s]) => s), [], "the phone hears on no other stream");
  assert.equal(c.daemons.length, 1, "no connection to the daemon for the phone");
});

test("while an owner's device's link has no room, this machine's terminal daemon is not read for it, and is read again once room returns: nothing lost", async () => {
  const c = computer();
  const laptop = c.connect(c.laptop);
  laptop.room(false);
  laptop.send("pty", "first ");
  await until(() => laptop.heard.get("pty")!.length === 1);
  laptop.send("pty", "second ");
  laptop.send("pty", "third");
  await wait(300);
  assert.deepEqual(laptop.heard.get("pty"), ['"first "']);
  assert.ok(c.daemons[0]!.readableLength > 0, "what the daemon sent waits in its socket");

  laptop.room(true);
  await until(() => laptop.heard.get("pty")!.join("") === '"first ""second ""third"');
  assert.equal(c.daemons[0]!.readableLength, 0);
});

test("a phone that reads deflated frames is sent its long ones deflated, in the order they were sent; one that does not, and the short ones, as they are", async () => {
  const c = computer();
  const phone = c.connect(c.phone);
  const watch = { tileId: "hm:t1", tile: "t1", cwd: `hive://${c.workspace}`, cmd: "", cols: 80, rows: 24, attachOnly: true };
  const reads = phone.open("api");
  const old = phone.open("api");
  reads.send({ t: "open", workspace: c.workspace, z: "deflate" });
  old.send({ t: "open", workspace: c.workspace });
  reads.send({ id: 1, method: "terminal.open", params: [watch] });
  old.send({ id: 1, method: "terminal.open", params: [watch] });
  await until(() => reads.heard.length >= 1 && old.heard.length >= 1);
  const long = "build ok · résumé 🐝\r\n".repeat(1_200);
  c.output("hm:t1", long);
  await wait(60);
  c.output("hm:t1", "done\r\n");
  await until(() => reads.heard.length >= 3 && old.heard.length >= 3);
  const said = (frames: string[]) => frames.slice(1).map((f) => (f.startsWith("z:") ? inflateRawSync(Buffer.from(f.slice(2), "base64")).toString() : f));
  const data = (frames: string[]) => said(frames).map((f) => (JSON.parse(f) as { params: [string, string] }).params[1]);
  assert.deepEqual(data(reads.heard), [long, "done\r\n"]);
  assert.deepEqual(data(old.heard), [long, "done\r\n"]);
  assert.deepEqual(reads.heard.slice(1).map((f) => f.startsWith("z:")), [true, false]);
  assert.ok(reads.heard[1]!.length < long.length / 3, `deflated to ${reads.heard[1]!.length} of ${long.length}`);
  assert.deepEqual(old.heard.slice(1).map((f) => f.startsWith("z:")), [false, false]);
});

test("a phone opens a workspace to watch and type into its terminals and answer and message its agents, as the owner's device; anything else there (starting a terminal, sizing one, giving or taking a keyboard) is refused, and one opened without naming a workspace here is closed", async () => {
  const c = computer();
  const phone = c.connect(c.phone);
  phone.send("api", { t: "open", workspace: c.workspace });
  const watch = { tileId: "hm:t1", tile: "t1", cwd: `hive://${c.workspace}`, cmd: "", cols: 80, rows: 24, attachOnly: true };
  phone.send("api", { id: 1, method: "terminal.open", params: [watch] });
  phone.send("api", { id: 2, method: "terminal.open", params: [{ ...watch, attachOnly: false }] });
  phone.send("api", { id: 3, method: "file.read", params: [`hive://${c.workspace}`, "README.md"] });
  phone.send("api", { id: 4, method: "terminal.open", params: [{ ...watch, tileId: "hm:elsewhere", tile: "elsewhere" }] });
  phone.send("api", { id: 5, method: "agent.answer", params: ["t1", 1_790_000_000_000, { text: "1" }] });
  phone.send("api", { id: 6, method: "agent.answer", params: ["elsewhere", 1_790_000_000_000, { text: "1" }] });
  phone.send("api", { id: 7, method: "agent.send", params: ["t1", "also add tests"] });
  phone.send("api", { id: 8, method: "agent.send", params: ["elsewhere", "also add tests"] });
  // It types as the person, asking for the keyboard first; it never sizes a terminal, nor gives or
  // takes its keyboard: those are dropped, as any notice it may not send.
  phone.send("api", { method: "terminal.keyboard.ask", params: ["hm:t1"] });
  phone.send("api", { method: "terminal.write", params: ["hm:t1", "y\r"] });
  phone.send("api", { method: "terminal.write", params: ["hm:elsewhere", "y\r"] });
  phone.send("api", { method: "terminal.resize", params: ["hm:t1", 40, 20] });
  phone.send("api", { method: "terminal.keyboard.give", params: ["hm:t1", "window:1"] });
  phone.send("api", { method: "terminal.keyboard.take", params: ["hm:t1"] });
  await until(() => phone.heard.get("api")!.length >= 8);
  const answers = Object.fromEntries(phone.heard.get("api")!.map((m) => JSON.parse(m) as { id: number; result?: unknown; error?: { code: string } }).map((a) => [a.id, a]));
  assert.deepEqual(answers[1]!.result, { pid: 1, joined: true });
  // A tile in no workspace here is not found.
  assert.deepEqual([2, 3, 4, 6, 8].map((id) => answers[id]?.error?.code), ["FORBIDDEN", "FORBIDDEN", "NOT_FOUND", "NOT_FOUND", "NOT_FOUND"]);
  const asPhone = { kind: "peer", person: c.person, device: c.phone, access: "owner" };
  assert.deepEqual(c.watched, [{ by: asPhone, opts: { ...watch, cwd: c.repo } }]);
  assert.deepEqual(answers[5]!.result, { answered: true });
  assert.deepEqual(c.answered, [{ by: asPhone, tile: "t1" }]);
  assert.deepEqual(answers[7]!.result, { sent: true });
  assert.deepEqual(c.sent, [{ by: asPhone, tile: "t1" }]);
  await wait(100);
  assert.deepEqual(c.typed, [{ by: asPhone, tile: "hm:t1" }]);
  assert.deepEqual(c.keyed, [{ what: "terminal.keyboard.ask", by: asPhone, tile: "hm:t1" }]);

  for (const first of [{ t: "open", workspace: "f".repeat(32) }, { id: 1, method: "terminal.open", params: [watch] }]) {
    const other = c.connect(c.phone);
    other.send("api", first);
    assert.equal(await Promise.race([other.closed, wait(2_000).then(() => "open")]), "removed", JSON.stringify(first));
  }
});

test("a phone follows several things at once on its one connection: each `api` stream it opens is a workspace's API of its own, for the workspace it names, answered on it alone, with that workspace's events; one it ends leaves the others served", async () => {
  const c = computer();
  const web = c.another("web", ["w1"]);
  const phone = c.connect(c.phone);
  // As its Agent screen: t1's terminal watched on one stream, t2 sent a message on another; and a
  // stream for the workspace `web` beside them.
  const watching = phone.open("api");
  const talking = phone.open("api");
  const elsewhere = phone.open("api");
  watching.send({ t: "open", workspace: c.workspace });
  talking.send({ t: "open", workspace: c.workspace });
  elsewhere.send({ t: "open", workspace: web.workspace });
  const watch = { tileId: "hm:t1", tile: "t1", cwd: `hive://${c.workspace}`, cmd: "", cols: 80, rows: 24, attachOnly: true };
  watching.send({ id: 1, method: "terminal.open", params: [watch] });
  talking.send({ id: 1, method: "agent.send", params: ["t2", "add tests"] });
  elsewhere.send({ id: 1, method: "agent.send", params: ["w1", "fix the nav"] });
  elsewhere.send({ id: 2, method: "agent.send", params: ["t2", "fix the nav"] });
  const said = (s: { heard: string[] }) => s.heard.map((m) => JSON.parse(m) as unknown).flatMap((m) => (Array.isArray(m) ? m : [m])) as Array<Record<string, unknown>>;
  const answers = (s: { heard: string[] }) => said(s).filter((m) => "id" in m).map(({ id, result, error }) => [id, result ?? (error as { code: string }).code]);
  const events = (s: { heard: string[] }) => said(s).filter((m) => "event" in m).map(({ event, params }) => [event, (params as unknown[])[0]]);
  await until(() => answers(watching).length + answers(talking).length + answers(elsewhere).length >= 4);
  await wait(100);
  // Each answered on its own stream, as the workspace it opened: t2 is none of `web`'s.
  assert.deepEqual(answers(watching), [[1, { pid: 1, joined: true }]]);
  assert.deepEqual(answers(talking), [[1, { sent: true }]]);
  assert.deepEqual(answers(elsewhere), [[1, { sent: true }], [2, "FORBIDDEN"]]);
  assert.deepEqual(c.sent.map((s) => s.tile), ["t2", "w1"]);

  // What t1's terminal prints goes to the stream watching it; what each workspace's agents do, to
  // that workspace's streams.
  c.output("hm:t1", "Allow edit to Nav.tsx?");
  c.statusChanged("t1", { state: "working", since: T + 1 });
  c.statusChanged("w1", { state: "working", since: T + 1 });
  await until(() => events(elsewhere).length > 0 && events(talking).length > 0 && events(watching).length > 1);
  await wait(100);
  assert.deepEqual(events(watching), [["terminal.data", "hm:t1"], ["status.changed", { tileId: "t1", state: "working", since: T + 1 }]]);
  assert.deepEqual(events(talking), [["status.changed", { tileId: "t1", state: "working", since: T + 1 }]]);
  assert.deepEqual(events(elsewhere), [["status.changed", { tileId: "w1", state: "working", since: T + 1 }]]);

  // The message sent, its stream ends: the terminal is still watched, and its stream answered.
  talking.end();
  await wait(50);
  c.output("hm:t1", "probe is thinking");
  watching.send({ id: 2, method: "agent.answer", params: ["t1", T, { text: "y" }] });
  await until(() => answers(watching).length > 1 && events(watching).length > 2);
  assert.deepEqual(answers(watching), [[1, { pid: 1, joined: true }], [2, { answered: true }]]);
  assert.deepEqual(events(watching).at(-1), ["terminal.data", "hm:t1"]);
  assert.equal(events(talking).length, 1);
});

test("a phone asks on several `device` streams at once, and follows every agent on several `agents` streams: each answered on its own", async () => {
  const c = computer();
  const phone = c.connect(c.phone);
  // Two questions at once, as the phone asks which workspaces a device holds before it watches a
  // terminal there while it hears from the device.
  const [holds, waits] = [phone.open("device"), phone.open("device")];
  holds.send({ t: "workspaces" });
  waits.send({ t: "needs" });
  const [following, again] = [phone.open("agents"), phone.open("agents")];
  following.send({ t: "follow" });
  again.send({ t: "follow" });
  const ts = (s: { heard: string[] }) => s.heard.map((m) => (JSON.parse(m) as { t: string }).t);
  await until(() => [holds, waits, following, again].every((s) => s.heard.length > 0));
  await wait(100);
  assert.deepEqual([holds, waits, following, again].map(ts), [["workspaces"], ["needs"], ["agents"], ["agents"]]);
  // One stops following: the other is still sent the list as it changes.
  following.end();
  await wait(50);
  c.statusChanged("t1", { state: "working", since: T + 1 });
  await until(() => again.heard.length > 1);
  assert.deepEqual([ts(following), ts(again)], [["agents"], ["agents", "agents"]]);
});

test("a phone drives the workspace's agents as the owner's device: sees what may be started, starts one, interrupts its turn, closes it and reads what it changed; a tile in no workspace is not found", async () => {
  const c = computer();
  const phone = c.connect(c.phone);
  phone.send("api", { t: "open", workspace: c.workspace });
  const here = `hive://${c.workspace}`;
  phone.send("api", { id: 1, method: "agent.startable", params: [here] });
  phone.send("api", { id: 2, method: "agent.start", params: [here, { program: "claude", prompt: "fix the nav" }] });
  phone.send("api", { id: 3, method: "agent.interrupt", params: ["t2"] });
  phone.send("api", { id: 4, method: "agent.diff", params: ["t2"] });
  phone.send("api", { id: 5, method: "agent.close", params: ["t2"] });
  phone.send("api", { id: 6, method: "agent.close", params: ["elsewhere"] });
  await until(() => phone.heard.get("api")!.length >= 6);
  const answers = Object.fromEntries(phone.heard.get("api")!.map((m) => JSON.parse(m) as { id: number; error?: { code: string } }).map((a) => [a.id, a]));
  assert.deepEqual([1, 2, 3, 4, 5].map((id) => answers[id]?.error), [undefined, undefined, undefined, undefined, undefined]);
  assert.equal(answers[6]?.error?.code, "NOT_FOUND");
  const asPhone = { kind: "peer", person: c.person, device: c.phone, access: "owner" };
  assert.deepEqual(c.driven, [
    { what: "agent.startable", by: asPhone, at: c.repo },
    { what: "agent.start", by: asPhone, at: c.repo },
    { what: "agent.interrupt", by: asPhone, at: "t2" },
    { what: "agent.diff", by: asPhone, at: "t2" },
    { what: "agent.close", by: asPhone, at: "t2" },
  ]);
});

test("a phone shows the workspace's community views as the owner's device: lists them, reads their files, opens one there on its screen and talks to it; the view may do there what a phone may", async () => {
  const c = computer();
  const phone = c.connect(c.phone);
  const screen = { w: 390, h: 844, theme: { colors: {}, mode: "dark" } };
  phone.send("api", { t: "open", workspace: c.workspace });
  phone.send("api", { id: 1, method: "view.list", params: [] });
  phone.send("api", { id: 2, method: "view.file", params: ["priya-board", "index.html"] });
  phone.send("api", { id: 3, method: "view.open", params: ["priya-board", `hive://${c.workspace}`, screen] });
  phone.send("api", { method: "view.post", params: ["s1", { type: "ready", v: 1 }] });
  phone.send("api", { method: "view.screen", params: ["s1", { ...screen, w: 844, h: 390 }] });
  phone.send("api", { id: 4, method: "view.close", params: ["s1"] });
  await until(() => phone.heard.get("api")!.length >= 4);
  const answers = phone.heard.get("api")!.map((m) => JSON.parse(m) as { id: number; error?: unknown });
  assert.deepEqual(answers.map((a) => [a.id, a.error]), [[1, undefined], [2, undefined], [3, undefined], [4, undefined]]);
  const asPhone = { kind: "peer", person: c.person, device: c.phone, access: "owner" };
  assert.deepEqual(c.viewed, [
    { what: "view.list", by: asPhone, at: [] },
    { what: "view.file", by: asPhone, at: ["priya-board", "index.html"] },
    { what: "view.open", by: asPhone, at: ["priya-board", c.repo, screen], may: ["agent.start", "agent.close", "widget.press"] },
    { what: "view.post", by: asPhone, at: ["s1", { type: "ready", v: 1 }] },
    { what: "view.screen", by: asPhone, at: ["s1", { ...screen, w: 844, h: 390 }] },
    { what: "view.close", by: asPhone, at: ["s1"] },
  ]);
});

test("a phone gives where it is told what happens here and is answered that it was taken, or that it is no subscription; the owner's laptop is told nothing", async () => {
  const c = computer();
  const key = createECDH("prime256v1");
  key.generateKeys();
  const sub = { endpoint: "https://push.example/phone", p256dh: key.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 1).toString("base64url") };
  const phone = c.connect(c.phone);
  phone.send("device", { t: "push", ...sub });
  phone.send("device", { t: "push", ...sub, endpoint: "file:///etc/passwd" });
  await until(() => phone.heard.get("device")!.length >= 2);
  assert.deepEqual(phone.heard.get("device")!.map((m) => JSON.parse(m) as unknown), [{ t: "push", ok: true }, { t: "push", ok: false, error: "not a push subscription" }]);

  // The laptop's is not taken: answered in order, it hears only its question's answer.
  const laptop = c.connect(c.laptop);
  laptop.send("device", { t: "push", ...sub, endpoint: "https://push.example/laptop" });
  laptop.send("device", { t: "workspaces" });
  await until(() => laptop.heard.get("device")!.length >= 1);
  await wait(100);
  assert.deepEqual(laptop.heard.get("device")!.map((m) => (JSON.parse(m) as { t: string }).t), ["workspaces"]);
  assert.deepEqual(c.subscribed, [{ device: c.phone, sub }]);
});

test("a phone unpairs itself: it is told so and forgotten once it hangs up, or let go a moment later; the owner's laptop asking the same is answered nothing", async () => {
  const c = computer();
  const laptop = c.connect(c.laptop);
  laptop.send("device", { t: "unpair" });
  laptop.send("device", { t: "workspaces" });
  await until(() => laptop.heard.get("device")!.length >= 1);
  await wait(100);
  assert.deepEqual(laptop.heard.get("device")!.map((m) => (JSON.parse(m) as { t: string }).t), ["workspaces"]);
  assert.deepEqual(c.unpaired, []);

  // Told once, however often it asks, and forgotten only once it has hung up: forgetting it
  // would cut the answer short.
  const phone = c.connect(c.phone);
  phone.send("device", { t: "unpair" });
  phone.send("device", { t: "unpair" });
  await until(() => phone.heard.get("device")!.length >= 1);
  await wait(100);
  assert.deepEqual(phone.heard.get("device")!.map((m) => JSON.parse(m) as unknown), [{ t: "unpair", ok: true }]);
  await wait(100);
  assert.deepEqual(c.unpaired, []);
  phone.hangUp();
  await until(() => c.unpaired.length > 0);
  assert.deepEqual(c.unpaired, [c.phone]);

  // One that does not hang up is let go, and forgotten all the same.
  const again = c.connect(c.phone);
  again.send("device", { t: "unpair" });
  assert.equal(await Promise.race([again.closed, wait(4_000).then(() => "open")]), "removed");
  await until(() => c.unpaired.length > 1);
  assert.deepEqual(c.unpaired, [c.phone, c.phone]);
});

test("the owner's laptop says which phones it paired with, which it unpaired that paired here, and where it is a guest, and is answered; a phone asks which of the owner's devices it may reach through this one, and is told, and whose they are; neither is answered the other's question", async () => {
  const c = computer();
  const pixel = { device: c.phone, name: "Pixel" };
  const laptop = c.connect(c.laptop);
  laptop.send("device", { t: "phones", phones: [pixel] });
  laptop.send("device", { t: "forget", device: c.phone });
  laptop.send("device", { t: "forget", device: c.laptop });
  const theirs = { workspace: "ab".repeat(16), host: "cd".repeat(32), addrs: [], relay: null };
  laptop.send("device", { t: "guest", workspaces: [theirs] });
  laptop.send("device", { t: "devices" });
  laptop.send("device", { t: "workspaces" });
  await until(() => laptop.heard.get("device")!.length >= 5);
  await wait(100);
  assert.deepEqual(laptop.heard.get("device")!.map((m) => (JSON.parse(m) as { t: string; ok?: boolean })).map(({ t, ok }) => ({ t, ok })), [
    { t: "phones", ok: true }, { t: "forget", ok: true }, { t: "forget", ok: false }, { t: "guest", ok: true }, { t: "workspaces", ok: undefined },
  ]);
  assert.deepEqual(c.guests, [{ by: c.laptop, workspaces: [theirs] }]);
  assert.deepEqual(c.introduced, [{ by: c.laptop, phones: [pixel] }]);
  assert.deepEqual(c.forgot, [{ by: c.laptop, device: c.phone }, { by: c.laptop, device: c.laptop }]);

  const phone = c.connect(c.phone);
  phone.send("device", { t: "phones", phones: [] });
  phone.send("device", { t: "forget", device: c.phone });
  phone.send("device", { t: "guest", workspaces: [] });
  phone.send("device", { t: "devices" });
  await until(() => phone.heard.get("device")!.length >= 1);
  await wait(100);
  assert.deepEqual(phone.heard.get("device")!.map((m) => JSON.parse(m) as unknown), [{ t: "devices", devices: [c.host], profile: { name: "Priya", color: "#3b82f6" } }]);
  assert.deepEqual(c.introduced, [{ by: c.laptop, phones: [pixel] }], "a phone's word is no introduction");
  assert.equal(c.forgot.length, 2, "nor is it unpairing another");
  assert.equal(c.guests.length, 1, "nor where the person is a guest");
});

test("the owner's devices follow every agent here: sent the list at once, and again as it changes, the first change at once and those in the next 100 ms together, never the same list twice, until they go; anyone else is cut off", async () => {
  const c = computer();
  const [phone, laptop] = [c.connect(c.phone), c.connect(c.laptop)];
  const lists = (d: ReturnType<typeof c.connect>) => d.heard.get("agents")!.map((m) => JSON.parse(m) as unknown);
  const agent = (tile: string, status: Record<string, unknown>) => ({ workspace: c.workspace, name: "api", tile, ...status, machine: "desk" });
  const t1 = (status: Record<string, unknown>) => ({ ...agent("t1", status), program: { id: "claude", label: "Claude Code" } });
  const t2 = (status: Record<string, unknown>) => ({ ...agent("t2", status), interrupt: true });
  phone.send("agents", { t: "follow" });
  laptop.send("agents", { t: "follow" });
  await until(() => lists(phone).length === 1 && lists(laptop).length === 1);
  const first = { t: "agents", agents: [
    { ...t1({ agent: "Editing Nav.tsx", state: "waiting", since: T }), waiting: { kind: "permission", since: T, decide: true } },
    t2({ agent: "Claude", state: "working", since: T }),
  ], working: 1 };
  assert.deepEqual(lists(phone), [first]);
  assert.deepEqual(lists(laptop), [first]);

  // Answered, t1 works again: told at once, with that, though two more changes come in the same
  // moment; those two are told together once 100 ms have passed, as the last left it.
  c.statusChanged("t1", { state: "working", since: T + 1, title: "Editing Nav.tsx" });
  c.statusChanged("t2", { state: "idle", since: T + 2 });
  c.statusChanged("t1", { state: "done", since: T + 3, title: "Nav fixed" });
  await until(() => lists(phone).length === 3);
  await wait(300);
  assert.deepEqual(lists(phone).slice(1), [
    { t: "agents", agents: [t1({ agent: "Editing Nav.tsx", state: "working", since: T + 1 }), t2({ agent: "Claude", state: "working", since: T })], working: 2 },
    { t: "agents", agents: [t1({ agent: "Nav fixed", state: "done", since: T + 3 }), t2({ agent: "Claude", state: "idle", since: T + 2 })], working: 0 },
  ]);
  assert.deepEqual(lists(laptop), lists(phone));

  // Told of a change that leaves the list as it was: nothing is sent.
  c.statusChanged("t2", { state: "idle", since: T + 2 });
  await wait(300);
  assert.equal(lists(phone).length, 3);

  // The phone goes: the laptop is still told, the phone no more.
  phone.hangUp();
  await phone.closed;
  c.statusChanged("t2", { state: "working", since: T + 4 });
  await until(() => lists(laptop).length === 4);
  await wait(200);
  assert.equal(lists(phone).length, 3);

  // Someone else's device asking to follow is cut off, and told nothing.
  const stranger = c.connect(idOf(newSeed()));
  stranger.send("agents", { t: "follow" });
  assert.equal(await Promise.race([stranger.closed, wait(2_000).then(() => "still open")]), "removed");
  assert.deepEqual(lists(stranger), []);
});

test("an owner's device whose link has no room is sent no list of agents, however many changes come, and the newest once room returns; another is sent each as before", async () => {
  const c = computer();
  const [phone, laptop] = [c.connect(c.phone), c.connect(c.laptop)];
  const lists = (d: ReturnType<typeof c.connect>) => d.heard.get("agents")!.map((m) => JSON.parse(m) as { agents: Array<{ state: string }> });
  phone.send("agents", { t: "follow" });
  laptop.send("agents", { t: "follow" });
  await until(() => lists(phone).length === 1 && lists(laptop).length === 1);

  phone.room(false);
  for (let n = 1; n <= 3; n++) {
    c.statusChanged("t1", { state: n % 2 ? "working" : "idle", since: T + n, title: `step ${n}` });
    await wait(150);
  }
  await until(() => lists(laptop).length === 4);
  assert.equal(lists(phone).length, 1);

  phone.room(true);
  await until(() => lists(phone).length === 2);
  await wait(200);
  assert.equal(lists(phone).length, 2);
  assert.deepEqual(lists(phone)[1], lists(laptop).at(-1));
});

test("the phone following Home is told how the computer looks, every colour in hex and no file of its own; and the look again, alone, when the computer is recoloured", async () => {
  const dusk = { ...DEFAULT_APPEARANCE, wallpaper: { ...DEFAULT_APPEARANCE.wallpaper, kind: "image" as const, imageSrc: "hivemedia://media/secret.png" } };
  const c = computer({ look: dusk });
  const phone = c.connect(c.phone);
  const heard = () => phone.heard.get("home")!.map((m) => JSON.parse(m) as HomeMessage);
  phone.send("home", { t: "follow" });
  await until(() => heard().length === 1);
  const first = heard()[0]!.look!;
  assert.equal(first.mode, DEFAULT_APPEARANCE.mode);
  const hexes = [...Object.values(first.colors), first.terminal.background, first.terminal.foreground, first.terminal.cursor, first.terminal.selection, ...first.terminal.ansi];
  assert.deepEqual(hexes.filter((h) => !/^#[0-9a-f]{6}$/.test(h)), []);
  assert.equal(first.terminal.ansi.length, 16);
  assert.ok(first.colors.brand && first.colors.bg && first.colors.fg);
  // A picture is a file on the computer: the phone is told the default wallpaper, never its path.
  assert.equal(first.wallpaper.kind, DEFAULT_APPEARANCE.wallpaper.kind);
  assert.ok(!JSON.stringify(heard()[0]).includes("secret"));

  const light = PRESETS["catppuccin-latte"]!;
  c.recolour({ ...dusk, mode: light.mode, palette: light.palette, terminal: light.terminal, wallpaper: { ...dusk.wallpaper, kind: "koi", colour: true } });
  await until(() => heard().length === 2);
  const [again] = heard().slice(1);
  assert.deepEqual(Object.keys(again!).sort(), ["look", "t"]);
  assert.equal(again!.look!.mode, "light");
  assert.notEqual(again!.look!.colors.bg, first.colors.bg);
  assert.deepEqual(again!.look!.wallpaper, { kind: "koi", colour: true });

  // A device that starts following then is told the look as it is now.
  const later = c.connect(c.phone);
  later.send("home", { t: "follow" });
  await until(() => later.heard.get("home")!.length === 1);
  assert.deepEqual((JSON.parse(later.heard.get("home")![0]!) as HomeMessage).look, again!.look);
});

test("an owner's device whose link has no room is sent nothing of Home, and once room returns, what came after where it was, in one message; then each change as before", async () => {
  const c = computer();
  c.lines.set("t1", "Allow edit to Nav.tsx?");
  const phone = c.connect(c.phone);
  const heard = () => phone.heard.get("home")!.map((m) => JSON.parse(m) as HomeMessage);
  phone.send("home", { t: "follow" });
  await until(() => heard().length === 1);
  const [t1, t2] = [`t:${c.workspace}/t1`, `t:${c.workspace}/t2`];

  phone.room(false);
  c.lines.set("t2", "Compiling…");
  c.links.homeLinesChanged();
  await wait(300);
  c.lines.set("t2", "Compiled");
  c.lines.delete("t1");
  c.links.homeLinesChanged();
  await wait(300);
  assert.equal(heard().length, 1);

  phone.room(true);
  await until(() => heard().length === 2);
  await wait(100);
  assert.equal(heard().length, 2);
  assert.deepEqual(heard()[1], { t: "changes", layout: { seq: 3, changes: [] }, lines: { seq: 4, changes: [
    { seq: 2, key: t2, row: "Compiling…" }, { seq: 3, key: t2, row: "Compiled" }, { seq: 4, key: t1, gone: true },
  ] } });

  await wait(300);
  c.lines.set("t1", "Done");
  c.links.homeLinesChanged();
  await until(() => heard().length === 3);
  assert.deepEqual(heard()[2], { t: "changes", lines: { seq: 5, changes: [{ seq: 5, key: t1, row: "Done" }] } });
});

test("the owner's devices follow Home: sent both sequences whole, then each change as it comes, the board's and the last lines' apart; a device that comes back with its positions is sent only what it missed; anyone else is cut off", async () => {
  const c = computer();
  c.shown.set(c.repo, { order: ["t2", "t1"], pinned: ["t2"] });
  c.lines.set("t1", "Allow edit to Nav.tsx?");
  const phone = c.connect(c.phone);
  const heard = () => phone.heard.get("home")!.map((m) => JSON.parse(m) as HomeMessage);
  // Asked anything but to follow: nothing.
  phone.send("home", { t: "home" });
  await wait(100);
  assert.deepEqual(heard(), []);
  phone.send("home", { t: "follow" });
  await until(() => heard().length === 1);
  const [t1, t2] = [`t:${c.workspace}/t1`, `t:${c.workspace}/t2`];
  const row = (id: string, more: Record<string, unknown>) => ({ of: "tile", workspace: c.workspace, id, frameId: null, kind: "claude", terminal: true, ...more, machine: "desk" });
  assert.deepEqual(heard()[0], {
    t: "home",
    layout: { seq: 3, rows: [
      [`w:${c.workspace}`, { of: "workspace", workspace: c.workspace, name: "api" }],
      [t1, row("t1", { name: "Editing Nav.tsx", order: 1, state: "waiting", since: T, waiting: { kind: "permission", since: T, decide: true }, program: { id: "claude", label: "Claude Code" } })],
      [t2, row("t2", { name: "Claude", order: 0, pinned: true, state: "working", since: T, interrupt: true })],
    ] },
    lines: { seq: 1, rows: [[t1, "Allow edit to Nav.tsx?"]] },
  });

  // Asked to follow again on the same stream: nothing more.
  phone.send("home", { t: "follow" });
  await wait(100);
  assert.equal(heard().length, 1);

  // t2 prints: only the lines move. t1 is answered: only its row is sent.
  c.lines.set("t2", "Compiling…");
  c.links.homeLinesChanged();
  await until(() => heard().length === 2);
  assert.deepEqual(heard()[1], { t: "changes", lines: { seq: 2, changes: [{ seq: 2, key: t2, row: "Compiling…" }] } });
  await wait(300);
  c.statusChanged("t1", { state: "working", since: T + 1, title: "Editing Nav.tsx" });
  await until(() => heard().length === 3);
  assert.deepEqual(heard()[2], { t: "changes", layout: { seq: 4, changes: [{ seq: 4, key: t1, row: row("t1", { name: "Editing Nav.tsx", order: 1, state: "working", since: T + 1, program: { id: "claude", label: "Claude Code" } }) }] } });

  // The phone goes and comes back from where it was: sent what it missed, nothing whole.
  phone.hangUp();
  await phone.closed;
  c.lines.delete("t1");
  c.links.homeLinesChanged();
  const again = c.connect(c.phone);
  again.send("home", { t: "follow", layout: 4, lines: 2 });
  await until(() => again.heard.get("home")!.length === 1);
  assert.deepEqual(JSON.parse(again.heard.get("home")![0]!), { t: "changes", layout: { seq: 4, changes: [] }, lines: { seq: 3, changes: [{ seq: 3, key: t1, gone: true }] } });

  // Someone else's device asking to follow is cut off, and told nothing.
  const stranger = c.connect(idOf(newSeed()));
  stranger.send("home", { t: "follow" });
  assert.equal(await Promise.race([stranger.closed, wait(2_000).then(() => "still open")]), "removed");
  assert.deepEqual(stranger.heard.get("home"), []);
});

test("while a phone follows Home, every agent's words are read, unwatched and with no report; after it hangs up a report reads nothing, and Home followed again reads what it said meanwhile", async () => {
  const file = path.join(tmp, `said-${made}.jsonl`);
  let n = 0;
  const words = (text: string) => fs.appendFileSync(file, `${JSON.stringify({ type: "assistant", uuid: `a${n}`, timestamp: new Date(1_790_000_000_000 + n++).toISOString(), message: { content: text } })}\n`);
  const format = { id: "uuid", at: "timestamp", said: [{ require: { type: "assistant" }, text: "message.content", who: "agent" as const }] };
  // eslint-disable-next-line prefer-const
  let c: ReturnType<typeof computer>;
  const lines = new TileLines({
    server: () => ({ publishTo: () => {} }), changed: () => c.links.homeLinesChanged(),
    transcriptOf: (bare) => (bare === "t1" ? { session: "s1", file, format } : null),
  });
  c = computer({ lines });
  const t1 = `t:${c.workspace}/t1`;
  /** What Home last told `phone` t1's line is. */
  const homeLine = (phone: { heard: Map<string, string[]> }) => {
    let line: string | undefined;
    for (const m of phone.heard.get("home")!.map((h) => JSON.parse(h) as HomeMessage)) {
      if (m.t === "home") line = m.lines.rows.find(([k]) => k === t1)?.[1];
      else for (const ch of m.lines?.changes ?? []) if (ch.key === t1) line = "row" in ch ? ch.row : undefined;
    }
    return line;
  };
  words("Waiting on CI");
  const phone = c.connect(c.phone);
  phone.send("home", { t: "follow" });
  await until(() => homeLine(phone) === "Waiting on CI");
  assert.equal(homeLine(phone), "Waiting on CI");

  phone.hangUp();
  await phone.closed;
  // Its streams close as the link does.
  await wait(50);
  words("Merged");
  lines.reported("t1", "s1");
  await wait(100);
  assert.equal(lines.get("t1"), "Waiting on CI", "followed by no one: not read");

  const again = c.connect(c.phone);
  again.send("home", { t: "follow" });
  await until(() => homeLine(again) === "Merged");
  assert.equal(homeLine(again), "Merged");
});

/** The person's computer hosting the workspace `api`, whose terminals are the host's own
 *  (terminals.ts) over a backend that records which sessions it lets go of, and Priya's computer, a
 *  guest there, with her app's `api` stream for the workspace and two windows showing t1's
 *  terminal, each with an `api` stream of its own for terminals, on her one connection, as her app
 *  opens them. `early`: the first window asks before her app's hello on `sync` arrives, as one may
 *  just after it dials. */
async function guestWindows({ early = false } = {}) {
  const dir = path.join(tmp, String(made++));
  const repo = path.join(dir, "api");
  const person = newSeed();
  const store = new WorkspaceStore({ dir: path.join(dir, "workspaces"), person });
  store.setCore(repo, { v: 1, frames: [], tiles: [{ id: "t1", kind: "claude", label: "Claude" }] });
  const workspace = store.ownership(repo)!.workspaceId as string;
  const [priya, hers] = [newSeed(), idOf(newSeed())];
  const lists = new AccessLists({ dir: path.join(dir, "access"), owner: person, devices: () => [] });
  lists.grant(workspace, idOf(priya), "view");
  lists.addDevice(workspace, certifyDevice(priya, hers));
  const intents = new Intents(new AuditLog({ file: path.join(dir, "audit.jsonl") }));
  const letGo: string[] = [];
  let session: SessionOutput | undefined;
  const terminals = new Terminals({
    intents,
    relay: { record: () => {}, screenPrefix: "" },
    backend: {
      start: async (_, out) => { session = out; return { pid: 7 }; },
      write: () => {}, echoes: () => false, resize: () => {}, repaint: () => {}, pause: () => {}, resume: () => {}, kill: () => {},
      detach: (tile) => letGo.push(tile),
      screen: (_, lines) => (cb) => { cb(lines === undefined ? "screen" : `screen with ${lines} lines`); return true; },
    },
  });
  const tileLines = new TileLines({ server: () => server });
  const server = new WorkspaceServer([...workspaceDomains, terminals.domain, tileLines.domain], intents);
  const links = new PeerLinks({ store, changes: () => () => {}, lists, server, machines: { self: () => ({ device: idOf(newSeed()), name: "desk" }), mine: () => undefined, whose: () => undefined, saved: () => undefined } });
  const [computerEnd, herComputer] = linkPair(hers, idOf(newSeed()));
  links.serve(computerEnd);
  const hello = () => herComputer.send("sync", JSON.stringify({ t: "hello", workspace, seen: null }));
  if (!early) hello();
  const stream = (first?: unknown) => {
    const api = herComputer.open("api");
    if (first) api.send(JSON.stringify(first));
    const heard: Array<{ id?: number; event?: string; params?: unknown[] }> = [];
    api.on((t) => { const m = JSON.parse(t) as typeof heard[number] | typeof heard; heard.push(...(Array.isArray(m) ? m : [m])); });
    return { api, heard, events: () => heard.flatMap((m) => (m.event ? [m.event] : [])) };
  };
  const herApp = stream({ terminals: false });
  const window = () => {
    const { api, heard, events } = stream({ terminals: true });
    return {
      events,
      open: () => api.send(JSON.stringify({ id: 1, method: "terminal.open", params: [{ tileId: "hm:t1", tile: "t1", cwd: `hive://${workspace}`, cmd: "", cols: 80, rows: 24, attachOnly: true }] })),
      notice: (method: string, ...params: unknown[]) => api.send(JSON.stringify({ method, params })),
      /** Watch the last lines of `tiles`: what it is answered. */
      watchLines: async (tiles: string[]) => {
        api.send(JSON.stringify({ id: 2, method: "tile.watchLines", params: [tiles] }));
        await until(() => heard.some((m) => m.id === 2));
        return heard.find((m) => m.id === 2);
      },
      /** Each `tile.lines` it was told. */
      lines: () => heard.filter((m) => m.event === "tile.lines").map((m) => (m.params![0] as { lines: Record<string, string> }).lines),
      answered: () => heard.some((m) => m.id === 1),
      /** What it was sent of t1's screen and output. */
      shown: () => heard.filter((m) => m.event === "terminal.data").map((m) => m.params![1] as string),
    };
  };
  const [a, b] = [window(), window()];
  a.open();
  if (early) {
    await wait(50);
    hello();
  }
  await until(() => a.answered());
  b.open();
  await until(() => b.shown().includes("screen"));
  return { a, b, herApp, letGo, server, tileLines, print: (data: string) => session!.data(data) };
}

test("a guest's app hears what happens in the workspace once, on its own stream, and her windows only their terminals", async () => {
  const { a, b, herApp, server, print } = await guestWindows();
  server.publish("status.changed", { tileId: "t1", state: "working", since: T } as never);
  server.publish("terminal.size", "hm:t1", 100, 30);
  print("out");
  await until(() => herApp.events().includes("status.changed") && b.shown().includes("out"));
  await wait(100);
  assert.deepEqual(herApp.events(), ["status.changed"]);
  for (const w of [a, b]) {
    assert.deepEqual(w.events().filter((e) => !e.startsWith("terminal.")), [], "a window hears no event but a terminal's");
    assert.ok(w.events().includes("terminal.size"));
  }
});

test("a guest's window that watches last lines is answered and told them on its own stream, alone: neither her other window nor her app hears them", async () => {
  const { a, b, herApp, tileLines } = await guestWindows();
  tileLines.set("t1", "npm test");
  assert.deepEqual(await a.watchLines(["t1"]), { id: 2, result: { lines: { t1: "npm test" } } });
  tileLines.set("t1", "214 tests passed");
  await until(() => a.lines().length > 0);
  await wait(100);
  assert.deepEqual(a.lines(), [{ t1: "214 tests passed" }]);
  assert.deepEqual([b.lines(), herApp.events().filter((e) => e === "tile.lines")], [[], []]);
});

test("a guest's window that asks before her app's hello reaches the host is answered once it does", async () => {
  const { a, b, print } = await guestWindows({ early: true });
  assert.ok(a.answered());
  print("live");
  await until(() => a.shown().includes("live"));
  assert.deepEqual(a.shown(), ["live"]);
  assert.deepEqual(b.shown(), ["screen", "live"]);
});

test("a guest's window that hides a terminal another of her windows shows hides it from itself alone: the other is sent its output", async () => {
  const { a, b, print } = await guestWindows();
  a.notice("terminal.show", "hm:t1", false);
  await wait(50);
  print("after a hid it");
  await until(() => b.shown().includes("after a hid it"));
  assert.deepEqual(b.shown(), ["screen", "after a hid it"]);
  assert.deepEqual(a.shown(), []);
});

test("a guest's window that lets go of a terminal another of her windows shows leaves it shown there; once both let go, the host lets go of it", async () => {
  const { a, b, letGo, print } = await guestWindows();
  a.notice("terminal.detach", "hm:t1");
  await wait(100);
  assert.deepEqual(letGo, []);
  print("still shown");
  await until(() => b.shown().includes("still shown"));
  assert.deepEqual(b.shown(), ["screen", "still shown"]);
  b.notice("terminal.detach", "hm:t1");
  await until(() => letGo.length > 0);
  assert.deepEqual(letGo, ["hm:t1"]);
});

test("a guest's window that asks for more of a terminal's history is sent the screen again alone: her other window showing it is sent nothing", async () => {
  const { a, b } = await guestWindows();
  a.notice("terminal.history", "hm:t1", 500);
  await until(() => a.shown().length > 0);
  await wait(100);
  assert.deepEqual(b.shown(), ["screen"]);
  assert.deepEqual(a.shown(), ["screen with 500 lines"]);
});
