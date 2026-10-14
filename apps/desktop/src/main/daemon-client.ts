/**
 * Daemon client — the main process's connection to the persistent PTY daemon, where every
 * terminal runs (spawnPty/writePty/resizePty/killPty + detachPty). Starts the daemon on demand
 * and reconnects transparently. See research/persistence-plan.md.
 */
import net from "node:net";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { app } from "electron";
import { type ServerMsg, type SessionInfo, SOCKET_NAME, frame, makeLineDecoder } from "@hivemind/agent-host/pty-protocol";
import { DaemonEndpoint, type Callbacks } from "@hivemind/agent-host/daemon-endpoint";
import { reachDaemon } from "@hivemind/agent-host/daemon-start";
import { ipcPath } from "./platform.js";
import { hiveNetBin } from "./hive-net-bin.js";

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
// The daemon runs agents' hooks through hive-net when it is named here.
const daemonEnv = (): NodeJS.ProcessEnv => {
  const hiveNet = hiveNetBin();
  return { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...(hiveNet ? { HIVEMIND_HIVE_NET: hiveNet } : {}) };
};
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
 * startup; every connection waits for it, so the window need not.
 */
let freshness: Promise<void> | null = null;
export function ensureFreshDaemon(): Promise<void> {
  freshness ??= replaceStaleDaemon();
  return freshness;
}

async function replaceStaleDaemon(): Promise<void> {
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

/** This computer's daemon, started if it is not running; never keeping quit waiting on it. */
async function doConnect(): Promise<net.Socket> {
  await freshness?.catch(() => undefined);
  const sp = socketPath();
  // ELECTRON_RUN_AS_NODE: Electron runs the daemon as plain Node, no Chromium.
  const s = await reachDaemon(sp, [process.execPath, daemonScript(), sp], { env: daemonEnv() });
  s.unref();
  return s;
}

/** A connection of its own to this computer's daemon, started if it is not running: for another
 *  of the person's devices running terminals in frames here (M3), through hive-net. */
export function connectDaemon(): Promise<net.Socket> {
  return doConnect();
}

let eventSink: ((topic: string, data: unknown) => void) | null = null;
/** Where this computer's daemon's events go: its sessions' screen readings. */
export function setDaemonEventSink(fn: (topic: string, data: unknown) => void): void { eventSink = fn; }
// New sessions start from this app's environment, the person's shell's as last read.
const local = new DaemonEndpoint({ connect: doConnect, onEvent: (topic, data) => eventSink?.(topic, data), env: () => process.env as Record<string, string> });

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
/** Ask for the session's screen now; false when this client does not hold the session. */
export function screenPty(tileId: string, cb: (replay: string | null) => void, lines?: number): boolean {
  if (!local.has(tileId)) return false;
  local.screen(tileId, cb, lines);
  return true;
}
/** The session's screen as text, line by line; null when this client does not hold it. */
export function viewportPty(tileId: string): Promise<string | null> {
  return local.has(tileId) ? local.viewport(tileId) : Promise.resolve(null);
}
export function writePty(tileId: string, data: string, paste?: boolean): void {
  local.write(tileId, data, paste);
}
export function resizePty(tileId: string, cols: number, rows: number): void {
  local.resize(tileId, cols, rows);
}
export function repaintPty(tileId: string): void {
  local.repaint(tileId);
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
