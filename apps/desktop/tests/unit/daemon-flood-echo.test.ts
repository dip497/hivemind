// The real daemon (from source): one session prints 50 MB while a window keeps asking for its
// screen; another session's keystrokes, typed in another window, still echo at once. Reading and
// serializing the flood's screen is the daemon's slowest work, and none of it may stand between a
// key and its echo.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { frame, makeLineDecoder, type ClientMsg, type ServerMsg } from "@hivemind/agent-host/pty-protocol";

const here = path.dirname(fileURLToPath(import.meta.url));
const DAEMON = path.join(here, "../../../../packages/agent-host/src/pty-daemon.ts");
const dir = fs.mkdtempSync("/tmp/hfe-");
let daemon: ChildProcess | undefined;
after(() => { daemon?.kill("SIGKILL"); fs.rmSync(dir, { recursive: true, force: true }); });

const FLOOD_BYTES = 50_000_000;
// A build log's colored lines, as fast as awk prints them.
const FLOOD = `awk 'BEGIN { n = 0; for (i = 0; n < ${FLOOD_BYTES}; i++) { s = sprintf("\\033[32m[%3d%%]\\033[0m \\033[1mBuilding CXX object\\033[0m src/module_%d/file.cpp.o -- warning: \\033[33munused variable\\033[0m", i % 100, i); print s; n += length(s) + 1 } }'`;

test("a session printing 50 MB, its screen asked for again and again, does not hold up another session's echo", { skip: process.platform === "win32" }, async () => {
  const sock = path.join(dir, "d.sock");
  daemon = spawn(process.execPath, ["--import", "tsx", DAEMON, sock], { stdio: "ignore" });
  for (let i = 0; i < 100 && !fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 100));
  // Each window has its own connection and says, as the app does, that it can be resynced.
  const window = async () => {
    const w = net.connect(sock);
    await new Promise((r) => w.once("connect", r));
    w.write(frame({ t: "hello", caps: ["resync"] }));
    return w;
  };
  const c = await window();
  const e = await window();
  let printing = false;
  let echoed = "";
  let floodEnded = false;
  let screens = 0;
  e.on("data", makeLineDecoder((line) => {
    const m = JSON.parse(line) as ServerMsg;
    if (m.t === "data" && m.id === "echo") echoed += m.data;
  }));
  c.on("data", makeLineDecoder((line) => {
    const m = JSON.parse(line) as ServerMsg;
    if ((m.t === "data" || m.t === "resync") && m.id === "flood") printing = true;
    if (m.t === "exit" && m.id === "flood") floodEnded = true;
    if (m.t === "screen" && m.id === "flood") screens++;
  }));
  const send = (m: ClientMsg) => ("id" in m && m.id === "echo" ? e : c).write(frame(m));
  const spec = (script: string) => ({ cwd: dir, cmd: "sh", args: ["-c", script], cols: 160, rows: 50 });
  try {
    send({ t: "attach", reqId: "e", id: "echo", spec: spec("stty -icanon; echo READY; exec cat >/dev/null") });
    // A key typed before the terminal is set up is not echoed.
    while (!echoed.includes("READY")) await new Promise((r) => setTimeout(r, 20));
    send({ t: "attach", reqId: "f", id: "flood", spec: spec(`sleep 1; ${FLOOD}; sleep 0.5`) });
    let asked = 0;
    const asking = setInterval(() => send({ t: "screen", reqId: `s${asked++}`, id: "flood", lines: 5000 }), 500);
    // The pty echoes each key itself, so the time to see it is the daemon's alone.
    const waits: number[] = [];
    for (let k = 0; !floodEnded; k++) {
      const before = echoed.length;
      const sent = performance.now();
      send({ t: "write", id: "echo", data: String.fromCharCode(97 + (k % 26)) });
      while (echoed.length === before && performance.now() - sent < 30_000) await new Promise((r) => setImmediate(r));
      if (printing && !floodEnded) waits.push(performance.now() - sent);
      await new Promise((r) => setTimeout(r, 50));
    }
    clearInterval(asking);
    waits.sort((a, b) => a - b);
    const median = waits[Math.floor(waits.length / 2)]!;
    const worst = waits.at(-1)!;
    assert.ok(screens > 0, "its screen was taken while it printed");
    assert.ok(median < 50, `echo while it printed: median ${median.toFixed(1)} ms, worst ${worst.toFixed(1)} ms over ${waits.length} keys`);
    assert.ok(worst < 1000, `no echo waited on the flood's screens: worst ${worst.toFixed(1)} ms, median ${median.toFixed(1)} ms`);
  } finally {
    send({ t: "kill", id: "echo" });
    send({ t: "kill", id: "flood" });
    c.destroy();
    e.destroy();
  }
});
