// One of the owner's phones on the links a device serves (peer-links.ts, spec/pairing.md 0.3): let
// in as the person's device, it is answered which workspaces the device holds and what waits on
// the person there (spec/needs.md), and served nothing else the owner's computers are: no
// terminals in this machine's daemon, no workspace's board or calls, no files, no hosting. The
// owner's laptop, on the same links, is served each of them.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { AccessLists } from "@hivemind/workspace-host/access";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import { certifyDevice, idOf, newSeed } from "@hivemind/workspace-host/identity";
import { Intents } from "@hivemind/workspace-host/intents";
import type { Link } from "@hivemind/workspace-host/hive-net";
import { WorkspaceStore } from "@hivemind/workspace-host/store";
import { WorkspaceServer } from "@hivemind/workspace-api/server";
import { workspaceDomains } from "../src/domains.ts";
import { PeerLinks } from "../src/peer-links.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hm-peer-links-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const REPO = path.join(tmp, "api");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/** The person's computer, holding the workspace in `REPO`, with their phone and laptop paired. */
function computer() {
  const person = newSeed();
  const store = new WorkspaceStore({ dir: path.join(tmp, "workspaces"), person });
  store.setCore(REPO, { v: 1, frames: [], tiles: [{ id: "t1", kind: "claude", label: "Claude" }, { id: "t2", kind: "claude", label: "Claude" }] });
  const workspace = store.ownership(REPO)!.workspaceId as string;
  const [phone, laptop, self] = [idOf(newSeed()), idOf(newSeed()), idOf(newSeed())];
  const lists = new AccessLists({ dir: path.join(tmp, "access"), owner: person, devices: () => [certifyDevice(person, phone), certifyDevice(person, laptop)] });
  const server = new WorkspaceServer(workspaceDomains, new Intents(new AuditLog({ file: path.join(tmp, "audit.jsonl") })));
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
    /** Ask on each stream what an owner's computer asks. */
    const askEverything = () => {
      deviceEnd.send("pty", JSON.stringify({ t: "attach", reqId: 1, id: "hm:t1", spec: { cwd: REPO, cmd: "/bin/sh", args: [], cols: 80, rows: 24 } }));
      deviceEnd.send("sync", JSON.stringify({ t: "hello", workspace, seen: null }));
      deviceEnd.send("api", JSON.stringify({ id: 1, method: "status.all", params: [] }));
      deviceEnd.send("files", JSON.stringify({ id: 1, method: "file.read", params: [REPO, "README.md"] }));
      deviceEnd.send("hosting", JSON.stringify({ t: "take", workspace }));
      deviceEnd.send("device", JSON.stringify({ t: "workspaces" }));
      deviceEnd.send("device", JSON.stringify({ t: "needs" }));
    };
    return { heard, askEverything };
  };
  return { workspace, phone, laptop, daemons, connect };
}

test("a phone is answered which workspaces its computer holds and what waits on the person there, and served nothing else: no terminals, board, calls, files or hosting", async () => {
  const c = computer();
  // The owner's laptop is served each.
  const laptop = c.connect(c.laptop);
  laptop.askEverything();
  for (let t = 0; t < 5_000 && [...laptop.heard.values()].some((h) => h.length === 0); t += 20) await wait(20);
  assert.deepEqual([...laptop.heard].filter(([, h]) => h.length === 0).map(([s]) => s), [], "the laptop hears on every stream");
  assert.equal(c.daemons.length, 1);

  const phone = c.connect(c.phone);
  phone.askEverything();
  for (let t = 0; t < 5_000 && phone.heard.get("device")!.length < 2; t += 20) await wait(20);
  assert.deepEqual(phone.heard.get("device")!.map((m) => JSON.parse(m) as unknown), [
    { t: "workspaces", workspaces: [{ workspace: c.workspace, name: "api", repo: REPO }] },
    { t: "needs", needs: [{ workspace: c.workspace, name: "api", tile: "t1", agent: "Editing Nav.tsx", kind: "permission", since: 1_790_000_000_000 }] },
  ]);
  await wait(200);
  assert.deepEqual([...phone.heard].filter(([s, h]) => s !== "device" && h.length > 0).map(([s]) => s), [], "the phone hears on no other stream");
  assert.equal(c.daemons.length, 1, "no connection to the daemon for the phone");
});
