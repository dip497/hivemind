// One of the owner's phones on the links a device serves (peer-links.ts, spec/pairing.md 0.3): let
// in as the person's device, it is answered which workspaces the device holds and what waits on
// the person there (spec/needs.md), gives where it is told what happens there (spec/push.md), and
// may open one workspace to watch its terminals and answer its agents, as the owner's device; it
// is served nothing else the owner's computers are: no terminals started or typed into, no
// workspace's board, files or other calls, no hosting. The owner's laptop, on the same links, is
// served each of them, and is told nothing on a phone's behalf.
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

/** Two ends of one connection: frames arrive in order, a moment after they are sent. */
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
    close: (why = "closed") => close(why),
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
  /** What was typed into a terminal, and by whom; each agent answered, and by whom. */
  const typed: Array<{ by: Actor; tile: unknown }> = [];
  const answered: Array<{ by: Actor; tile: unknown }> = [];
  /** Where each device is told what happens here. */
  const subscribed: Array<{ device: string; sub: unknown }> = [];
  const terminals = {
    answers: {
      "terminal.open": (from: Connection, opts: unknown) => { watched.push({ by: from.actor, opts }); return { pid: 1, joined: true }; },
      "agent.answer": (from: Connection, tile: unknown) => { answered.push({ by: from.actor, tile }); return { answered: true }; },
    },
    effects: {},
    notices: { "terminal.write": (from: Connection, tile: unknown) => { typed.push({ by: from.actor, tile }); } },
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
    subscribe: (device, sub) => subscribed.push({ device, sub }),
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
    return { heard, send: (stream: string, m: unknown) => deviceEnd.send(stream, JSON.stringify(m)), closed: computerEnd.closed };
  };
  return { repo, workspace, phone, laptop, person: idOf(person), daemons, watched, typed, answered, subscribed, connect };
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
    { t: "needs", needs: [{ workspace: c.workspace, name: "api", tile: "t1", agent: "Editing Nav.tsx", kind: "permission", since: 1_790_000_000_000 }] },
  ]);
  await wait(200);
  assert.deepEqual([...phone.heard].filter(([s, h]) => s !== "device" && h.length > 0).map(([s]) => s), [], "the phone hears on no other stream");
  assert.equal(c.daemons.length, 1, "no connection to the daemon for the phone");
});

test("a phone opens a workspace to watch its terminals and answer its agents, as the owner's device; anything else there, typing included, is refused, and one opened without naming a workspace here is closed", async () => {
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
  // Typing is not among what a phone asks: it is dropped, as any notice it may not send.
  phone.send("api", { method: "terminal.write", params: ["hm:t1", "rm -rf ~\n"] });
  await until(() => phone.heard.get("api")!.length >= 6);
  const answers = Object.fromEntries(phone.heard.get("api")!.map((m) => JSON.parse(m) as { id: number; result?: unknown; error?: { code: string } }).map((a) => [a.id, a]));
  assert.deepEqual(answers[1]!.result, { pid: 1, joined: true });
  assert.deepEqual([2, 3, 4, 6].map((id) => answers[id]?.error?.code), ["FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN"]);
  const asPhone = { kind: "peer", person: c.person, device: c.phone, access: "owner" };
  assert.deepEqual(c.watched, [{ by: asPhone, opts: { ...watch, cwd: c.repo } }]);
  assert.deepEqual(answers[5]!.result, { answered: true });
  assert.deepEqual(c.answered, [{ by: asPhone, tile: "t1" }]);
  await wait(100);
  assert.deepEqual(c.typed, []);

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
