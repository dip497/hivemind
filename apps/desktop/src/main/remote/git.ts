/**
 * Remote git: `git -C <remotePath> <args>` over ssh, with the local spawnGit contract
 * (stdout on exit 0, throw with stderr otherwise). git-adapter's rawGit() delegates
 * here for an ssh:// repoPath, so every porcelain op works remotely unchanged.
 */
import { parseRemote } from "../../shared/remote-uri.js";
import { remoteConns } from "./conn.js";
import { remoteGit } from "./exec.js";

/** rawGit-over-ssh. `uri` is the ssh:// repo target; `args` is the git argv. */
export async function runRemoteGit(uri: string, args: string[], timeoutMs: number): Promise<string> {
  const target = parseRemote(uri);
  const res = await remoteConns.exec(target, remoteGit(target.path, args), { timeoutMs });
  if (res.code !== 0) {
    const msg = res.stderr.trim() || res.stdout.toString("utf8").trim() || `git exited ${res.code}`;
    throw new Error(msg);
  }
  return res.stdout.toString("utf8");
}

/** Working-tree reads (the WORKING rev of gitFileContents, conflicted files) bypass git. */
export async function readRemoteFile(uri: string, relPath: string): Promise<string> {
  const target = parseRemote(uri);
  return (await remoteConns.fs(target)).readFile(joinPosix(target.path, relPath));
}

export async function writeRemoteFile(uri: string, relPath: string, contents: string): Promise<void> {
  const target = parseRemote(uri);
  await (await remoteConns.fs(target)).writeFile(joinPosix(target.path, relPath), contents);
}

function joinPosix(base: string, rel: string): string {
  if (rel.startsWith("/")) return rel;
  return base.endsWith("/") ? base + rel : `${base}/${rel}`;
}
