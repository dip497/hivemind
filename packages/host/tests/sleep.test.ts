// Agents put to sleep on the host (terminals.ts over daemon-sessions.ts), with this machine's real
// PTY daemon (from source): a session nobody shows can be put to sleep by its folder, and its
// process ends; a client showing one is told it slept, not that it ended; the screen it saved is
// read by its tile, from the folder the layout says it slept in; a client's open, even one asking
// to wake it, starts nothing and is told it sleeps; the host wakes it, and a client then joins it;
// a client whose connection to the daemon dropped while it slept is told it slept once back; a start
// that would resume a conversation another tile sleeps in is refused, whoever starts it; and a wake
// that finds nothing asleep says so.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DaemonEndpoint } from "@hivemind/agent-host/daemon-endpoint";
import { NothingAsleep, frame, makeLineDecoder, type ServerMsg } from "@hivemind/agent-host/pty-protocol";
import { Intents } from "@hivemind/workspace-host/intents";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import { WorkspaceServer, type Connection } from "@hivemind/workspace-api/server";
import type { EventMessage } from "@hivemind/workspace-api/protocol";
import { Terminals } from "../src/terminals.ts";
import { daemonSessions } from "../src/daemon-sessions.ts";

const unix = process.platform !== "win32";
const DAEMON = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../agent-host/src/pty-daemon.ts");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hm-sleep-"));
const sock = path.join(dir, "d.sock");
let daemon: ChildProcess | undefined;
const stops: Array<() => void> = [];
after(() => {
  for (const stop of stops) stop();
  daemon?.kill("SIGKILL");
  fs.rmSync(dir, { recursive: true, force: true });
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const connect = () => new Promise<net.Socket>((resolve, reject) => {
  const c = net.connect(sock);
  c.once("connect", () => resolve(c));
  c.once("error", reject);
});
const loop = (word: string) => ({ cwd: dir, cmd: "sh", args: ["-c", `echo ${word}; while :; do sleep 0.1; done`], cols: 80, rows: 24 });

async function host() {
  if (!daemon) {
    daemon = spawn(process.execPath, ["--import", "tsx", DAEMON, sock], { stdio: "ignore", env: { ...process.env, HOME: dir, XDG_CONFIG_HOME: path.join(dir, "xdg") } });
    let up = false;
    for (let t = 0; t < 15_000 && !up; t += 100) {
      await wait(100);
      up = await connect().then((c) => { c.destroy(); return true; }, () => false);
    }
    assert.ok(up, "the daemon listens");
  }
  // Paused, a dropped connection stays dropped until `reconnectNow`.
  const paused = { on: false };
  const endpoint = new DaemonEndpoint({ connect, isPaused: () => paused.on });
  stops.push(() => endpoint.close());
  /** The folder each tile's session runs in, as the layout says. */
  const slept = new Map<string, string>();
  /** The tile asleep in each conversation, as the control plane says. */
  const conversations = new Map<string, string>();
  const file = path.join(dir, `audit-${Math.random()}.jsonl`);
  const terminals = new Terminals({
    intents: new Intents(new AuditLog({ file })),
    relay: { record: () => {}, screenPrefix: "" },
    backend: daemonSessions({ endpoint, pace: async () => {} }),
    folderOf: (tile) => slept.get(tile),
    conversationAsleep: (opts) => (opts.args ?? []).map((a) => conversations.get(a)).find((t) => t && `hm:${t}` !== opts.tileId),
  });
  const server = new WorkspaceServer([terminals.domain], new Intents(new AuditLog({ file })));
  const client = () => {
    const received: EventMessage[] = [];
    const c: Connection & { received: EventMessage[] } = { actor: { kind: "person" }, received, send: (m) => received.push(m), closed: new AbortController().signal };
    server.connect(c);
    return c;
  };
  const open = async (from: Connection, tileId: string, word: string, extra: object = {}) => {
    const answer = await server.answer("terminal.open", [{ tileId, ...loop(word), ...extra }], from);
    if ("error" in answer) throw new Error(answer.error.message);
    return answer.result as { pid: number; joined: boolean; asleep?: true };
  };
  const saved = async (from: Connection, tile: string) => {
    const answer = await server.answer("terminal.saved", [tile, 1000], from);
    if ("error" in answer) throw new Error(answer.error.message);
    return answer.result as string | null;
  };
  const notice = (from: Connection, method: string, ...params: unknown[]) => server.notice(method, params, from);
  const exits = (c: { received: EventMessage[] }, tile: string) => c.received.filter((m) => m.event === "terminal.exit" && m.params[0] === tile).map((m) => m.params[1]);
  return { endpoint, paused, terminals, slept, conversations, client, open, saved, notice, exits };
}

/** Until `ok`, or a few seconds. */
async function until(ok: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !ok(); i++) await wait(25);
}

test("a session nobody shows is put to sleep by its folder; its saved screen is read by its tile; a client's open starts nothing, even asking to wake it; the host wakes it", { skip: !unix }, async () => {
  const h = await host();
  const window = h.client();
  const { pid } = await h.open(window, "hm:s1", "AWAKE");
  await wait(300);
  // The window lets go of it: the daemon keeps it running, attached to nothing here.
  h.notice(window, "terminal.detach", "hm:s1");
  await wait(100);
  await h.terminals.sleep("hm:s1", dir);
  await until(() => !alive(pid));
  assert.equal(alive(pid), false, "its process ended");

  // Its screen is read from where the layout says it slept, and only then.
  const reader = h.client();
  assert.equal(await h.saved(reader, "hm:s1"), null, "in no workspace here: nothing to read");
  h.slept.set("s1", dir);
  assert.match((await h.saved(reader, "s1")) ?? "", /AWAKE/, "named as the layout names it");

  // A client cannot start it again, nor forge a wake.
  assert.deepEqual(await h.open(reader, "hm:s1", "AWAKE"), { pid: -1, joined: false, asleep: true });
  assert.deepEqual(await h.open(reader, "hm:s1", "AWAKE", { wake: true }), { pid: -1, joined: false, asleep: true });

  // The host wakes it; a client then joins it.
  const woke = await h.terminals.own({ tileId: "hm:s1", ...loop("AWAKE"), wake: true }, { data: () => {}, exit: () => {} });
  assert.ok(woke.pid > 0 && alive(woke.pid), "woken, it runs");
  assert.deepEqual(await h.open(reader, "hm:s1", "AWAKE"), { pid: woke.pid, joined: true });
  h.terminals.end("hm:s1");
});

test("a client showing a session is told it slept, not that it ended; one whose daemon connection dropped meanwhile is told so once back", { skip: !unix }, async () => {
  const h = await host();
  const shown = h.client();
  await h.open(shown, "hm:s2", "SHOWN");
  await h.terminals.sleep("hm:s2", dir);
  await until(() => h.exits(shown, "hm:s2").length > 0);
  assert.deepEqual(h.exits(shown, "hm:s2"), [{ code: 0, signal: 1, slept: true }]);

  // Another host's connection drops; the session is put to sleep while it is away.
  const away = await host();
  const watcher = away.client();
  await away.open(watcher, "hm:s3", "AWAY");
  away.paused.on = true;
  away.endpoint.disconnect();
  const other = await connect();
  other.write(frame({ t: "sleep", reqId: "z", id: "hm:s3" }));
  await wait(1500);
  away.paused.on = false;
  away.endpoint.reconnectNow();
  await until(() => away.exits(watcher, "hm:s3").length > 0);
  assert.deepEqual(away.exits(watcher, "hm:s3"), [{ code: 0, signal: undefined, slept: true }]);
  other.destroy();
  h.terminals.end("hm:s2");
  away.terminals.end("hm:s3");
});

test("a session a viewer holds back still ends promptly when put to sleep: what it writes as it ends is read", { skip: !unix }, async () => {
  await host();
  // As it ends it writes far more than a pty holds unread.
  const spec = { cwd: dir, cmd: "sh", args: ["-c", "trap 'i=0; while [ $i -lt 4000 ]; do echo GOODBYE-$i-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; i=$((i+1)); done; exit 0' HUP; echo HELD; while :; do sleep 0.1; done"], cols: 80, rows: 24 };
  const c = await connect();
  const got: ServerMsg[] = [];
  let out = "";
  c.on("data", makeLineDecoder((line) => { const m = JSON.parse(line) as ServerMsg; got.push(m); if (m.t === "data") out += m.data; }));
  c.write(frame({ t: "attach", reqId: "a", id: "hm:s4", spec }));
  await until(() => out.includes("HELD"));
  c.write(frame({ t: "pause", id: "hm:s4" }));
  await wait(200);
  const t0 = Date.now();
  c.write(frame({ t: "sleep", reqId: "s", id: "hm:s4" }));
  for (let i = 0; i < 400 && !got.some((m) => m.t === "slept"); i++) await wait(50);
  assert.ok(got.some((m) => m.t === "slept"), "it slept");
  assert.ok(Date.now() - t0 < 10_000, `it ended itself, not at the grace's SIGKILL (${Date.now() - t0} ms)`);
  assert.notEqual((got.find((m) => m.t === "exit") as Extract<ServerMsg, { t: "exit" }> | undefined)?.signal, 9);
  c.write(frame({ t: "kill", id: "hm:s4" }));
  c.destroy();
});

test("a start that would resume a conversation another tile sleeps in is refused, whoever starts it; a wake that finds nothing asleep says so", { skip: !unix }, async () => {
  const h = await host();
  h.conversations.set("CONVERSATION-1", "s9");
  const window = h.client();
  const resuming = { args: ["-c", "echo RESUMED", "CONVERSATION-1"] };
  await assert.rejects(h.open(window, "hm:n1", "X", resuming), /that conversation is asleep in tile s9: wake it instead/);
  await assert.rejects(h.terminals.own({ tileId: "hm:n2", ...loop("X"), ...resuming }, { data: () => {}, exit: () => {} }), /asleep in tile s9/);
  await assert.rejects(h.terminals.own({ tileId: "hm:n3", ...loop("X"), wake: true }, { data: () => {}, exit: () => {} }), NothingAsleep);
});
