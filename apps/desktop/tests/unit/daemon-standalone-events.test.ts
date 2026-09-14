// The real daemon (from source, under node) with and without the standalone flag `hive daemon` sets.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { frame, makeLineDecoder, type ServerMsg } from "../../src/main/pty-protocol.ts";

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
  daemons.push(spawn(process.execPath, ["--import", "tsx", path.join(here, "../../src/main/pty-daemon.ts"), sock], { stdio: "ignore", env }));
  for (let i = 0; i < 100 && !fs.existsSync(sock); i++) await wait(100);
  await wait(300);
  return { dir, sock, hcp: path.join(dir, "hcp.sock") };
}

/** One line to the control-plane socket, as a hook does; resolves with the reply line if any. */
function hook(hcp: string, msg: unknown, awaitReply = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = net.connect(hcp);
    let got = "";
    c.on("error", reject);
    c.on("data", (d) => { got += d; });
    c.on("close", () => resolve(got));
    c.on("connect", () => { c.write(`${JSON.stringify(msg)}\n`); if (!awaitReply) c.end(); });
  });
}

test("standalone: hook events reach event viewers, requests are refused at once, pushes are sent and throttled", { skip: !unix, timeout: 60000 }, async () => {
  const pushes: { body: string; title?: string }[] = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => { pushes.push({ body, title: req.headers.title as string | undefined }); res.end("ok"); });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as net.AddressInfo).port;

  const d = await startDaemon(true);
  fs.writeFileSync(path.join(d.dir, "push.json"), JSON.stringify({ url: `http://127.0.0.1:${port}/t`, events: ["notification"] }));
  const viewer = net.connect(d.sock);
  const events: ServerMsg[] = [];
  viewer.on("data", makeLineDecoder((l) => { const m = JSON.parse(l) as ServerMsg; if (m.t === "event") events.push(m); }));
  await new Promise((r) => viewer.once("connect", r));
  viewer.write(frame({ t: "hello", caps: ["events"] }));
  await wait(200);

  await hook(d.hcp, { t: "event", topic: "notification", data: { tileId: "tile-1", notificationType: "permission_prompt" } });
  for (let t = 0; t < 5000 && (events.length === 0 || pushes.length === 0); t += 25) await wait(25);
  assert.deepEqual(events[0], { t: "event", topic: "notification", data: { tileId: "tile-1", notificationType: "permission_prompt" } });
  assert.equal(pushes.length, 1);
  assert.match(pushes[0]!.body, /needs your input/);
  assert.match(pushes[0]!.title ?? "", /^hivemind - /);

  await hook(d.hcp, { t: "event", topic: "notification", data: { tileId: "tile-1" } });
  await hook(d.hcp, { t: "event", topic: "turn", data: { tileId: "tile-1" } });
  await wait(500);
  assert.equal(pushes.length, 1, "same session again within the window, and a topic not asked for: no push");
  assert.equal(events.length, 3, "viewers still get every event");

  const started = Date.now();
  const reply = await hook(d.hcp, { t: "req", id: "a1", method: "agent.await_approval", token: "x", params: {} }, true);
  assert.ok(Date.now() - started < 2000, "an approval request never waits");
  assert.deepEqual(JSON.parse(reply), { t: "res", id: "a1", ok: false, error: { code: "UNAVAILABLE", message: "no desktop on this machine" } });
  assert.equal(fs.statSync(d.hcp).mode & 0o777, 0o600);
  viewer.destroy();
  srv.close();
});

test("inside the desktop the daemon leaves the control-plane socket to the app", { skip: !unix, timeout: 30000 }, async () => {
  const d = await startDaemon(false);
  assert.equal(fs.existsSync(d.sock), true);
  assert.equal(fs.existsSync(d.hcp), false);
});
