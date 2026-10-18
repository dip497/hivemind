// The real daemon: stopped (SIGTERM) right after a session printed, and after its last viewer
// left, which starts a save of its own, it still saves that output, and a daemon started again
// shows it.
import { afterAll, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { frame, makeLineDecoder, type ClientMsg, type ServerMsg } from "../src/pty-protocol.ts";

const DAEMON = path.join(import.meta.dir, "../src/pty-daemon.ts");
const dir = fs.mkdtempSync("/tmp/hss-");
const sock = path.join(dir, "d.sock");
let daemon: ChildProcess | undefined;
afterAll(() => { daemon?.kill("SIGKILL"); fs.rmSync(dir, { recursive: true, force: true }); });

async function start(): Promise<void> {
  daemon = spawn(process.execPath, [DAEMON, sock], { stdio: "ignore", env: { ...process.env, HOME: dir, XDG_CONFIG_HOME: path.join(dir, "config") } });
  for (let i = 0; i < 600 && !fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 100));
}

async function connect() {
  const c = net.connect(sock);
  await new Promise((r) => c.once("connect", r));
  const got: ServerMsg[] = [];
  c.on("data", makeLineDecoder((line) => got.push(JSON.parse(line) as ServerMsg)));
  const until = async <T extends ServerMsg>(f: (m: ServerMsg) => m is T): Promise<T | undefined> => {
    for (let i = 0; i < 1500; i++) { const m = got.find(f); if (m) return m; await new Promise((r) => setTimeout(r, 20)); }
    return undefined;
  };
  return { c, send: (m: ClientMsg) => c.write(frame(m)), until };
}

test.skipIf(process.platform === "win32")("a daemon stopped as a session's viewer leaves still saves what it printed last", async () => {
  await start();
  const spec = { cwd: dir, cmd: "sh", args: ["-c", "echo LAST-$((6*7)); exec sleep 60"], cols: 80, rows: 24 };
  const v = await connect();
  v.send({ t: "attach", reqId: "a", id: "t1", spec });
  await v.until((m): m is Extract<ServerMsg, { t: "data" }> => m.t === "data" && m.data.includes("LAST-42"));
  v.c.destroy();
  await new Promise((r) => setTimeout(r, 100));
  const gone = new Promise((r) => daemon!.once("exit", r));
  daemon!.kill("SIGTERM");
  await gone;
  fs.rmSync(sock, { force: true });

  await start();
  const after = await connect();
  after.send({ t: "attach", reqId: "b", id: "t1", spec: { ...spec, args: ["-c", "exec sleep 60"] } });
  const back = await after.until((m): m is Extract<ServerMsg, { t: "attached" }> => m.t === "attached");
  expect(back?.replay).toContain("LAST-42");
  after.send({ t: "kill", id: "t1" });
  after.c.destroy();
}, 120_000);
