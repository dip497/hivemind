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

function connect(access: Access, only?: readonly string[]) {
  ran.length = 0;
  gone.length = 0;
  const server = new WorkspaceServer([domain], new Intents(new AuditLog({ file: path.join(tmp, "audit.jsonl") })));
  const [host, guest, close] = channel();
  const actor = { kind: "peer", person: "p".repeat(64), device: "d".repeat(64), access } as const;
  servePeer(server, host, { actor, workspace: W, repo: REPO, holds: (t) => t.startsWith("in-"), ...(only ? { only } : {}) });
  const client = new WorkspaceClient(peerTransport(guest));
  return { server, client, close, actor, guest };
}
const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return (e as ApiError).code; } };

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
  const driver = connect("agents");
  await driver.client.call("terminal.open", { tileId: "in-1", cwd: `${workspaceUrl(W)}/src` } as never);
  expect(ran).toEqual([{ what: "terminal.open", by: driver.actor, args: [{ tileId: "in-1", cwd: "/work/api/src" }] }]);
  // The owner's alone: not named for any role.
  expect(await code(driver.client.call("git.commit", workspaceUrl(W), "m"))).toBe("FORBIDDEN");
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

test("a peer is answered the statuses and links of its workspace's own agents, never another's", async () => {
  const { client } = connect("view");
  expect(await client.call("status.all")).toEqual([{ tileId: "in-1", status: { state: "working", title: "in-1's work" } } as never]);
  expect(await client.call("link.list")).toEqual({ pipes: [{ src: "in-1", dst: "in-2" }], spawns: [{ parent: "in-1", child: "in-2" }] });
});

test("a peer let use only some calls is refused any other, whatever its role allows; and those still as its role allows", async () => {
  const phone = connect("view", ["terminal.open", "terminal.show"]);
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
  await Bun.sleep(PEER_FRAME_MS * 2);
  // A hundred milliseconds of output, every 5 ms: four or five frames, not twenty.
  expect(frames.length).toBeGreaterThanOrEqual(3);
  expect(frames.length).toBeLessThanOrEqual(7);
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
