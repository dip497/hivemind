// Replacing a daemon that speaks another protocol, with the real daemon: no agent is put to sleep
// while one is mid-turn; once none is, every session sleeps and the daemon stops, and each is woken
// in the next daemon in the conversation it was in.
import { afterAll, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { frame, makeLineDecoder, type ServerMsg } from "../src/pty-protocol.ts";
import { retireDaemon, wakeSessions } from "../src/daemon-replace.ts";

const DAEMON = path.join(import.meta.dir, "../src/pty-daemon.ts");
const dir = fs.mkdtempSync("/tmp/hdr-");
const daemons: ChildProcess[] = [];
afterAll(() => { for (const d of daemons) d.kill("SIGKILL"); fs.rmSync(dir, { recursive: true, force: true }); });

const unix = process.platform !== "win32";
const sock = path.join(dir, "d.sock");
const manifest = path.join(dir, "config", "hivemind", "agents", "turns", "agent.yaml");
fs.mkdirSync(path.dirname(manifest), { recursive: true });
fs.writeFileSync(manifest, JSON.stringify({
  manifestVersion: 2, id: "turns", label: "Turns", bin: "turns", enabled: true,
  caps: { promptDelivery: "typed", turnSignal: false, resume: "session", supervise: "human", blockedDetection: false },
  session: { bind: { args: ["--session-id", "{newId}"], unless: ["--session-id", "--resume"] }, resume: { args: ["--resume", "{id}"], position: "before", from: { bound: "--session-id" } } },
  detect: { default: "idle", rules: [{ when: { containsCS: "MID-TURN" }, then: "working" }] },
}));
// It writes how it was started, then shows MID-TURN while its flag file is there.
const agent = path.join(dir, "bin", "turns");
fs.mkdirSync(path.dirname(agent), { recursive: true });
fs.writeFileSync(agent, [
  "#!/bin/sh",
  "name=; prev=; for a in \"$@\"; do [ \"$prev\" = --name ] && name=$a; prev=$a; done",
  `echo "$$ $*" >> "${dir}/started-$name"`,
  `while :; do if [ -e "${dir}/busy-$name" ]; then s=MID-TURN; else s=READY; fi; printf '\\033[2J\\033[H%s' "$s"; sleep 0.2; done`,
].join("\n"), { mode: 0o755 });

const startDaemon = async () => {
  fs.rmSync(sock, { force: true });
  const d = spawn(process.execPath, [DAEMON, sock], { stdio: "ignore", env: { ...process.env, HOME: dir, XDG_CONFIG_HOME: path.join(dir, "config") } });
  daemons.push(d);
  for (let i = 0; i < 100 && !fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 100));
  return d;
};
const connect = async () => {
  const c = net.connect(sock);
  await new Promise((r) => c.once("connect", r));
  return c;
};
const wait = async (ok: () => boolean, ms = 15_000) => { for (let t = 0; t < ms && !ok(); t += 50) await new Promise((r) => setTimeout(r, 50)); return ok(); };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** Each start of the agent `name`: its pid and its arguments. */
const starts = (name: string) => (fs.existsSync(path.join(dir, `started-${name}`)) ? fs.readFileSync(path.join(dir, `started-${name}`), "utf8").trim().split("\n") : [])
  .map((l) => ({ pid: Number(l.split(" ")[0]), args: l.split(" ").slice(1) }));

test.skipIf(!unix)("a daemon is replaced only once no agent is mid-turn, and each agent is woken in its conversation", async () => {
  const old = await startDaemon();
  for (const name of ["calm", "busy"]) {
    const c = await connect();
    c.write(frame({ t: "attach", reqId: "a", id: name, spec: { cwd: dir, cmd: agent, args: ["--name", name], cols: 80, rows: 24 } }));
    expect(await wait(() => starts(name).length === 1)).toBe(true);
    c.destroy();
  }
  fs.writeFileSync(path.join(dir, "busy-busy"), "");
  // What the daemon reads off each screen.
  const watcher = await connect();
  const states = new Map<string, string>();
  watcher.on("data", makeLineDecoder((line) => {
    const m = JSON.parse(line) as ServerMsg;
    if (m.t === "event" && m.topic === "agent.status") { const d = m.data as { tileId: string; status: { state: string } }; states.set(d.tileId, d.status.state); }
  }));
  watcher.write(frame({ t: "hello", caps: ["events"] }));
  expect(await wait(() => states.get("busy") === "working" && states.get("calm") === "idle")).toBe(true);

  const waited: string[][] = [];
  let retired = false;
  const retiring = retireDaemon(sock, { waiting: (ids) => waited.push(ids), now: new Promise(() => {}) }).finally(() => { retired = true; });
  expect(await wait(() => waited.length > 0)).toBe(true);
  expect(waited[0]).toEqual(["busy"]);
  await new Promise((r) => setTimeout(r, 1500));
  expect(retired).toBe(false);
  expect(alive(starts("calm")[0]!.pid) && alive(starts("busy")[0]!.pid)).toBe(true);

  fs.rmSync(path.join(dir, "busy-busy"));
  const { asleep, ended } = await retiring;
  expect(waited.at(-1)).toEqual([]);
  expect(ended).toEqual([]);
  expect(asleep.map((s) => s.id).sort()).toEqual(["busy", "calm"]);
  expect(await wait(() => old.exitCode !== null && !alive(starts("calm")[0]!.pid) && !alive(starts("busy")[0]!.pid))).toBe(true);

  await startDaemon();
  expect((await wakeSessions(await connect(), asleep)).sort()).toEqual(["busy", "calm"]);
  for (const name of ["calm", "busy"]) {
    expect(await wait(() => starts(name).length === 2)).toBe(true);
    const [first, woken] = starts(name);
    const bound = first!.args[first!.args.indexOf("--session-id") + 1];
    expect(woken!.args).toContain("--resume");
    expect(woken!.args[woken!.args.indexOf("--resume") + 1]).toBe(bound);
    expect(alive(woken!.pid)).toBe(true);
  }
  watcher.destroy();
}, 60_000);
