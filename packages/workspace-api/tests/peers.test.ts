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
import { PEER_FRAME_MS, peerTransport, servePeer, workspaceUrl, type TextChannel } from "../src/peers.ts";

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
    "terminal.open": (from: Connection, opts: unknown) => {
      ran.push({ what: "terminal.open", by: from.actor, args: [opts] });
      // Opening a terminal tells the opener its size first, as the host's does.
      from.send({ event: "terminal.size", params: [(opts as { tileId: string }).tileId, 80, 24] });
      return { pid: 1, joined: false };
    },
    "plan.list": (from: Connection, repo: unknown) => { ran.push({ what: "plan.list", by: from.actor, args: [repo] }); return []; },
    // Machine-wide, as the host's are: every agent it runs, in whichever workspace.
    "status.all": () => ["in-1", "out-1"].map((tileId) => ({ tileId, status: { state: "working", title: `${tileId}'s work` } })),
    "link.list": () => ({
      pipes: [{ src: "in-1", dst: "in-2" }, { src: "in-1", dst: "out-1" }, { src: "out-1", dst: "in-2" }],
      spawns: [{ parent: "in-1", child: "in-2" }, { parent: "out-1", child: "in-1" }],
    }),
    "plan.decide": (from: Connection, tile: unknown) => { ran.push({ what: "plan.decide", by: from.actor, args: [tile] }); return { answered: true, by: null }; },
    "agent.answer": (from: Connection, tile: unknown) => { ran.push({ what: "agent.answer", by: from.actor, args: [tile] }); return { answered: true }; },
    "agent.send": (from: Connection, tile: unknown) => { ran.push({ what: "agent.send", by: from.actor, args: [tile] }); return { sent: true }; },
    ...Object.fromEntries(["agent.startable", "agent.start", "agent.interrupt", "agent.close", "agent.diff", "agent.conversation"].map((what) => [
      what, (from: Connection, at: unknown) => { ran.push({ what, by: from.actor, args: [at] }); return {}; },
    ])),
    // A view opened for the caller: what it is let do there is what the caller may call.
    "view.open": (from: Connection, id: unknown, repo: unknown) => {
      ran.push({ what: "view.open", by: from.actor, args: [id, repo, ["agent.start", "agent.close", "store.setCore"].filter((m) => from.may?.(m))] });
      return { session: "s1" };
    },
    "view.list": (from: Connection, repo: unknown) => { ran.push({ what: "view.list", by: from.actor, args: [repo] }); return []; },
    "view.file": (from: Connection, id: unknown, at: unknown, repo: unknown) => { ran.push({ what: "view.file", by: from.actor, args: [repo] }); return {}; },
  },
  effects: { "git.commit": () => ({}), "terminal.open": () => ({}) },
  notices: {
    "terminal.show": (from: Connection, tile: unknown) => { ran.push({ what: "terminal.show", by: from.actor, args: [tile] }); },
    "presence.set": (from: Connection, repo: unknown) => { ran.push({ what: "presence.set", by: from.actor, args: [repo] }); },
    ...Object.fromEntries(["terminal.detach", "terminal.keyboard.ask", "terminal.keyboard.give", "terminal.keyboard.take", "view.post", "view.screen"].map((what) => [
      what, (from: Connection, at: unknown) => { ran.push({ what, by: from.actor, args: [at] }); },
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

function connect(access: Access, allows?: (method: string, params: unknown[]) => boolean, repo = REPO) {
  ran.length = 0;
  gone.length = 0;
  const server = new WorkspaceServer([domain], new Intents(new AuditLog({ file: path.join(tmp, "audit.jsonl") })));
  const [host, guest, close] = channel();
  const actor = { kind: "peer", person: "p".repeat(64), device: "d".repeat(64), access } as const;
  servePeer(server, host, { actor, workspace: W, repo, holds: (t) => t.startsWith("in-"), ...(allows ? { allows } : {}) });
  const client = new WorkspaceClient(peerTransport(guest));
  return { server, client, close, actor, guest };
}
const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return (e as ApiError).code; } };

test("what may be started in its workspace and what an agent changed, anyone with access sees; starting, interrupting and closing an agent is driving agents: for its workspace and its tiles alone", async () => {
  const viewer = connect("view");
  await viewer.client.call("agent.startable", workspaceUrl(W));
  await viewer.client.call("agent.diff", "in-1");
  expect(await code(viewer.client.call("agent.diff", "out-1"))).toBe("FORBIDDEN");
  await viewer.client.call("agent.conversation", "in-1");
  expect(await code(viewer.client.call("agent.conversation", "out-1"))).toBe("FORBIDDEN");
  for (const [method, at] of [["agent.start", workspaceUrl(W)], ["agent.interrupt", "in-1"], ["agent.close", "in-1"]] as const) {
    expect(await code(viewer.client.call(method as "agent.close", at))).toBe("FORBIDDEN");
  }
  expect(ran).toEqual([
    { what: "agent.startable", by: viewer.actor, args: [REPO] },
    { what: "agent.diff", by: viewer.actor, args: ["in-1"] },
    { what: "agent.conversation", by: viewer.actor, args: ["in-1"] },
  ]);

  const driver = connect("agents");
  await driver.client.call("agent.start", workspaceUrl(W), { program: "claude" });
  await driver.client.call("agent.interrupt", "in-1");
  await driver.client.call("agent.close", "in-1");
  expect(await code(driver.client.call("agent.start", "/work/other", { program: "claude" }))).toBe("FORBIDDEN");
  expect(await code(driver.client.call("agent.startable", "/work/other"))).toBe("FORBIDDEN");
  expect(await code(driver.client.call("agent.interrupt", "out-1"))).toBe("FORBIDDEN");
  expect(await code(driver.client.call("agent.close", "out-1"))).toBe("FORBIDDEN");
  expect(ran).toEqual([
    { what: "agent.start", by: driver.actor, args: [REPO] },
    { what: "agent.interrupt", by: driver.actor, args: ["in-1"] },
    { what: "agent.close", by: driver.actor, args: ["in-1"] },
  ]);
});

test("a peer's calls run as the peer, with the workspace it names read as its repo here; what its role does not allow never runs", async () => {
  const viewer = connect("view");
  expect(await viewer.client.call("file.read", workspaceUrl(W), "a.ts")).toBe("a.ts in /work/api");
  expect(ran).toEqual([{ what: "file.read", by: viewer.actor, args: [REPO, "a.ts"] }]);
  expect(await code(viewer.client.call("store.setCore", workspaceUrl(W), {}))).toBe("FORBIDDEN");
  expect(await code(viewer.client.call("git.commit", workspaceUrl(W), "m"))).toBe("FORBIDDEN");
  expect(ran.map((r) => r.what)).toEqual(["file.read"]);

  // The board is edited through the document's sync, which takes only what the role allows: the
  // store's writes are the owner's, whatever the role.
  const editor = connect("edit");
  expect(await code(editor.client.call("store.setCore", workspaceUrl(W), {}))).toBe("FORBIDDEN");
  expect(ran).toEqual([]);
  // Starting what runs on the host is for those who drive agents; its cwd is read as a path here.
  expect(await code(editor.client.call("terminal.open", { tileId: "in-1", cwd: `${workspaceUrl(W)}/src` } as never))).toBe("FORBIDDEN");
  const repo = path.join(tmp, "repo");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  const driver = connect("agents", undefined, repo);
  await driver.client.call("terminal.open", { tileId: "in-1", cwd: `${workspaceUrl(W)}/src` } as never);
  expect(ran).toEqual([{ what: "terminal.open", by: driver.actor, args: [{ tileId: "in-1", cwd: path.join(repo, "src") }] }]);
  // The owner's alone: not named for any role.
  expect(await code(driver.client.call("git.commit", workspaceUrl(W), "m"))).toBe("FORBIDDEN");
  // Answering what an agent of the workspace waits on, and sending one a message, is driving
  // agents.
  ran.length = 0;
  expect(await code(editor.client.call("agent.answer", "in-1", 1, { text: "1" }))).toBe("FORBIDDEN");
  expect(await code(driver.client.call("agent.answer", "out-1", 1, { text: "1" }))).toBe("FORBIDDEN");
  await driver.client.call("agent.answer", "in-1", 1, { text: "1" });
  expect(await code(editor.client.call("agent.send", "in-1", "hi"))).toBe("FORBIDDEN");
  expect(await code(driver.client.call("agent.send", "out-1", "hi"))).toBe("FORBIDDEN");
  await driver.client.call("agent.send", "in-1", "hi");
  expect(ran).toEqual([{ what: "agent.answer", by: driver.actor, args: ["in-1"] }, { what: "agent.send", by: driver.actor, args: ["in-1"] }]);
});

test("an agent-role peer cannot open a terminal outside its workspace or on another workspace's tile", async () => {
  const repo = path.join(tmp, "repo");
  const elsewhere = path.join(tmp, "elsewhere");
  fs.mkdirSync(repo);
  fs.mkdirSync(elsewhere);
  const alias = path.join(repo, "outside-link");
  fs.symlinkSync(elsewhere, alias);
  const driver = connect("agents", undefined, repo);
  for (const [tileId, cwd] of [["in-1", elsewhere], ["in-1", alias], ["out-1", repo]] as const) {
    expect(await code(driver.client.call("terminal.open", { tileId, cwd, cmd: "sh", cols: 80, rows: 24 }))).toBe("FORBIDDEN");
  }
  expect(ran).toEqual([]);
});

test("a peer may open a terminal under a URI-backed repo only on that machine and below that path", async () => {
  for (const [repo, inside, otherMachine, traversal] of [
    ["machine://machine-a/srv/repo", "machine://machine-a/srv/repo/sub", "machine://machine-b/srv/repo/sub", "machine://machine-a/srv/repo/../private"],
    ["ssh://alice@box:2222/srv/repo", "ssh://alice@box:2222/srv/repo/sub", "ssh://alice@other:2222/srv/repo/sub", "ssh://alice@box:2222/srv/repo/../private"],
  ]) {
    const driver = connect("agents", undefined, repo);
    const opts = (cwd: string) => ({ tileId: "in-1", cwd, cmd: "sh", cols: 80, rows: 24 });
    await driver.client.call("terminal.open", opts(inside));
    expect(ran.map((r) => r.what)).toEqual(["terminal.open"]);
    ran.length = 0;
    for (const cwd of [otherMachine, traversal]) expect(await code(driver.client.call("terminal.open", opts(cwd)))).toBe("FORBIDDEN");
    expect(ran).toEqual([]);
  }
});

test("a peer cannot name a symlink outside the workspace as a nested repo", async () => {
  const repo = path.join(tmp, "repo");
  const elsewhere = path.join(tmp, "elsewhere");
  fs.mkdirSync(repo);
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, path.join(repo, "outside-link"));
  const viewer = connect("view", undefined, repo);
  expect(await code(viewer.client.call("file.read", `${workspaceUrl(W)}/outside-link`, "secret.txt"))).toBe("FORBIDDEN");
  expect(ran).toEqual([]);
});

test("a guest names this workspace, by its id, and nothing else on the host: another folder, a way out of it, another workspace or a machine is refused and never runs; the person's own devices are the owner", async () => {
  const viewer = connect("view");
  const url = workspaceUrl(W);
  const elsewhere = ["/etc", "/work/apix", `${url}/../../etc`, "/work/api/../../etc", "../etc", "relative", `hive://${"f".repeat(32)}`, "ssh://box/etc", `machine://${"e".repeat(64)}/home`];
  for (const repo of elsewhere) expect(await code(viewer.client.call("file.read", repo, "passwd"))).toBe("FORBIDDEN");
  viewer.client.notice("presence.set", `hive://${"f".repeat(32)}`, null);
  await new Promise((r) => setTimeout(r, PEER_FRAME_MS * 2));
  expect(ran).toEqual([]);
  expect(await viewer.client.call("file.read", `${url}/src`, "a.ts")).toBe("a.ts in /work/api/src");
  expect(await viewer.client.call("file.read", "/work/api", "a.ts")).toBe("a.ts in /work/api");

  const mine = connect("owner");
  expect(await mine.client.call("file.read", "/elsewhere", "a.ts")).toBe("a.ts in /elsewhere");
});

test("a view opened on a remote screen names the workspace after the view, a guest this one alone; what the view may do there is what the peer may, as its role and its device allow", async () => {
  const viewer = connect("view");
  for (const elsewhere of ["/work/other", `hive://${"f".repeat(32)}`, `${workspaceUrl(W)}/../../etc`]) {
    expect(await code(viewer.client.call("view.open", "board", elsewhere))).toBe("FORBIDDEN");
  }
  await viewer.client.call("view.open", "board", workspaceUrl(W));
  expect(ran).toEqual([{ what: "view.open", by: viewer.actor, args: ["board", REPO, []] }]);
  // Talking to the view it opened, and saying what screen it is shown on, are the viewer's too.
  viewer.client.notice("view.post", "s1", { type: "ready", v: 1 });
  viewer.client.notice("view.screen", "s1", { w: 390, h: 844, theme: { colors: {} } });
  await new Promise((r) => setTimeout(r, PEER_FRAME_MS * 2));
  expect(ran.slice(1).map((r) => r.what)).toEqual(["view.post", "view.screen"]);
  // A guest's desktop lists and loads the views of this workspace, and no other folder's.
  ran.length = 0;
  for (const elsewhere of ["/work/other", `hive://${"f".repeat(32)}`]) {
    expect(await code(viewer.client.call("view.list", elsewhere, "desktop"))).toBe("FORBIDDEN");
    expect(await code(viewer.client.call("view.file", "board", "index.html", elsewhere))).toBe("FORBIDDEN");
  }
  expect(ran).toEqual([]);
  await viewer.client.call("view.list", workspaceUrl(W), "desktop");
  await viewer.client.call("view.file", "board", "index.html", workspaceUrl(W));
  expect(ran.map((r) => r.args[0])).toEqual([REPO, REPO]);
  ran.length = 0;
  const driver = connect("agents");
  await driver.client.call("view.open", "board", workspaceUrl(W));
  expect(ran.map((r) => r.args[2])).toEqual([["agent.start", "agent.close"]]);
  // The person's own device, held to some calls (as their phone is): those alone.
  const phone = connect("owner", (method) => method.startsWith("view.") || method === "agent.close");
  await phone.client.call("view.open", "board", workspaceUrl(W));
  expect(ran.map((r) => r.args[2])).toEqual([["agent.close"]]);
});

test("a peer hears only the events about its workspace, and is refused a tile outside it", async () => {
  const { server, client } = connect("view");
  const heard: string[] = [];
  client.on("terminal.data", (tile, data) => heard.push(`${tile}:${data}`));
  client.on("file.changed", (repo) => heard.push(`changed ${repo}`));
  client.on("store.changed", () => heard.push("store"));
  client.on("presence.changed", (repo, people) => heard.push(`here ${repo}: ${people.map((p) => p.name).join()}`));
  client.on("agent.said", (tile, entries) => heard.push(`${tile} said ${entries.length}`));
  await client.call("file.read", workspaceUrl(W), "a.ts"); // connected
  server.publish("terminal.data", "in-1", "hello");
  server.publish("terminal.data", "out-1", "secret");
  const entry = { id: "u1", at: 1, who: "agent" as const, text: "hi" };
  server.publish("agent.said", "in-1", [entry], 10);
  server.publish("agent.said", "out-1", [entry, entry], 20);
  server.publish("file.changed", REPO, { paths: ["a.ts"] });
  server.publish("file.changed", "/work/other", { paths: [".env"] });
  server.publish("store.changed", { repo: REPO, part: "core" });
  const someone = (name: string) => ({ id: "window:1", person: "o".repeat(64), name, color: "", cursor: null, selection: [] });
  server.publish("presence.changed", REPO, [someone("Ana")]);
  server.publish("presence.changed", "/work/other", [someone("Bo")]);
  await Bun.sleep(10);
  expect(heard).toEqual(["in-1:hello", "in-1 said 1", `changed ${workspaceUrl(W)}`, `here ${workspaceUrl(W)}: Ana`]);

  ran.length = 0;
  client.notice("terminal.show", "out-1", true);
  client.notice("terminal.show", "in-1", true);
  // Being there is anyone's with access.
  client.notice("presence.set", workspaceUrl(W), { name: "Priya", color: "", cursor: null, selection: [] });
  await Bun.sleep(10);
  expect(ran.map((r) => r.args[0])).toEqual(["in-1", REPO]);
});

test("a peer is answered the statuses and links of its workspace's own agents, never another's", async () => {
  const { client } = connect("view");
  expect(await client.call("status.all")).toEqual([{ tileId: "in-1", status: { state: "working", title: "in-1's work" } } as never]);
  expect(await client.call("link.list")).toEqual({ pipes: [{ src: "in-1", dst: "in-2" }], spawns: [{ parent: "in-1", child: "in-2" }] });
});

test("a peer let use only some calls is refused any other, whatever its role allows; and those still as its role allows", async () => {
  const phone = connect("view", (method) => method === "terminal.open" || method === "terminal.show");
  expect(await code(phone.client.call("file.read", workspaceUrl(W), "a.ts"))).toBe("FORBIDDEN");
  expect(await code(phone.client.call("status.all"))).toBe("FORBIDDEN");
  phone.client.notice("presence.set", workspaceUrl(W), null);
  // Watching a terminal of the workspace, as its role allows; never starting one, nor another's.
  await phone.client.call("terminal.open", { tileId: "in-1", cwd: "", cmd: "", cols: 80, rows: 24, attachOnly: true });
  expect(await code(phone.client.call("terminal.open", { tileId: "in-2", cwd: "", cmd: "", cols: 80, rows: 24 }))).toBe("FORBIDDEN");
  expect(await code(phone.client.call("terminal.open", { tileId: "out-1", cwd: "", cmd: "", cols: 80, rows: 24, attachOnly: true }))).toBe("FORBIDDEN");
  phone.client.notice("terminal.show", "in-1", true);
  await new Promise((r) => setTimeout(r, PEER_FRAME_MS * 2));
  expect(ran.map((r) => `${r.what} ${JSON.stringify(r.args[0])}`)).toEqual([
    `terminal.open ${JSON.stringify({ tileId: "in-1", cwd: "", cmd: "", cols: 80, rows: 24, attachOnly: true })}`,
    "terminal.show \"in-1\"",
  ]);
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

test("the events of one moment reach a peer as one frame, and each is heard", async () => {
  const { server, client, guest } = connect("view");
  const frames: string[] = [];
  guest.on((text) => frames.push(text));
  const heard: string[] = [];
  client.on("terminal.data", (tile, data) => heard.push(`${tile}:${data}`));
  await client.call("file.read", workspaceUrl(W), "a.ts"); // connected
  frames.length = 0;
  for (let n = 0; n < 10; n++) server.publish("terminal.data", `in-${n}`, `out ${n}`);
  server.publish("terminal.data", "out-1", "secret");
  await Bun.sleep(10);
  expect(frames).toHaveLength(1);
  expect(heard).toEqual(Array.from({ length: 10 }, (_, n) => `in-${n}:out ${n}`));
  // One event alone is sent as itself.
  server.publish("terminal.data", "in-1", "alone");
  await Bun.sleep(PEER_FRAME_MS + 15);
  expect(JSON.parse(frames[1]!)).toEqual({ event: "terminal.data", params: ["in-1", "alone"] });
});

test("while events stream a peer is sent a frame at most every 25 ms, each heard; after a quiet spell the next goes at once", async () => {
  const { server, client, guest } = connect("view");
  const frames: number[] = [];
  guest.on(() => frames.push(Date.now()));
  const heard: string[] = [];
  client.on("terminal.data", (_tile, data) => heard.push(data));
  await client.call("file.read", workspaceUrl(W), "a.ts"); // connected
  await Bun.sleep(PEER_FRAME_MS * 2);
  frames.length = 0;
  const start = Date.now();
  for (let n = 0; n < 20; n++) {
    server.publish("terminal.data", "in-1", `${n}`);
    await Bun.sleep(5);
  }
  const streamed = Date.now() - start;
  await Bun.sleep(PEER_FRAME_MS * 2);
  // A hundred milliseconds of output, every 5 ms: four or five frames, not twenty. A busy machine
  // stretches the stream, not the frames: in each 25 ms it lasted, at most the tick's frame and one
  // at once after a quiet spell.
  expect(frames.length).toBeGreaterThanOrEqual(3);
  expect(frames.length).toBeLessThanOrEqual(2 * Math.ceil(streamed / PEER_FRAME_MS) + 1);
  expect(frames.length).toBeLessThan(20);
  expect(frames[0]! - start).toBeLessThan(15);
  expect(heard).toEqual(Array.from({ length: 20 }, (_, n) => `${n}`));
});

test("while events stream to several peers, a moment's frames to each go out together", async () => {
  const [one, two] = [connect("view"), connect("view")];
  const at: Record<"one" | "two", number[]> = { one: [], two: [] };
  one.guest.on(() => at.one.push(performance.now()));
  two.guest.on(() => at.two.push(performance.now()));
  await one.client.call("file.read", workspaceUrl(W), "a.ts"); // connected
  await two.client.call("file.read", workspaceUrl(W), "a.ts");
  await Bun.sleep(PEER_FRAME_MS * 2);
  at.one.length = 0;
  at.two.length = 0;
  // Output for the two, a few milliseconds apart, for a tenth of a second.
  for (let n = 0; n < 12; n++) {
    one.server.publish("terminal.data", "in-1", `${n}`);
    await Bun.sleep(4);
    two.server.publish("terminal.data", "in-1", `${n}`);
    await Bun.sleep(4);
  }
  await Bun.sleep(PEER_FRAME_MS * 2);
  // After the first to each, which goes at once, the frames to the two go at the same moments:
  // all but those a tick fell between their first or their last outputs.
  const [ones, twos] = [at.one.slice(1), at.two.slice(1)];
  expect(twos.length).toBeGreaterThanOrEqual(3);
  expect(twos.filter((t) => ones.some((o) => Math.abs(o - t) < 1)).length).toBeGreaterThanOrEqual(twos.length - 2);
});

test("an answer comes after the events its call brought", async () => {
  const driver = connect("agents");
  const order: string[] = [];
  driver.client.on("terminal.size", () => order.push("size"));
  await driver.client.call("file.read", workspaceUrl(W), "a.ts"); // connected
  driver.server.publish("terminal.data", "in-1", "streaming"); // a frame just went: the next waits its turn
  await driver.client.call("terminal.open", { tileId: "in-2", cwd: workspaceUrl(W), attachOnly: true } as never);
  order.push("answer");
  expect(order).toEqual(["size", "answer"]);
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
