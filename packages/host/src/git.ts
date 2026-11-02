/**
 * Git and worktrees on a workspace's host: the workspace API's `git.*` and `worktree.*`. Each
 * method checks its call's params (text where text is taken, files inside the repo, nothing git
 * would read as an option) and hands them to the git adapter.
 */
import path from "node:path";
import { ApiError, fields, flag, oneOf, text, texts, written } from "@hivemind/workspace-api/protocol";
import { howMany, named, type Domain } from "@hivemind/workspace-api/server";
import type { Method } from "@hivemind/workspace-api/methods";
import type { DiffScope, WorktreeCreateOpts } from "@hivemind/workspace-api/git";
import {
  gitCommit,
  gitConflictedFile,
  gitDiff,
  gitDiscard,
  gitFileContents,
  gitListBranches,
  gitListFiles,
  gitPull,
  gitPush,
  gitStage,
  gitStatus,
  gitUnstage,
  gitWriteResolved,
  worktreeCreate,
  worktreeList,
  worktreePrune,
  worktreeRemove,
} from "./git-adapter.js";
import { allInRepo, fileIn, inRepo } from "./repo-paths.js";
import { gitBlame, gitCommitInfo, gitFileHistory, gitLog, refreshCommitGraph } from "./git-history.js";
import type { BlameOptions, FileHistoryCursor, LogOptions } from "@hivemind/workspace-api/git";

/** A hand-off is its own domain's (`hand-off.ts`): it places a tile, and needs who calls. */
type GitMethod = Exclude<Extract<Method, `git.${string}` | `worktree.${string}`>, "git.handOff">;

const bad = (message: string): never => {
  throw new ApiError("BAD_REQUEST", message);
};
const repoOf = (v: unknown) => text(v, "repo");
const fileOf = (repo: string, v: unknown) => inRepo(repo, text(v, "file"));
const filesOf = (repo: string, v: unknown) => allInRepo(repo, texts(v, "files"));

/** A value git takes as an argument of its own (a revision, a branch, a sparse root): one that
 *  begins with `-` would be read as an option. */
function notOption(value: unknown, name: string): string {
  const v = text(value, name);
  if (v.startsWith("-")) bad(`${name} may not begin with "-": ${v}`);
  return v;
}

/** Inside the repo: relative, and no `..`. */
function relative(value: string, name: string): string {
  if (path.isAbsolute(value) || value.split(/[/\\]/).includes("..")) bad(`${name} must be relative to the repo and contain no "..": ${value}`);
  return value;
}

function scopeOf(value: unknown): DiffScope {
  const scope = fields(value, "scope");
  const kind = oneOf(scope.kind, "scope.kind", ["working", "branch", "unpushed", "commit"] as const);
  flag(scope.ignoreWhitespace, "scope.ignoreWhitespace");
  flag(scope.staged, "scope.staged");
  for (const ref of ["base", "head"] as const) if (scope[ref] != null) notOption(scope[ref], `scope.${ref}`);
  if (kind === "commit") notOption(scope.sha, "scope.sha");
  return scope as unknown as DiffScope;
}

const whole = (v: unknown, name: string, lo: number, hi: number): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) bad(`${name} must be a whole number from ${lo} to ${hi}`);
  return v as number;
};

function logOptsOf(value: unknown): LogOptions {
  if (value == null) return {};
  const o = fields(value, "opts");
  return {
    ...(o.all != null ? { all: flag(o.all, "opts.all") } : {}),
    ...(o.cursor != null ? { cursor: whole(o.cursor, "opts.cursor", 0, 10_000_000) } : {}),
    ...(o.limit != null ? { limit: whole(o.limit, "opts.limit", 1, 1000) } : {}),
  };
}

/** A page's `next`, handed back: a revision git reads as one (never an option), a path in the repo. */
function cursorOf(repo: string, value: unknown): FileHistoryCursor | undefined {
  if (value == null) return undefined;
  const c = fields(value, "next");
  const rev = notOption(c.rev, "next.rev");
  if (!/^[0-9a-fA-F]{4,64}\^?$|^HEAD$/.test(rev)) bad(`next.rev is not one a page gives: ${rev}`);
  return { rev, path: inRepo(repo, text(c.path, "next.path")), skip: whole(c.skip, "next.skip", 0, 10_000_000) };
}

function blameOptsOf(value: unknown): BlameOptions {
  if (value == null) return {};
  const o = fields(value, "opts");
  return {
    ...(o.contents != null ? { contents: written(o.contents, "opts.contents") } : {}),
    ...(o.from != null ? { from: whole(o.from, "opts.from", 1, 10_000_000) } : {}),
    ...(o.to != null ? { to: whole(o.to, "opts.to", 1, 10_000_000) } : {}),
    ...(o.moved != null ? { moved: flag(o.moved, "opts.moved") } : {}),
  };
}

function worktreeOptsOf(value: unknown): WorktreeCreateOpts {
  const opts = fields(value, "opts");
  const branch = notOption(opts.branch, "opts.branch");
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes("..")) bad(`invalid branch name: ${JSON.stringify(branch)}`);
  if (opts.base != null) {
    const base = notOption(opts.base, "opts.base");
    if (!/^[A-Za-z0-9._/~^-]+$/.test(base) || base.includes("..")) bad(`invalid base: ${JSON.stringify(base)}`);
  }
  if (opts.path != null) relative(text(opts.path, "opts.path"), "opts.path");
  for (const list of ["sparse", "includeFiles"] as const) {
    if (opts[list] == null) continue;
    for (const entry of texts(opts[list], `opts.${list}`)) relative(notOption(entry, `opts.${list}`), `opts.${list}`);
  }
  flag(opts.partial, "opts.partial");
  return opts as unknown as WorktreeCreateOpts;
}

export const git: Domain<GitMethod> = {
  answers: {
    "git.status": (_, repo) => gitStatus(repoOf(repo)),
    "git.listFiles": (_, repo) => gitListFiles(repoOf(repo)),
    "git.listBranches": (_, repo) => gitListBranches(repoOf(repo)),
    "git.diff": (_, repo, scope, file) => {
      const r = repoOf(repo);
      return gitDiff(r, scopeOf(scope), file == null ? undefined : fileOf(r, file));
    },
    "git.fileContents": (_, repo, file, rev) => {
      const r = repoOf(repo);
      return gitFileContents(r, fileOf(r, file), oneOf(rev, "rev", ["HEAD", "INDEX", "WORKING"] as const));
    },
    "git.log": (_, repo, opts) => gitLog(repoOf(repo), logOptsOf(opts)),
    "git.fileHistory": (_, repo, file, cursor) => { const r = repoOf(repo); return gitFileHistory(r, fileOf(r, file), cursorOf(r, cursor)); },
    "git.blame": (_, repo, file, opts) => { const r = repoOf(repo); return gitBlame(r, fileOf(r, file), blameOptsOf(opts)); },
    "git.commitInfo": (_, repo, sha) => gitCommitInfo(repoOf(repo), notOption(sha, "sha")),
    "git.stage": (_, repo, files) => { const r = repoOf(repo); return gitStage(r, filesOf(r, files)); },
    "git.unstage": (_, repo, files) => { const r = repoOf(repo); return gitUnstage(r, filesOf(r, files)); },
    "git.discard": (_, repo, files) => { const r = repoOf(repo); return gitDiscard(r, filesOf(r, files)); },
    "git.commit": async (_, repo, message, allowEmpty) => {
      const r = repoOf(repo);
      const done = await gitCommit(r, text(message, "message"), flag(allowEmpty, "allowEmpty"));
      refreshCommitGraph(r);
      return done;
    },
    "git.push": (_, repo, setUpstream) => gitPush(repoOf(repo), flag(setUpstream, "setUpstream")),
    "git.pull": async (_, repo) => { const r = repoOf(repo); await gitPull(r); refreshCommitGraph(r); },
    "git.conflictedFile": (_, repo, file) => { const r = repoOf(repo); return gitConflictedFile(r, fileOf(r, file)); },
    "git.writeResolved": (_, repo, file, contents) => { const r = repoOf(repo); return gitWriteResolved(r, fileOf(r, file), written(contents, "contents")); },
    "worktree.list": (_, repo) => worktreeList(repoOf(repo)),
    "worktree.create": (_, repo, opts) => worktreeCreate(repoOf(repo), worktreeOptsOf(opts)),
    "worktree.remove": (_, repo, worktree, force) => worktreeRemove(repoOf(repo), notOption(worktree, "worktree"), flag(force, "force")),
    "worktree.prune": (_, repo) => worktreePrune(repoOf(repo)),
  },
  effects: {
    "git.stage": (repo, files) => ({ target: named(repo), detail: howMany(files, "file") }),
    "git.unstage": (repo, files) => ({ target: named(repo), detail: howMany(files, "file") }),
    "git.discard": (repo, files) => ({ target: named(repo), detail: howMany(files, "file") }),
    "git.commit": (repo) => ({ target: named(repo) }),
    "git.push": (repo, setUpstream) => ({ target: named(repo), detail: setUpstream === true ? "set upstream" : undefined }),
    "git.pull": (repo) => ({ target: named(repo) }),
    "git.writeResolved": (repo, file) => ({ target: fileIn(repo, file) }),
    "worktree.create": (repo, opts) => ({ target: named(repo), detail: named((opts as { branch?: unknown } | null)?.branch) }),
    "worktree.remove": (_repo, worktree) => ({ target: named(worktree) }),
    "worktree.prune": (repo) => ({ target: named(repo) }),
  },
};
