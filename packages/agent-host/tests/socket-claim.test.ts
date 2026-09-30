// Binding a daemon's socket without stealing it (socket-claim.ts): a live listener keeps its
// socket, a socket its owner left behind is taken over, and a file that is not a socket is never
// removed. Run under Bun, which the compiled `hive` is: its listen replaces a socket file whatever
// holds it, where Node refuses with EADDRINUSE.
import { afterAll, expect, test } from "bun:test";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { listenExclusive, probeLive } from "../src/socket-claim.ts";

const unix = process.platform !== "win32";
const dirs: string[] = [];
// Short dir: sun_path is ~108 bytes and tmpdir can be deep.
const tmp = () => { const d = fs.mkdtempSync(path.join(os.platform() === "linux" ? "/tmp" : os.tmpdir(), "hsc-")); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const close = (s: net.Server) => new Promise<void>((r) => s.close(() => r()));

test.skipIf(!unix)("free path → listening", async () => {
  const p = path.join(tmp(), "d.sock");
  const s = net.createServer();
  expect(await listenExclusive(s, p)).toBe("listening");
  expect(await probeLive(p)).toBe(true);
  await close(s);
});

test.skipIf(!unix)("live listener → taken, and the live socket keeps working", async () => {
  const p = path.join(tmp(), "d.sock");
  const a = net.createServer((c) => { c.on("error", () => {}); c.end("owner"); });
  expect(await listenExclusive(a, p)).toBe("listening");
  const b = net.createServer();
  expect(await listenExclusive(b, p)).toBe("taken");
  const reply = await new Promise<string>((r) => { const c = net.connect(p); let d = ""; c.on("data", (x) => (d += x)); c.on("end", () => r(d)); });
  expect(reply).toBe("owner");
  await close(a);
});

test.skipIf(!unix)("stale socket file (owner died) → removed and re-bound", async () => {
  const p = path.join(tmp(), "d.sock");
  // What a crashed daemon leaves behind: SIGKILL gives it no chance to unlink.
  const owner = spawn(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(p)}, () => console.log("up"))`]);
  await new Promise<void>((r) => owner.stdout.once("data", () => r()));
  owner.kill("SIGKILL");
  await new Promise<void>((r) => owner.once("exit", () => r()));
  expect(fs.existsSync(p)).toBe(true);
  expect(await probeLive(p)).toBe(false);
  const s = net.createServer();
  expect(await listenExclusive(s, p)).toBe("listening");
  await close(s);
});

test.skipIf(!unix)("a regular file at the path is never deleted", async () => {
  const p = path.join(tmp(), "d.sock");
  fs.writeFileSync(p, "precious");
  await expect(listenExclusive(net.createServer(), p)).rejects.toThrow(/not a socket/);
  expect(fs.readFileSync(p, "utf8")).toBe("precious");
});
