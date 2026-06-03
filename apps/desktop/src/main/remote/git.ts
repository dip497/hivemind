/**
 * Remote git: run `git -C <remotePath> <args>` over ssh exec and return stdout,
 * mirroring the local spawnGit contract (resolve stdout on exit 0, throw with
 * stderr otherwise). git-adapter's rawGit() delegates here when the repoPath is
 * an ssh:// uri, so every porcelain op (status, ls-files, diff, show, rev-parse,
 * commit, push, branch, worktree…) works remotely with no per-op change.
 *
 * Concurrency is capped per host (OpenSSH MaxSessions) so a burst of git execs
 * never starves the interactive PTY / SFTP channels on the same connection.
 */
import { parseRemote } from "../../shared/remote-uri.js";
import { remoteConns } from "./conn.js";
import { execCapture, remoteGit } from "./exec.js";
import { RemoteFs } from "./fs.js";

/** rawGit-over-ssh. `uri` is the ssh:// repo target; `args` is the git argv. */
export async function runRemoteGit(uri: string, args: string[], timeoutMs: number): Promise<string> {
  const target = parseRemote(uri);
  const conn = await remoteConns.get(target);
  const cmd = remoteGit(target.path, args);
  const res = await remoteConns.limiter.run(target.hostId, () => execCapture(conn, cmd, timeoutMs));
  if (res.code !== 0) {
    const msg = res.stderr.trim() || res.stdout.trim() || `git exited ${res.code}`;
    throw new Error(msg);
  }
  return res.stdout;
}

/** Read a working-tree file on the remote over SFTP (the WORKING rev of
 *  gitFileContents, and conflicted-file reads, bypass git and hit the fs). */
export async function readRemoteFile(uri: string, relPath: string): Promise<string> {
  const target = parseRemote(uri);
  const fs: RemoteFs = await remoteConns.fs(target);
  const full = joinPosix(target.path, relPath);
  return fs.readFile(full);
}

export async function writeRemoteFile(uri: string, relPath: string, contents: string): Promise<void> {
  const target = parseRemote(uri);
  const fs: RemoteFs = await remoteConns.fs(target);
  const full = joinPosix(target.path, relPath);
  await fs.writeFile(full, contents);
}

function joinPosix(base: string, rel: string): string {
  if (rel.startsWith("/")) return rel;
  return base.endsWith("/") ? base + rel : `${base}/${rel}`;
}
