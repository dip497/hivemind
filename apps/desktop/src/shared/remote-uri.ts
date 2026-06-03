/**
 * Remote target URI scheme — `ssh://[user@]host[:port]/abs/posix/path`.
 *
 * The entire IPC surface is keyed by a single path string (repoPath / cwd).
 * Rather than thread a separate "host" field through every channel and every
 * tile's data, a REMOTE target is encoded into that one string as an ssh:// URI.
 * It flows through canvas-node-build → tile data unchanged; each backend helper
 * branches once on isRemote(). This module is the pure parse/format core, shared
 * by main (transport routing) and renderer (display + frame binding). No deps.
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

/** True when a path string denotes a remote (ssh://) target. */
export function isRemote(p: string | null | undefined): p is string {
  return typeof p === "string" && p.startsWith(REMOTE_SCHEME);
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
  if (!isRemote(uri)) throw new Error(`not a remote uri: ${uri}`);
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

/** Join a remote uri's host authority with a new absolute path (for navigation). */
export function withRemotePath(uri: string, newPath: string): string {
  const t = parseRemote(uri);
  return formatRemote({ host: t.host, port: t.port, user: t.user, path: newPath });
}

/** Short human label: `user@host:/path` (for chips, titles, tooltips). */
export function remoteDisplay(uri: string): string {
  const t = parseRemote(uri);
  const u = t.user ? `${t.user}@` : "";
  return `${u}${t.host}:${t.path}`;
}

/** The basename of a remote uri's path — for a frame title. */
export function remoteBasename(uri: string): string {
  const { path } = parseRemote(uri);
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
