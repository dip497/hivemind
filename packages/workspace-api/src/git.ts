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
  /** Directory to place the worktree (relative or absolute). Default: under repo .hivemind-worktrees/<branch-slug>/. */
  path?: string;
  /** Sparse-checkout cone roots (empty = full checkout). */
  sparse?: string[];
  /** Apply `--filter=blob:none` partial clone. Default: true. */
  partial?: boolean;
  /** Files/globs to copy from main worktree (e.g. .env). Read from .worktreeinclude if not given. */
  includeFiles?: string[];
}
