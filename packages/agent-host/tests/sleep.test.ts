// The real daemon: a session put to sleep ends its process, says so in its exit, and keeps its last
// screen, what it printed as it was told to end included. A viewer that only watches does not wake
// it; a plain attach does, restored from that screen.
import { afterAll, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { frame, makeLineDecoder, type ClientMsg, type ServerMsg } from "../src/pty-protocol.ts";

const DAEMON = path.join(import.meta.dir, "../src/pty-daemon.ts");
const dir = fs.mkdtempSync("/tmp/hsl-");
let daemon: ChildProcess | undefined;
afterAll(() => { daemon?.kill("SIGKILL"); fs.rmSync(dir, { recursive: true, force: true }); });

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test.skipIf(process.platform === "win32")("a session put to sleep ends, keeps its last screen, and only a plain attach brings it back", async () => {
  const sock = path.join(dir, "d.sock");
  daemon = spawn(process.execPath, [DAEMON, sock], { stdio: "ignore", env: { ...process.env, HOME: dir } });
  for (let i = 0; i < 100 && !fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 100));
  const connect = async () => {
    const c = net.connect(sock);
    await new Promise((r) => c.once("connect", r));
    const got: ServerMsg[] = [];
    let out = "";
    c.on("data", makeLineDecoder((line) => {
      const m = JSON.parse(line) as ServerMsg;
      got.push(m);
      if (m.t === "data") out += m.data;
    }));
    const reply = async <T extends ServerMsg["t"]>(t: T) => {
      for (let i = 0; i < 400 && !got.some((m) => m.t === t); i++) await new Promise((r) => setTimeout(r, 25));
      return got.find((m) => m.t === t) as Extract<ServerMsg, { t: T }> | undefined;
    };
    return { c, got, reply, out: () => out, send: (m: ClientMsg) => c.write(frame(m)) };
  };
  const spec = { cwd: dir, cmd: "sh", args: ["-c", "trap 'echo SAID-GOODBYE; exit 0' HUP; echo WORKING; while :; do sleep 0.1; done"], cols: 80, rows: 24 };

  const first = await connect();
  first.send({ t: "attach", reqId: "a", id: "t1", spec });
  const started = await first.reply("attached");
  for (let i = 0; i < 200 && !first.out().includes("WORKING"); i++) await new Promise((r) => setTimeout(r, 25));

  first.send({ t: "sleep", reqId: "s", id: "t1" });
  const slept = await first.reply("slept");
  expect(slept?.error).toBeUndefined();
  expect((await first.reply("exit"))?.slept).toBe(true);
  expect(alive(started!.pid)).toBe(false);

  first.send({ t: "screen", reqId: "r", id: "t1", saved: true });
  const saved = await first.reply("screen");
  expect(saved?.replay).toContain("WORKING");
  expect(saved?.replay).toContain("SAID-GOODBYE");

  const watcher = await connect();
  watcher.send({ t: "attach", reqId: "w", id: "t1", spec, noSpawn: true, liveOnly: true });
  expect((await watcher.reply("attached"))?.error).toBeDefined();
  watcher.send({ t: "list", reqId: "l", detail: true });
  expect((await watcher.reply("sessions"))?.detail?.find((s) => s.id === "t1")?.state).toBe("frozen");

  const waker = await connect();
  waker.send({ t: "attach", reqId: "b", id: "t1", spec });
  const woke = await waker.reply("attached");
  expect(woke?.isNew).toBe(true);
  expect(woke?.replay).toContain("SAID-GOODBYE");
  expect(alive(woke!.pid)).toBe(true);

  waker.send({ t: "kill", id: "t1" });
  for (const v of [first, watcher, waker]) v.c.destroy();
}, 20_000);
