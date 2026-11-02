/**
 * What git and worktree calls answer (the workspace API's `git.*` and `worktree.*`), shared by
 * every host and client. Node-free.
 */

/** Files above this many bytes are not loaded into the diff viewer — a single
 *  huge/generated/binary blob (a scip index, a lockfile, a bundle) would load
 *  its full contents twice as JS strings and then run an O(n) line-diff, spiking
 *  renderer memory into the GBs. `git.fileContents` returns `${OVERSIZE_SENTINEL}${bytes}`
 *  instead; the diff renders a "too large" placeholder. */
export const DIFF_MAX_FILE_BYTES = 1_500_000;
export const OVERSIZE_SENTINEL = "\0HM_OVERSIZE:";

// ── git (mirror simple-git status v2 + pretty wrappers) ─────────────────────

export type GitFileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "ignored"
  | "conflicted";

export interface GitFileEntry {
  path: string;
  status: GitFileStatus;
  /** Has staged changes for this file (index ≠ HEAD). */
  staged: boolean;
  /** Has unstaged changes (working tree ≠ index). */
  unstaged: boolean;
  /** For renames/copies. */
  origPath?: string;
}

export interface GitStatusSnapshot {
  /** Current branch (or null in detached HEAD). */
  branch: string | null;
  /** Tracked-upstream branch, if any. */
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFileEntry[];
  conflictedFiles: string[];
  isMerging: boolean;
  isRebasing: boolean;
  /** SHA of HEAD. */
  head: string;
}

/** Every scope may hide reindent-only changes (`git diff --ignore-all-space`). */
interface DiffScopeBase { ignoreWhitespace?: boolean }

export type DiffScope =
  | ({ kind: "working"; staged?: boolean } & DiffScopeBase)
  // base...head merge-base (3-dot) diff — what `head` adds since it diverged
  // from `base`, the same semantics GitHub/Azure PRs show. `head` defaults to
  // HEAD (review another branch against the checkout); set it to review any two
  // arbitrary branches without a remote PR.
  | ({ kind: "branch"; base?: string; head?: string } & DiffScopeBase)
  // Committed-but-not-pushed: the net diff of local commits ahead of the
  // branch's remote tracking ref (`@{upstream}...HEAD`). Optional `base`
  // overrides the auto-resolved upstream so this same scope serves future
  // "ahead of <any ref>" reviews without a new variant.
  | ({ kind: "unpushed"; base?: string } & DiffScopeBase)
  | ({ kind: "commit"; sha: string } & DiffScopeBase);

export interface DiffPayload {
  /** Unified-diff patch text (`git diff` output). */
  patch: string;
  /** SHA-style cache key so Pierre's worker can cache the AST. */
  cacheKey: string;
}

/** Branch inventory for the diff tile's base/head pickers. */
/** A branch handed off to a workspace's host (M4): the branch it landed as there, and the host's
 *  branch the Diff tile it opened shows it against. */
export interface HandedOff {
  branch: string;
  base: string;
}

export interface GitBranchList {
  /** Current local branch, or null when detached. */
  current: string | null;
  /** Local branch names (`refs/heads`). */
  local: string[];
  /** Remote-tracking refs, e.g. `origin/main` (`origin/HEAD` filtered out). */
  remote: string[];
}

export type GitRevision = "HEAD" | "INDEX" | "WORKING";

// ── worktrees ───────────────────────────────────────────────────────────────

export interface WorktreeEntry {
  path: string;
  branch: string | null;
  head: string;
  locked: boolean;
  prunable: boolean;
  bare: boolean;
}

export interface WorktreeCreateOpts {
  /** Branch name to create the worktree on (will be created if missing). */
  branch: string;
  /** Where a new branch starts (a branch, tag or commit; 0.20). Default: the repo's HEAD. A branch
   *  that exists is checked out as it is. */
  base?: string;
  /** Directory to place the worktree, relative to the repo. Default: `../<repo>-worktrees/<branch-slug>`. */
  path?: string;
  /** Sparse-checkout cone roots (empty = full checkout). */
  sparse?: string[];
  /** Apply `--filter=blob:none` partial clone. Default: true. */
  partial?: boolean;
  /** Files/globs to copy from main worktree (e.g. .env). Read from .worktreeinclude if not given. */
  includeFiles?: string[];
}

// ── history (0.39): the log, a file's history, blame, a commit ──────────────

/** One commit of the log, as much as a row of it shows. */
export interface LogCommit {
  oid: string;
  parents: string[];
  /** Author time, seconds since the epoch. */
  time: number;
  author: string;
  email: string;
  subject: string;
  /** What points at it: `HEAD -> main`, `origin/main`, `tag: v1`. */
  refs: string[];
}

export interface LogOptions {
  /** Every branch, by date, as against the current one in git's own order (the default, and the
   *  fast one: its first page is read without walking the rest). */
  all?: boolean;
  /** Commits to skip: the `next` of the page before. */
  cursor?: number;
  /** At most this many, 1 to 1000; 200 by default. */
  limit?: number;
}

export interface LogPage { commits: LogCommit[]; next: number | null }

/** Where a file's history goes on from: a revision, the path the file had there, and how many of
 *  that stretch's commits were read already. Opaque to a caller: hand back the page's `next`. */
export interface FileHistoryCursor { rev: string; path: string; skip: number }

export interface FileHistoryEntry {
  oid: string;
  time: number;
  author: string;
  subject: string;
  /** The path the file had in this commit. */
  path: string;
  /** In this commit it was renamed from this path. */
  renamedFrom?: string;
}

export interface FileHistoryPage { entries: FileHistoryEntry[]; next: FileHistoryCursor | null }

export interface BlameOptions {
  /** The text to blame, as the editor has it: its unsaved lines read as not committed yet. */
  contents?: string;
  /** Lines `from` to `to` only, 1-based and inclusive: the ones on screen first. */
  from?: number;
  to?: number;
  /** Follow lines moved or copied (`-M -C`): about three times the work. */
  moved?: boolean;
}

/** A run of lines last changed by one commit. */
export interface BlameHunk {
  /** Null for lines not committed yet. */
  oid: string | null;
  /** First line, 1-based, in the text blamed. */
  start: number;
  lines: number;
  author: string;
  time: number;
  summary: string;
}

export interface BlamePayload {
  hunks: BlameHunk[];
  /** The editor's text was blamed. False when it was given but git could not (before 2.41, or a
   *  repo on another machine): the committed file was blamed instead. */
  contents: boolean;
}

export interface CommitFile {
  path: string;
  /** `added`, `modified`, `deleted`, `renamed`, `copied` or `typechange`. */
  status: string;
  /** The path before, for a rename or copy. */
  from?: string;
  /** Lines added and removed; null for a binary file. */
  add: number | null;
  del: number | null;
}

export interface CommitInfo {
  oid: string;
  parents: string[];
  author: string;
  email: string;
  time: number;
  committer: string;
  committerTime: number;
  message: string;
  /** Against its first parent. */
  files: CommitFile[];
}
