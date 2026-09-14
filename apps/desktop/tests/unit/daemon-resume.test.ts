// Drives the real daemon (from source, under node) over its socket.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { frame, makeLineDecoder, type ClientMsg, type ServerMsg } from "../../src/main/pty-protocol.ts";

const unix = process.platform !== "win32";
const here = path.dirname(fileURLToPath(import.meta.url));
const dir = unix ? fs.mkdtempSync("/tmp/hdr-") : "";
const sock = path.join(dir, "d.sock");
let daemon: ChildProcess | undefined;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  if (!unix) return;
  daemon = spawn(process.execPath, ["--import", "tsx", path.join(here, "../../src/main/pty-daemon.ts"), sock], { stdio: "ignore" });
  for (let i = 0; i < 100 && !fs.existsSync(sock); i++) await wait(100);
});
after(() => { daemon?.kill("SIGKILL"); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

function client() {
  const s = net.connect(sock);
  const msgs: ServerMsg[] = [];
  let bytes = 0;
  s.on("data", (d) => { bytes += d.length; });
  s.on("data", makeLineDecoder((l) => msgs.push(JSON.parse(l) as ServerMsg)));
  const send = (m: ClientMsg) => s.write(frame(m));
  const until = async <T extends ServerMsg>(f: (m: ServerMsg) => m is T, ms = 10000): Promise<T> => {
    for (let t = 0; t < ms; t += 20) { const m = msgs.find(f); if (m) return m; await wait(20); }
    throw new Error("timed out");
  };
  const text = (id: string) => msgs.filter((m): m is Extract<ServerMsg, { t: "data" }> => m.t === "data" && m.id === id).map((m) => m.data).join("");
  return { s, msgs, send, until, text, bytes: () => bytes };
}
const spec = (cmd: string, args: string[]) => ({ cwd: "/tmp", cmd, args, cols: 80, rows: 24 });

test("a returning viewer is sent exactly the output it missed", { skip: !unix, timeout: 30000 }, async () => {
  const a = client();
  a.send({ t: "attach", reqId: "1", id: "r1", spec: spec("bash", ["--norc", "--noprofile"]) });
  const at = await a.until((m): m is Extract<ServerMsg, { t: "attached" }> => m.t === "attached");
  assert.ok(at.epoch);
  a.send({ t: "write", id: "r1", data: "echo SEEN-$((1+1)); (sleep 1; echo LATE-$((2*3))) &\r" });
  for (let t = 0; t < 5000 && !a.text("r1").includes("SEEN-2"); t += 20) await wait(20);
  const last = [...a.msgs].reverse().find((m): m is Extract<ServerMsg, { t: "data" }> => m.t === "data" && m.seq !== undefined)!;
  a.s.destroy();
  await wait(1500);

  const b = client();
  b.send({ t: "attach", reqId: "2", id: "r1", spec: spec("bash", []), since: { seq: last.seq!, epoch: at.epoch! } });
  const back = await b.until((m): m is Extract<ServerMsg, { t: "attached" }> => m.t === "attached");
  assert.equal(back.delta, true);
  assert.ok(back.replay.includes("LATE-6"), "output printed while away");
  assert.ok(!back.replay.includes("SEEN-2"), "nothing it had already seen");
  b.send({ t: "kill", id: "r1" });
  await wait(200);
  b.s.destroy();
});

test("a viewer that stops reading during a flood is sent the screen instead of every byte", { skip: !unix, timeout: 120000 }, async () => {
  const c = client();
  c.send({ t: "hello", caps: ["resync"] });
  c.send({ t: "attach", reqId: "1", id: "f1", spec: spec("sh", ["-c", "seq 1 2000000; echo FLOOD-$((3*3))-END; sleep 30"]) });
  // Stop reading at once: the viewer is the slow one from the first byte, however busy the machine is.
  c.s.pause();
  await wait(5000);
  c.s.resume();
  await c.until((m): m is Extract<ServerMsg, { t: "attached" }> => m.t === "attached");
  const rs = await c.until((m): m is Extract<ServerMsg, { t: "resync" }> => m.t === "resync" && m.id === "f1", 40000);
  assert.ok(rs.epoch && rs.seq > 0);
  const all = () => (c.msgs.filter((m) => m.t === "resync" && m.id === "f1") as Extract<ServerMsg, { t: "resync" }>[]).map((m) => m.replay).join("") + c.text("f1");
  for (let t = 0; t < 40000 && !all().includes("FLOOD-9-END"); t += 50) await wait(50);
  assert.ok(all().includes("FLOOD-9-END"), "the final screen arrives");
  // How much is skipped depends on how long the flood outlasts the stall; that some was is the point.
  const lines = c.text("f1").split("\n").length;
  assert.ok(lines < 2_000_000, `all ${lines} lines were streamed despite the stall`);
  c.send({ t: "kill", id: "f1" });
  await wait(200);
  c.s.destroy();
});
