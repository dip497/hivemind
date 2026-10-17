// The real daemon: a session put to sleep ends its process and its children, says so in its exit,
// and keeps the screen it showed when it was put to sleep, and its size, though it clears its screen
// as it ends.
// Only an attach that wakes it restores it, from that screen, also after the daemon restarts; any
// other is told it is asleep. Its viewer is shown the newest lines only. Asleep, it keeps its name
// and is not counted as exited. A sleep is kept only once it is on disk, and nothing starts a
// sleeper afresh: not a wake while it is still ending, not one after its save is lost.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { frame, makeLineDecoder, type ClientMsg, type ServerMsg } from "../src/pty-protocol.ts";
import { fileNameForId } from "../src/session-snapshot-store.ts";

const DAEMON = path.join(import.meta.dir, "../src/pty-daemon.ts");
const dir = fs.mkdtempSync("/tmp/hsl-");
let daemon: ChildProcess | undefined;
afterAll(() => { daemon?.kill("SIGKILL"); fs.rmSync(dir, { recursive: true, force: true }); });

const alive = (pid: number) => {
  try { process.kill(pid, 0); } catch { return false; }
  try { return fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)?.[0] !== "Z"; } catch { return true; }
};
const unix = process.platform !== "win32";
const sock = path.join(dir, "d.sock");
// An installed agent, so the daemon names its tiles from their titles.
const manifest = path.join(dir, "config", "hivemind", "agents", "acme", "agent.yaml");
fs.mkdirSync(path.dirname(manifest), { recursive: true });
fs.writeFileSync(manifest, JSON.stringify({
  manifestVersion: 2, id: "acme", label: "Acme", bin: "acme",
  caps: { promptDelivery: "typed", turnSignal: false, resume: "none", supervise: "human", blockedDetection: false },
}));
const start = async () => {
  // Standalone: the daemon keeps the statuses, as under `hive host`.
  daemon = spawn(process.execPath, [DAEMON, sock], { stdio: "ignore", env: { ...process.env, HOME: dir, XDG_CONFIG_HOME: path.join(dir, "config"), HIVEMIND_DAEMON_STANDALONE: "1" } });
  for (let i = 0; i < 300 && !fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 100));
};
beforeAll(async () => { if (unix) await start(); }, 40_000);
const connect = async () => {
  const c = net.connect(sock);
  await new Promise((r) => c.once("connect", r));
  const got: ServerMsg[] = [];
  let out = "";
  c.on("data", makeLineDecoder((line) => {
    const m = JSON.parse(line) as ServerMsg;
    got.push(m);
    // What it wrote before the attach was answered comes in the answer.
    if (m.t === "attached" && m.replay) out += m.replay;
    if (m.t === "data") out += m.data;
  }));
  const reply = async <T extends ServerMsg["t"]>(t: T) => {
    for (let i = 0; i < 400 && !got.some((m) => m.t === t); i++) await new Promise((r) => setTimeout(r, 25));
    return got.find((m) => m.t === t) as Extract<ServerMsg, { t: T }> | undefined;
  };
  return { c, got, reply, out: () => out, send: (m: ClientMsg) => c.write(frame(m)) };
};

test.skipIf(!unix)("a session put to sleep ends with its children, keeps its last screen, and only an attach that wakes it brings it back", async () => {
  // The agent, whose title is kept: it starts a child that ignores the hangup, as an agent's
  // tool server may, and clears its title and its screen as it ends.
  const agent = path.join(dir, "bin", "acme");
  fs.mkdirSync(path.dirname(agent), { recursive: true });
  fs.writeFileSync(agent, "#!/bin/sh\n(trap '' HUP; exec sleep 1000) & echo CHILD=$!\ntrap 'printf \"\\033]0;\\007\\033[2J\\033[3J\\033[H\"; echo CLEARED; exit 0' HUP\nprintf '\\033]0;Named\\007'; echo WORKING\nwhile :; do sleep 0.1; done\n", { mode: 0o755 });
  const spec = { cwd: dir, cmd: agent, args: [], cols: 80, rows: 24 };

  const events = await connect();
  events.send({ t: "hello", caps: ["events"] });
  const first = await connect();
  first.send({ t: "attach", reqId: "a", id: "t1", spec });
  const started = await first.reply("attached");
  for (let i = 0; i < 200 && !first.out().includes("WORKING"); i++) await new Promise((r) => setTimeout(r, 25));
  // Its tile grew after it started: its screen is that size now.
  first.send({ t: "resize", id: "t1", cols: 132, rows: 41 });

  first.send({ t: "sleep", reqId: "s", id: "t1" });
  const slept = await first.reply("slept");
  expect(slept?.error).toBeUndefined();
  expect((await first.reply("exit"))?.slept).toBe(true);
  expect(alive(started!.pid)).toBe(false);
  const child = Number(/CHILD=(\d+)/.exec(first.out())?.[1]);
  expect(child).toBeGreaterThan(0);
  for (let i = 0; i < 40 && alive(child); i++) await new Promise((r) => setTimeout(r, 25));
  expect(alive(child)).toBe(false);
  const of = (topic: string) => events.got.flatMap((m) => (m.t === "event" && m.topic === topic && (m.data as { tileId?: string }).tileId === "t1" ? [m.data] : []));
  expect(of("agent.title").at(-1)).toMatchObject({ title: "Named" });
  expect(of("agent.status").at(-1)).toMatchObject({ status: { state: "idle", title: "Named" } });

  first.send({ t: "screen", reqId: "r", id: "t1", saved: true });
  const saved = await first.reply("screen");
  expect(saved?.replay).toContain("WORKING");
  expect(saved?.replay).not.toContain("CLEARED");
  expect({ cols: saved?.cols, rows: saved?.rows }).toEqual({ cols: 132, rows: 41 });

  const watcher = await connect();
  watcher.send({ t: "attach", reqId: "w", id: "t1", spec, noSpawn: true, liveOnly: true });
  expect((await watcher.reply("attached"))?.error).toBeDefined();
  watcher.send({ t: "list", reqId: "l", detail: true });
  expect((await watcher.reply("sessions"))?.detail?.find((s) => s.id === "t1")).toMatchObject({ state: "frozen", asleep: true });

  const viewer = await connect();
  viewer.send({ t: "attach", reqId: "v", id: "t1", spec });
  expect((await viewer.reply("attached"))?.asleep).toBe(true);

  const waker = await connect();
  waker.send({ t: "attach", reqId: "b", id: "t1", spec, wake: true });
  const woke = await waker.reply("attached");
  expect(woke?.isNew).toBe(true);
  expect(woke?.replay).toContain("WORKING");
  expect(alive(woke!.pid)).toBe(true);

  waker.send({ t: "kill", id: "t1" });
  for (const v of [events, first, watcher, viewer, waker]) v.c.destroy();
}, 20_000);

test.skipIf(!unix)("a sleeping session's viewer asking for 1000 lines is shown its newest, not all it saved", async () => {
  const spec = { cwd: dir, cmd: "sh", args: ["-c", "i=0; while [ $i -lt 3000 ]; do echo LINE$i; i=$((i+1)); done; echo done; while :; do sleep 0.1; done"], cols: 80, rows: 24 };
  const v = await connect();
  v.send({ t: "attach", reqId: "a", id: "t2", spec });
  for (let i = 0; i < 400 && !v.out().includes("done"); i++) await new Promise((r) => setTimeout(r, 25));
  v.send({ t: "sleep", reqId: "s", id: "t2" });
  expect((await v.reply("slept"))?.error).toBeUndefined();
  v.send({ t: "screen", reqId: "r", id: "t2", saved: true, lines: 1000 });
  const recent = (await v.reply("screen"))?.replay ?? "";
  v.got.length = 0;
  v.send({ t: "screen", reqId: "w", id: "t2", saved: true });
  const whole = (await v.reply("screen"))?.replay ?? "";
  // 24 rows show LINE2978 to LINE2999, "done" and the cursor's line; 1000 lines above them start at LINE1978.
  expect(recent).toMatch(/LINE1978\b/);
  expect(recent).not.toMatch(/LINE1977\b/);
  expect(whole).toMatch(/LINE0\b/);
  v.send({ t: "kill", id: "t2" });
  v.c.destroy();
}, 20_000);

test.skipIf(!unix)("asleep stays asleep when the daemon restarts, and a session saved before a restart can be put to sleep too", async () => {
  const spec = (word: string) => ({ cwd: dir, cmd: "sh", args: ["-c", `echo ${word}; while :; do sleep 0.1; done`], cols: 80, rows: 24 });
  const v = await connect();
  for (const [id, word] of [["t3", "SLEPT"], ["t4", "SAVED"]] as const) v.send({ t: "attach", reqId: id, id, spec: spec(word) });
  for (let i = 0; i < 200 && !(v.out().includes("SLEPT") && v.out().includes("SAVED")); i++) await new Promise((r) => setTimeout(r, 25));
  v.send({ t: "sleep", reqId: "s", id: "t3" });
  expect((await v.reply("slept"))?.error).toBeUndefined();
  v.c.destroy();
  // t4's periodic save lands (2 s): what a daemon stopped at once still has.
  await new Promise((r) => setTimeout(r, 2500));
  const gone = new Promise((r) => daemon!.once("exit", r));
  daemon!.kill("SIGTERM");
  await gone;
  fs.rmSync(sock, { force: true });
  await start();

  const after = await connect();
  after.send({ t: "attach", reqId: "a", id: "t3", spec: spec("SLEPT") });
  expect((await after.reply("attached"))?.asleep).toBe(true);
  after.got.length = 0;
  after.send({ t: "sleep", reqId: "z", id: "t4" });
  expect((await after.reply("slept"))?.error).toBeUndefined();
  after.send({ t: "attach", reqId: "b", id: "t4", spec: spec("SAVED") });
  const t4 = await after.reply("attached");
  expect(t4?.asleep).toBe(true);
  after.got.length = 0;
  after.send({ t: "attach", reqId: "w", id: "t4", spec: spec("SAVED"), wake: true });
  const woke = await after.reply("attached");
  expect(woke?.pid).toBeGreaterThan(0);
  expect(woke?.replay).toContain("SAVED");
  for (const id of ["t3", "t4"]) after.send({ t: "kill", id });
  after.c.destroy();
}, 30_000);

const loop = (word: string) => ({ cwd: dir, cmd: "sh", args: ["-c", `trap 'sleep 1; exit 0' HUP; echo ${word}; while :; do sleep 0.1; done`], cols: 80, rows: 24 });
const sessions = path.join(dir, "sessions");

test.skipIf(!unix)("a sleep that cannot be saved is an end, and a wake then finds nothing asleep", async () => {
  const v = await connect();
  v.send({ t: "attach", reqId: "a", id: "t5", spec: loop("UNSAVED") });
  for (let i = 0; i < 200 && !v.out().includes("UNSAVED"); i++) await new Promise((r) => setTimeout(r, 25));
  fs.chmodSync(sessions, 0o500);
  try {
    v.send({ t: "sleep", reqId: "s", id: "t5" });
    expect((await v.reply("slept"))?.error).toBeDefined();
    expect((await v.reply("exit"))?.slept).toBeUndefined();
  } finally {
    fs.chmodSync(sessions, 0o700);
  }
  v.got.length = 0;
  v.send({ t: "attach", reqId: "w", id: "t5", spec: loop("UNSAVED"), wake: true });
  const woke = await v.reply("attached");
  expect(woke?.error).toContain("nothing asleep");
  expect(woke?.gone).toBe(true);
  expect(woke?.pid).toBe(-1);
  v.c.destroy();
}, 20_000);

test.skipIf(!unix)("a wake while it is still ending waits, and restores it rather than joining what ends", async () => {
  const v = await connect();
  v.send({ t: "attach", reqId: "a", id: "t6", spec: loop("ENDING") });
  const first = await v.reply("attached");
  for (let i = 0; i < 200 && !v.out().includes("ENDING"); i++) await new Promise((r) => setTimeout(r, 25));
  v.send({ t: "sleep", reqId: "s", id: "t6" });
  const waker = await connect();
  waker.send({ t: "attach", reqId: "w", id: "t6", spec: loop("ENDING"), wake: true });
  const woke = await waker.reply("attached");
  expect(woke?.isNew).toBe(true);
  expect(woke?.pid).not.toBe(first?.pid);
  expect(alive(woke!.pid)).toBe(true);
  waker.send({ t: "kill", id: "t6" });
  for (const c of [v, waker]) c.c.destroy();
}, 20_000);

test.skipIf(!unix)("a sleeper whose saved screen is lost stays asleep: nothing starts it afresh", async () => {
  const v = await connect();
  v.send({ t: "attach", reqId: "a", id: "t7", spec: loop("LOST") });
  for (let i = 0; i < 200 && !v.out().includes("LOST"); i++) await new Promise((r) => setTimeout(r, 25));
  v.send({ t: "sleep", reqId: "s", id: "t7" });
  expect((await v.reply("slept"))?.error).toBeUndefined();
  fs.writeFileSync(path.join(sessions, fileNameForId("t7")), "not a snapshot");
  v.got.length = 0;
  v.send({ t: "attach", reqId: "b", id: "t7", spec: loop("LOST") });
  expect((await v.reply("attached"))?.asleep).toBe(true);
  v.got.length = 0;
  v.send({ t: "attach", reqId: "w", id: "t7", spec: loop("LOST"), wake: true });
  const woke = await v.reply("attached");
  expect(woke?.pid).toBe(-1);
  expect(woke?.error).toContain("cannot be read");
  expect(woke?.gone, "still asleep, not gone").toBeUndefined();
  v.send({ t: "kill", id: "t7" });
  v.c.destroy();
}, 20_000);
