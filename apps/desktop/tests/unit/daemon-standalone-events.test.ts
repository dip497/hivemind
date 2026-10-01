// The real daemon (from source) as each place runs it: inside the desktop, under Electron's Node;
// on its own (the standalone flag `hive daemon` sets), inside `hive`, under Bun.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { frame, makeLineDecoder, type ServerMsg } from "@hivemind/agent-host/pty-protocol";
import { tileToken } from "@hivemind/agent-host/hooks/token";

const unix = process.platform !== "win32";
/** Bun, which runs `hive`, on PATH. */
const BUN = (process.env.PATH ?? "").split(path.delimiter).map((d) => path.join(d, "bun")).find((p) => fs.existsSync(p)) ?? "bun";
const here = path.dirname(fileURLToPath(import.meta.url));
const daemons: ChildProcess[] = [];
const dirs: string[] = [];
after(() => { for (const d of daemons) d.kill("SIGKILL"); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function startDaemon(standalone: boolean, prepare?: (dir: string) => Record<string, string>) {
  const dir = fs.mkdtempSync("/tmp/hse-");
  dirs.push(dir);
  const sock = path.join(dir, "d.sock");
  const env = { ...process.env, ...(standalone ? { HIVEMIND_DAEMON_STANDALONE: "1" } : {}), ...prepare?.(dir) };
  const daemon = path.join(here, "../../../../packages/agent-host/src/pty-daemon.ts");
  const proc = standalone ? spawn(BUN, [daemon, sock], { stdio: "ignore", env }) : spawn(process.execPath, ["--import", "tsx", daemon, sock], { stdio: "ignore", env });
  daemons.push(proc);
  for (let i = 0; i < 100 && !fs.existsSync(sock); i++) await wait(100);
  await wait(300);
  return { dir, sock, hcp: path.join(dir, "hcp.sock"), proc };
}

/** Where a push is sent: the pushes it took. It holds no test open that failed before closing it. */
async function pushServer() {
  const pushes: { body: string; title?: string }[] = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => { pushes.push({ body, title: req.headers.title as string | undefined }); res.end("ok"); });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  srv.unref();
  return { pushes, srv, url: `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}/t` };
}

/** Lines to the control-plane socket, as a hook does; resolves with what came back once `replies` lines have. */
function hook(hcp: string, msg: unknown, awaitReply = false, replies = 1): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = net.connect(hcp);
    let got = "";
    c.on("error", reject);
    c.on("data", (d) => { got += d; if (got.split("\n").length > replies) c.end(); });
    c.on("close", () => resolve(got));
    c.on("connect", () => { c.write((Array.isArray(msg) ? msg : [msg]).map((m) => `${JSON.stringify(m)}\n`).join("")); if (!awaitReply) c.end(); });
  });
}

test("standalone: hook events reach event viewers, requests are answered at once, pushes are sent and throttled", { skip: !unix, timeout: 60000 }, async () => {
  const { pushes, srv, url } = await pushServer();
  const d = await startDaemon(true);
  fs.writeFileSync(path.join(d.dir, "push.json"), JSON.stringify({ url, events: ["input.requested"] }));
  const token = fs.readFileSync(path.join(d.dir, "hcp.token"), "utf8").trim();
  const viewer = net.connect(d.sock);
  const events: ServerMsg[] = [];
  // The raw events: each session's status, which the machine keeps too, is the next test's.
  viewer.on("data", makeLineDecoder((l) => { const m = JSON.parse(l) as ServerMsg; if (m.t === "event" && m.topic !== "agent.status") events.push(m); }));
  await new Promise((r) => viewer.once("connect", r));
  viewer.write(frame({ t: "hello", caps: ["events"] }));
  await wait(200);

  const needsYou = { tileId: "tile-1", event: "input.requested", kind: "permission" };
  await hook(d.hcp, { jsonrpc: "2.0", method: "agent.event", params: needsYou });
  for (let t = 0; t < 5000 && (events.length === 0 || pushes.length === 0); t += 25) await wait(25);
  assert.deepEqual(events[0], { t: "event", topic: "agent.event", data: needsYou });
  assert.equal(pushes.length, 1);
  assert.match(pushes[0]!.body, /needs your input/);
  assert.match(pushes[0]!.title ?? "", /^hivemind - /);

  await hook(d.hcp, { jsonrpc: "2.0", method: "agent.event", params: needsYou });
  await hook(d.hcp, { jsonrpc: "2.0", method: "agent.event", params: { tileId: "tile-1", event: "turn.ended" } });
  await hook(d.hcp, { jsonrpc: "2.0", method: "agent.event", params: { tileId: "tile-1", event: "not.an.event" } });
  await wait(500);
  assert.equal(pushes.length, 1, "same session again within the window, and an event not asked for: no push");
  assert.equal(events.length, 3, "viewers get every valid event, nothing else");

  const init = (id: string, as: string) => ({ jsonrpc: "2.0", id: `${id}-init`, method: "initialize", params: { token: as } });
  const ask = async (id: string, method: string, params: unknown, as = token) => {
    const got = await hook(d.hcp, [init(id, as), { jsonrpc: "2.0", id, method, params }], true, 2);
    return got.trim().split("\n").map((l) => JSON.parse(l)).find((m: { id: string }) => m.id === id);
  };
  const started = Date.now();
  const approval = await ask("a1", "agent.await_approval", {});
  assert.ok(Date.now() - started < 2000, "an approval request never waits");
  assert.deepEqual(approval, { jsonrpc: "2.0", id: "a1", error: { code: -32000, message: "no desktop on this machine", data: { code: "UNAVAILABLE" } } });
  assert.equal(fs.statSync(d.hcp).mode & 0o777, 0o600);

  // A reply is answered at once and goes to the desktops watching, never to push.
  const before = pushes.length;
  assert.deepEqual(await ask("r1", "agent.reply", { tileId: "tile-1", text: "the reply" }), { jsonrpc: "2.0", id: "r1", result: { ok: true } });
  for (let t = 0; t < 3000 && !events.some((e) => (e as { topic?: string }).topic === "agent.reply"); t += 25) await wait(25);
  assert.deepEqual(events.at(-1), { t: "event", topic: "agent.reply", data: { tileId: "tile-1", text: "the reply" } });
  await wait(200);
  assert.equal(pushes.length, before);
  // An agent here reports with the token its tile was given, which the machine knows too; one it
  // did not give is refused.
  assert.deepEqual(await ask("r2", "agent.reply", { tileId: "hm:tile-1", text: "again" }, tileToken(token, "hm:tile-1")), { jsonrpc: "2.0", id: "r2", result: { ok: true } });
  assert.equal((await ask("r3", "agent.reply", { tileId: "hm:tile-1", text: "forged" }, "hm:tile-1.forged")).error.data.code, "UNAUTHORIZED");
  viewer.destroy();
  srv.close();
});

/** A desktop watching the machine: each session's status as the machine last sent it. */
async function statusViewer(sock: string) {
  const c = net.connect(sock);
  const statuses = new Map<string, { state: string; source?: string | null; title?: string }>();
  /** Every event's topic and session, as it came. */
  const events: Array<{ topic: string; tileId?: string }> = [];
  /** Everything the daemon sent it. */
  const msgs: ServerMsg[] = [];
  c.on("data", makeLineDecoder((l) => {
    const m = JSON.parse(l) as ServerMsg;
    msgs.push(m);
    if (m.t === "event") events.push({ topic: m.topic, tileId: (m.data as { tileId?: string } | null)?.tileId });
    if (m.t !== "event" || m.topic !== "agent.status") return;
    const { tileId, status } = m.data as { tileId: string; status: { state: string; source?: string | null; title?: string } };
    statuses.set(tileId, status);
  }));
  await new Promise((r) => c.once("connect", r));
  c.write(frame({ t: "hello", caps: ["events"] }));
  return { c, events, msgs, stateOf: (id: string) => statuses.get(id)?.state, statusOf: (id: string) => statuses.get(id) };
}
const until = async (done: () => boolean) => { for (let t = 0; t < 5000 && !done(); t += 25) await wait(25); };

test("standalone: the machine keeps each session's status, and every desktop watching, one that connects later too, is sent it", { skip: !unix, timeout: 30000 }, async () => {
  const d = await startDaemon(true);
  const id = "hm:tile-9";
  const a = await statusViewer(d.sock);
  // A session that outlives a Ctrl+C, as an agent's TUI does.
  a.c.write(frame({ t: "attach", reqId: "r1", id, spec: { cwd: d.dir, cmd: "bash", args: ["-c", "trap '' INT; sleep 30"], cols: 80, rows: 24 } }));
  await hook(d.hcp, { jsonrpc: "2.0", method: "agent.event", params: { tileId: id, event: "turn.started" } });
  await until(() => a.stateOf(id) === "working");
  assert.equal(a.stateOf(id), "working");
  const b = await statusViewer(d.sock);
  await until(() => b.stateOf(id) === "working");
  assert.equal(b.stateOf(id), "working", "a desktop that connects later is sent the status there is");
  // A person's Ctrl+C reaches the machine, which ends the turn for everyone watching.
  b.c.write(frame({ t: "write", id, data: "\x03" }));
  await until(() => a.stateOf(id) === "interrupted" && b.stateOf(id) === "interrupted");
  assert.deepEqual([a.stateOf(id), b.stateOf(id)], ["interrupted", "interrupted"]);
  a.c.write(frame({ t: "kill", id }));
  await until(() => a.stateOf(id) === "exited" && b.stateOf(id) === "exited");
  assert.deepEqual([a.stateOf(id), b.stateOf(id)], ["exited", "exited"]);
  a.c.destroy();
  b.c.destroy();
});

test("standalone: an agent that reports nothing is shown by what the machine reads of its screen and its title", { skip: !unix, timeout: 30000 }, async () => {
  // A throwaway agent: its manifest says a screen reading "probe is thinking" means working.
  const d = await startDaemon(true, (dir) => {
    const agent = path.join(dir, "xdg", "hivemind", "agents", "probe");
    fs.mkdirSync(agent, { recursive: true });
    fs.writeFileSync(path.join(agent, "agent.yaml"), [
      "manifestVersion: 2", "id: probe", "label: Probe", "bin: probe-agent", "enabled: true",
      "caps: { promptDelivery: argv, turnSignal: false, resume: none, supervise: human, blockedDetection: true }",
      "detect:", "  default: idle", "  rules:", "  - when: { contains: probe is thinking }", "    then: working", "",
    ].join("\n"));
    const bin = path.join(dir, "probe-agent");
    fs.writeFileSync(bin, "#!/bin/bash\nprintf '\\033]0;Fixing the tests\\007probe is thinking\\n'\nexec sleep 30\n");
    fs.chmodSync(bin, 0o755);
    return { XDG_CONFIG_HOME: path.join(dir, "xdg") };
  });
  const id = "hm:tile-probe";
  const a = await statusViewer(d.sock);
  a.c.write(frame({ t: "attach", reqId: "r1", id, spec: { cwd: d.dir, cmd: path.join(d.dir, "probe-agent"), args: [], cols: 80, rows: 24 } }));
  await until(() => a.statusOf(id)?.state === "working" && a.statusOf(id)?.title === "Fixing the tests");
  assert.deepEqual({ ...a.statusOf(id) }, { ...a.statusOf(id), state: "working", source: "screen", title: "Fixing the tests" });
  a.c.write(frame({ t: "kill", id }));
  await until(() => a.stateOf(id) === "exited");
  // Ended, the session is gone for good: a desktop that connects now is told nothing of it.
  const late = await statusViewer(d.sock);
  await wait(500);
  assert.deepEqual(late.events.filter((e) => e.tileId === id), []);
  a.c.destroy();
  late.c.destroy();
});

/** A call on the machine's control-plane socket, made with `token`: what answers it. */
async function call(hcp: string, token: string, id: string, method: string, params: unknown) {
  const got = await hook(hcp, [{ jsonrpc: "2.0", id: `${id}-init`, method: "initialize", params: { token } }, { jsonrpc: "2.0", id, method, params }], true, 2);
  return got.trim().split("\n").map((l) => JSON.parse(l)).find((m: { id: string }) => m.id === id);
}

/** A control plane's own socket, as `hive host` serves one: it answers every call itself, and
 *  keeps the notifications it is sent. */
async function planeSocket(dir: string) {
  const sock = path.join(dir, "plane.sock");
  const heard: Array<{ method: string; params: unknown }> = [];
  const server = net.createServer((c) => {
    c.on("error", () => { /* gone */ });
    c.on("data", makeLineDecoder((l) => {
      const m = JSON.parse(l) as { id?: unknown; method: string; params?: unknown };
      if (m.id === undefined) heard.push({ method: m.method, params: m.params });
      else c.write(`${JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { answeredBy: "plane", method: m.method } })}\n`);
    }));
  });
  await new Promise<void>((r) => server.listen(sock, r));
  server.unref();
  return { sock, heard, server };
}


test("standalone: a control plane that takes the socket answers on it; the daemon still hears what agents report there, for its other viewers and pushes, and answers again once it goes", { skip: !unix, timeout: 60000 }, async () => {
  const phone = await pushServer();
  const d = await startDaemon(true);
  fs.writeFileSync(path.join(d.dir, "push.json"), JSON.stringify({ url: phone.url, events: ["input.requested"] }));
  const token = fs.readFileSync(path.join(d.dir, "hcp.token"), "utf8").trim();
  const plane = await planeSocket(d.dir);
  // Another device watching this machine, and the host serving its control plane.
  const other = await statusViewer(d.sock);
  const host = await statusViewer(d.sock);
  host.c.write(frame({ t: "control", reqId: "c1", sock: plane.sock }));
  await until(() => host.msgs.some((m) => m.t === "control"));
  assert.deepEqual(host.msgs.find((m) => m.t === "control"), { t: "control", reqId: "c1" });

  assert.deepEqual(await call(d.hcp, token, "a1", "tile.list", {}), { jsonrpc: "2.0", id: "a1", result: { answeredBy: "plane", method: "tile.list" } });
  // A hook's event reaches the control plane, and through this daemon the other viewers and the
  // phone; the control plane is not told again what it heard itself.
  const needsYou = { tileId: "tile-1", event: "input.requested", kind: "permission" };
  await hook(d.hcp, { jsonrpc: "2.0", method: "agent.event", params: needsYou });
  await until(() => plane.heard.length > 0 && other.events.some((e) => e.topic === "agent.event") && phone.pushes.length > 0);
  assert.deepEqual(plane.heard, [{ method: "agent.event", params: needsYou }]);
  assert.deepEqual(other.events.filter((e) => e.topic === "agent.event"), [{ topic: "agent.event", tileId: "tile-1" }]);
  assert.match(phone.pushes[0]?.body ?? "", /needs your input/);
  // The session's status, which the machine keeps, goes to every viewer, the control plane too.
  await until(() => host.stateOf("tile-1") === "waiting" && other.stateOf("tile-1") === "waiting");
  assert.deepEqual([host.stateOf("tile-1"), other.stateOf("tile-1")], ["waiting", "waiting"]);
  // A reply likewise: the control plane answers it, the other viewers are told.
  assert.deepEqual(await call(d.hcp, token, "r1", "agent.reply", { tileId: "tile-1", text: "done" }), { jsonrpc: "2.0", id: "r1", result: { answeredBy: "plane", method: "agent.reply" } });
  await until(() => other.events.some((e) => e.topic === "agent.reply"));
  assert.deepEqual(other.events.filter((e) => e.topic === "agent.reply"), [{ topic: "agent.reply", tileId: "tile-1" }]);
  await wait(200);
  assert.deepEqual(host.events.filter((e) => e.topic === "agent.event" || e.topic === "agent.reply"), []);

  // The control plane gone, this daemon answers on its socket again.
  host.c.destroy();
  await wait(200);
  assert.equal((await call(d.hcp, token, "a2", "agent.await_approval", {})).error.message, "no desktop on this machine");
  // One whose socket cannot be reached is answered for here.
  const late = await statusViewer(d.sock);
  late.c.write(frame({ t: "control", reqId: "c2", sock: path.join(d.dir, "nobody.sock") }));
  await until(() => late.msgs.some((m) => m.t === "control"));
  assert.equal((await call(d.hcp, token, "a3", "agent.await_approval", {})).error.message, "no desktop on this machine");
  late.c.destroy();
  other.c.destroy();
  plane.server.close();
  phone.srv.close();
});

test("standalone: a daemon a control plane holds stays up with no session to run, and goes once it has gone", { skip: !unix, timeout: 60000 }, async () => {
  const d = await startDaemon(true);
  const host = await statusViewer(d.sock);
  host.c.write(frame({ t: "control", reqId: "c1", sock: path.join(d.dir, "plane.sock") }));
  await until(() => host.msgs.some((m) => m.t === "control"));
  // A session that ends at once: with none left, a daemon goes 8 s later.
  host.c.write(frame({ t: "attach", reqId: "r1", id: "hm:tile-1", spec: { cwd: d.dir, cmd: "bash", args: ["-c", "exit 0"], cols: 80, rows: 24 } }));
  await until(() => host.msgs.some((m) => m.t === "exit"));
  await wait(9_500);
  assert.equal(d.proc.exitCode, null, "held by a control plane, it stays");
  host.c.destroy();
  for (let t = 0; t < 12_000 && d.proc.exitCode === null; t += 100) await wait(100);
  assert.equal(d.proc.exitCode, 0, "and goes once that control plane has");
});

test("inside the desktop the daemon leaves the control-plane socket to the app", { skip: !unix, timeout: 30000 }, async () => {
  const d = await startDaemon(false);
  assert.equal(fs.existsSync(d.sock), true);
  assert.equal(fs.existsSync(d.hcp), false);
  // A control plane asking for it is told so: the app serves it.
  const host = await statusViewer(d.sock);
  host.c.write(frame({ t: "control", reqId: "c1", sock: path.join(d.dir, "plane.sock") }));
  await until(() => host.msgs.some((m) => m.t === "control"));
  assert.deepEqual(host.msgs.find((m) => m.t === "control"), { t: "control", reqId: "c1", error: "the app serves this machine's control plane" });
  host.c.destroy();
});
