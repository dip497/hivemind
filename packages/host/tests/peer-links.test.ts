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
import { AccessLists } from "@hivemind/workspace-host/access";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import { certifyDevice, idOf, newSeed } from "@hivemind/workspace-host/identity";
import { Intents, type Actor } from "@hivemind/workspace-host/intents";
import type { Link, Stream } from "@hivemind/workspace-host/hive-net";
import { WorkspaceStore } from "@hivemind/workspace-host/store";
import { WorkspaceServer, type Connection } from "@hivemind/workspace-api/server";
import { workspaceDomains } from "../src/domains.ts";
import { PeerLinks } from "../src/peer-links.ts";
import type { WaitingStatus } from "../src/needs.ts";

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
  };
  return [computerEnd, deviceEnd] as const;
}

/** The person's computer, holding the workspace `api`, with their phone and laptop paired. */
function computer() {
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
        viewed.push({ what: "view.open", by: from.actor, at, may: ["agent.start", "agent.close", "store.setCore"].filter((m) => from.may?.(m)) });
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
  const server = new WorkspaceServer([...workspaceDomains, terminals], new Intents(new AuditLog({ file: path.join(dir, "audit.jsonl") })));
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
  const links = new PeerLinks({
    store, changes: () => () => {}, lists, server,
    daemon: async () => { const d = new PassThrough(); daemons.push(d); return d; },
    phone: (device) => device === phone,
    statuses: () => statuses,
    // The agent of t1 is Claude Code, and says which of its keys allow and deny what it asks; t2's
    // says which interrupt its turn.
    facts: () => ({
      program: (tile) => (tile === "t1" ? { id: "claude", label: "Claude Code" } : undefined),
      decides: (tile) => tile === "t1",
      interrupts: (tile) => tile === "t2",
      converses: () => false,
    }),
    // Each agent here runs on this computer.
    machines: { self: () => ({ device: self, name: "desk" }), mine: () => undefined, whose: () => undefined, saved: () => undefined },
    subscribe: (device, sub) => subscribed.push({ device, sub }),
    unpair: (device) => unpaired.push(device),
    introduced: (by, phones) => introduced.push({ by, phones }),
    forget: (by, device) => { forgot.push({ by, device }); return device === phone; },
    devices: () => [host],
    profile: async () => ({ name: "Priya", color: "#3b82f6" }),
  });
  /** `device` connects: what it hears on each stream, and its end of the link; and a stream of its
   *  own, opened beside them (`open`): what is sent on it, what it hears, and its end. */
  const connect = (device: string) => {
    const [computerEnd, deviceEnd] = linkPair(device, self);
    links.serve(computerEnd);
    const heard = new Map<string, string[]>();
    for (const stream of ["device", "pty", "sync", "api", "files", "hosting", "agents"]) {
      heard.set(stream, []);
      deviceEnd.on(stream, (t) => heard.get(stream)!.push(t));
    }
    const open = (name: string) => {
      const s = deviceEnd.open(name);
      const said: string[] = [];
      s.on((t) => said.push(t));
      return { send: (m: unknown) => s.send(JSON.stringify(m)), heard: said, end: s.end };
    };
    return { heard, send: (stream: string, m: unknown) => deviceEnd.send(stream, JSON.stringify(m)), open, closed: computerEnd.closed, hangUp: () => deviceEnd.close("done") };
  };
  return { repo, workspace, phone, laptop, person: idOf(person), daemons, watched, typed, answered, sent, keyed, driven, viewed, subscribed, unpaired, introduced, forgot, host, connect, statusChanged, output, another };
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
  await until(() => [...laptop.heard].every(([s, h]) => s === "api" || s === "agents" || h.length > 0));
  assert.deepEqual([...laptop.heard].filter(([s, h]) => s !== "api" && s !== "agents" && h.length === 0).map(([s]) => s), [], "the laptop hears on every stream");
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
  assert.deepEqual([2, 3, 4, 6, 8].map((id) => answers[id]?.error?.code), ["FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN"]);
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

test("a phone drives the workspace's agents as the owner's device: sees what may be started, starts one, interrupts its turn, closes it and reads what it changed; an agent of another workspace is refused", async () => {
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
  assert.equal(answers[6]?.error?.code, "FORBIDDEN");
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
    { what: "view.open", by: asPhone, at: ["priya-board", c.repo, screen], may: ["agent.start", "agent.close"] },
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

test("the owner's laptop says which phones it paired with, and which it unpaired that paired here, and is answered; a phone asks which of the owner's devices it may reach through this one, and is told, and whose they are; neither is answered the other's question", async () => {
  const c = computer();
  const pixel = { device: c.phone, name: "Pixel" };
  const laptop = c.connect(c.laptop);
  laptop.send("device", { t: "phones", phones: [pixel] });
  laptop.send("device", { t: "forget", device: c.phone });
  laptop.send("device", { t: "forget", device: c.laptop });
  laptop.send("device", { t: "devices" });
  laptop.send("device", { t: "workspaces" });
  await until(() => laptop.heard.get("device")!.length >= 4);
  await wait(100);
  assert.deepEqual(laptop.heard.get("device")!.map((m) => (JSON.parse(m) as { t: string; ok?: boolean })).map(({ t, ok }) => ({ t, ok })), [
    { t: "phones", ok: true }, { t: "forget", ok: true }, { t: "forget", ok: false }, { t: "workspaces", ok: undefined },
  ]);
  assert.deepEqual(c.introduced, [{ by: c.laptop, phones: [pixel] }]);
  assert.deepEqual(c.forgot, [{ by: c.laptop, device: c.phone }, { by: c.laptop, device: c.laptop }]);

  const phone = c.connect(c.phone);
  phone.send("device", { t: "phones", phones: [] });
  phone.send("device", { t: "forget", device: c.phone });
  phone.send("device", { t: "devices" });
  await until(() => phone.heard.get("device")!.length >= 1);
  await wait(100);
  assert.deepEqual(phone.heard.get("device")!.map((m) => JSON.parse(m) as unknown), [{ t: "devices", devices: [c.host], profile: { name: "Priya", color: "#3b82f6" } }]);
  assert.deepEqual(c.introduced, [{ by: c.laptop, phones: [pixel] }], "a phone's word is no introduction");
  assert.equal(c.forgot.length, 2, "nor is it unpairing another");
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
