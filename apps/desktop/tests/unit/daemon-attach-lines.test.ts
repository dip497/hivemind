// The real daemon (from source): an attach that asks for a few lines of scrollback is replayed the
// screen with that many, the newest; one that asks for none is replayed all of it.
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
const dir = fs.mkdtempSync("/tmp/hal-");
let daemon: ChildProcess | undefined;
after(() => { daemon?.kill("SIGKILL"); fs.rmSync(dir, { recursive: true, force: true }); });

test("an attach asking for 5 lines of scrollback is replayed the 5 newest above the screen; one asking nothing, all of them", { skip: process.platform === "win32" }, async () => {
  const sock = path.join(dir, "d.sock");
  daemon = spawn(process.execPath, ["--import", "tsx", DAEMON, sock], { stdio: "ignore" });
  for (let i = 0; i < 100 && !fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 100));
  const connect = async () => {
    const c = net.connect(sock);
    await new Promise((r) => c.once("connect", r));
    const replays: string[] = [];
    let out = "";
    c.on("data", makeLineDecoder((line) => {
      const m = JSON.parse(line) as ServerMsg;
      if (m.t === "data") out += m.data;
      if (m.t === "attached") replays.push(m.replay);
    }));
    return { c, replays, out: () => out, send: (m: ClientMsg) => c.write(frame(m)) };
  };
  const until = async (what: () => boolean) => { for (let i = 0; i < 200 && !what(); i++) await new Promise((r) => setTimeout(r, 25)); };
  const spec = { cwd: dir, cmd: "sh", args: ["-c", "i=0; while [ $i -lt 100 ]; do echo LINE$i; i=$((i+1)); done; echo done; while :; do sleep 1; done"], cols: 80, rows: 24 };
  const first = await connect();
  try {
    first.send({ t: "attach", reqId: "a", id: "t1", spec });
    await until(() => first.out().includes("done"));
    const few = await connect(), all = await connect();
    few.send({ t: "attach", reqId: "b", id: "t1", spec, noSpawn: true, lines: 5 });
    all.send({ t: "attach", reqId: "c", id: "t1", spec, noSpawn: true });
    await until(() => few.replays.length > 0 && all.replays.length > 0);
    // 24 rows show LINE78 to LINE99, "done" and the cursor's line; the five above them are LINE73 to LINE77.
    assert.match(few.replays[0]!, /LINE73\b/);
    assert.doesNotMatch(few.replays[0]!, /LINE72\b/);
    assert.match(all.replays[0]!, /LINE0\b/);
    few.c.destroy(); all.c.destroy();
  } finally {
    first.send({ t: "kill", id: "t1" });
    first.c.destroy();
  }
});
