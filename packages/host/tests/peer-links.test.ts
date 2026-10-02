// One of the owner's phones on the links a device serves (peer-links.ts, spec/pairing.md 0.3): let
// in as the person's device, it is answered which workspaces the device holds and what waits on
// the person there (spec/needs.md), gives where it is told what happens there (spec/push.md),
// unpairs itself (spec/pairing.md), and may open one workspace to watch and type into its
// terminals and answer and message its agents, as the owner's device; it is served nothing else
// the owner's computers are: no terminals started or sized, no keyboards given or taken, no
// workspace's board, files or other calls, no hosting. The
// owner's laptop, on the same links, is served each of them, and is told nothing on a phone's
// behalf, nor unpaired by asking.
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
import type { Link } from "@hivemind/workspace-host/hive-net";
import { WorkspaceStore } from "@hivemind/workspace-host/store";
import { WorkspaceServer, type Connection } from "@hivemind/workspace-api/server";
import { workspaceDomains } from "../src/domains.ts";
import { PeerLinks } from "../src/peer-links.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hm-peer-links-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let made = 0;

/** Two ends of one connection: frames arrive in order, a moment after they are sent, and what
 *  was sent before it closed arrives before the close, as on hive-net. */
function linkPair(device: string, computer: string): [Link, Link] {
  const heard = [new Map<string, Set<(t: string) => void>>(), new Map<string, Set<(t: string) => void>>()];
  let close!: (why: string) => void;
  const closed = new Promise<string>((r) => { close = r; });
  const end = (i: number, peer: string): Link => ({
    peer,
    send: (stream, data) => void setImmediate(() => { for (const l of heard[1 - i]!.get(stream) ?? []) l(data); }),
    on: (stream, l) => {
      const set = heard[i]!.get(stream) ?? new Set();
      heard[i]!.set(stream, set.add(l));
      return () => { set.delete(l); };
    },
    close: (why = "closed") => void setImmediate(() => close(why)),
    closed,
  });
  // The computer's end hears from the device, its peer, and the other way.
  return [end(0, device), end(1, computer)];
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
  /** Each terminal a connection opened, and as whom: what the host's terminals would show. */
  const watched: Array<{ by: Actor; opts: unknown }> = [];
  /** What was typed into a terminal, and by whom; each agent answered, and sent a message, and by
   *  whom; and what else reached a terminal's keyboard or size. */
  const typed: Array<{ by: Actor; tile: unknown }> = [];
  const answered: Array<{ by: Actor; tile: unknown }> = [];
  const sent: Array<{ by: Actor; tile: unknown }> = [];
  const keyed: Array<{ what: string; by: Actor; tile: unknown }> = [];
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
      "terminal.open": (from: Connection, opts: unknown) => { watched.push({ by: from.actor, opts }); return { pid: 1, joined: true }; },
      "agent.answer": (from: Connection, tile: unknown) => { answered.push({ by: from.actor, tile }); return { answered: true }; },
      "agent.send": (from: Connection, tile: unknown) => { sent.push({ by: from.actor, tile }); return { sent: true }; },
    },
    effects: {},
    notices: {
      "terminal.write": (from: Connection, tile: unknown) => { typed.push({ by: from.actor, tile }); },
      ...Object.fromEntries(["terminal.resize", "terminal.keyboard.ask", "terminal.keyboard.give", "terminal.keyboard.take"].map((what) => [
        what, (from: Connection, tile: unknown) => { keyed.push({ what, by: from.actor, tile }); },
      ])),
    },
  };
  const server = new WorkspaceServer([...workspaceDomains, terminals], new Intents(new AuditLog({ file: path.join(dir, "audit.jsonl") })));
  /** The connections made to this machine's terminal daemon: each echoes what it is sent. */
  const daemons: PassThrough[] = [];
  const links = new PeerLinks({
    store, changes: () => () => {}, lists, server,
    daemon: async () => { const d = new PassThrough(); daemons.push(d); return d; },
    phone: (device) => device === phone,
    // The agent of t1 waits on the person; t2's works.
    statuses: () => [
      { tileId: "t1", status: { state: "waiting", kind: "permission", since: 1_790_000_000_000, title: "Editing Nav.tsx" } },
      { tileId: "t2", status: { state: "working", since: 1_790_000_000_000 } },
    ],
    // The agent of t1 says which of its keys allow and deny what it asks.
    decides: (tile) => tile === "t1",
    // Each agent here runs on this computer.
    machines: { self: () => ({ device: self, name: "desk" }), mine: () => undefined, whose: () => undefined, saved: () => undefined },
    subscribe: (device, sub) => subscribed.push({ device, sub }),
    unpair: (device) => unpaired.push(device),
    introduced: (by, phones) => introduced.push({ by, phones }),
    forget: (by, device) => { forgot.push({ by, device }); return device === phone; },
    devices: () => [host],
    profile: async () => ({ name: "Priya", color: "#3b82f6" }),
  });
  /** `device` connects: what it hears on each stream, and its end of the link. */
  const connect = (device: string) => {
    const [computerEnd, deviceEnd] = linkPair(device, self);
    links.serve(computerEnd);
    const heard = new Map<string, string[]>();
    for (const stream of ["device", "pty", "sync", "api", "files", "hosting"]) {
      heard.set(stream, []);
      deviceEnd.on(stream, (t) => heard.get(stream)!.push(t));
    }
    return { heard, send: (stream: string, m: unknown) => deviceEnd.send(stream, JSON.stringify(m)), closed: computerEnd.closed, hangUp: () => deviceEnd.close("done") };
  };
  return { repo, workspace, phone, laptop, person: idOf(person), daemons, watched, typed, answered, sent, keyed, subscribed, unpaired, introduced, forgot, host, connect };
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
  await until(() => [...laptop.heard].every(([s, h]) => s === "api" || h.length > 0));
  assert.deepEqual([...laptop.heard].filter(([s, h]) => s !== "api" && h.length === 0).map(([s]) => s), [], "the laptop hears on every stream");
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

test("a phone opens a workspace to watch and type into its terminals and answer and message its agents, as the owner's device; anything else there (starting, sizing a terminal, giving or taking a keyboard) is refused, and one opened without naming a workspace here is closed", async () => {
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
