// The real daemon (from source): a session starts from the environment its starter has now, not
// the one the daemon was started with, so what the person changed since reaches new terminals.
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
const dir = fs.mkdtempSync("/tmp/hbe-");
let daemon: ChildProcess | undefined;
after(() => { daemon?.kill("SIGKILL"); fs.rmSync(dir, { recursive: true, force: true }); });

/** What a session started with `base` (or none) prints of HM_PROBE. */
async function probe(sock: string, id: string, base?: Record<string, string>): Promise<string> {
  const c = net.connect(sock);
  await new Promise((r) => c.once("connect", r));
  let out = "";
  const printed = new Promise<string>((resolve) => {
    c.on("data", makeLineDecoder((line) => {
      const m = JSON.parse(line) as ServerMsg;
      if (m.t === "attached") out += m.replay ?? "";
      if (m.t === "data" && m.id === id) out += m.data;
      const got = /probe=(\S*)\./.exec(out);
      if (got) resolve(got[1]!);
    }));
  });
  const msg: ClientMsg = { t: "attach", reqId: id, id, spec: { cwd: dir, cmd: "sh", args: ["-c", "echo probe=$HM_PROBE.; sleep 5"], cols: 80, rows: 24 }, ...(base ? { base } : {}) };
  c.write(frame(msg));
  try {
    return await Promise.race([printed, new Promise<string>((r) => setTimeout(() => r(`(nothing: ${JSON.stringify(out)})`), 10_000))]);
  } finally {
    c.destroy();
  }
}

test("a session starts from its starter's environment as it is now, and from the daemon's when none is sent", { skip: process.platform === "win32" }, async () => {
  const sock = path.join(dir, "d.sock");
  daemon = spawn(process.execPath, ["--import", "tsx", DAEMON, sock], { stdio: "ignore", env: { ...process.env, HM_PROBE: "old" } });
  for (let i = 0; i < 100 && !fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(await probe(sock, "t-none"), "old");
  assert.equal(await probe(sock, "t-base", { ...(process.env as Record<string, string>), HM_PROBE: "new" }), "new");
});
