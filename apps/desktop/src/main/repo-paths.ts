/**
 * Paths a call names inside a repo, a local one or an ssh:// one: each is refused (BAD_REQUEST)
 * when it would reach outside the repo — an absolute path, `..`. Every file a window, a peer or
 * the dev-bridge names goes through here before it reaches git or the disk.
 */
import path from "node:path";
import { ApiError } from "@hivemind/workspace-api/protocol";
import { isRemote } from "../shared/remote-uri.js";

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

/** `rel` inside an ssh:// repo: POSIX-relative, no `..`. */
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
