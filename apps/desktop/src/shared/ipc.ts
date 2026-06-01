/** Typed contract for IPC between main and renderer. */
import type { Issue, IssueSummary, IssueState, AcceptanceItem, Assignee, LinkType } from "@hivemind/core/types";

/** A registered workspace (subset of the core registry entry — display shape
 *  for the renderer; avoids pulling node-only registry deps into the web tsconfig). */
export interface WorkspaceInfo {
  prefix: string;
  root: string;
  repo: string;
  title: string;
}

/**
 * Patch shape for `updateIssue`. Duplicated from `@hivemind/core/storage`
 * because importing from there pulls node-only deps into the web tsconfig.
 */
export type IssuePatch = Partial<{
  title: string;
  state: IssueState;
  parent: string | null | undefined;
  labels: string[];
  assignee: Assignee | null | undefined;
  github: number | null | undefined;
  description: string;
  acceptanceCriteria: AcceptanceItem[];
  extra: string;
}>;

// ── git types (mirror simple-git status v2 + pretty wrappers) ─────────────

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

export type DiffScope =
  | { kind: "working"; staged?: boolean }
  | { kind: "branch"; base?: string }
  | { kind: "commit"; sha: string };

export interface DiffPayload {
  /** Unified-diff patch text (`git diff` output). */
  patch: string;
  /** SHA-style cache key so Pierre's worker can cache the AST. */
  cacheKey: string;
}

// ── worktree types ───────────────────────────────────────────────────────

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

// ── full IPC surface ──────────────────────────────────────────────────────

export interface HiveIpc {
  // ── project resolution ────────────────────────────────────
  resolveProject(rootHint?: string): Promise<{
    root: string | null;
    cwd: string;
    /** Git repo root (parent of .git/). Set when found even without
     *  .hivemind/ — lets diff/tree tiles work in any git project. */
    repoPath: string | null;
  }>;
  /** Show a native folder picker. Returns the selected absolute path or
   *  null if the user cancelled. The renderer should then re-invoke
   *  resolveProject(picked) to repoint the canvas + sidebar at the chosen
   *  workspace without restarting the app. */
  pickProjectFolder(): Promise<string | null>;
  /** Create a .hivemind/ workspace in `dir` with the given issue prefix.
   *  Returns the new root path. Renderer should re-resolve afterwards. */
  initWorkspace(dir: string, prefix: string): Promise<{ root: string }>;

  // ── hive-core (issues) ───────────────────────────
  listIssues(root: string): Promise<IssueSummary[]>;
  readIssue(root: string, id: string): Promise<Issue>;
  updateIssueState(
    root: string,
    id: string,
    state: IssueSummary["state"],
    note?: string
  ): Promise<Issue>;
  createIssue(
    root: string,
    opts: {
      title: string;
      state?: IssueSummary["state"];
      parent?: string;
      labels?: string[];
      assignee?: Issue["assignee"];
      description?: string;
      acceptanceCriteria?: AcceptanceItem[];
    }
  ): Promise<Issue>;
  updateIssue(root: string, id: string, patch: IssuePatch): Promise<Issue>;
  commentOnIssue(root: string, id: string, message: string): Promise<Issue>;
  deleteIssue(root: string, id: string): Promise<void>;

  // ── cross-repo (registry + transfer + links) ───────────────
  /** Every registered workspace (other repos) whose root still exists. */
  listWorkspaces(): Promise<WorkspaceInfo[]>;
  /** Resolve the `.hivemind` root that owns an issue id (via its prefix), or
   *  null if its workspace isn't registered. Used to open a cross-repo link. */
  resolveIssueRoot(id: string): Promise<{ root: string | null }>;
  /** Transfer an issue into another workspace (by destination prefix). */
  moveIssue(
    root: string,
    id: string,
    destPrefix: string,
    mode: "move" | "copy"
  ): Promise<{ newId: string; mode: "move" | "copy"; from: string }>;
  /** Cross-repo link between two issues; reciprocal recorded on the other end. */
  linkIssue(
    root: string,
    id: string,
    otherId: string,
    type: LinkType
  ): Promise<{ from: string; to: string; type: LinkType; reciprocal: LinkType }>;
  /** Remove all links between two issues (both ends). */
  unlinkIssue(root: string, id: string, otherId: string): Promise<{ removed: number }>;

  // ── git ───────────────────────────────────────────────────
  gitStatus(repoPath: string): Promise<GitStatusSnapshot>;
  /** Tracked + untracked paths (respecting .gitignore). Used by the file-tree tile. */
  gitListFiles(repoPath: string): Promise<string[]>;
  gitDiff(repoPath: string, scope: DiffScope, file?: string): Promise<DiffPayload>;
  gitFileContents(
    repoPath: string,
    file: string,
    rev: "HEAD" | "INDEX" | "WORKING"
  ): Promise<string>;
  gitStage(repoPath: string, files: string[]): Promise<void>;
  gitUnstage(repoPath: string, files: string[]): Promise<void>;
  gitDiscard(repoPath: string, files: string[]): Promise<void>;
  gitCommit(repoPath: string, message: string, allowEmpty?: boolean): Promise<{ sha: string }>;
  gitPush(repoPath: string, setUpstream?: boolean): Promise<void>;
  gitConflictedFile(
    repoPath: string,
    file: string
  ): Promise<{ raw: string; conflicts: number }>;
  gitWriteResolved(repoPath: string, file: string, contents: string): Promise<void>;

  // ── plain filesystem (editor tile) ────────────────────────
  /** Read a repo-relative file as UTF-8. Rejects path traversal outside repoPath. */
  fileRead(repoPath: string, relPath: string): Promise<string>;
  /** Write UTF-8 contents to a repo-relative file. Rejects path traversal. */
  fileWrite(repoPath: string, relPath: string, contents: string): Promise<void>;

  // ── worktree ──────────────────────────────────────────────
  worktreeList(repoPath: string): Promise<WorktreeEntry[]>;
  worktreeCreate(
    repoPath: string,
    opts: WorktreeCreateOpts
  ): Promise<{ path: string; branch: string }>;
  worktreeRemove(repoPath: string, worktreePath: string, force?: boolean): Promise<void>;
  worktreePrune(repoPath: string): Promise<{ removed: string[] }>;

  // ── PTY ───────────────────────────────────────────────────
  ptySpawn(opts: {
    tileId: string;
    cwd: string;
    cmd: string;
    args?: string[];
    cols: number;
    rows: number;
    env?: Record<string, string>;
  }): Promise<{ pid: number }>;
  /** Install the agentic stack (hive MCP + hive-work skill + CLAUDE.md) into a
   *  repo so a spawned claude can actually work issues. Idempotent. */
  installAgentic(dir: string): Promise<{ ok: boolean }>;
  ptyWrite(tileId: string, data: string): void;
  ptyResize(tileId: string, cols: number, rows: number): void;
  ptyKill(tileId: string): void;
  /** Window closed / tile unmounted: keep the session alive (daemon mode) or
   *  kill it (in-process mode). Distinct from ptyKill, which always terminates. */
  ptyDetach(tileId: string): void;
  /** True when HIVEMIND_PTY_DAEMON=1 — terminals persist across window close. */
  persistentPty: boolean;

  // ── notifications ─────────────────────────────────────────
  /** Forward a notable agent-status transition to the main process, which fires
   *  a native OS notification IF the window is unfocused. Fire-and-forget. */
  notifyAgent(notice: AgentNotice): void;
}

/** A notable agent-status transition worth a native OS notification. */
export interface AgentNotice {
  tileId: string;
  /** Human label for the popup, e.g. "claude #2 · plan". */
  label: string;
  /** "needs" = blocked/permission/question; "done" = finished (working→idle). */
  kind: "needs" | "done";
  /** Tile's repo cwd, if known — its basename is shown as context. */
  repo?: string;
}

export type IpcChannel =
  | keyof HiveIpc
  | `pty:data:${string}`
  | `pty:exit:${string}`
  | `fs:changed:${string}`;
