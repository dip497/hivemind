/**
 * Paths a call names inside a repo, a local one or a remote one: each is refused (BAD_REQUEST)
 * when it would reach outside the repo — an absolute path, `..`. Every file a window, a peer or
 * the dev-bridge names goes through here before it reaches git or the disk.
 */
import path from "node:path";
import { realpath } from "node:fs/promises";
import { ApiError } from "@hivemind/workspace-api/protocol";
import { isRemote } from "@hivemind/core/remote-uri";

const escapes = (rel: string): never => {
  throw new ApiError("BAD_REQUEST", `path escapes repo: ${rel}`);
};

/** `rel` inside a local repo, as an absolute path. */
export function resolveInRepo(repoPath: string, rel: string): string {
  const root = path.resolve(repoPath);
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) escapes(rel);
  return abs;
}

/** Resolve a local file for reading, including symlinks, without leaving the repo. A missing
 *  target is returned as before so each caller keeps its existing missing-file behaviour. */
export async function resolveRealInRepo(repoPath: string, rel: string): Promise<string> {
  const abs = resolveInRepo(repoPath, rel);
  let root: string;
  try {
    root = await realpath(repoPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return abs;
    throw e;
  }
  let at = abs;
  for (;;) {
    try {
      const target = await realpath(at);
      if (target !== root && !target.startsWith(root + path.sep)) escapes(rel);
      return at === abs ? target : abs;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const parent = path.dirname(at);
      if (parent === at) throw e;
      at = parent;
    }
  }
}

/** `rel` inside a remote repo: POSIX-relative, no `..`. */
export function remoteRel(rel: string): string {
  const norm = rel.replace(/\\/g, "/");
  if (norm.startsWith("/") || norm.split("/").includes("..")) escapes(rel);
  return rel;
}

/** `rel` inside the repo, as it was given (git takes paths relative to the repo). */
export function inRepo(repoPath: string, rel: string): string {
  if (isRemote(repoPath)) return remoteRel(rel);
  resolveInRepo(repoPath, rel);
  return rel;
}

/** Each of `rels` inside the repo. */
export function allInRepo(repoPath: string, rels: readonly string[]): string[] {
  return rels.map((rel) => inRepo(repoPath, rel));
}

/** A file in a repo as an effect names it, from params not yet checked: the path it resolves to. */
export function fileIn(repo: unknown, rel: unknown): string | undefined {
  if (typeof repo !== "string" || typeof rel !== "string" || !repo || !rel) return undefined;
  return isRemote(repo) ? `${repo.replace(/\/+$/, "")}/${rel}` : path.resolve(repo, rel);
}
