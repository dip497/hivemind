import { after, test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { DaemonEndpoint, REATTACH_RESET } from "../../src/main/daemon-endpoint.ts";
import { MAX_LINE_CHARS, frame, makeLineDecoder, type ClientMsg } from "../../src/main/pty-protocol.ts";

const dir = fs.mkdtempSync(path.join(process.platform === "linux" ? "/tmp" : fs.realpathSync(process.env.TMPDIR ?? "/tmp"), "hde-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 3000) => { for (let t = 0; t < ms && !f(); t += 10) await wait(10); return f(); };

/** A daemon stand-in: replays "SCREEN" on attach, echoes writes, and records what it was sent. */
function fakeDaemon(sock: string, delta = false) {
  const got: ClientMsg[] = [];
  const conns = new Set<net.Socket>();
  const server = net.createServer((c) => {
    conns.add(c);
    c.on("close", () => conns.delete(c));
    c.on("data", makeLineDecoder((line) => {
      const m = JSON.parse(line) as ClientMsg;
      got.push(m);
      if (m.t === "attach" && m.since) c.write(frame({ t: "attached", reqId: m.reqId, id: m.id, pid: 42, isNew: false, replay: `MISSED-after-${m.since.seq}`, seq: m.since.seq + 1, epoch: m.since.epoch, delta: true }));
      else if (m.t === "attach") c.write(frame({ t: "attached", reqId: m.reqId, id: m.id, pid: 42, isNew: false, replay: "SCREEN", ...(delta ? { seq: 0, epoch: "E" } : {}) }));
      if (m.t === "write") c.write(frame({ t: "data", id: m.id, data: `echo:${m.data}`, ...(delta ? { seq: 7 } : {}) }));
      if (m.t === "hello" && m.caps.includes("events")) c.write(frame({ t: "event", topic: "status", data: { tileId: "t1", state: "idle" } }));
    }));
  });
  return {
    got, server,
    listen: () => new Promise<void>((r) => server.listen(sock, r)),
    dropAll: () => { for (const c of conns) c.destroy(); },
    close: () => new Promise<void>((r) => { for (const c of conns) c.destroy(); server.close(() => r()); }),
  };
}

test("spawn streams, a dropped transport re-attaches with a reset replay, close stops retrying", async () => {
  const sock = path.join(dir, "a.sock");
  const d = fakeDaemon(sock);
  await d.listen();
  let connects = 0;
  const ep = new DaemonEndpoint({ connect: () => new Promise((res, rej) => { connects++; const s = net.connect(sock); s.once("connect", () => res(s)); s.once("error", rej); }), retryInitialMs: 20 });
  let out = "";
  const r = await ep.spawn({ tileId: "t1", cwd: "/", cmd: "sh", cols: 80, rows: 24 }, { onData: (x) => { out += x; }, onExit: () => {} });
  assert.equal(r.pid, 42);
  assert.equal(out, "SCREEN", "first attach replay is not reset");
  ep.write("t1", "ls");
  assert.ok(await until(() => out.includes("echo:ls")));

  d.dropAll();
  assert.ok(await until(() => out.endsWith(REATTACH_RESET + "SCREEN")), "re-attach replays onto a reset screen");
  assert.equal(connects, 2);
  assert.equal(d.got.filter((m) => m.t === "attach").length, 2);

  ep.detach("t1");
  assert.ok(await until(() => d.got.some((m) => m.t === "detach")));
  assert.equal(ep.has("t1"), false);
  ep.close();
  d.dropAll();
  await wait(100);
  assert.equal(connects, 2, "a closed endpoint never reconnects");
  await d.close();
});

test("a spawn while the daemon is unreachable fails fast, then attaches by itself when it comes up", async () => {
  const sock = path.join(dir, "b.sock");
  let connects = 0;
  const ep = new DaemonEndpoint({ connect: () => new Promise((res, rej) => { connects++; const s = net.connect(sock); s.once("connect", () => res(s)); s.once("error", rej); }), retryInitialMs: 20, retryMaxMs: 40 });
  let out = "";
  const r = await ep.spawn({ tileId: "t1", cwd: "/", cmd: "sh", cols: 80, rows: 24 }, { onData: (x) => { out += x; }, onExit: () => {} });
  assert.equal(r.pid, -1);
  const d = fakeDaemon(sock);
  await d.listen();
  assert.ok(await until(() => out === REATTACH_RESET + "SCREEN"), "attaches on its own once the daemon is reachable");
  assert.ok(connects >= 2);
  ep.write("t1", "x");
  assert.ok(await until(() => out.includes("echo:x")));
  ep.kill("t1");
  assert.ok(await until(() => d.got.some((m) => m.t === "kill")));
  ep.close();
  await d.close();
});

test("a re-attach resumes from the last position with no screen reset", async () => {
  const sock = path.join(dir, "c.sock");
  const d = fakeDaemon(sock, true);
  await d.listen();
  const ep = new DaemonEndpoint({ connect: () => new Promise((res, rej) => { const s = net.connect(sock); s.once("connect", () => res(s)); s.once("error", rej); }), retryInitialMs: 20 });
  let out = "";
  await ep.spawn({ tileId: "t1", cwd: "/", cmd: "sh", cols: 80, rows: 24 }, { onData: (x) => { out += x; }, onExit: () => {} });
  ep.write("t1", "ls");
  assert.ok(await until(() => out.includes("echo:ls")));
  d.dropAll();
  assert.ok(await until(() => out.endsWith("MISSED-after-7")), "asked from the last data position");
  assert.ok(!out.includes(REATTACH_RESET), "a delta continues the stream: no reset");
  const attaches = d.got.filter((m) => m.t === "attach");
  assert.deepEqual((attaches[1] as { since?: unknown }).since, { seq: 7, epoch: "E" });
  assert.ok(d.got.some((m) => m.t === "hello"));
  ep.close();
  await d.close();
});

test("hook events are delivered only to an endpoint that asked for them", async () => {
  const sock = path.join(dir, "e.sock");
  const d = fakeDaemon(sock);
  await d.listen();
  const got: unknown[] = [];
  const connect = () => new Promise<import("node:stream").Duplex>((res, rej) => { const s = net.connect(sock); s.once("connect", () => res(s)); s.once("error", rej); });
  const withEvents = new DaemonEndpoint({ connect, onEvent: (topic, data) => got.push({ topic, data }) });
  await withEvents.spawn({ tileId: "t1", cwd: "/", cmd: "sh", cols: 80, rows: 24 }, { onData: () => {}, onExit: () => {} });
  assert.ok(await until(() => got.length === 1));
  assert.deepEqual(got[0], { topic: "status", data: { tileId: "t1", state: "idle" } });
  const plain = new DaemonEndpoint({ connect });
  await plain.spawn({ tileId: "t2", cwd: "/", cmd: "sh", cols: 80, rows: 24 }, { onData: () => {}, onExit: () => {} });
  const hellos = d.got.filter((m) => m.t === "hello") as { caps: string[] }[];
  assert.deepEqual(hellos.map((h) => h.caps), [["resync", "events"], ["resync"]]);
  withEvents.close(); plain.close();
  await d.close();
});

test("a tile that exited is never started again by a re-attach; one gone while away shows as exited", async () => {
  const sock = path.join(dir, "x.sock");
  const got: ClientMsg[] = [];
  const conns = new Set<net.Socket>();
  const server = net.createServer((c) => {
    conns.add(c);
    c.on("data", makeLineDecoder((line) => {
      const m = JSON.parse(line) as ClientMsg;
      got.push(m);
      if (m.t !== "attach") return;
      if (m.noSpawn) c.write(frame({ t: "attached", reqId: m.reqId, id: m.id, pid: -1, isNew: false, replay: "", error: `no session '${m.id}'` }));
      else c.write(frame({ t: "attached", reqId: m.reqId, id: m.id, pid: 42, isNew: true, replay: "", seq: 0, epoch: "E" }));
      if (m.id === "done") c.write(frame({ t: "exit", id: "done", code: 0, signal: null }));
    }));
  });
  await new Promise<void>((r) => server.listen(sock, r));
  const ep = new DaemonEndpoint({ connect: () => new Promise((res, rej) => { const s = net.connect(sock); s.once("connect", () => res(s)); s.once("error", rej); }), retryInitialMs: 20 });
  const exits: Record<string, [number, number | undefined][]> = { done: [], gone: [] };
  await ep.spawn({ tileId: "done", cwd: "/", cmd: "sh", cols: 80, rows: 24 }, { onData: () => {}, onExit: (c, s) => exits.done!.push([c, s]) });
  await ep.spawn({ tileId: "gone", cwd: "/", cmd: "sh", cols: 80, rows: 24 }, { onData: () => {}, onExit: (c, s) => exits.gone!.push([c, s]) });
  assert.ok(await until(() => exits.done!.length === 1));
  assert.equal(ep.has("done"), false);

  for (const c of conns) c.destroy();
  assert.ok(await until(() => exits.gone!.length === 1));
  const re = got.filter((m): m is Extract<ClientMsg, { t: "attach" }> => m.t === "attach" && m.reqId.startsWith("re"));
  assert.deepEqual(re.map((m) => [m.id, m.noSpawn]), [["gone", true]]);
  assert.deepEqual(exits.gone, [[0, 1]]);
  assert.equal(ep.has("gone"), false);
  ep.close();
  for (const c of conns) c.destroy();
  await new Promise<void>((r) => server.close(() => r()));
});

test("status follows the transport, ping measures the round trip, sessions lists the daemon", async () => {
  const sock = path.join(dir, "s.sock");
  const conns = new Set<net.Socket>();
  const server = net.createServer((c) => {
    conns.add(c);
    c.on("data", makeLineDecoder((line) => {
      const m = JSON.parse(line) as ClientMsg;
      if (m.t === "ping") c.write(frame({ t: "pong", reqId: m.reqId }));
      if (m.t === "list") c.write(frame({ t: "sessions", reqId: m.reqId, ids: ["run-1"], detail: [{ id: "run-1", state: "live", cmd: "make", args: [], cwd: "/srv", pid: 9, viewers: 0, cols: 80, rows: 24 }] }));
      if (m.t === "attach" && m.noSpawn && m.id === "gone") c.write(frame({ t: "attached", reqId: m.reqId, id: m.id, pid: -1, isNew: false, replay: "", error: "no session 'gone'" }));
      else if (m.t === "attach") c.write(frame({ t: "attached", reqId: m.reqId, id: m.id, pid: 42, isNew: false, replay: "", seq: 0, epoch: "E" }));
    }));
  });
  await new Promise<void>((r) => server.listen(sock, r));
  const states: string[] = [];
  const ep = new DaemonEndpoint({
    connect: () => new Promise((res, rej) => { const s = net.connect(sock); s.once("connect", () => res(s)); s.once("error", rej); }),
    retryInitialMs: 20,
    onStatus: (s, d) => states.push(d ? `${s}:${d.includes("ECONNREFUSED") || d.includes("ENOENT") ? "refused" : d}` : s),
  });
  await assert.rejects(ep.ping(), /not connected/);
  assert.deepEqual((await ep.sessions()).map((s) => s.id), ["run-1"]);
  assert.ok((await ep.ping()) >= 0);
  assert.deepEqual(states, ["connecting", "online"]);

  const r = await ep.spawn({ tileId: "gone", cwd: "/", cmd: "sh", cols: 80, rows: 24, noSpawn: true }, { onData: () => {}, onExit: () => {} });
  assert.equal(r.pid, -1);
  assert.equal(ep.has("gone"), false, "an attach-only tile whose session is gone is forgotten");

  await ep.spawn({ tileId: "t1", cwd: "/", cmd: "sh", cols: 80, rows: 24 }, { onData: () => {}, onExit: () => {} });
  const closed = new Promise<void>((r2) => server.close(() => r2()));
  for (const c of conns) c.destroy();
  conns.clear();
  await closed;
  assert.ok(await until(() => states.some((s) => s === "reconnecting:refused")), states.join(","));
  await new Promise<void>((r2) => server.listen(sock, r2));
  ep.reconnectNow();
  assert.ok(await until(() => states.at(-1) === "online"), states.join(","));
  ep.close();
  const done = new Promise<void>((r2) => server.close(() => r2()));
  for (const c of conns) c.destroy();
  await done;
});

test("a login failure stops the retries until asked; retries stay 'reconnecting' without flicker", async () => {
  const sock = path.join(dir, "f.sock");
  const mk = () => net.createServer((c) => {
    c.on("data", makeLineDecoder((line) => {
      const msg = JSON.parse(line) as ClientMsg;
      if (msg.t === "attach") c.write(frame({ t: "attached", reqId: msg.reqId, id: msg.id, pid: 42, isNew: true, replay: "", seq: 0, epoch: "E" }));
    }));
  });
  const server = mk();
  await new Promise<void>((r) => server.listen(sock, r));
  let up = true;
  let attempts = 0;
  let fail = "ssh: connect to host box port 22: Connection refused";
  const states: string[] = [];
  let transport: net.Socket | null = null;
  const ep = new DaemonEndpoint({
    connect: () => {
      if (!up) { attempts++; return Promise.reject(new Error(fail)); }
      return new Promise((res, rej) => { const s = net.connect(sock); transport = s; s.once("connect", () => res(s)); s.once("error", rej); });
    },
    retryInitialMs: 10, retryMaxMs: 20,
    isFatal: (msg) => /Permission denied/.test(msg),
    onStatus: (s) => states.push(s),
  });
  await ep.spawn({ tileId: "t", cwd: "/", cmd: "sh", cols: 80, rows: 24 }, { onData: () => {}, onExit: () => {} });
  up = false;
  transport!.destroy();
  assert.ok(await until(() => attempts >= 3));
  assert.ok(!states.slice(states.indexOf("reconnecting")).includes("connecting"), states.join(","));
  fail = "me@box: Permission denied (publickey).";
  const at = attempts;
  assert.ok(await until(() => attempts > at));
  const stoppedAt = attempts;
  await wait(200);
  assert.equal(attempts, stoppedAt, "no retries after a login failure");
  up = true;
  ep.reconnectNow();
  assert.ok(await until(() => states.at(-1) === "online"), states.join(","));
  ep.close();
  const closed = new Promise<void>((r) => server.close(() => r()));
  transport?.destroy();
  await closed;
});

test("a peer that never ends a line is dropped instead of filling memory", () => {
  const lines: string[] = [];
  let overflowed = false;
  const feed = makeLineDecoder((l) => lines.push(l), () => { overflowed = true; });
  feed("{\"t\":\"pong\",\"reqId\":\"a\"}\n");
  assert.equal(lines.length, 1);
  for (let sent = 0; sent < MAX_LINE_CHARS + 1024; sent += 1 << 20) feed("x".repeat(1 << 20));
  assert.equal(overflowed, true);
  // The buffer is dropped, so the next complete line still parses.
  feed("{\"t\":\"pong\",\"reqId\":\"b\"}\n");
  assert.equal(lines.length, 2);
});
