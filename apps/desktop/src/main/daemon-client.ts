/**
 * Daemon client — the main process's connection to the persistent PTY daemon.
 * Exposes the SAME surface as pty-host (spawnPty/writePty/resizePty/killPty +
 * detachPty) so index.ts can route to either. Spawns the daemon on demand and
 * reconnects transparently. See research/persistence-plan.md.
 */
import net from "node:net";
import path from "node:path";
import { readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { app } from "electron";
import { type ServerMsg, type SessionInfo, SOCKET_NAME, frame, makeLineDecoder } from "./pty-protocol.js";
import { DaemonEndpoint, type Callbacks } from "./daemon-endpoint.js";
import { ipcPath } from "./platform.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface SpawnOpts {
  tileId: string;
  cwd: string;
  cmd: string;
  args?: string[];
  cols: number;
  rows: number;
  env?: Record<string, string>;
  /** Initial task delivered as claude's positional argv (HIVE_INITIAL_PROMPT); consumed by the ptySpawn handler into env. */
  initialPrompt?: string;
}

const socketPath = () => ipcPath(app.getPath("userData"), SOCKET_NAME);
const daemonScript = () => path.join(__dirname, "pty-daemon.js");
const delay = (ms: number) =>
  new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });

/** CONTENT hash (FNV-1a) of the on-disk daemon bundle. Using content — not mtime
 *  — means a rebuild that doesn't change the daemon's code keeps the same stamp,
 *  so renderer/main-only rebuilds DON'T trigger a respawn that would tear down
 *  live claude sessions. Must match pty-daemon.ts's BUILD_STAMP byte-for-byte. */
function currentBuildStamp(): number {
  try {
    const b = readFileSync(daemonScript());
    let h = 0x811c9dc5;
    for (let i = 0; i < b.length; i++) { h ^= b[i]!; h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  } catch { return 0; }
}

/**
 * If a daemon is already running but was launched from an OLDER build of the
 * daemon script (i.e. you rebuilt since it started), tell it to exit so the next
 * connect spawns a fresh one carrying the new code (hooks, env injection, …).
 * Sessions persist via on-disk snapshots, so the new daemon replays + respawns
 * them. No-op when no daemon is running or it's already current. Call ONCE at
 * startup, before the renderer attaches any tiles.
 */
export async function ensureFreshDaemon(): Promise<void> {
  const want = currentBuildStamp();
  if (!want) return; // can't stat the script — don't risk disrupting a live daemon
  const sp = socketPath();
  const probe = await new Promise<{ stamp: number; sock: net.Socket } | null>((resolve) => {
    const s = net.connect(sp);
    let settled = false;
    const fin = (v: { stamp: number; sock: net.Socket } | null) => { if (settled) return; settled = true; resolve(v); };
    const timer = setTimeout(() => { try { s.destroy(); } catch { /* */ } fin(null); }, 1000);
    timer.unref?.();
    s.once("error", () => { clearTimeout(timer); try { s.destroy(); } catch { /* */ } fin(null); }); // no daemon
    s.on("data", makeLineDecoder((line) => {
      try {
        const m = JSON.parse(line) as ServerMsg;
        if (m.t === "pong") { clearTimeout(timer); fin({ stamp: m.buildStamp ?? 0, sock: s }); }
      } catch { /* ignore */ }
    }));
    s.once("connect", () => { try { s.write(frame({ t: "ping", reqId: "fresh" })); } catch { fin(null); } });
  });
  if (!probe) return;                       // nothing running → fresh spawns on demand
  if (probe.stamp === want) { try { probe.sock.destroy(); } catch { /* */ } return; } // current
  // Stale build → replace it.
  try { probe.sock.write(frame({ t: "shutdown" })); } catch { /* */ }
  try { probe.sock.end(); } catch { /* */ }
  await delay(300); // let it exit + unlink the socket so the next connect spawns fresh
}

// GNOME / systemd desktops launch the app inside a transient
// `app-gnome-<name>-<pid>.scope` cgroup whose default `KillMode=control-group`
// terminates EVERY process in the cgroup when the window closes. `detached`
// (setsid) escapes the process group + controlling terminal but NOT the cgroup,
// so a plainly-detached daemon is killed on every close. Detect this and, if so,
// register the daemon in its OWN transient scope (a `run-*.scope` outside the
// app cgroup) via `systemd-run --user --scope`. Returns the systemd-run argv
// prefix to wrap the daemon command with, or null to spawn it directly.
function cgroupEscapePrefix(): string[] | null {
  if (process.platform !== "linux") return null;
  if (!process.env.XDG_RUNTIME_DIR) return null; // no user systemd manager to talk to
  let cg = "";
  try { cg = readFileSync("/proc/self/cgroup", "utf8"); } catch { return null; }
  // Only intervene when we're actually inside a killable app scope — elsewhere
  // (plain login session, container, non-systemd) the direct spawn is correct.
  if (!/app-[^/\n]*\.scope/.test(cg)) return null;
  const probe = spawnSync("systemd-run", ["--version"], { stdio: "ignore" });
  if (probe.status !== 0) return null;
  // --scope runs the command in OUR env + cwd (no env-forwarding dance), just in
  // a fresh scope cgroup; --collect cleans the unit up when the daemon exits.
  return ["systemd-run", "--user", "--scope", "--quiet", "--collect"];
}

function spawnDaemon(sp: string): void {
  // ELECTRON_RUN_AS_NODE makes Electron run the daemon as plain Node (no
  // Chromium); detached + unref so it outlives this window.
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  const daemonCmd = [process.execPath, daemonScript(), sp];
  const prefix = cgroupEscapePrefix();
  const [file, ...args] = prefix ? [...prefix, ...daemonCmd] : daemonCmd;
  const child = spawn(file as string, args, { env, detached: true, stdio: "ignore" });
  child.unref();
}

function tryConnect(sp: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect(sp);
    const onErr = (e: Error) => {
      s.destroy();
      reject(e);
    };
    s.once("error", onErr);
    s.once("connect", () => {
      s.removeListener("error", onErr);
      // Never keep main's event loop alive on this socket, or quit would hang.
      s.unref();
      resolve(s);
    });
  });
}

async function doConnect(): Promise<net.Socket> {
  const sp = socketPath();
  for (let attempt = 0; attempt < 25; attempt++) {
    try {
      return await tryConnect(sp);
    } catch {
      if (attempt === 0) spawnDaemon(sp); // first failure → bring the daemon up
      await delay(120);
    }
  }
  throw new Error("pty-daemon unreachable");
}

const local = new DaemonEndpoint({ connect: doConnect });

export async function spawnPty(opts: SpawnOpts & { attachOnly?: boolean; liveOnly?: boolean }, cb: Callbacks): Promise<{ pid: number }> {
  const r = await local.spawn({ ...opts, noSpawn: opts.attachOnly, liveOnly: opts.attachOnly && opts.liveOnly }, cb);
  if (r.pid === -1 && opts.attachOnly) local.detach(opts.tileId);
  return r;
}
/** Every session in this computer's daemon (the session picker's "this computer"). */
export function listSessions(): Promise<SessionInfo[]> {
  return local.sessions();
}
/** Whether we hold a live attach spec for this id (HCP dead-tile detection). */
export function hasSession(tileId: string): boolean {
  return local.has(tileId);
}
export function writePty(tileId: string, data: string): void {
  local.write(tileId, data);
}
export function resizePty(tileId: string, cols: number, rows: number): void {
  local.resize(tileId, cols, rows);
}
/** Renderer back-pressure (see TerminalTile flow control); the daemon also
 *  resumes on its own on detach/kill/reattach, so a dropped resume can't wedge a session. */
export function pausePty(tileId: string): void {
  local.pause(tileId);
}
export function resumePty(tileId: string): void {
  local.resume(tileId);
}
/** Explicit close (× button): terminate the session in the daemon. */
export function killPty(tileId: string): void {
  local.kill(tileId);
}
/** Window closed / tile unmounted: stop streaming but KEEP the session alive. */
export function detachPty(tileId: string): void {
  local.detach(tileId);
}
/** App quit: sessions PERSIST in the daemon; only our socket goes, so it can't stall exit. */
export function killAll(): void {
  local.close();
}
