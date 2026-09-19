import { after, test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { listenExclusive, probeLive } from "../../src/main/socket-claim.ts";

const unix = process.platform !== "win32";
const dirs: string[] = [];
// Short dir: sun_path is ~108 bytes and tmpdir can be deep.
const tmp = () => { const d = fs.mkdtempSync(path.join(os.platform() === "linux" ? "/tmp" : os.tmpdir(), "hsc-")); dirs.push(d); return d; };
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const close = (s: net.Server) => new Promise<void>((r) => s.close(() => r()));

test("free path → listening", { skip: !unix }, async () => {
  const p = path.join(tmp(), "d.sock");
  const s = net.createServer();
  assert.equal(await listenExclusive(s, p), "listening");
  assert.equal(await probeLive(p), true);
  await close(s);
});

test("live listener → taken, and the live socket keeps working", { skip: !unix }, async () => {
  const p = path.join(tmp(), "d.sock");
  const a = net.createServer((c) => { c.on("error", () => {}); c.end("owner"); });
  assert.equal(await listenExclusive(a, p), "listening");
  const b = net.createServer();
  assert.equal(await listenExclusive(b, p), "taken");
  const reply = await new Promise<string>((r) => { const c = net.connect(p); let d = ""; c.on("data", (x) => (d += x)); c.on("end", () => r(d)); });
  assert.equal(reply, "owner", "the first daemon is still reachable");
  await close(a);
});

test("stale socket file (owner died) → removed and re-bound", { skip: !unix }, async () => {
  const p = path.join(tmp(), "d.sock");
  // What a crashed daemon leaves behind: SIGKILL gives it no chance to unlink.
  const owner = spawn(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(p)}, () => console.log("up"))`]);
  await new Promise<void>((r) => owner.stdout.once("data", () => r()));
  owner.kill("SIGKILL");
  await new Promise<void>((r) => owner.once("exit", () => r()));
  assert.equal(fs.existsSync(p), true);
  assert.equal(await probeLive(p), false);
  const s = net.createServer();
  assert.equal(await listenExclusive(s, p), "listening");
  await close(s);
});

test("a regular file at the path is never deleted", { skip: !unix }, async () => {
  const p = path.join(tmp(), "d.sock");
  fs.writeFileSync(p, "precious");
  await assert.rejects(listenExclusive(net.createServer(), p), /not a socket/);
  assert.equal(fs.readFileSync(p, "utf8"), "precious");
});
