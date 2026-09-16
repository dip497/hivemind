/**
 * Saved machines for the app: the same catalog as `hive machine` (machines.json), plus each
 * host's live connection state. Frames stay bound by ssh:// uri; a frame finds its machine by
 * host id, so a machine is a name and a status over hosts the app already talks to.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  PUBLISHED_PLATFORMS, installCopyCommand, installFetchCommand, localPlatform, machinesPath, newMachineId,
  releaseAssetUrl, validateLabel, validateTarget, type Machine, type ProbeResult,
} from "@hivemind/core";
import { machineHostId, machineUri, parseRemote, sshTargetOf, type RemoteTarget } from "../../shared/remote-uri.js";
import type { MachineAddRequest, MachineAddResult, MachineInfo, MachineProbe, MachineState, MachineStatus, MachinesSnapshot, SessionSummary } from "../../shared/ipc.js";
import type { SessionInfo } from "../pty-protocol.js";
import { remoteConns } from "./conn.js";
import { Catalog } from "./catalog.js";
import { needsAttention, probeCommand, probeRemote } from "./ssh.js";
import { closeIdle, endpointFor, hostConnected, hostFailure, readyEndpoints, reconnectHost, resetHost, setRemoteStatusSink, sshPaths } from "./pty.js";
import { forgetSavedHost, listSavedHosts, passwordState, saveHost } from "./saved-hosts.js";

const PING_MS = 10_000;
const IDLE_CLOSE_MS = 60_000;
/** Startup probes, a few at a time: a saved machine should read true before anyone opens anything. */
const CHECK_PARALLEL = 4;
const run = promisify(execFile);

const catalog = new Catalog(machinesPath(), () => emit());
const status = new Map<string, MachineStatus>();
let sink: ((s: MachinesSnapshot) => void) | undefined;
let emitTimer: ReturnType<typeof setTimeout> | null = null;
let listSessionsLocal: () => Promise<SessionInfo[]> = async () => [];
let appVersion = "0.0.0";

const info = (m: Machine): MachineInfo => ({ ...m, hostId: machineHostId(m.target) });
const targetOf = (m: Machine): RemoteTarget => parseRemote(machineUri(m.target));

export function snapshot(): MachinesSnapshot {
  return { machines: catalog.list.map(info), status: Object.fromEntries(status), ...(catalog.error ? { catalogError: catalog.error } : {}) };
}

function emit(): void {
  if (emitTimer) return;
  emitTimer = setTimeout(() => { emitTimer = null; sink?.(snapshot()); }, 30);
  emitTimer.unref?.();
}

/** ssh listed `password` among the methods it tried, so a password is what this host wants. */
const offeredPassword = (detail?: string) => /permission denied[^\n]*password/i.test(detail ?? "");

function setStatus(hostId: string, state: MachineState, detail?: string): void {
  const prev = status.get(hostId);
  if (prev?.state === state && prev.detail === detail) return;
  let note = detail;
  let needsPassword = false;
  if (state === "attention" && offeredPassword(detail)) {
    const held = passwordState(hostId);
    // A password is what this host wants either way, so the offer to set one always stands.
    needsPassword = true;
    // A password saved by another install (or with no keychain) cannot be read here; saying
    // "run ssh by hand" would be wrong, since that only ever fixes keys and host keys.
    if (held === "unreadable") note = "the password saved for this machine can't be read by this app";
    // Saved, and the host still said no: it is the password that is wrong, not a missing one.
    else if (held === "ready") note = "the password saved for this machine was refused";
  }
  status.set(hostId, {
    state, ...(note ? { detail: note } : {}), ...(needsPassword ? { needsPassword: true } : {}),
    ...(state === "online" && prev?.rttMs !== undefined ? { rttMs: prev.rttMs } : {}), at: Date.now(),
  });
  emit();
}

function pingAll(): void {
  closeIdle(IDLE_CLOSE_MS);
  for (const [hostId, ep] of readyEndpoints()) {
    if (!ep.connected) continue;
    ep.ping().then((rtt) => {
      // An answer is the ground truth, whatever an earlier probe concluded.
      const s = status.get(hostId);
      if (s?.state === "online" && s.rttMs === rtt) return;
      status.set(hostId, { state: "online", rttMs: rtt, at: s?.state === "online" ? s.at : Date.now() });
      emit();
    }).catch(() => { /* a drop is reported by the endpoint itself */ });
  }
}

const mutate = (fn: (list: Machine[]) => Machine[]) => catalog.mutate(fn);

/** Once per profile: after that, removing a machine (here or with `hive machine`) must stick. */
async function migrateSavedHosts(flag: string): Promise<void> {
  if (fs.existsSync(flag)) return;
  await mutate((list) => {
    const known = new Set(list.map((m) => machineHostId(m.target)));
    const added: Machine[] = [];
    for (const h of listSavedHosts()) {
      if (known.has(h.hostId)) continue;
      try {
        const target = validateTarget(sshTargetOf({ host: h.host, port: h.port, user: h.user || null }));
        added.push({ id: newMachineId(), label: validateLabel(h.host), target, enabled: true });
        known.add(h.hostId);
      } catch { /* a row we cannot express as a target stays a plain saved host */ }
    }
    return added.length ? [...list, ...added] : list;
  });
  fs.writeFileSync(flag, "");
}

export async function initMachines(opts: { send: (s: MachinesSnapshot) => void; listLocalSessions: () => Promise<SessionInfo[]>; version: string; stateDir: string }): Promise<void> {
  sink = opts.send;
  listSessionsLocal = opts.listLocalSessions;
  appVersion = opts.version;
  setRemoteStatusSink(setStatus);
  await catalog.reload();
  if (!catalog.error) await migrateSavedHosts(path.join(opts.stateDir, "machines-migrated")).catch(() => {});
  const file = machinesPath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // `hive machine` edits from a terminal show up without a restart.
    fs.watch(path.dirname(file), (_ev, name) => { if (name === path.basename(file)) void catalog.reload(); }).unref();
  } catch { /* no watch: the app still sees its own edits */ }
  setInterval(pingAll, PING_MS).unref();
  void checkAll();
}

/** Ask every enabled machine where it stands, in the background, without holding up the window. */
async function checkAll(): Promise<void> {
  const due = catalog.list.filter((m) => m.enabled).map((m) => m.id);
  const next = async (): Promise<void> => {
    const id = due.shift();
    if (!id) return;
    await checkMachine(id).catch(() => { /* the status carries the reason */ });
    return next();
  };
  await Promise.all(Array.from({ length: CHECK_PARALLEL }, next));
}

function byId(id: string): Machine {
  const m = catalog.list.find((x) => x.id === id);
  if (!m) throw new Error(`no machine ${id}`);
  return m;
}

/** Errors the add dialog can act on: `[attention]` means run `ssh <target>` once by hand. */
function probeError(target: string, e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e);
  return new Error(needsAttention(msg) ? `[attention] ${msg}` : `[offline] ${target}: ${msg}`);
}

async function probe(t: RemoteTarget): Promise<ProbeResult> {
  return probeRemote(probeCommand(t, remoteConns.resolveAuthFor(t.hostId), sshPaths()));
}

function isNativeBinary(file: string): boolean {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size < 10 * 1024 * 1024) return false;
    const head = Buffer.alloc(4);
    const fd = fs.openSync(file, "r");
    try { fs.readSync(fd, head, 0, 4, 0); } finally { fs.closeSync(fd); }
    return head.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) || head.readUInt32LE(0) === 0xfeedfacf;
  } catch {
    return false;
  }
}

/** A compiled `hive` here of this app's version (so an update never downgrades) that runs the daemon; copying needs no network. */
async function localHiveBinary(): Promise<string | null> {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const cands = [process.env.HIVE_BIN, ...dirs.map((d) => path.join(d, "hive")), path.join(os.homedir(), ".local/bin/hive"), path.join(os.homedir(), ".hivemind-app/hive")];
  for (const c of new Set(cands)) {
    if (!c) continue;
    let real: string;
    try { real = fs.realpathSync(c); } catch { continue; }
    if (!isNativeBinary(real)) continue;
    try {
      // One picked by hand (HIVE_BIN) is taken as asked; one merely found on PATH must match this app.
      if (c !== process.env.HIVE_BIN && (await run(real, ["--version"], { timeout: 10_000 })).stdout.trim() !== appVersion) continue;
      const help = await run(real, ["daemon", "--help"], { timeout: 10_000 });
      if (`${help.stdout}${help.stderr}`.includes("bridge")) return real;
    } catch { /* not a working hive */ }
  }
  return null;
}

async function installHive(t: RemoteTarget, platform: string): Promise<void> {
  const bin = localPlatform() === platform ? await localHiveBinary() : null;
  if (!bin && !PUBLISHED_PLATFORMS.includes(platform)) throw new Error(`no hive release is published for ${platform} — install it there from source`);
  const url = releaseAssetUrl(platform, appVersion);
  const body = bin ? fs.readFileSync(bin) : undefined;
  console.log(`[machines] installing hive on ${t.hostId} from ${bin ?? url}`);
  const r = await remoteConns.exec(t, body ? installCopyCommand(body.length) : installFetchCommand(url), { input: body, timeoutMs: 300_000 });
  if (r.code === 0) return;
  const why = r.stderr.trim() || `exit ${r.code}`;
  if (body) throw new Error(`copying hive failed: ${why}`);
  // curl 22 on a release URL: that version was never published for this platform (a build from source).
  if (/\b22\b|404/.test(why)) throw new Error(`no published hive ${appVersion} for ${platform} — install it there by hand, or run a released build of this app`);
  throw new Error(`downloading ${url} failed: ${why}`);
}

function toProbe(p: ProbeResult): MachineProbe {
  return { platform: p.platform, ...(p.hivePath ? { hivePath: p.hivePath } : {}), ...(p.hiveVersion ? { hiveVersion: p.hiveVersion } : {}), ...(p.daemon ? { daemon: true } : {}) };
}

const clashWith = (list: Machine[], target: string, hostId: string) => {
  const clash = list.find((m) => m.target === target || machineHostId(m.target) === hostId);
  if (clash) throw new Error(`${target} is already saved as '${clash.label}'`);
};

export async function addMachine(req: MachineAddRequest): Promise<MachineAddResult> {
  const target = validateTarget(req.target);
  const t = parseRemote(machineUri(target));
  clashWith(catalog.list, target, t.hostId);
  const label = validateLabel(req.label?.trim() || t.host);
  if (req.password) remoteConns.setAuth(t.hostId, { ...remoteConns.resolveAuthFor(t.hostId), password: req.password });
  let found: ProbeResult;
  try {
    found = await probe(t);
  } catch (e) {
    if (req.password) remoteConns.clearAuth(t.hostId);
    throw probeError(target, e);
  }
  let installed = false;
  if ((!found.hivePath || !found.daemon) && req.install) {
    await installHive(t, found.platform);
    installed = true;
    found = await probe(t);
    if (!found.daemon) throw new Error(`installed hive ${found.hiveVersion ?? ""} on ${target}, but it cannot run terminal sessions yet (needs a newer release)`);
  }
  const passwordSaved = req.password ? saveHost(t.host, t.port, t.user ?? "", { password: req.password }) : true;
  const m: Machine = { id: newMachineId(), label, target, enabled: true, platform: found.platform, ...(found.hivePath ? { hivePath: found.hivePath } : {}) };
  await mutate((list) => { clashWith(list, target, t.hostId); return [...list, m]; });
  resetHost(t.hostId);
  setStatus(t.hostId, found.daemon ? "online" : "no-hive");
  return { machine: info(m), probe: toProbe(found), installed, ...(passwordSaved ? {} : { passwordSaved: false }) };
}

export async function checkMachine(id: string): Promise<MachineProbe> {
  const m = byId(id);
  const t = targetOf(m);
  // A live connection is better evidence than a probe: a check never overrides it.
  const live = () => hostConnected(t.hostId);
  if (!live()) setStatus(t.hostId, "connecting");
  let found: ProbeResult;
  try {
    found = await probe(t);
  } catch (e) {
    const err = probeError(m.target, e);
    if (!live()) setStatus(t.hostId, err.message.startsWith("[attention]") ? "attention" : "offline", err.message.replace(/^\[\w+\] /, ""));
    throw err;
  }
  await mutate((list) => {
    const m0 = list.find((x) => x.id === id);
    if (!m0 || (m0.hivePath === found.hivePath && m0.platform === found.platform)) return list;
    return list.map((x) => {
      if (x.id !== id) return x;
      const { hivePath: _old, ...rest } = x;
      return { ...rest, platform: found.platform, ...(found.hivePath ? { hivePath: found.hivePath } : {}) };
    });
  }).then(() => {}, () => { /* an unreadable catalog: the check still reports */ });
  if (!live()) setStatus(t.hostId, found.daemon ? "online" : "no-hive");
  if (found.daemon) resetHost(t.hostId);
  return toProbe(found);
}

export async function installOnMachine(id: string): Promise<MachineProbe> {
  const m = byId(id);
  const t = targetOf(m);
  const before = await probe(t).catch((e: unknown) => { throw probeError(m.target, e); });
  await installHive(t, before.platform);
  return checkMachine(id);
}

export async function updateMachine(id: string, patch: { label?: string; enabled?: boolean }): Promise<void> {
  byId(id);
  const label = patch.label === undefined ? undefined : validateLabel(patch.label);
  await mutate((list) => list.map((m) => (m.id === id ? { ...m, ...(label !== undefined ? { label } : {}), ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}) } : m)));
}

export async function removeMachine(id: string): Promise<void> {
  const m = byId(id);
  const hostId = machineHostId(m.target);
  await mutate((list) => list.filter((x) => x.id !== id));
  forgetSavedHost(hostId);
  remoteConns.clearAuth(hostId);
  resetHost(hostId);
  if (!hostConnected(hostId)) { status.delete(hostId); emit(); }
}

const MAX_SESSIONS = 500;
const clamp = (v: string) => (typeof v === "string" ? v.slice(0, 512) : "");
/** The far side picks these values; keep them to a size the list can show. */
const summary = ({ pid: _pid, ...s }: SessionInfo): SessionSummary => ({
  ...s, id: clamp(s.id), cmd: clamp(s.cmd), cwd: clamp(s.cwd),
  args: (s.args ?? []).slice(0, 64).map(clamp), ...(s.title ? { title: clamp(s.title) } : {}),
});

export async function machineSessions(uri: string | null): Promise<SessionSummary[]> {
  if (!uri) return (await listSessionsLocal()).slice(0, MAX_SESSIONS).map(summary);
  const t = parseRemote(uri);
  const ep = await endpointFor(t);
  if (!ep) throw new Error(hostFailure(t.hostId) ?? "hive is not installed there (or is too old) — install it from Machines");
  return (await ep.sessions()).slice(0, MAX_SESSIONS).map(summary);
}

/** A new password for a saved machine (it changed there, or the keychain lost the old one). */
export function setMachinePassword(id: string, password: string): boolean {
  const m = byId(id);
  const t = targetOf(m);
  remoteConns.setAuth(t.hostId, { ...remoteConns.resolveAuthFor(t.hostId), password });
  // Wakes a connection parked on the old password, and re-probes when there is none.
  reconnectHost(t.hostId);
  return saveHost(t.host, t.port, t.user ?? "", { password });
}

export function reconnectMachineHost(hostId: string): void {
  reconnectHost(hostId);
}
