/**
 * Daemon client — the main process's connection to the persistent PTY daemon, where every
 * terminal runs (spawnPty/writePty/resizePty/killPty + detachPty). Starts the daemon on demand
 * and reconnects transparently. See research/persistence-plan.md.
 */
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";
import { type SessionInfo, DAEMON_PROTOCOL_VERSION, SOCKET_NAME } from "@hivemind/agent-host/pty-protocol";
import { daemonProtocol, retireDaemon, socketAt, wakeSessions } from "@hivemind/agent-host/daemon-replace";
import { DaemonEndpoint, type Callbacks } from "@hivemind/agent-host/daemon-endpoint";
import { reachDaemon } from "@hivemind/agent-host/daemon-start";
import { lastingDaemon } from "@hivemind/agent-host/daemon-runtime";
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
/** How the daemon is started: ELECTRON_RUN_AS_NODE runs this app's binary as plain Node, from a
 *  place that outlives the app. */
const daemonCommand = async (sp: string): Promise<string[]> => {
  const [runtime, script] = await lastingDaemon({
    runtime: process.execPath, script: daemonScript(), appImage: process.env.APPIMAGE, mount: process.env.APPDIR,
    dir: path.join(app.getPath("userData"), "runtime"), version: app.getVersion(),
  });
  return [runtime, script, sp];
};
// The daemon runs agents' hooks through hive-net when it is named here.
const daemonEnv = (): NodeJS.ProcessEnv => {
  const hiveNet = hiveNetBin();
  return { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...(hiveNet ? { HIVEMIND_HIVE_NET: hiveNet } : {}) };
};
/** The sessions a daemon replacement waits on (agents mid-turn); null when none is waiting. */
let waitingOn: string[] | null = null;
let onWaiting: (ids: string[] | null) => void = () => {};
let cutWait: (() => void) | null = null;
/** Who hears which sessions a daemon replacement waits on, and when it waits no more (null). */
export function setDaemonWaitSink(fn: (ids: string[] | null) => void): void { onWaiting = fn; }
export function daemonWaitingOn(): string[] | null { return waitingOn; }
/** Stop waiting for agents to finish their turns: they are put to sleep now. */
export function restartAgentsNow(): void { cutWait?.(); }

/**
 * A daemon of this app's protocol is kept, whatever build started it: its agents run on through
 * the app's upgrade. One of another protocol is replaced once no agent is mid-turn, each session
 * put to sleep and woken in the new one. Call ONCE at startup; every connection waits for it.
 */
let freshness: Promise<void> | null = null;
export function ensureFreshDaemon(): Promise<void> {
  freshness ??= replaceOtherProtocol();
  return freshness;
}

async function replaceOtherProtocol(): Promise<void> {
  const sp = socketPath();
  const protocol = await daemonProtocol(socketAt(sp));
  if (protocol === null || protocol === DAEMON_PROTOCOL_VERSION) return;
  const show = (ids: string[] | null) => { waitingOn = ids; onWaiting(ids); };
  const retired = await retireDaemon(socketAt(sp), {
    waiting: (ids) => show(ids.length ? ids : null),
    now: new Promise<void>((resolve) => { cutWait = resolve; }),
  }).finally(() => { cutWait = null; show(null); });
  if (!retired.asleep.length) return;
  const s = await reachDaemon(sp, await daemonCommand(sp), { env: daemonEnv() });
  await wakeSessions(s, retired.asleep);
}

/** This computer's daemon, started if it is not running; never keeping quit waiting on it. */
async function doConnect(): Promise<net.Socket> {
  await freshness?.catch(() => undefined);
  const sp = socketPath();
  const s = await reachDaemon(sp, await daemonCommand(sp), { env: daemonEnv() });
  s.unref();
  return s;
}

/** A connection of its own to this computer's daemon, started if it is not running: for another
 *  of the person's devices running terminals in frames here (M3), through hive-net. */
export function connectDaemon(): Promise<net.Socket> {
  return doConnect();
}

let eventSink: ((topic: string, data: unknown) => void) | null = null;
/** Where this computer's daemon's events go: its sessions' statuses, hook reports and screen readings. */
export function setDaemonEventSink(fn: (topic: string, data: unknown) => void): void { eventSink = fn; }
// New sessions start from this app's environment, the person's shell's as last read.
const local = new DaemonEndpoint({ connect: doConnect, onEvent: (topic, data) => eventSink?.(topic, data), env: () => process.env as Record<string, string> });
/** This computer's daemon, for the control plane to serve behind (`ControlPlane.serveBehind`). */
export const daemonEndpoint: Pick<DaemonEndpoint, "control"> = local;

export async function spawnPty(opts: SpawnOpts & { attachOnly?: boolean; liveOnly?: boolean; history?: number }, cb: Callbacks): Promise<{ pid: number; asleep?: true }> {
  const r = await local.spawn({ ...opts, noSpawn: opts.attachOnly, liveOnly: opts.attachOnly && opts.liveOnly, lines: opts.history }, cb);
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
/** End the session's process but keep it, its screen saved, for a wake to bring back. */
export function sleepPty(tileId: string): Promise<void> {
  return local.sleep(tileId);
}
/** What a sleeping session saved as its screen; null when none sleeps as `tileId`. */
export function savedPty(tileId: string, lines?: number): Promise<string | null> {
  return local.saved(tileId, lines);
}
/** Window closed / tile unmounted: stop streaming but KEEP the session alive. */
export function detachPty(tileId: string): void {
  local.detach(tileId);
}
/** App quit: sessions PERSIST in the daemon; only our socket goes, so it can't stall exit. */
export function killAll(): void {
  local.close();
}
