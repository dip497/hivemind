// This machine shown to the host of someone else's workspace (machine-share.ts, M4), with this
// machine's real PTY daemon (from source), its own app's connection to it, and the host's side as
// the host runs it (deviceSessions), joined by an in-memory connection in place of hive-net's: the
// host watches what this machine's person placed here as it runs, at the size it has here, and one
// placed that does not run yet once it does; what it sends to type, size, hold back or end a
// session goes nowhere, as does anything else it asks of the daemon; it hears nothing of anything
// else here; when the daemon is replaced, the machine is shown afresh and watched again; and when
// this machine's person lets them type, what the host types reaches what it watches, until they
// take it back; and when they let them run agents here, the host starts and ends the sessions of
// their frames here, in those frames' folders, running what the document says, and no other.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DaemonEndpoint } from "@hivemind/agent-host/daemon-endpoint";
import type { Link } from "@hivemind/workspace-host/hive-net";
import { MACHINE_OFFER, SHOWN_WAIT_MS, grantOf, serveMachine, type Grant } from "../src/machine-share.ts";
import { deviceSessions, linkDuplex } from "../src/device-sessions.ts";
import { streamOf } from "../src/peer-links.ts";

const unix = process.platform !== "win32";
const DAEMON = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../agent-host/src/pty-daemon.ts");
const PRIYA = "d".repeat(64);
const HOST = "e".repeat(64);
const daemons: ChildProcess[] = [];
const dirs: string[] = [];
const stops: Array<() => void> = [];
after(() => {
  for (const s of stops) s();
  for (const d of daemons) d.kill("SIGKILL");
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (done: () => boolean, ms = 10_000) => { for (let t = 0; t < ms && !done(); t += 25) await wait(25); return done(); };
const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "");

/** Two ends of one connection, as hive-net gives each device its own: frames arrive in order, a
 *  moment after they are sent. */
function linkPair(): [host: Link, machine: Link] {
  const heard = [new Map<string, Set<(t: string) => void>>(), new Map<string, Set<(t: string) => void>>()];
  let close!: (why: string) => void;
  const closed = new Promise<string>((r) => { close = r; });
  const end = (i: number, peer: string): Link => ({
    peer,
    send: (stream, data) => void setImmediate(() => { for (const l of heard[1 - i]!.get(stream) ?? []) l(data); }),
    on: (stream, l) => {
      const set = heard[i]!.get(stream) ?? new Set();
      heard[i]!.set(stream, set.add(l));
      return () => { set.delete(l); };
    },
    close: (why = "closed") => close(why),
    closed,
  });
  return [end(0, PRIYA), end(1, HOST)];
}

/** What a shell runs: `script`. */
const sh = (script: string) => ["/bin/sh", "-c", script];

/** Priya's machine: its daemon with a throwaway agent it reads the title of, her app's own
 *  connection to it, the sessions she placed, shown to the host, and the tiles someone else put
 *  in her frames here (`framed`, by session: the program each runs, in her folder); and the host,
 *  watching. */
async function machine(placed: string[], framed: Record<string, string[]> = {}) {
  const dir = fs.mkdtempSync("/tmp/hm-ms-");
  dirs.push(dir);
  const agent = path.join(dir, "xdg", "hivemind", "agents", "probe");
  fs.mkdirSync(agent, { recursive: true });
  fs.writeFileSync(path.join(agent, "agent.yaml"), [
    "manifestVersion: 2", "id: probe", "label: Probe", "bin: probe-agent", "enabled: true",
    "caps: { promptDelivery: argv, turnSignal: false, resume: none, supervise: human, blockedDetection: true }",
    "detect:", "  default: idle", "  rules:", "  - when: { contains: probe is thinking }", "    then: working", "",
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "probe-agent"), "#!/bin/bash\nprintf \"\\033]0;$1\\007probe is thinking\\n\"\nexec sleep 60\n");
  fs.chmodSync(path.join(dir, "probe-agent"), 0o755);
  const sock = path.join(dir, "d.sock");
  /** A connection to the daemon, once made, as the app makes one. */
  const connect = () => new Promise<net.Socket>((resolve, reject) => {
    const c = net.connect(sock);
    c.once("connect", () => resolve(c));
    c.once("error", reject);
  });
  /** The daemon, started; resolves once it answers. */
  const start = async (): Promise<ChildProcess> => {
    const d = spawn(process.execPath, ["--import", "tsx", DAEMON, sock], { stdio: "ignore", env: { ...process.env, XDG_CONFIG_HOME: path.join(dir, "xdg") } });
    daemons.push(d);
    let up = false;
    for (let t = 0; t < 15_000 && !up; t += 100) {
      await wait(100);
      up = await connect().then((c) => { c.destroy(); return true; }, () => false);
    }
    assert.ok(up, "the daemon listens");
    return d;
  };
  let daemon = await start();
  /** The daemon goes, as the app replaces one older than itself, its sessions kept to be brought
   *  back, and another takes its place. */
  const replace = async () => {
    const gone = new Promise((r) => daemon.once("exit", r));
    daemon.kill("SIGTERM");
    await gone;
    daemon = await start();
  };
  const own = new DaemonEndpoint({ connect });
  stops.push(() => own.close());

  const [hostEnd, machineEnd] = linkPair();
  const shown = new Set(placed);
  const inFrames = new Map(Object.entries(framed).map(([id, run]) => [id, { run, cwd: "" }]));
  let granted: Grant = "watch";
  const toldOfGrant = new Set<() => void>();
  stops.push(serveMachine(streamOf(machineEnd, "machine"), {
    daemon: connect,
    shows: (id) => shown.has(id),
    runs: (id) => { const f = inFrames.get(id); return f ? { cwd: f.cwd || dir, cmd: f.run[0]!, args: f.run.slice(1) } : null; },
    grant: () => granted,
    granted: (l) => { toldOfGrant.add(l); return () => { toldOfGrant.delete(l); }; },
  }));
  /** Its person lets the people in the workspace do `g` here. */
  const grant = (g: Grant) => { granted = g; for (const l of toldOfGrant) l(); };
  /** Someone else puts the tile of session `id` in a frame of Priya's here, to run `run` in its
   *  folder (`cwd`, hers by default): her copy of the workspace holds it from now on. */
  const frame = (id: string, run: string[], cwd = "") => { inFrames.set(id, { run, cwd }); };
  /** Everything the host is sent on the `machine` stream. */
  const heard: string[] = [];
  let offered = false;
  hostEnd.on("machine", (t) => { heard.push(t); offered ||= t.trim() === MACHINE_OFFER; });
  const events: Array<{ topic: string; data: unknown }> = [];
  const host = deviceSessions({
    dial: () => Promise.reject(new Error("a participant's machine is never dialled")),
    mine: () => false,
    // Reached once its app shows it, with what it last said it grants, as the host's links give it.
    shown: () => ({
      key: `${PRIYA}/ws`,
      open: () => (offered ? linkDuplex(hostEnd, "machine", { borrowed: true, endsAt: MACHINE_OFFER }) : null),
      grant: () => heard.map(grantOf).filter((g): g is Grant => g !== null).at(-1) ?? "watch",
    }),
    onEvent: (topic, data) => events.push({ topic, data }),
  });
  stops.push(() => host.close());
  assert.ok(await until(() => offered), "the machine is shown to the host");
  /** The host's window opens tile `id`'s terminal, as it would start it (with `env`, and a task
   *  for an agent), or only to show it (`attachOnly`): what it is shown. */
  const watch = (id: string, o: { env?: Record<string, string>; initialPrompt?: string; attachOnly?: boolean } = {}) => {
    const seen = { data: "", sizes: [] as Array<[number, number]>, exits: [] as number[] };
    const started = host.start(
      { tileId: id, tile: id.slice(3), cwd: `machine://${PRIYA}/home/priya/api`, cmd: "/bin/sh", args: ["-c", "touch host-cmd-ran"], cols: 50, rows: 10, ...o },
      { data: (d) => { seen.data += d; }, exit: (code) => { seen.exits.push(code); }, size: (cols, rows) => { seen.sizes.push([cols, rows]); } },
    );
    return { seen, started };
  };
  /** Priya's own window starts a session here, and what it shows. */
  const run = async (id: string, cmd = "/bin/sh", args: string[] = []) => {
    const seen = { data: "" };
    const r = await own.spawn({ tileId: id, cwd: dir, cmd, args, cols: 100, rows: 30 }, { onData: (d) => { seen.data += d; }, onExit: () => {} });
    assert.ok(r.pid > 0, `${id} runs`);
    return seen;
  };
  /** A raw line to the daemon, as a host could send anything. */
  const raw = (msg: unknown) => hostEnd.send("machine", `${JSON.stringify(msg)}\n`);
  /** A session's size here, as the daemon keeps it. */
  const size = async (id: string) => { const s = (await own.sessions()).find((x) => x.id === id); return s && [s.cols, s.rows]; };
  /** What the host was told this machine grants, in turn. */
  const told = () => heard.map(grantOf).filter((g) => g !== null);
  return { dir, own, host, watch, run, raw, size, replace, grant, frame, told, heard, events };
}

test("the host watches what this machine's person placed here, as it runs and at the size it has here: its attach starts, sizes and holds back nothing, and a size given here reaches it", { skip: !unix, timeout: 60_000 }, async () => {
  const m = await machine(["hm:shell"]);
  await m.run("hm:shell");
  m.own.write("hm:shell", "echo one-$((40+2))\n");
  const w = m.watch("hm:shell");
  assert.ok((await w.started).pid > 0);
  assert.ok(await until(() => w.seen.data.includes("one-42")), "what ran before it watched");
  assert.deepEqual(w.seen.sizes, [[100, 30]], "the size it has here, not the host's");
  assert.deepEqual(await m.size("hm:shell"), [100, 30], "still its size here");

  m.own.resize("hm:shell", 120, 40);
  assert.ok(await until(() => w.seen.sizes.length === 2), "sized here, it is told");
  assert.deepEqual(w.seen.sizes[1], [120, 40]);
  m.own.write("hm:shell", "echo two-$((40+2))\n");
  assert.ok(await until(() => w.seen.data.includes("two-42")), "as it runs");
});

test("what the host sends to type into a session, size it, hold it back or end it goes nowhere, nor is anything else it asks of the daemon done: no session started, listed or restored, no control plane, no shutdown", { skip: !unix, timeout: 60_000 }, async () => {
  const m = await machine(["hm:shell", "hm:placed-not-running"]);
  const mine = await m.run("hm:shell");
  await m.run("hm:other");
  const w = m.watch("hm:shell");
  assert.ok((await w.started).pid > 0);

  m.host.write("hm:shell", `touch ${m.dir}/host-typed\n`);
  m.host.resize("hm:shell", 20, 5);
  m.host.pause("hm:shell");
  m.raw({ t: "write", id: "hm:shell", data: `touch ${m.dir}/raw-typed\n` });
  m.raw({ t: "resize", id: "hm:shell", cols: 21, rows: 6 });
  m.raw({ t: "pause", id: "hm:shell" });
  m.raw({ t: "kill", id: "hm:other" });
  m.raw({ t: "attach", reqId: "x1", id: "hm:placed-not-running", spec: { cwd: m.dir, cmd: "/bin/sh", args: [], cols: 80, rows: 24 } });
  m.raw({ t: "attach", reqId: "x2", id: "hm:other", spec: { cwd: m.dir, cmd: "/bin/sh", args: [], cols: 80, rows: 24 } });
  m.raw({ t: "list", reqId: "x3", detail: true });
  m.raw({ t: "control", reqId: "x4", sock: path.join(m.dir, "plane.sock") });
  m.raw({ t: "shutdown" });
  m.host.kill("hm:shell");

  assert.ok(await until(() => m.heard.some((l) => l.includes('"x4"'))));
  const answer = (reqId: string) => m.heard.map((l) => JSON.parse(l) as { t: string; reqId?: string; pid?: number; error?: string }).find((x) => x.reqId === reqId);
  assert.equal(answer("x2")?.pid, -1, "a session not placed here is not shown");
  assert.equal(answer("x3")?.t, "error", "nor is the list of them");
  assert.ok(answer("x4")?.error, "nor the control plane");
  await wait(500);
  assert.deepEqual(await m.size("hm:shell"), [100, 30], "at its own size");
  assert.deepEqual((await m.own.sessions()).map((x) => x.id).sort(), ["hm:other", "hm:shell"], "nothing ended or started, the daemon up");
  m.own.write("hm:shell", "echo done > done.txt\n");
  assert.ok(await until(() => read(path.join(m.dir, "done.txt")) === "done"));
  assert.ok(await until(() => mine.data.includes("done.txt")), "its output not held back");
  assert.equal(fs.existsSync(path.join(m.dir, "host-typed")) || fs.existsSync(path.join(m.dir, "raw-typed")), false);
  assert.equal(m.heard.some((l) => l.includes('"sessions"')), false);
  // One placed that never runs is waited for a while, not for ever: then the host is told so.
  assert.ok(await until(() => answer("x1") !== undefined, SHOWN_WAIT_MS + 5_000));
  assert.equal(answer("x1")?.pid, -1);
  assert.deepEqual((await m.own.sessions()).map((x) => x.id).sort(), ["hm:other", "hm:shell"]);
});

test("a session placed here that does not run yet is waited for, never started from the host: it is shown once this machine starts it", { skip: !unix, timeout: 60_000 }, async () => {
  const m = await machine(["hm:late"]);
  const w = m.watch("hm:late");
  await wait(1_000);
  assert.deepEqual((await m.own.sessions()).map((s) => s.id), [], "the host started nothing");
  await m.run("hm:late");
  m.own.write("hm:late", "echo late-$((40+2))\n");
  assert.ok((await w.started).pid > 0);
  assert.ok(await until(() => w.seen.data.includes("late-42")));
});

test("the host hears what the daemon says of the sessions shown it alone", { skip: !unix, timeout: 60_000 }, async () => {
  const m = await machine(["hm:shown-agent"]);
  await m.run("hm:shown-agent", path.join(m.dir, "probe-agent"), ["Shown work"]);
  await m.run("hm:hidden-agent", path.join(m.dir, "probe-agent"), ["Hidden work"]);
  const w = m.watch("hm:shown-agent");
  assert.ok((await w.started).pid > 0);
  assert.ok(await until(() => m.events.some((e) => e.topic === "agent.title" && JSON.stringify(e.data).includes("Shown work"))), "what it says of a session shown");
  await wait(1_500);
  assert.equal(m.heard.filter((l) => l.includes("hm:hidden-agent") || l.includes("Hidden work")).length, 0, "nothing of one not shown");
});

test("when this machine's daemon is replaced, the machine is shown to the host afresh, and the host watches the session again once it is back", { skip: !unix, timeout: 90_000 }, async () => {
  const m = await machine(["hm:shell"]);
  await m.run("hm:shell");
  m.own.write("hm:shell", "echo before-$((40+2))\n");
  const w = m.watch("hm:shell");
  assert.ok((await w.started).pid > 0);
  assert.ok(await until(() => w.seen.data.includes("before-42")));
  const offers = () => m.heard.filter((l) => l.trim() === MACHINE_OFFER).length;
  const before = offers();
  await m.replace();
  assert.ok(await until(() => offers() > before), "shown afresh");
  // Its own window here brings the session back; the host, attached again, watches it.
  assert.ok(await until(() => m.own.connected, 15_000), "this machine's app is back on it");
  await wait(1_000);
  m.own.write("hm:shell", "echo after-$((40+2))\n");
  assert.ok(await until(() => w.seen.data.includes("after-42"), 30_000), w.seen.data.slice(-300));
  assert.deepEqual(w.seen.exits, [], "never told it ended");
});

test("let type by this machine's person, what the host types reaches what it watches here, at the size it has here; taken back, it goes nowhere again; the host is told each change", { skip: !unix, timeout: 60_000 }, async () => {
  const m = await machine(["hm:shell"]);
  const mine = await m.run("hm:shell");
  await m.run("hm:other");
  const w = m.watch("hm:shell");
  assert.ok((await w.started).pid > 0);
  assert.deepEqual(m.told(), ["watch"], "told what it grants as it is shown");

  m.grant("terminals");
  assert.ok(await until(() => m.told().at(-1) === "terminals"));
  m.host.write("hm:shell", `touch ${m.dir}/typed-granted\n`);
  m.host.resize("hm:shell", 20, 5);
  m.raw({ t: "write", id: "hm:other", data: `touch ${m.dir}/typed-unwatched\n` });
  assert.ok(await until(() => fs.existsSync(path.join(m.dir, "typed-granted"))), "typed");
  assert.deepEqual(await m.size("hm:shell"), [100, 30], "sized here still");

  m.grant("watch");
  assert.ok(await until(() => m.told().at(-1) === "watch"));
  m.host.write("hm:shell", `touch ${m.dir}/typed-after\n`);
  m.own.write("hm:shell", "echo done > done.txt\n");
  assert.ok(await until(() => read(path.join(m.dir, "done.txt")) === "done"));
  assert.ok(await until(() => mine.data.includes("done.txt")));
  await wait(300);
  assert.equal(fs.existsSync(path.join(m.dir, "typed-after")) || fs.existsSync(path.join(m.dir, "typed-unwatched")), false);
});

test("let run agents here by this machine's person, the host starts the session of a tile it put in a frame of theirs here, in that frame's folder, running what the document says, hears of it and ends it; one their copy holds a moment later is waited for; it starts nothing it only watches, nor what is in no frame of theirs, nor once that is taken back", { skip: !unix, timeout: 90_000 }, async () => {
  const m = await machine([], {
    "hm:planted": sh("echo planted-$((40+2)) $X | tee planted.txt; echo token-$HCP_TOKEN > token.txt; exec sleep 60"),
    "hm:watched": sh("touch watched-ran; exec sleep 60"),
    "hm:later": sh("touch later-ran; exec sleep 60"),
  });
  m.frame("hm:agent", [path.join(m.dir, "probe-agent")]);
  m.frame("hm:no-folder", sh("exec sleep 60"), path.join(m.dir, "gone"));
  // Before: the host starts nothing here.
  const before = m.watch("hm:planted");
  assert.equal((await before.started).pid, -1);
  assert.deepEqual((await m.own.sessions()).map((s) => s.id), []);

  m.grant("agents");
  assert.ok(await until(() => m.told().at(-1) === "agents"), "the host is told");
  // Asked for at once: what the host only shows, and what is in no frame of theirs, start nothing.
  const watching = m.watch("hm:watched", { attachOnly: true });
  const elsewhere = m.watch("hm:not-framed");
  const w = m.watch("hm:planted", { env: { X: "from-host", HCP_TOKEN: "host-secret" } });
  assert.ok((await w.started).pid > 0, "started here");
  assert.ok(await until(() => read(path.join(m.dir, "planted.txt")) === "planted-42 from-host"), "in its folder, as the document says, with what the host gives it");
  assert.ok(await until(() => w.seen.data.includes("planted-42 from-host")), "watched from the host");
  assert.equal(fs.existsSync(path.join(m.dir, "host-cmd-ran")), false, "never the host's own command");
  assert.ok(await until(() => read(path.join(m.dir, "token.txt")).startsWith("token-")));
  assert.equal(read(path.join(m.dir, "token.txt")).includes("host-secret"), false, "never the host's control-plane credentials");
  // An agent the host gives a task to starts on it.
  const agent = m.watch("hm:agent", { initialPrompt: "Host work" });
  assert.ok((await agent.started).pid > 0);
  assert.ok(await until(() => m.events.some((e) => e.topic === "agent.title" && JSON.stringify(e.data).includes("Host work"))), "what the daemon says of it");
  // One that ends as it starts (its folder is gone) is told so at once.
  const asked = Date.now();
  const gone = m.watch("hm:no-folder");
  assert.ok((await gone.started).pid > 0);
  assert.ok(await until(() => gone.seen.exits.length === 1), "told it ended");
  assert.ok(Date.now() - asked < SHOWN_WAIT_MS / 3, "at once");

  // One the host puts there that their copy of the workspace holds only a moment later.
  const late = m.watch("hm:late");
  await wait(1_000);
  m.frame("hm:late", sh("echo late-$((40+2)); exec sleep 60"));
  assert.ok((await late.started).pid > 0, "started once held here");
  assert.ok(await until(() => late.seen.data.includes("late-42")));

  m.host.kill("hm:planted");
  for (let t = 0; t < 5_000 && (await m.own.sessions()).some((s) => s.id === "hm:planted"); t += 100) await wait(100);
  assert.equal((await m.own.sessions()).some((s) => s.id === "hm:planted"), false, "ended from the host");

  assert.equal((await watching.started).pid, -1, "what the host only shows, it does not start");
  assert.equal((await elsewhere.started).pid, -1, "nor what is in no frame of theirs");
  assert.equal(fs.existsSync(path.join(m.dir, "watched-ran")), false);

  // Taken back: the host starts and ends nothing more here, whatever it asks.
  m.grant("watch");
  m.raw({ t: "attach", reqId: "r1", id: "hm:later", spec: { cwd: m.dir, cmd: "/bin/sh", args: [], cols: 80, rows: 24 } });
  m.host.kill("hm:late");
  assert.ok(await until(() => m.told().at(-1) === "watch"));
  assert.equal((await m.watch("hm:later").started).pid, -1);
  assert.ok(await until(() => m.heard.some((l) => l.includes('"r1"') && l.includes('"pid":-1'))), "refused at once");
  await wait(300);
  assert.equal(fs.existsSync(path.join(m.dir, "later-ran")), false);
  assert.ok((await m.own.sessions()).some((s) => s.id === "hm:late"), "nor ended");
});
