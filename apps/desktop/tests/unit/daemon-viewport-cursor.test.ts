// The real daemon (from source): a session's screen is read with its cursor, so what an agent's
// prompt holds is what comes before the cursor, never the suggestion it shows after it.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { frame, makeLineDecoder, upToCursor, type ClientMsg, type ServerMsg } from "@hivemind/agent-host/pty-protocol";

const here = path.dirname(fileURLToPath(import.meta.url));
const DAEMON = path.join(here, "../../../../packages/agent-host/src/pty-daemon.ts");
const dir = fs.mkdtempSync("/tmp/hvc-");
let daemon: ChildProcess | undefined;
after(() => { daemon?.kill("SIGKILL"); fs.rmSync(dir, { recursive: true, force: true }); });

test("a screen read carries its cursor: before it, the prompt; after it, the agent's own suggestion", { skip: process.platform === "win32" }, async () => {
  const sock = path.join(dir, "d.sock");
  daemon = spawn(process.execPath, ["--import", "tsx", DAEMON, sock], { stdio: "ignore" });
  for (let i = 0; i < 100 && !fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 100));
  const c = net.connect(sock);
  await new Promise((r) => c.once("connect", r));
  let out = "";
  const read: Array<Extract<ServerMsg, { t: "viewport" }>> = [];
  c.on("data", makeLineDecoder((line) => {
    const m = JSON.parse(line) as ServerMsg;
    if (m.t === "data") out += m.data;
    if (m.t === "viewport") read.push(m);
  }));
  const send = (m: ClientMsg) => c.write(frame(m));
  const until = async (what: () => boolean) => { for (let i = 0; i < 200 && !what(); i++) await new Promise((r) => setTimeout(r, 25)); };
  try {
    send({ t: "attach", reqId: "a", id: "t1", spec: { cwd: dir, cmd: "sh", args: ["-c", "printf '\\033[2J\\033[H────\\n❯ Try \"fix lint\"\\033[3G'; while :; do sleep 0.05; done"], cols: 80, rows: 24 } });
    await until(() => out.includes("fix lint"));
    await new Promise((r) => setTimeout(r, 200));
    send({ t: "viewport", reqId: "v", id: "t1" });
    await until(() => read.length > 0);
    const v = read[0]!;
    assert.deepEqual(v.cursor, { x: 2, y: 1 });
    assert.equal(upToCursor({ text: v.text!, cursor: v.cursor }), "────\n❯ ");
  } finally {
    send({ t: "kill", id: "t1" });
    c.destroy();
  }
});
