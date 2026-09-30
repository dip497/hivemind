// The workspace API between devices (peers.ts, spec/workspace-api.md "Peers"): a peer's calls run
// as that peer, with the workspace it names by id read as its repo here; what its role does not
// allow is FORBIDDEN and never runs; it hears only the events about its workspace's tiles and is
// refused any other tile; a call waiting when the connection goes fails, and the host lets go.
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
  },
  effects: { "git.commit": () => ({}), "terminal.open": () => ({}) },
  notices: {
    "terminal.show": (from: Connection, tile: unknown) => { ran.push({ what: "terminal.show", by: from.actor, args: [tile] }); },
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

test("a peer hears only the events about its workspace's tiles, and is refused a tile outside it", async () => {
  const { server, client } = connect("view");
  const heard: string[] = [];
  client.on("terminal.data", (tile, data) => heard.push(`${tile}:${data}`));
  client.on("file.changed", (repo) => heard.push(`changed ${repo}`));
  client.on("store.changed", () => heard.push("store"));
  await client.call("file.read", workspaceUrl(W), "a.ts"); // connected
  server.publish("terminal.data", "in-1", "hello");
  server.publish("terminal.data", "out-1", "secret");
  server.publish("file.changed", REPO, { paths: ["a.ts"] });
  server.publish("file.changed", "/work/other", { paths: [".env"] });
  server.publish("store.changed", { repo: REPO, part: "core" });
  await Bun.sleep(10);
  expect(heard).toEqual(["in-1:hello", `changed ${workspaceUrl(W)}`]);

  ran.length = 0;
  client.notice("terminal.show", "out-1", true);
  client.notice("terminal.show", "in-1", true);
  await Bun.sleep(10);
  expect(ran.map((r) => r.args[0])).toEqual(["in-1"]);
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
