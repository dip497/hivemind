// The real daemon, with an agent that finds its conversation only as the newest its store keeps in
// its folder: put to sleep, a session keeps the conversation it is in, so woken it resumes that
// one, whatever is newest there by then. One that shares its folder with another session of its
// agent, or whose conversation cannot be found, is not put to sleep, saying why.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { frame, makeLineDecoder, type ClientMsg, type ServerMsg } from "../src/pty-protocol.ts";

const DAEMON = path.join(import.meta.dir, "../src/pty-daemon.ts");
const dir = fs.mkdtempSync("/tmp/hsc-");
let daemon: ChildProcess | undefined;
afterAll(() => { daemon?.kill("SIGKILL"); fs.rmSync(dir, { recursive: true, force: true }); });

const unix = process.platform !== "win32";
const sock = path.join(dir, "d.sock");
const manifest = path.join(dir, "config", "hivemind", "agents", "folio", "agent.yaml");
fs.mkdirSync(path.dirname(manifest), { recursive: true });
fs.writeFileSync(manifest, JSON.stringify({
  manifestVersion: 2, id: "folio", label: "Folio", bin: "folio", enabled: true,
  caps: { promptDelivery: "typed", turnSignal: false, resume: "cwd", supervise: "human", blockedDetection: false },
  session: { resume: { args: ["--resume", "{id}"], find: { strategy: "jsonl-header", root: "{home}/.folio/sessions", cwdPath: "cwd", idPath: "id" } } },
}));
// The agent says what it was started with.
const agent = path.join(dir, "bin", "folio");
fs.mkdirSync(path.dirname(agent), { recursive: true });
fs.writeFileSync(agent, "#!/bin/sh\necho \"ARGS=$*.\"\nwhile :; do sleep 0.1; done\n", { mode: 0o755 });

/** A conversation its store keeps for `cwd`, the newest of them. */
let stamp = 0;
const conversation = (id: string, cwd: string) => {
  const file = path.join(dir, ".folio", "sessions", `${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ id, cwd })}\n`);
  const at = new Date(Date.now() + ++stamp * 1000);
  fs.utimesSync(file, at, at);
};
const folder = (name: string) => { const f = path.join(dir, name); fs.mkdirSync(f, { recursive: true }); return f; };

beforeAll(async () => {
  if (!unix) return;
  daemon = spawn(process.execPath, [DAEMON, sock], { stdio: "ignore", env: { ...process.env, HOME: dir, XDG_CONFIG_HOME: path.join(dir, "config") } });
  for (let i = 0; i < 100 && !fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 100));
});

const connect = async () => {
  const c = net.connect(sock);
  await new Promise((r) => c.once("connect", r));
  const got: ServerMsg[] = [];
  let out = "";
  c.on("data", makeLineDecoder((line) => {
    const m = JSON.parse(line) as ServerMsg;
    got.push(m);
    if (m.t === "attached" && m.replay) out += m.replay;
    if (m.t === "data") out += m.data;
  }));
  const reply = async <T extends ServerMsg["t"]>(t: T) => {
    for (let i = 0; i < 400 && !got.some((m) => m.t === t); i++) await new Promise((r) => setTimeout(r, 25));
    return got.find((m) => m.t === t) as Extract<ServerMsg, { t: T }> | undefined;
  };
  const until = async (text: string) => { for (let i = 0; i < 200 && !out.includes(text); i++) await new Promise((r) => setTimeout(r, 25)); };
  return { c, reply, until, out: () => out, send: (m: ClientMsg) => c.write(frame(m)) };
};

/** A tile's session started in `cwd`, running. */
const started = async (id: string, cwd: string) => {
  const c = await connect();
  c.send({ t: "attach", reqId: "a", id, spec: { cwd, cmd: agent, args: [], cols: 80, rows: 24 } });
  await c.reply("attached");
  await c.until("ARGS=");
  return c;
};

test.skipIf(!unix)("woken, it resumes the conversation it was in when put to sleep, not the newest in its folder", async () => {
  const api = folder("api");
  conversation("0b6c1a52-7d0e-4c55-9f43-2a8f6f2b9c11", api);
  const c = await started("f1", api);
  c.send({ t: "sleep", reqId: "s", id: "f1" });
  expect((await c.reply("slept"))?.error).toBeUndefined();
  conversation("6f1d0c2e-1111-4c55-9f43-2a8f6f2b9c22", api);

  const w = await connect();
  w.send({ t: "attach", reqId: "w", id: "f1", spec: { cwd: api, cmd: agent, args: [], cols: 80, rows: 24 }, wake: true });
  await w.reply("attached");
  await w.until("ARGS=--resume");
  expect(w.out()).toContain("ARGS=--resume 0b6c1a52-7d0e-4c55-9f43-2a8f6f2b9c11.");
  w.send({ t: "kill", id: "f1" });
  for (const v of [c, w]) v.c.destroy();
}, 20_000);

test.skipIf(!unix)("one whose folder another session of its agent shares, or whose conversation cannot be found, is not put to sleep", async () => {
  const web = folder("web");
  conversation("9a1d0c2e-2222-4c55-9f43-2a8f6f2b9c33", web);
  const a = await started("f2", web);
  const b = await started("f3", web);
  a.send({ t: "sleep", reqId: "s", id: "f2" });
  expect((await a.reply("slept"))?.error).toBe("its conversation is found only by its folder, which session 'f3' shares");

  const docs = folder("docs");
  const d = await started("f4", docs);
  d.send({ t: "sleep", reqId: "s", id: "f4" });
  expect((await d.reply("slept"))?.error).toBe("its conversation cannot be found: woken, it would start afresh");
  for (const [v, id] of [[a, "f2"], [b, "f3"], [d, "f4"]] as const) { v.send({ t: "kill", id }); v.c.destroy(); }
}, 20_000);
