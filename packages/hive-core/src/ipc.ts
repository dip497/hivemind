/**
 * Local IPC endpoint naming shared by the desktop app and the `hive` CLI —
 * both must derive the SAME address for the same install, and the CLI cannot
 * import from apps/desktop, so the one implementation lives here.
 */
import crypto from "node:crypto";
import path from "node:path";

/**
 * Address for a local IPC endpoint.
 *
 * POSIX: a unix socket file inside userData, as before.
 *
 * Windows: there is no filesystem socket. Node's net API speaks named pipes
 * through the same connect()/createServer() calls, but the address must look
 * like `\\.\pipe\<name>` — a path under userData just yields ENOENT/EACCES.
 * The name must be IDENTICAL in every process that reaches this endpoint: the
 * pty daemon is spawned detached and re-derives it, and the hcp address is
 * handed to agent CLIs through HIVE_HCP_SOCK. So it's derived from the
 * userData dir (hashed — the raw path contains `\`, spaces and a drive letter,
 * none of which belong in a pipe name), which keeps it unique per install and
 * per user while staying stable across processes.
 */
export function ipcPath(userDataDir: string, name: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return path.join(userDataDir, name);
  // win32.resolve, not the host's, so the hash is identical wherever it's
  // derived (the CLI on another OS must compute the same pipe name).
  const key = crypto.createHash("sha256").update(path.win32.resolve(userDataDir)).digest("hex").slice(0, 12);
  return `\\\\.\\pipe\\hivemind-${key}-${name.replace(/\.sock$/, "")}`;
}
