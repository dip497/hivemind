/**
 * Remote interactive PTYs, keyed by tileId with the local pty-host surface so the
 * ptySpawn IPC handler only branches on an ssh:// cwd. A host that has `hive`
 * runs them in its own PTY daemon (they survive ssh drops and app restarts);
 * otherwise they fall back to a local PTY running `ssh -tt`, where detach == kill.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import * as nodePty from "@lydell/node-pty";
import { parseRemote, type RemoteTarget } from "../../shared/remote-uri.js";
import { shq } from "@hivemind/agents/node";
import { remoteConns } from "./conn.js";
import { DaemonEndpoint, type EndpointState } from "../daemon-endpoint.js";
import { acceptRemoteEvent } from "./events.js";
import { ASKPASS_SCRIPT, bridgeRemoteCommand, needsAttention, openBridge, probeCommand, probeRemote, sshCommand, type SshPaths } from "./ssh.js";

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
}

interface Callbacks {
  onData: (data: string) => void;
  onExit: (code: number, signal: number | undefined) => void;
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

export function hostFailure(hostId: string): string | undefined {
  return failure.get(hostId);
}

/** This host's daemon endpoint, or null when it has no daemon-capable `hive` (or cannot be probed right now). */
export function endpointFor(target: RemoteTarget): Promise<DaemonEndpoint | null> {
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
    const ep: DaemonEndpoint = new DaemonEndpoint({
      // Auth is looked up per connect, so a password changed in Machines applies to the next attempt.
      connect: () => openBridge(sshCommand(target, remoteConns.resolveAuthFor(target.hostId), sshPaths(), bridgeRemoteCommand(hivePath))),
      retryInitialMs: 500,
      // The bridge itself may take up to its own 20 s start budget.
      attachTimeoutMs: 30_000,
      isFatal: needsAttention,
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
    failure.set(target.hostId, msg);
    report(target.hostId, needsAttention(msg) ? "attention" : "offline", msg);
    console.warn(`[remote] ${target.hostId}: no remote daemon (${msg}); using an in-app session`);
  });
  return made.catch(() => null);
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

/** Local control-plane credentials never travel to another machine. */
const remoteEnv = (env?: Record<string, string>) => {
  if (!env) return undefined;
  const { HCP_TOKEN: _t, HIVE_HCP_SOCK: _s, ...rest } = env;
  return rest;
};

/** Spawn a remote PTY for an ssh:// cwd. Returns a synthetic negative pid (the
 *  renderer uses pid only as an opaque liveness token). */
export async function spawnRemotePty(opts: SpawnOpts, cb: Callbacks): Promise<{ pid: number }> {
  if (remotePtys.has(opts.tileId)) killRemotePty(opts.tileId);
  const target = parseRemote(opts.cwd);
  const release = hold(target.hostId);
  try {
    return await spawnThroughDaemon(opts, target, cb);
  } finally {
    release();
  }
}

async function spawnThroughDaemon(opts: SpawnOpts, target: RemoteTarget, cb: Callbacks): Promise<{ pid: number }> {
  const ep = process.platform === "win32" ? null : await endpointFor(target);
  if (!ep && opts.attachOnly) return { pid: -1 };
  if (ep) {
    daemonTiles.set(opts.tileId, ep);
    const r = await ep.spawn(
      { tileId: opts.tileId, cwd: target.path, cmd: opts.cmd, args: opts.args ?? [], cols: opts.cols, rows: opts.rows, env: remoteEnv(opts.env), noSpawn: opts.attachOnly },
      { onData: cb.onData, onExit: (code, signal) => { daemonTiles.delete(opts.tileId); cb.onExit(code, signal); } },
    );
    // A session that could not be opened is let go, so nothing streams into a tile that says it failed.
    if (r.pid === -1 && opts.attachOnly) { daemonTiles.delete(opts.tileId); ep.detach(opts.tileId); }
    return { pid: r.pid > 0 ? -r.pid : r.pid };
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

export function writeRemotePty(tileId: string, data: string): void {
  const ep = daemonTiles.get(tileId);
  if (ep) ep.write(tileId, data); else remotePtys.get(tileId)?.write(data);
}
export function resizeRemotePty(tileId: string, cols: number, rows: number): void {
  const ep = daemonTiles.get(tileId);
  if (ep) ep.resize(tileId, cols, rows); else remotePtys.get(tileId)?.resize(cols, rows);
}
export function pauseRemotePty(tileId: string): void {
  const ep = daemonTiles.get(tileId);
  if (ep) ep.pause(tileId); else remotePtys.get(tileId)?.pause();
}
export function resumeRemotePty(tileId: string): void {
  const ep = daemonTiles.get(tileId);
  if (ep) ep.resume(tileId); else remotePtys.get(tileId)?.resume();
}
export function killRemotePty(tileId: string): void {
  const ep = daemonTiles.get(tileId);
  if (ep) { daemonTiles.delete(tileId); ep.kill(tileId); return; }
  const p = remotePtys.get(tileId);
  if (p) { remotePtys.delete(tileId); try { p.kill(); } catch { /* already gone */ } }
}
/** A daemon-backed session keeps running on the remote; an in-app one cannot outlive its channel. */
export function detachRemotePty(tileId: string): void {
  const ep = daemonTiles.get(tileId);
  if (ep) { daemonTiles.delete(tileId); ep.detach(tileId); return; }
  killRemotePty(tileId);
}
export function hasRemotePty(tileId: string): boolean {
  return daemonTiles.has(tileId) || remotePtys.has(tileId);
}
