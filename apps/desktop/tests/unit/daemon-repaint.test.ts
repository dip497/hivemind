// The real daemon (from source): a session repainted for a viewer shown a copy of its screen tells
// its program the size changed, and changes nothing of it: a screen read meanwhile is never a row
// short, which cut what a chooser's last row says.
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
const dir = fs.mkdtempSync("/tmp/hrp-");
let daemon: ChildProcess | undefined;
after(() => { daemon?.kill("SIGKILL"); fs.rmSync(dir, { recursive: true, force: true }); });

test("a repaint tells the session's program its size changed, and its screen keeps its size", { skip: process.platform === "win32" }, async () => {
  const sock = path.join(dir, "d.sock");
  daemon = spawn(process.execPath, ["--import", "tsx", DAEMON, sock], { stdio: "ignore" });
  for (let i = 0; i < 100 && !fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 100));
  const c = net.connect(sock);
  await new Promise((r) => c.once("connect", r));
  let out = "";
  const sizes: string[] = [];
  const rows: number[] = [];
  c.on("data", makeLineDecoder((line) => {
    const m = JSON.parse(line) as ServerMsg;
    if (m.t === "data") out += m.data;
    if (m.t === "size") sizes.push(`${m.cols}x${m.rows}`);
    if (m.t === "viewport" && m.text !== null) rows.push(m.text.split("\n").length);
  }));
  const send = (m: ClientMsg) => c.write(frame(m));
  const until = async (what: () => boolean) => { for (let i = 0; i < 200 && !what(); i++) await new Promise((r) => setTimeout(r, 25)); };
  try {
    send({ t: "attach", reqId: "a", id: "t1", spec: { cwd: dir, cmd: "sh", args: ["-c", "trap 'echo told' WINCH; echo ready; while :; do sleep 0.05; done"], cols: 80, rows: 24 } });
    await until(() => out.includes("ready"));
    send({ t: "repaint", id: "t1" });
    send({ t: "viewport", reqId: "v", id: "t1" });
    await until(() => out.includes("told") && rows.length > 0);
    assert.ok(out.includes("told"), `the program was told: ${JSON.stringify(out)}`);
    assert.deepEqual(rows, [24], "read as it repaints, the screen is its whole size");
    assert.deepEqual(sizes, [], "its size never changed");
  } finally {
    send({ t: "kill", id: "t1" });
    c.destroy();
  }
});
