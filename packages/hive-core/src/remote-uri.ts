/**
 * Where a folder is when it is not on this computer, as one path string.
 *
 * The entire IPC surface is keyed by a single path string (repoPath / cwd).
 * Rather than thread a separate "host" field through every channel and every
 * tile's data, a REMOTE folder is encoded into that one string. It flows through
 * canvas-node-build → tile data unchanged; each backend helper branches once on
 * isRemote(). Two forms:
 *
 * - `machine://<machineId>/abs/posix/path` (R9): on a saved machine, by its id. What the
 *   machine is and how it is reached is its record's, so editing its address or login never
 *   touches the frames on it. A machine id of 64 hex digits is a device's (M3): one of the
 *   person's own devices, reached over hive-net by its key, not over ssh.
 * - `ssh://[user@]host[:port]/abs/posix/path`: on a host no saved machine names — one removed,
 *   or a workspace from before R9 whose machine is not known here — reached over ssh as written.
 *
 * This module is the pure parse/format core, shared by main (transport routing) and the
 * renderer (display + frame binding). No deps.
 */

export interface RemoteTarget {
  /** Hostname or IP. */
  host: string;
  /** TCP port (default 22). */
  port: number;
  /** SSH username, or null when unspecified (resolve from ssh agent/config). */
  user: string | null;
  /** Absolute POSIX path on the remote. */
  path: string;
  /** Connection-pool key: `user@host:port` (user omitted when null). */
  hostId: string;
}

export const REMOTE_SCHEME = "ssh://";
export const MACHINE_SCHEME = "machine://";

/** True when a path string denotes a folder on another computer (machine:// or ssh://). */
export function isRemote(p: string | null | undefined): p is string {
  return typeof p === "string" && (p.startsWith(MACHINE_SCHEME) || p.startsWith(REMOTE_SCHEME));
}

/** `machine://<machineId>/path`'s machine and path (a missing path is "/"); null for any other uri. */
export function parseMachineUri(uri: string): { machineId: string; path: string } | null {
  if (!uri.startsWith(MACHINE_SCHEME)) return null;
  const rest = uri.slice(MACHINE_SCHEME.length);
  const slash = rest.indexOf("/");
  const machineId = slash === -1 ? rest : rest.slice(0, slash);
  return machineId ? { machineId, path: slash === -1 ? "/" : rest.slice(slash) } : null;
}

/** A device's id: its public key in lowercase hex. A saved machine's id is never one. */
const DEVICE_ID = /^[0-9a-f]{64}$/;

/** A folder on one of the person's own devices (M3): `machine://<device id>/path`'s device and
 *  path; null for any other uri, a saved machine's included. */
export function parseDeviceUri(uri: string): { device: string; path: string } | null {
  const m = parseMachineUri(uri);
  return m && DEVICE_ID.test(m.machineId) ? { device: m.machineId, path: m.path } : null;
}

/** What a frame's machine is called when it is a saved machine no longer saved, or a device no
 *  longer paired: in a window, and on the person's phone (spec/needs.md 0.3). */
export const GONE_MACHINE = "a machine no longer saved";
export const A_DEVICE = "a device not paired here";
/** What a participant's computer is called (M4), by their name: "" when it is not known. */
export const computerOf = (name: string): string => (name ? `${name}'s computer` : "someone's computer");

/** The machines a device knows, by what each is called. */
export interface KnownMachines {
  /** This device: its id, and what it is called. */
  self(): { device: string; name: string };
  /** What one of the person's other devices is called; undefined for one that is none of theirs. */
  mine(device: string): string | undefined;
  /** Whose computer a participant's device is (M4): their name, "" when they gave none; undefined
   *  for one that is no participant's. */
  whose(device: string): string | undefined;
  /** What a saved machine is called; undefined for one no longer saved. */
  saved(id: string): string | undefined;
}

/** What the machine the folder `folder` is on is called, as `known` has it: this device's own name
 *  for a folder here, else what it knows that machine by (spec/needs.md 0.3). */
export function machineCalled(folder: string, known: KnownMachines): string {
  if (!isRemote(folder)) return known.self().name;
  const device = parseDeviceUri(folder)?.device;
  if (device) {
    if (device === known.self().device) return known.self().name;
    const whose = known.whose(device);
    return known.mine(device) ?? (whose === undefined ? A_DEVICE : computerOf(whose));
  }
  const saved = parseMachineUri(folder);
  if (saved) return known.saved(saved.machineId) ?? GONE_MACHINE;
  try { return parseRemote(folder).host; } catch { return GONE_MACHINE; }
}

/** `path` on the saved machine `machineId`. */
export function machineUri(machineId: string, path = "/"): string {
  return `${MACHINE_SCHEME}${machineId}${path.startsWith("/") ? path : `/${path}`}`;
}

/** The path a remote uri names on its machine or host. */
export function remotePath(uri: string): string {
  return parseMachineUri(uri)?.path ?? parseRemote(uri).path;
}

/** Build the pool key for a host triple. */
export function hostIdOf(user: string | null, host: string, port: number): string {
  const u = user ? `${user}@` : "";
  return `${u}${host}:${port}`;
}

/**
 * Parse `ssh://[user@]host[:port]/path`. Throws on a non-ssh or malformed URI.
 * The path is everything after the authority — kept verbatim (absolute POSIX);
 * a missing path defaults to "/".
 */
export function parseRemote(uri: string): RemoteTarget {
  if (!uri.startsWith(REMOTE_SCHEME)) throw new Error(`not an ssh uri: ${uri}`);
  const rest = uri.slice(REMOTE_SCHEME.length);
  // authority is up to the FIRST slash; the rest (incl. that slash) is the path.
  const slash = rest.indexOf("/");
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? "/" : rest.slice(slash);
  if (!authority) throw new Error(`remote uri missing host: ${uri}`);

  let user: string | null = null;
  let hostPort = authority;
  const at = authority.lastIndexOf("@");
  if (at !== -1) {
    user = authority.slice(0, at) || null;
    hostPort = authority.slice(at + 1);
  }
  let host = hostPort;
  let port = 22;
  const colon = hostPort.lastIndexOf(":");
  if (colon !== -1) {
    const maybePort = hostPort.slice(colon + 1);
    if (/^\d+$/.test(maybePort)) {
      host = hostPort.slice(0, colon);
      port = Number(maybePort);
    }
  }
  if (!host) throw new Error(`remote uri missing host: ${uri}`);
  return { host, port, user, path, hostId: hostIdOf(user, host, port) };
}

/** Format a remote target back into an `ssh://` URI. */
export function formatRemote(t: {
  host: string;
  port?: number;
  user?: string | null;
  path: string;
}): string {
  const user = t.user ? `${t.user}@` : "";
  const port = t.port && t.port !== 22 ? `:${t.port}` : "";
  const path = t.path.startsWith("/") ? t.path : `/${t.path}`;
  return `${REMOTE_SCHEME}${user}${t.host}${port}${path}`;
}

/** A saved machine's ssh target (`alias`, `user@host`, `ssh://user@host:port`) as an ssh uri at `path`. */
export function sshUri(target: string, path = "/"): string {
  const authority = target.startsWith(REMOTE_SCHEME) ? target.slice(REMOTE_SCHEME.length).replace(/\/.*$/, "") : target;
  return `${REMOTE_SCHEME}${authority}${path.startsWith("/") ? path : `/${path}`}`;
}

/** The ssh target for a host, round-tripping through `machineHostId` to the same host id. */
export function sshTargetOf(t: { host: string; port: number; user: string | null }): string {
  const u = t.user ? `${t.user}@` : "";
  return t.port !== 22 ? `${REMOTE_SCHEME}${u}${t.host}:${t.port}` : `${u}${t.host}`;
}

/** The connection key of a machine's address: every connection to it is kept by this. */
export function machineHostId(target: string): string {
  return parseRemote(sshUri(target)).hostId;
}

/** Join a remote uri's host authority with a new absolute path (for navigation). */
export function withRemotePath(uri: string, newPath: string): string {
  const t = parseRemote(uri);
  return formatRemote({ host: t.host, port: t.port, user: t.user, path: newPath });
}

/** Short human label: `user@host:/path` for an ssh uri, `<name>:/path` given its machine's name. */
export function remoteDisplay(uri: string, machineName?: string): string {
  const m = parseMachineUri(uri);
  if (m) return `${machineName ?? m.machineId}:${m.path}`;
  const t = parseRemote(uri);
  const u = t.user ? `${t.user}@` : "";
  return `${u}${t.host}:${t.path}`;
}

/** The basename of a remote uri's path — for a frame title. */
export function remoteBasename(uri: string): string {
  const path = remotePath(uri);
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? trimmed || "/" : trimmed.slice(idx + 1) || "/";
}

/** POSIX path join for remote paths (the client may be Windows — never use path.join). */
export function posixJoin(a: string, b: string): string {
  if (b === "..") {
    const t = a.replace(/\/+$/, "");
    const i = t.lastIndexOf("/");
    return i <= 0 ? "/" : t.slice(0, i);
  }
  if (b.startsWith("/")) return b;
  return a.endsWith("/") ? a + b : `${a}/${b}`;
}

/** A saved machine, as a frame's binding knows it. */
export interface BindableMachine { id: string; target: string; hostId: string }

/** `uri` bound to the saved machine at its address, when it is an ssh uri one of `machines` is at
 *  (a workspace from before R9, or a host saved as a machine since); else as it was. */
export function bindToMachine<T extends string | null | undefined>(uri: T, machines: readonly BindableMachine[]): T | string {
  if (typeof uri !== "string" || !uri.startsWith(REMOTE_SCHEME)) return uri;
  let t: RemoteTarget;
  try { t = parseRemote(uri); } catch { return uri; }
  const m = machines.find((x) => x.hostId === t.hostId);
  return m ? machineUri(m.id, t.path) : uri;
}

/** `uri` on `machine`, which is no longer saved, back at its address: it still runs there. */
export function unbindFromMachine<T extends string | null | undefined>(uri: T, machine: BindableMachine): T | string {
  const m = typeof uri === "string" ? parseMachineUri(uri) : null;
  return m && m.machineId === machine.id ? sshUri(machine.target, m.path) : uri;
}
