// The workspace API's contract, as a client sees it over any transport: a method's result comes
// back; an error comes back thrown, with the code the host answered; a method with an effect is
// carried out through the host's intents and recorded as its caller's, and a read is not; an
// event reaches every client connected, until it goes.
import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Intents } from "@hivemind/workspace-host/intents";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import { WorkspaceClient } from "../src/client.ts";
import { WorkspaceServer, howMany, named, type Connection, type Domain } from "../src/server.ts";
import { ApiError, text, texts, type EventMessage } from "../src/protocol.ts";

let tmp: string;
let file: string;
const staged: string[] = [];
const gone: Connection[] = [];
const agent = { kind: "tile", tile: "tile-codex-2" } as const;

/** A domain as a host has one: it checks its params, and stages into a list rather than a repo. */
const domain: Domain<"git.status" | "git.stage" | "git.pull"> = {
  answers: {
    "git.status": (_, repo) => ({ branch: text(repo, "repo"), upstream: null, ahead: 0, behind: 0, files: [], conflictedFiles: [], isMerging: false, isRebasing: false, head: "" }),
    "git.stage": (_, repo, files) => {
      text(repo, "repo");
      staged.push(...texts(files, "files"));
    },
    "git.pull": () => {
      throw Object.assign(new Error("not a fast-forward"), { code: "ENOTFF" });
    },
  },
  effects: {
    "git.stage": (repo, files) => ({ target: named(repo), detail: howMany(files, "file") }),
    "git.pull": (repo) => ({ target: named(repo) }),
  },
  gone: (connection) => gone.push(connection),
};

const newServer = () => new WorkspaceServer([domain], new Intents(new AuditLog({ file })));
/** A connection as a transport holds one: what it is sent, and a way to close it. */
function connection(actor: Connection["actor"]): Connection & { received: EventMessage[]; close(): void } {
  const closing = new AbortController();
  const received: EventMessage[] = [];
  return { actor, received, send: (m) => received.push(m), closed: closing.signal, close: () => closing.abort() };
}
function clientAs(actor: Connection["actor"]): WorkspaceClient {
  const server = newServer();
  const over = connection(actor);
  // What a transport does: the call goes out as JSON, and its answer comes back as JSON.
  return new WorkspaceClient({
    call: async (method, params) => JSON.parse(JSON.stringify(await server.answer(method, JSON.parse(JSON.stringify(params)), over))),
    notice: () => {},
    events: () => {},
  });
}
const audited = () => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { const { at: _at, ...rest } = JSON.parse(l); return rest; }) : []);
const codeOf = (p: Promise<unknown>) => p.then(() => "answered", (e: unknown) => (e instanceof ApiError ? e.code : `not an ApiError: ${String(e)}`));
const change = (seq: number) => ({ seq, tileId: "tile-codex-2", status: { state: "working" } } as never);

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-api-"));
  file = path.join(tmp, "audit.jsonl");
  staged.length = 0;
  gone.length = 0;
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("a method's result comes back; an error comes back thrown with the host's code", async () => {
  const client = clientAs({ kind: "person" });
  expect((await client.call("git.status", "/repo")).branch).toBe("/repo");
  expect(await codeOf(client.call("git.status", ""))).toBe("BAD_REQUEST");
  expect(await codeOf(client.call("git.diff", "/repo", { kind: "working" }))).toBe("UNKNOWN_METHOD");
  const failed = await client.call("git.pull", "/repo").catch((e: ApiError) => e);
  expect(failed).toMatchObject({ code: "FAILED", message: "not a fast-forward (ENOTFF)" });
});

test("params that are not a list are a bad request, and nothing runs", async () => {
  expect(await newServer().answer("git.stage", { repo: "/repo", files: ["a"] }, connection(agent))).toEqual({ error: { code: "BAD_REQUEST", message: "params must be a list" } });
  expect(staged).toEqual([]);
  expect(audited()).toEqual([]);
});

test("a method with an effect is recorded as its caller's, named from its params, and how it ended; a read is not recorded", async () => {
  const client = clientAs(agent);
  await client.call("git.status", "/repo");
  await client.call("git.stage", "/repo", ["a.txt", "b.txt"]);
  await client.call("git.pull", "/repo").catch(() => undefined);
  await client.call("git.stage", "/repo", [7 as unknown as string]).catch(() => undefined);
  expect(staged).toEqual(["a.txt", "b.txt"]);
  expect(audited()).toEqual([
    { actor: agent, verb: "git.stage", target: "/repo", detail: "2 files", outcome: "ok" },
    { actor: agent, verb: "git.pull", target: "/repo", outcome: "error", code: "ENOTFF" },
    { actor: agent, verb: "git.stage", target: "/repo", detail: "1 file", outcome: "error", code: "BAD_REQUEST" },
  ]);
});

test("an event reaches every client connected until it goes; when one goes, each domain lets go of what it held", () => {
  const server = newServer();
  const first = connection({ kind: "person" });
  const second = connection(agent);
  server.connect(first);
  server.connect(second);
  server.connect(second); // a transport that connects twice is one connection
  server.publish("status.changed", change(1));
  second.close();
  server.publish("status.changed", change(2));
  expect(first.received).toEqual([{ event: "status.changed", params: [change(1)] }, { event: "status.changed", params: [change(2)] }]);
  expect(second.received).toEqual([{ event: "status.changed", params: [change(1)] }]);
  expect(gone).toEqual([second]);
});

test("a client's listeners each get the events they listen for; one that fails is reported and stops none of the others; one that stops gets no more", () => {
  let deliver: (m: EventMessage) => void = () => {};
  const client = new WorkspaceClient({ call: async () => ({ result: null }), notice: () => {}, events: (listener) => { deliver = listener; } });
  const seen: string[] = [];
  const failures: unknown[] = [];
  const consoleError = console.error;
  console.error = (...args: unknown[]) => { failures.push(args[1]); };
  client.on("status.changed", () => { throw new Error("a listener's bug"); });
  const stop = client.on("status.changed", (c) => seen.push(`status ${c.seq}`));
  client.on("link.pipe", (p) => seen.push(`pipe ${p.src}`));
  deliver({ event: "status.changed", params: [change(1)] });
  deliver({ event: "link.pipe", params: [{ src: "a", dst: "b", connected: true }] });
  stop();
  deliver({ event: "status.changed", params: [change(2)] });
  console.error = consoleError;
  expect(seen).toEqual(["status 1", "pipe a"]);
  expect(failures.map((e) => (e as Error).message)).toEqual(["a listener's bug", "a listener's bug"]);
});
