// The workspace API between devices (peers.ts, spec/workspace-api.md "Peers"): a peer's calls run
// as that peer, with the workspace it names by id read as its repo here; what its role does not
// allow is FORBIDDEN and never runs; it hears only the events about its workspace (its tiles, its
// files, who is in it) and is refused any other tile; a call waiting when the connection goes
// fails, and the host lets go.
import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Intents, type Actor } from "@hivemind/workspace-host/intents";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import type { Access } from "@hivemind/workspace-host/access";
import { WorkspaceClient } from "../src/client.ts";
import { WorkspaceServer, type Connection } from "../src/server.ts";
import { ApiError } from "../src/protocol.ts";
import { peerTransport, servePeer, workspaceUrl, type TextChannel } from "../src/peers.ts";

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "peers-")); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const W = "0123456789abcdef0123456789abcdef";
const REPO = "/work/api";
const ran: Array<{ what: string; by: Actor; args: unknown[] }> = [];
const gone: Connection[] = [];
const domain = {
  answers: {
    "file.read": (from: Connection, repo: unknown, file: unknown) => { ran.push({ what: "file.read", by: from.actor, args: [repo, file] }); return `${String(file)} in ${String(repo)}`; },
    "store.setCore": (from: Connection, repo: unknown) => { ran.push({ what: "store.setCore", by: from.actor, args: [repo] }); },
    "git.commit": (from: Connection, repo: unknown) => { ran.push({ what: "git.commit", by: from.actor, args: [repo] }); return { sha: "x" }; },
    "terminal.open": (from: Connection, opts: unknown) => { ran.push({ what: "terminal.open", by: from.actor, args: [opts] }); return { pid: 1, joined: false }; },
    "plan.list": (from: Connection, repo: unknown) => { ran.push({ what: "plan.list", by: from.actor, args: [repo] }); return []; },
    "plan.decide": (from: Connection, tile: unknown) => { ran.push({ what: "plan.decide", by: from.actor, args: [tile] }); return { answered: true, by: null }; },
  },
  effects: { "git.commit": () => ({}), "terminal.open": () => ({}) },
  notices: {
    "terminal.show": (from: Connection, tile: unknown) => { ran.push({ what: "terminal.show", by: from.actor, args: [tile] }); },
    "presence.set": (from: Connection, repo: unknown) => { ran.push({ what: "presence.set", by: from.actor, args: [repo] }); },
    ...Object.fromEntries(["terminal.detach", "terminal.keyboard.ask", "terminal.keyboard.give", "terminal.keyboard.take"].map((what) => [
      what, (from: Connection, tile: unknown) => { ran.push({ what, by: from.actor, args: [tile] }); },
    ])),
  },
  gone: (c: Connection) => gone.push(c),
};

/** Two ends of a channel, and a way to close it. */
function channel(): [TextChannel, TextChannel, (why: string) => void] {
  const toA = new Set<(t: string) => void>();
  const toB = new Set<(t: string) => void>();
  let close!: (why: string) => void;
  const closed = new Promise<string>((r) => { close = r; });
  const end = (mine: Set<(t: string) => void>, theirs: Set<(t: string) => void>): TextChannel => ({
    send: (t) => queueMicrotask(() => { for (const l of theirs) l(t); }),
    on: (l) => { mine.add(l); return () => { mine.delete(l); }; },
    closed,
  });
  return [end(toA, toB), end(toB, toA), close];
}

function connect(access: Access) {
  ran.length = 0;
  gone.length = 0;
  const server = new WorkspaceServer([domain], new Intents(new AuditLog({ file: path.join(tmp, "audit.jsonl") })));
  const [host, guest, close] = channel();
  const actor = { kind: "peer", person: "p".repeat(64), device: "d".repeat(64), access } as const;
  servePeer(server, host, { actor, workspace: W, repo: REPO, holds: (t) => t.startsWith("in-") });
  const client = new WorkspaceClient(peerTransport(guest));
  return { server, client, close, actor };
}
const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return (e as ApiError).code; } };

test("a peer's calls run as the peer, with the workspace it names read as its repo here; what its role does not allow never runs", async () => {
  const viewer = connect("view");
  expect(await viewer.client.call("file.read", workspaceUrl(W), "a.ts")).toBe("a.ts in /work/api");
  expect(ran).toEqual([{ what: "file.read", by: viewer.actor, args: [REPO, "a.ts"] }]);
  expect(await code(viewer.client.call("store.setCore", workspaceUrl(W), {}))).toBe("FORBIDDEN");
  expect(await code(viewer.client.call("git.commit", workspaceUrl(W), "m"))).toBe("FORBIDDEN");
  expect(ran.map((r) => r.what)).toEqual(["file.read"]);

  const editor = connect("edit");
  await editor.client.call("store.setCore", workspaceUrl(W), {});
  expect(ran).toEqual([{ what: "store.setCore", by: editor.actor, args: [REPO] }]);
  // Starting what runs on the host is for those who drive agents; its cwd is read as a path here.
  expect(await code(editor.client.call("terminal.open", { tileId: "in-1", cwd: `${workspaceUrl(W)}/src` } as never))).toBe("FORBIDDEN");
  const driver = connect("agents");
  await driver.client.call("terminal.open", { tileId: "in-1", cwd: `${workspaceUrl(W)}/src` } as never);
  expect(ran).toEqual([{ what: "terminal.open", by: driver.actor, args: [{ tileId: "in-1", cwd: "/work/api/src" }] }]);
  // The owner's alone: not named for any role.
  expect(await code(driver.client.call("git.commit", workspaceUrl(W), "m"))).toBe("FORBIDDEN");
});

test("a peer hears only the events about its workspace, and is refused a tile outside it", async () => {
  const { server, client } = connect("view");
  const heard: string[] = [];
  client.on("terminal.data", (tile, data) => heard.push(`${tile}:${data}`));
  client.on("file.changed", (repo) => heard.push(`changed ${repo}`));
  client.on("store.changed", () => heard.push("store"));
  client.on("presence.changed", (repo, people) => heard.push(`here ${repo}: ${people.map((p) => p.name).join()}`));
  await client.call("file.read", workspaceUrl(W), "a.ts"); // connected
  server.publish("terminal.data", "in-1", "hello");
  server.publish("terminal.data", "out-1", "secret");
  server.publish("file.changed", REPO, { paths: ["a.ts"] });
  server.publish("file.changed", "/work/other", { paths: [".env"] });
  server.publish("store.changed", { repo: REPO, part: "core" });
  const someone = (name: string) => ({ id: "window:1", person: "o".repeat(64), name, color: "", cursor: null, selection: [] });
  server.publish("presence.changed", REPO, [someone("Ana")]);
  server.publish("presence.changed", "/work/other", [someone("Bo")]);
  await Bun.sleep(10);
  expect(heard).toEqual(["in-1:hello", `changed ${workspaceUrl(W)}`, `here ${workspaceUrl(W)}: Ana`]);

  ran.length = 0;
  client.notice("terminal.show", "out-1", true);
  client.notice("terminal.show", "in-1", true);
  // Being there is anyone's with access.
  client.notice("presence.set", workspaceUrl(W), { name: "Priya", color: "", cursor: null, selection: [] });
  await Bun.sleep(10);
  expect(ran.map((r) => r.args[0])).toEqual(["in-1", REPO]);
});

test("a terminal's keyboard: one who may use terminals asks for it and hands it on, for the workspace's terminals only; taking it back is the host's; one who only watches may stop", async () => {
  const typist = connect("terminals");
  for (const [method, ...params] of [
    ["terminal.keyboard.ask", "in-1"], ["terminal.keyboard.ask", "out-1"],
    ["terminal.keyboard.give", "in-1", "peer:someone"], ["terminal.keyboard.give", "out-1", "peer:someone"],
    ["terminal.keyboard.take", "in-1"],
  ] as const) typist.client.notice(method as never, ...(params as never[]));
  await Bun.sleep(10);
  expect(ran.map((r) => `${r.what} ${String(r.args[0])}`)).toEqual(["terminal.keyboard.ask in-1", "terminal.keyboard.give in-1"]);

  const viewer = connect("view");
  viewer.client.notice("terminal.keyboard.ask", "in-1");
  viewer.client.notice("terminal.detach", "in-1");
  viewer.client.notice("terminal.detach", "out-1");
  await Bun.sleep(10);
  expect(ran.map((r) => `${r.what} ${String(r.args[0])}`)).toEqual(["terminal.detach in-1"]);
});

test("a peer hears who holds a terminal's keyboard, who asks for it and the terminal's size, for its workspace's terminals only", async () => {
  const { server, client } = connect("terminals");
  const heard: string[] = [];
  client.on("terminal.keyboard", (tile, holder) => heard.push(`${tile} held by ${holder?.name ?? "the host"}`));
  client.on("terminal.keyboard.asked", (tile, asker) => heard.push(`${tile} asked by ${asker.name}`));
  client.on("terminal.size", (tile, cols, rows) => heard.push(`${tile} ${cols}x${rows}`));
  await client.call("file.read", workspaceUrl(W), "a.ts"); // connected
  const ana = { id: "peer:a", person: "a".repeat(64), name: "Ana" };
  for (const tile of ["in-1", "out-1"]) {
    server.publish("terminal.keyboard", tile, ana);
    server.publish("terminal.keyboard.asked", tile, ana);
    server.publish("terminal.size", tile, 100, 30);
    server.publish("terminal.keyboard", tile, null);
  }
  await Bun.sleep(10);
  expect(heard).toEqual(["in-1 held by Ana", "in-1 asked by Ana", "in-1 100x30", "in-1 held by the host"]);
});

test("a plan an agent waits on: anyone with access sees those of the workspace; one who drives agents answers one of its tiles, and hears of its plans only", async () => {
  const typist = connect("terminals");
  expect(await typist.client.call("plan.list", workspaceUrl(W))).toEqual([]);
  expect(ran).toEqual([{ what: "plan.list", by: typist.actor, args: [REPO] }]);
  expect(await code(typist.client.call("plan.decide", "in-1", "r1", "allow"))).toBe("FORBIDDEN");

  const driver = connect("agents");
  await driver.client.call("plan.decide", "in-1", "r1", "allow");
  expect(await code(driver.client.call("plan.decide", "out-1", "r2", "allow"))).toBe("FORBIDDEN");
  expect(ran.map((r) => `${r.what} ${String(r.args[0])}`)).toEqual(["plan.decide in-1"]);

  const heard: string[] = [];
  driver.client.on("plan.review", (r) => heard.push(`review ${r.tileId}`));
  driver.client.on("plan.decided", (d) => heard.push(`decided ${d.tileId}`));
  for (const tileId of ["in-1", "out-1"]) {
    driver.server.publish("plan.review", { requestId: "r", tileId, plan: "# Plan", cwd: REPO });
    driver.server.publish("plan.decided", { requestId: "r", tileId, decision: "allow", by: null });
  }
  await Bun.sleep(10);
  expect(heard).toEqual(["review in-1", "decided in-1"]);
});

test("a call waiting when the connection goes fails, and the host lets go of the peer", async () => {
  const { client, close } = connect("view");
  await client.call("file.read", workspaceUrl(W), "a.ts");
  const hanging = new WorkspaceClient(peerTransport({ send: () => {}, on: () => () => {}, closed: Promise.resolve("gone") }));
  expect(await code(hanging.call("file.read", workspaceUrl(W), "a.ts"))).toBe("FAILED");
  close("the peer left");
  await Bun.sleep(10);
  expect(gone).toHaveLength(1);
});
