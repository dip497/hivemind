/**
 * Remote interactive PTYs, keyed by tileId with the local daemon client's surface so the
 * ptySpawn IPC handler only branches on an ssh:// cwd. A host that has `hive`
 * runs them in its own PTY daemon (they survive ssh drops and app restarts);
 * otherwise they fall back to a local PTY running `ssh -tt`, where detach == kill.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import * as nodePty from "@lydell/node-pty";
import { parseRemote, type RemoteTarget } from "@hivemind/core/remote-uri";
import { pasteText } from "@hivemind/agent-host/paste";
import { shq, withoutControl } from "@hivemind/agents/node";
import { remoteConns } from "@hivemind/host/remote/conn";
import { DaemonEndpoint, type EndpointState } from "@hivemind/agent-host/daemon-endpoint";
import { DAEMON_PROTOCOL_VERSION } from "@hivemind/agent-host/pty-protocol";
import { daemonProtocol, retireDaemon, wakeSessions } from "@hivemind/agent-host/daemon-replace";
import { acceptRemoteEvent } from "./events.js";
import { ASKPASS_SCRIPT, bridgeRemoteCommand, needsAttention, openBridge, probeCommand, probeRemote, sshCommand, type SshPaths } from "@hivemind/host/remote/ssh";

interface SpawnOpts {
  tileId: string;
  /** ssh:// uri whose path is the remote cwd. */
  cwd: string;
  cmd: string;
  args?: string[];
  cols: number;
  rows: number;
  env?: Record<string, string>;
  /** Initial task delivered as claude's positional argv (HIVE_INITIAL_PROMPT); consumed by the ptySpawn handler into env. */
  initialPrompt?: string;
  /** Show an existing session (`tileId` is its id); never start one. */
  attachOnly?: boolean;
  /** At most this many lines of scrollback in the replay of a running session. */
  history?: number;
  /** Restore a session put to sleep (its daemon's). */
  wake?: boolean;
}

interface Callbacks {
  onData: (data: string, replay?: boolean) => void;
  /** `slept`: it was put to sleep, not ended. */
  onExit: (code: number, signal: number | undefined, slept?: boolean) => void;
}

const remotePtys = new Map<string, nodePty.IPty>();
let remotePidSeq = 0;

// ── remote daemon route ─────────────────────────────────────────────────────

const daemonTiles = new Map<string, DaemonEndpoint>();
const endpoints = new Map<string, Promise<DaemonEndpoint | null>>();
const NO_HIVE_RECHECK_MS = 60_000;

let pathsCache: SshPaths | undefined;
export function sshPaths(): SshPaths {
  if (pathsCache) return pathsCache;
  const dir = app.getPath("userData");
  const askpass = path.join(dir, "hive-askpass");
  fs.writeFileSync(askpass, ASKPASS_SCRIPT, { mode: 0o700 });
  fs.chmodSync(askpass, 0o700);
  // ssh binds `<dir>/<40-char %C>.<16-char temp>`, which must fit a unix socket path (104 on macOS).
  const base = process.env.XDG_RUNTIME_DIR || "/tmp";
  const controlDir = path.join(base, `hivemind-ssh-${os.userInfo().uid}`);
  let usable = controlDir.length + 58 < 104;
  if (usable) {
    try {
      fs.mkdirSync(controlDir, { recursive: true, mode: 0o700 });
      // On a shared box someone may have put a symlink (or their own directory) there first.
      const st = fs.lstatSync(controlDir);
      if (!st.isDirectory() || st.uid !== process.getuid?.()) throw new Error("not our directory");
      fs.chmodSync(controlDir, 0o700);
    } catch { usable = false; }
  }
  return (pathsCache = { knownHosts: path.join(dir, "known_hosts"), askpass, ...(usable ? { controlDir } : {}) });
}
remoteConns.setSshPaths(sshPaths);

/** What a host's connection is doing, as the machine UI shows it. */
export type HostState = EndpointState | "offline" | "attention" | "no-hive";

let statusSink: ((hostId: string, state: HostState, detail?: string) => void) | undefined;
export function setRemoteStatusSink(fn: (hostId: string, state: HostState, detail?: string) => void): void {
  statusSink = fn;
}
const report = (hostId: string, state: HostState, detail?: string) => statusSink?.(hostId, state, detail);

const ready = new Map<string, DaemonEndpoint>();
/** Why this host has no daemon connection: ssh's own words beat a guess about `hive`. */
const failure = new Map<string, string>();

const paused = new Set<string>();
/** Turn a machine off (drop its connection; its terminals keep running there) or back on. */
export function setHostPaused(hostId: string, on: boolean): void {
  if (on === paused.has(hostId)) return;
  if (on) { paused.add(hostId); ready.get(hostId)?.disconnect(); report(hostId, "idle"); return; }
  paused.delete(hostId);
  ready.get(hostId)?.reconnectNow();
}

export function hostFailure(hostId: string): string | undefined {
  return failure.get(hostId);
}

/** This host's daemon endpoint, or null when it has no daemon-capable `hive` (or cannot be probed right now). */
export function endpointFor(target: RemoteTarget): Promise<DaemonEndpoint | null> {
  if (paused.has(target.hostId)) return Promise.reject(new Error("this machine is turned off"));
  const cached = endpoints.get(target.hostId);
  if (cached) return cached;
  report(target.hostId, "connecting");
  const made = (async () => {
    const auth = remoteConns.resolveAuthFor(target.hostId);
    const paths = sshPaths();
    const found = await probeRemote(probeCommand(target, auth, paths));
    if (!found.hivePath || !found.daemon) {
      failure.set(target.hostId, found.hivePath ? `hive ${found.hiveVersion ?? ""} there is too old for terminal sessions` : "hive is not installed there");
      report(target.hostId, "no-hive", found.hivePath ? `hive ${found.hiveVersion ?? ""} there is too old` : undefined);
      setTimeout(() => { if (endpoints.get(target.hostId) === made) endpoints.delete(target.hostId); }, NO_HIVE_RECHECK_MS).unref?.();
      return null;
    }
    const hivePath = found.hivePath;
    // Auth is looked up per connect, so a password changed in Machines applies to the next attempt.
    const bridge = () => openBridge(sshCommand(target, remoteConns.resolveAuthFor(target.hostId), sshPaths(), bridgeRemoteCommand(hivePath)));
    await replaceOtherProtocol(target, hivePath, bridge);
    const ep: DaemonEndpoint = new DaemonEndpoint({
      connect: bridge,
      retryInitialMs: 500,
      isFatal: needsAttention,
      isPaused: () => paused.has(target.hostId),
      onEvent: (topic, data) => remoteEvent(ep, topic, data),
      onStatus: (state, detail) => report(target.hostId, state === "reconnecting" && detail && needsAttention(detail) ? "attention" : state, detail),
    });
    ready.set(target.hostId, ep);
    failure.delete(target.hostId);
    return ep;
  })();
  endpoints.set(target.hostId, made);
  // A failed probe (offline, auth) is not cached: the next spawn tries again.
  made.catch((e: unknown) => {
    if (endpoints.get(target.hostId) === made) endpoints.delete(target.hostId);
    const msg = e instanceof Error ? e.message : String(e);
    const attention = msg.startsWith("[attention] ") || needsAttention(msg);
    failure.set(target.hostId, msg.replace(/^\[attention\] /, ""));
    report(target.hostId, attention ? "attention" : "offline", msg.replace(/^\[attention\] /, ""));
    console.warn(`[remote] ${target.hostId}: no remote daemon (${msg}); using an in-app session`);
  });
  return made.catch(() => null);
}

/** The daemon there kept when it speaks this app's protocol, as on this computer; else, when the
 *  `hive` there speaks it, replaced once no agent is mid-turn, each session woken in the new one. */
async function replaceOtherProtocol(target: RemoteTarget, hivePath: string, bridge: () => Promise<import("node:stream").Duplex>): Promise<void> {
  const protocol = await daemonProtocol(bridge, 30_000);
  if (protocol === null || protocol === DAEMON_PROTOCOL_VERSION) return;
  const r = await remoteConns.exec(target, `${shq(hivePath)} daemon status --json`, { timeoutMs: 30_000 });
  let speaks: unknown;
  try { speaks = (JSON.parse(String(r.stdout)) as { data?: { speaks?: unknown } }).data?.speaks; } catch { /* an older hive */ }
  if (speaks !== DAEMON_PROTOCOL_VERSION) throw new Error(`[attention] the hive on this machine is older than this app: update it there (hivemind upgrade)`);
  const retired = await retireDaemon(bridge, {
    waiting: (ids) => report(target.hostId, "connecting", ids.length ? `updating its terminals once ${ids.length === 1 ? "an agent finishes its turn" : `${ids.length} agents finish their turns`}` : undefined),
    now: new Promise(() => {}),
  });
  if (retired.asleep.length) await wakeSessions(await bridge(), retired.asleep);
}

/** Connected daemon endpoints by host, for the machine UI's round-trip pings. */
export function readyEndpoints(): ReadonlyMap<string, DaemonEndpoint> {
  return ready;
}

/** Forget what we learned about a host (hive installed or updated, machine removed); a connection still serving tiles stays. */
export function resetHost(hostId: string): void {
  const p = endpoints.get(hostId);
  if (!p) return;
  void p.then((ep) => {
    // Still in use: the connection stays, but a parked one (a login that failed) is woken with the new auth.
    if (ep && (ep.tiles > 0 || busy.has(hostId))) { ep.reconnectNow(); return; }
    ep?.close();
    if (endpoints.get(hostId) === p) endpoints.delete(hostId);
    ready.delete(hostId);
    idleSince.delete(hostId);
    report(hostId, "idle");
  }).catch(() => {});
}

/** Terminals are running on this host through our connection (or one is being opened). */
export async function hostServingTiles(hostId: string): Promise<boolean> {
  const ep = await (endpoints.get(hostId) ?? Promise.resolve(null)).catch(() => null);
  return !!ep && (ep.tiles > 0 || busy.has(hostId));
}

export function hostConnected(hostId: string): boolean {
  return !!ready.get(hostId)?.connected;
}

/** Retry now: wake a connection that has tiles waiting, otherwise start over and probe the host again. */
export function reconnectHost(hostId: string): void {
  const ep = ready.get(hostId);
  if (ep && ep.tiles > 0) { ep.reconnectNow(); return; }
  // Drop even an attempt still in flight: it carries the auth we are replacing, and its failure
  // would otherwise be the answer to this retry.
  void endpoints.get(hostId)?.then((old) => old?.close()).catch(() => {});
  endpoints.delete(hostId);
  ready.delete(hostId);
  idleSince.delete(hostId);
  void endpointFor(parseRemote(`ssh://${hostId}/`)).catch(() => {});
}

/** Hosts with a spawn in flight: `tiles` is still 0 until the attach lands, and the reaper must not race it. */
const busy = new Map<string, number>();
function hold(hostId: string): () => void {
  busy.set(hostId, (busy.get(hostId) ?? 0) + 1);
  return () => { const n = (busy.get(hostId) ?? 1) - 1; if (n > 0) busy.set(hostId, n); else busy.delete(hostId); };
}

const idleSince = new Map<string, number>();
/** Close connections that served no tile for `ms` (a session list, a finished tile); the next use reconnects. */
export function closeIdle(ms: number): void {
  const now = Date.now();
  for (const [hostId, ep] of ready) {
    if (ep.tiles > 0 || busy.has(hostId)) { idleSince.delete(hostId); continue; }
    const since = idleSince.get(hostId) ?? now;
    idleSince.set(hostId, since);
    if (now - since >= ms) { idleSince.delete(hostId); resetHost(hostId); }
  }
}

let eventSink: ((topic: string, data: unknown) => void) | undefined;
/** Where remote agents' hook events go (the local HCP event handler). */
export function setRemoteEventSink(fn: (topic: string, data: unknown) => void): void {
  eventSink = fn;
}

function remoteEvent(ep: DaemonEndpoint, topic: string, data: unknown): void {
  const ok = acceptRemoteEvent(data, (tileId) => daemonTiles.get(tileId) === ep);
  if (ok) eventSink?.(topic, ok);
}


/** Spawn a remote PTY at `target` (its cwd, on the host it names). Returns a synthetic negative
 *  pid (the renderer uses pid only as an opaque liveness token). */
export async function spawnRemotePty(opts: SpawnOpts, target: RemoteTarget, cb: Callbacks): Promise<{ pid: number; asleep?: true }> {
  if (remotePtys.has(opts.tileId)) killRemotePty(opts.tileId);
  const release = hold(target.hostId);
  try {
    return await spawnThroughDaemon(opts, target, cb);
  } finally {
    release();
  }
}

async function spawnThroughDaemon(opts: SpawnOpts, target: RemoteTarget, cb: Callbacks): Promise<{ pid: number; asleep?: true }> {
  const ep = process.platform === "win32" ? null : await endpointFor(target);
  if (!ep && opts.attachOnly) return { pid: -1 };
  // Only its daemon kept it: plain ssh would start the agent afresh, its conversation left there.
  if (!ep && opts.wake) throw new Error("this machine has no hive daemon: what slept there cannot be woken");
  if (ep) {
    daemonTiles.set(opts.tileId, ep);
    const r = await ep.spawn(
      { tileId: opts.tileId, cwd: target.path, cmd: opts.cmd, args: opts.args ?? [], cols: opts.cols, rows: opts.rows, env: withoutControl(opts.env), noSpawn: opts.attachOnly, lines: opts.history, wake: opts.wake },
      { onData: cb.onData, onExit: (code, signal, slept) => { daemonTiles.delete(opts.tileId); cb.onExit(code, signal, slept); } },
    );
    // A session that could not be opened is let go, so nothing streams into a tile that says it failed.
    if (r.pid === -1 && (opts.attachOnly || r.asleep)) { daemonTiles.delete(opts.tileId); ep.detach(opts.tileId); }
    return { pid: r.pid > 0 ? -r.pid : r.pid, ...(r.asleep ? { asleep: true as const } : {}) };
  }
  // The local PTY is ssh's terminal, so a resize reaches the remote as a window change.
  const inner = `cd ${shq(target.path)} && exec ${[opts.cmd, ...(opts.args ?? [])].map(shq).join(" ")}`;
  const c = sshCommand(target, remoteConns.resolveAuthFor(target.hostId), sshPaths(), `bash -lc ${shq(inner)}`, { tty: true });
  const p = nodePty.spawn("ssh", c.args, { name: "xterm-256color", cols: opts.cols, rows: opts.rows, env: { ...(process.env as Record<string, string>), ...c.env } });
  p.onData(cb.onData);
  p.onExit(({ exitCode, signal }) => {
    if (remotePtys.get(opts.tileId) === p) remotePtys.delete(opts.tileId);
    cb.onExit(exitCode, signal);
  });
  remotePtys.set(opts.tileId, p);
  return { pid: -(++remotePidSeq) };
}

export function writeRemotePty(tileId: string, data: string, paste?: boolean): void {
  const ep = daemonTiles.get(tileId);
  if (ep) ep.write(tileId, data, paste); else remotePtys.get(tileId)?.write(paste ? pasteText(data, false) : data);
}
export function resizeRemotePty(tileId: string, cols: number, rows: number): void {
  const ep = daemonTiles.get(tileId);
  if (ep) ep.resize(tileId, cols, rows); else remotePtys.get(tileId)?.resize(cols, rows);
}
/** Only a daemon keeps a copy of its screen to show, so only a session under one repaints. */
export function repaintRemotePty(tileId: string): void {
  daemonTiles.get(tileId)?.repaint(tileId);
}
/** Whether a remote session runs under a daemon, which keeps its screen. */
export function remoteKeepsScreen(tileId: string): boolean { return daemonTiles.has(tileId); }
/** Ask a daemon-backed remote session for its screen now; false for one with no screen kept. */
export function screenRemotePty(tileId: string, cb: (replay: string | null) => void, lines?: number): boolean {
  const ep = daemonTiles.get(tileId);
  if (!ep) return false;
  ep.screen(tileId, cb, lines);
  return true;
}
/** A daemon-backed remote session's screen as text, line by line; null for one with no screen kept. */
export function viewportRemotePty(tileId: string): Promise<string | null> {
  return daemonTiles.get(tileId)?.viewport(tileId) ?? Promise.resolve(null);
}
export function pauseRemotePty(tileId: string): void {
  const ep = daemonTiles.get(tileId);
  if (ep) ep.pause(tileId); else remotePtys.get(tileId)?.pause();
}
export function resumeRemotePty(tileId: string): void {
  const ep = daemonTiles.get(tileId);
  if (ep) ep.resume(tileId); else remotePtys.get(tileId)?.resume();
}
/** `target`: where a session nothing here is attached to (one asleep) is kept. */
export function killRemotePty(tileId: string, target?: RemoteTarget): void {
  const ep = daemonTiles.get(tileId);
  if (ep) { daemonTiles.delete(tileId); ep.kill(tileId); return; }
  const p = remotePtys.get(tileId);
  if (p) { remotePtys.delete(tileId); try { p.kill(); } catch { /* already gone */ } return; }
  if (target) void onDaemon(target, async (d) => d.kill(tileId)).catch(() => { /* unreachable: its snapshot ages out there */ });
}
/** Put a session on `target` to sleep: only its daemon can keep one. */
export function sleepRemotePty(tileId: string, target: RemoteTarget): Promise<void> {
  if (remotePtys.has(tileId)) return Promise.reject(new Error("this machine has no hive daemon: a session over plain ssh cannot sleep"));
  return onDaemon(target, (d) => d.sleep(tileId));
}
/** What a session asleep on `target` saved as its screen; null when none sleeps there. */
export function savedRemotePty(tileId: string, target: RemoteTarget, lines?: number): Promise<string | null> {
  return onDaemon(target, (d) => d.saved(tileId, lines)).catch(() => null);
}
/** `use` the daemon on `target`, held open while it does. */
async function onDaemon<T>(target: RemoteTarget, use: (d: DaemonEndpoint) => Promise<T>): Promise<T> {
  const release = hold(target.hostId);
  try {
    const ep = process.platform === "win32" ? null : await endpointFor(target);
    if (!ep) throw new Error("this machine has no hive daemon: a session over plain ssh cannot sleep");
    return await use(ep);
  } finally {
    release();
  }
}
/** A daemon-backed session keeps running on the remote; an in-app one cannot outlive its channel. */
export function detachRemotePty(tileId: string): void {
  const ep = daemonTiles.get(tileId);
  if (ep) { daemonTiles.delete(tileId); ep.detach(tileId); return; }
  killRemotePty(tileId);
}
/** Sessions on other machines that go on running there when this app quits. */
export function sessionsKeptElsewhere(): string[] {
  return [...daemonTiles.keys()];
}
export function hasRemotePty(tileId: string): boolean {
  return daemonTiles.has(tileId) || remotePtys.has(tileId);
}
