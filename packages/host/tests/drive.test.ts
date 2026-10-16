// The drive socket: programs the person granted drive one workspace at their grant's role; an
// agent drives the workspace its tile is in, as itself; the install's token is the person; nothing
// else gets in.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Intents } from "@hivemind/workspace-host/intents";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import { WorkspaceServer, type Domain } from "@hivemind/workspace-api/server";
import { tileToken } from "@hivemind/agent-host/hooks/token";
import { serveDrive } from "../src/drive.ts";
import { Grants, grantsDomain } from "../src/grants.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hm-drive-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const repoA = fs.mkdirSync(path.join(tmp, "a"), { recursive: true })!;
const repoB = fs.mkdirSync(path.join(tmp, "b"), { recursive: true })!;
/** A worktree of repo A, beside it as git puts one, and a folder beside it that is not one. */
const worktreeA = fs.mkdirSync(path.join(tmp, "a-worktrees", "fix"), { recursive: true })!;
const besideA = fs.mkdirSync(path.join(tmp, "a-other"), { recursive: true })!;
const INSTALL = "install-token";
const tileIn: Record<string, string> = { "tile-a": repoA, "tile-b": repoB };

// What the agents domain answers here: who asked, so a test sees each call reached it as whom.
const asked = (from: { actor: unknown }) => ({ by: from.actor });
const domain = {
  answers: {
    "agent.start": (from: { actor: unknown }) => asked(from),
    "git.push": (from: { actor: unknown }) => asked(from),
    "git.status": (from: { actor: unknown }) => asked(from),
  },
  effects: {},
} as unknown as Domain<never>;

const grants = new Grants(path.join(tmp, "grants.json"));
const auditFile = path.join(tmp, "audit.jsonl");
const server = new WorkspaceServer([domain, grantsDomain(() => grants)], new Intents(new AuditLog({ file: auditFile })));
const sock = path.join(tmp, "drive.sock");
const drive = serveDrive(sock, {
  server,
  installToken: () => INSTALL,
  grants,
  repos: () => [repoA, repoB],
  workspaceOf: (tile) => tileIn[tile] ?? null,
  nameOf: (tile) => `the ${tile} agent`,
  places: (repo) => (repo === repoA ? [worktreeA] : []),
});
/** Every program's socket, closed at the end whatever a test left open. */
const opened = new Set<net.Socket>();
after(() => { for (const s of opened) s.destroy(); drive.close(); });

/** `p`, or a failure once `ms` pass. */
const within = <T>(p: Promise<T>, what: string, ms = 2000): Promise<T> =>
  Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} did not happen`)), ms))]);

/** A connection to the drive socket, once it is listening. */
async function listening(): Promise<net.Socket> {
  for (;;) {
    const socket = net.connect(sock);
    const up = await new Promise<boolean>((resolve) => { socket.once("connect", () => resolve(true)); socket.once("error", () => resolve(false)); });
    if (up) return socket;
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A program on the socket: say hello, then call and hear events. */
async function connect(hello: Record<string, unknown>) {
  const socket = await within(listening(), "the drive socket listening");
  opened.add(socket);
  socket.setEncoding("utf8");
  const lines: unknown[] = [];
  const waiting: Array<() => void> = [];
  let buf = "";
  socket.on("data", (chunk: string) => {
    buf += chunk;
    const parts = buf.split("\n");
    buf = parts.pop()!;
    for (const p of parts) {
      const m = JSON.parse(p) as unknown;
      for (const one of Array.isArray(m) ? m : [m]) lines.push(one);
    }
    for (const w of waiting.splice(0)) w();
  });
  const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
  socket.write(`${JSON.stringify({ hello })}\n`);
  const next = async (pick: (m: Record<string, unknown>) => boolean, ms = 2000): Promise<Record<string, unknown>> => {
    const until = Date.now() + ms;
    for (;;) {
      const at = lines.findIndex((m) => pick(m as Record<string, unknown>));
      if (at >= 0) return lines.splice(at, 1)[0] as Record<string, unknown>;
      if (Date.now() > until) throw new Error(`nothing came: ${JSON.stringify(lines)}`);
      await new Promise<void>((resolve) => { waiting.push(resolve); setTimeout(resolve, 50); });
    }
  };
  let id = 0;
  const call = async (method: string, params: unknown[] = []) => {
    const mine = ++id;
    socket.write(`${JSON.stringify({ id: mine, method, params })}\n`);
    return next((m) => m.id === mine);
  };
  return { socket, next, call, closed, lines };
}

test("a program with a grant drives its workspace at its role, and is refused what its role does not reach", async () => {
  const { token } = grants.create({ name: "review-bot", repos: [repoA], role: "agents" });
  const p = await connect({ token, workspace: repoA });
  assert.deepEqual((await p.next((m) => "hello" in m)).hello, { api: "0.27", as: { client: "review-bot", role: "agents", workspace: repoA } });
  const started = await p.call("agent.start", [repoA, { program: "claude" }]);
  assert.equal((started.result as { by: { client?: string } }).by.client, "review-bot");
  const pushed = await p.call("git.push", [repoA]);
  assert.equal((pushed.error as { code: string }).code, "FORBIDDEN");
  const granted = await p.call("grant.create", [{ name: "more", repos: [repoA], role: "agents" }]);
  assert.equal((granted.error as { code: string }).code, "FORBIDDEN");
  p.socket.destroy();
});

test("a grant that reaches one workspace needs it named no more than an agent does; one that reaches several names one", async () => {
  const one = await connect({ token: grants.create({ name: "one", repos: [repoA], role: "view" }).token });
  assert.deepEqual((await one.next((m) => "hello" in m)).hello, { api: "0.27", as: { client: "one", role: "view", workspace: repoA } });
  one.socket.destroy();
  const both = grants.create({ name: "both", repos: [repoA, repoB], role: "view" }).token;
  const unnamed = await connect({ token: both });
  assert.equal(((await unnamed.next((m) => "error" in m)).error as { code: string }).code, "BAD_REQUEST");
  await within(unnamed.closed, "the unnamed connection closing");
  const named = await connect({ token: both, workspace: repoB });
  assert.deepEqual((await named.next((m) => "hello" in m)).hello, { api: "0.27", as: { client: "both", role: "view", workspace: repoB } });
  named.socket.destroy();
});

test("a program reaches its workspace's worktrees, wherever git put them, and no folder beside them", async () => {
  const { token } = grants.create({ name: "wt-bot", repos: [repoA], role: "view" });
  const p = await connect({ token, workspace: repoA });
  await p.next((m) => "hello" in m);
  assert.ok("result" in (await p.call("git.status", [worktreeA])));
  assert.equal(((await p.call("git.status", [besideA])).error as { code: string }).code, "FORBIDDEN");
  p.socket.destroy();
});

test("a program hears only its own workspace's events", async () => {
  const { token } = grants.create({ name: "watcher", repos: [repoA], role: "view" });
  const p = await connect({ token, workspace: repoA });
  await p.next((m) => "hello" in m);
  server.publish("status.changed", { seq: 1, tileId: "hm:tile-b", status: { state: "working" } } as never);
  server.publish("status.changed", { seq: 2, tileId: "hm:tile-a", status: { state: "idle" } } as never);
  const heard = await p.next((m) => m.event === "status.changed");
  assert.equal((heard.params as Array<{ tileId: string }>)[0]!.tileId, "hm:tile-a");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(p.lines.filter((m) => (m as { event?: string }).event === "status.changed").length, 0);
  p.socket.destroy();
});

test("a grant reaches only the workspaces it names", async () => {
  const { token } = grants.create({ name: "a-only", repos: [repoA], role: "agents" });
  const p = await connect({ token, workspace: repoB });
  const refused = await p.next((m) => "error" in m);
  assert.equal((refused.error as { code: string }).code, "FORBIDDEN");
  await within(p.closed, "the refused connection closing");
});

test("taking a grant back closes the program's connection, and its token lets nothing in again", async () => {
  const { grant, token } = grants.create({ name: "gone-soon", repos: [repoA], role: "agents" });
  const p = await connect({ token, workspace: repoA });
  await p.next((m) => "hello" in m);
  const person = await connect({ token: INSTALL });
  await person.next((m) => "hello" in m);
  assert.deepEqual((await person.call("grant.revoke", [grant.id])).result, { revoked: true });
  await within(p.closed, "the program's connection closing");
  const again = await connect({ token, workspace: repoA });
  assert.equal(((await again.next((m) => "error" in m)).error as { code: string }).code, "FORBIDDEN");
  person.socket.destroy();
});

test("a grant that runs out closes its program's connection then, and lets nothing in after", async () => {
  const { token } = grants.create({ name: "brief", repos: [repoA], role: "agents", expires: Date.now() + 300 });
  const p = await connect({ token, workspace: repoA });
  await p.next((m) => "hello" in m);
  await within(p.closed, "the connection closing as the grant ran out");
  const again = await connect({ token, workspace: repoA });
  assert.equal(((await again.next((m) => "error" in m)).error as { code: string }).code, "FORBIDDEN");
});

test("the install's token is the person, with every method", async () => {
  const person = await connect({ token: INSTALL });
  assert.deepEqual((await person.next((m) => "hello" in m)).hello, { api: "0.27", as: "person" });
  assert.deepEqual(((await person.call("git.push", [repoA])).result as { by: unknown }).by, { kind: "person" });
  person.socket.destroy();
});

test("an agent's token drives the workspace its tile is in, as that agent at the role agents, while its tile is there; no other workspace, and none with no tile", async () => {
  const agent = await connect({ token: tileToken(INSTALL, "hm:tile-a") });
  assert.deepEqual((await agent.next((m) => "hello" in m)).hello, { api: "0.27", as: { agent: "tile-a", role: "agents", workspace: repoA } });
  const started = await agent.call("agent.start", [repoA, { program: "claude" }]);
  assert.deepEqual((started.result as { by: unknown }).by, { kind: "peer", person: "tile-a", device: "tile-a", access: "agents", client: "the tile-a agent", tile: "tile-a" });
  assert.equal(((await agent.call("git.push", [repoA])).error as { code: string }).code, "FORBIDDEN");
  assert.equal(((await agent.call("agent.start", [repoB, { program: "claude" }])).error as { code: string }).code, "FORBIDDEN");
  // Its tile leaves the workspace: it drives nothing there any more.
  delete tileIn["tile-a"];
  try {
    assert.equal(((await agent.call("agent.start", [repoA, { program: "claude" }])).error as { code: string }).code, "FORBIDDEN");
  } finally {
    tileIn["tile-a"] = repoA;
  }
  agent.socket.destroy();
  const elsewhere = await connect({ token: tileToken(INSTALL, "tile-a"), workspace: repoB });
  assert.equal(((await elsewhere.next((m) => "error" in m)).error as { code: string }).code, "FORBIDDEN");
  const nowhere = await connect({ token: tileToken(INSTALL, "tile-z") });
  assert.equal(((await nowhere.next((m) => "error" in m)).error as { code: string }).code, "FORBIDDEN");
});

test("a grant is kept as a hash, never its token, in a file only the person reads", () => {
  const { token } = grants.create({ name: "kept", repos: [repoA], role: "view" });
  const file = path.join(tmp, "grants.json");
  assert.ok(!fs.readFileSync(file, "utf8").includes(token));
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(new Grants(file).holder(token), "a grant holds after the host starts again");
});
