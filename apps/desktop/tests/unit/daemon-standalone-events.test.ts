// The real daemon (from source, under node) with and without the standalone flag `hive daemon` sets.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { frame, makeLineDecoder, type ServerMsg } from "@hivemind/agent-host/pty-protocol";

const unix = process.platform !== "win32";
const here = path.dirname(fileURLToPath(import.meta.url));
const daemons: ChildProcess[] = [];
const dirs: string[] = [];
after(() => { for (const d of daemons) d.kill("SIGKILL"); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function startDaemon(standalone: boolean) {
  const dir = fs.mkdtempSync("/tmp/hse-");
  dirs.push(dir);
  const sock = path.join(dir, "d.sock");
  const env = { ...process.env, ...(standalone ? { HIVEMIND_DAEMON_STANDALONE: "1" } : {}) };
  daemons.push(spawn(process.execPath, ["--import", "tsx", path.join(here, "../../../../packages/agent-host/src/pty-daemon.ts"), sock], { stdio: "ignore", env }));
  for (let i = 0; i < 100 && !fs.existsSync(sock); i++) await wait(100);
  await wait(300);
  return { dir, sock, hcp: path.join(dir, "hcp.sock") };
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
  const pushes: { body: string; title?: string }[] = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => { pushes.push({ body, title: req.headers.title as string | undefined }); res.end("ok"); });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as net.AddressInfo).port;

  const d = await startDaemon(true);
  fs.writeFileSync(path.join(d.dir, "push.json"), JSON.stringify({ url: `http://127.0.0.1:${port}/t`, events: ["input.requested"] }));
  const token = fs.readFileSync(path.join(d.dir, "hcp.token"), "utf8").trim();
  const viewer = net.connect(d.sock);
  const events: ServerMsg[] = [];
  viewer.on("data", makeLineDecoder((l) => { const m = JSON.parse(l) as ServerMsg; if (m.t === "event") events.push(m); }));
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

  const init = (id: string) => ({ jsonrpc: "2.0", id: `${id}-init`, method: "initialize", params: { token } });
  const ask = async (id: string, method: string, params: unknown) => {
    const got = await hook(d.hcp, [init(id), { jsonrpc: "2.0", id, method, params }], true, 2);
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
  viewer.destroy();
  srv.close();
});

test("inside the desktop the daemon leaves the control-plane socket to the app", { skip: !unix, timeout: 30000 }, async () => {
  const d = await startDaemon(false);
  assert.equal(fs.existsSync(d.sock), true);
  assert.equal(fs.existsSync(d.hcp), false);
});
