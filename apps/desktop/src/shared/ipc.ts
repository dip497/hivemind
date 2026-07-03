/** Typed contract for IPC between main and renderer. */
import type { Issue, IssueSummary, IssueState, AcceptanceItem, Assignee, LinkType, IssuePatch } from "@hivemind/core/types";
import type { NotificationSettings } from "./notification-settings.js";
export type { NotificationSettings };

// IssuePatch is owned by @hivemind/core/types (node-free) — re-export so renderer
// modules keep importing it from the IPC contract, with no hand-maintained copy.
export type { IssuePatch };

/** A registered workspace (subset of the core registry entry — display shape
 *  for the renderer; avoids pulling node-only registry deps into the web tsconfig). */
export interface WorkspaceInfo {
  prefix: string;
  root: string;
  repo: string;
  title: string;
}

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
  // base...head merge-base (3-dot) diff — what `head` adds since it diverged
  // from `base`, the same semantics GitHub/Azure PRs show. `head` defaults to
  // HEAD (review another branch against the checkout); set it to review any two
  // arbitrary branches without a remote PR.
  | { kind: "branch"; base?: string; head?: string }
  // Committed-but-not-pushed: the net diff of local commits ahead of the
  // branch's remote tracking ref (`@{upstream}...HEAD`). Optional `base`
  // overrides the auto-resolved upstream so this same scope serves future
  // "ahead of <any ref>" reviews without a new variant.
  | { kind: "unpushed"; base?: string }
  | { kind: "commit"; sha: string };

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

// ── remote (SSH) frames ───────────────────────────────────────────────────
/** Auth for a remote host. SSH agent is always tried first; these are the
 *  explicit fallbacks. */
export interface RemoteAuth {
  /** Path to a private key file. */
  privateKeyPath?: string;
  /** Passphrase for an encrypted private key. */
  passphrase?: string;
  /** Password (for hosts without key auth). Held in memory only, never persisted. */
  password?: string;
  /** Username override (else parsed from the uri, else $USER). */
  username?: string;
}
/** One remote directory entry (SFTP) for the folder picker / tree. */
export interface RemoteDirEntry {
  name: string;
  isDir: boolean;
  isSymlink: boolean;
  size: number;
  mtime: number;
}
/** A saved remote connection (password lives encrypted in the OS keychain — the
 *  renderer only learns whether one exists). */
export interface SavedHost {
  hostId: string;
  host: string;
  port: number;
  user: string;
  hasPassword: boolean;
  hasKey: boolean;
}

// ── app version + self-update ─────────────────────────────────────────────

/** Result of the GitHub "latest release" check. On offline / rate-limit the
 *  main process returns `latest: null` + `updateAvailable: false` so the
 *  renderer shows NOTHING (never a scary error). */
export interface UpdateStatus {
  /** This app's running version (apps/desktop/package.json "version"). */
  current: string;
  /** Latest release tag (leading "v" stripped), or null when the check failed. */
  latest: string | null;
  /** True iff `latest` is strictly newer than `current`. */
  updateAvailable: boolean;
  /** True iff the check actually completed (reached GitHub, got a valid tag).
   *  False on offline / timeout / rate-limit — the renderer must NOT treat a
   *  false-ok result as "up to date" or persist it over a known-good state. */
  ok: boolean;
}

// ── full IPC surface ──────────────────────────────────────────────────────

export interface HiveIpc {
  // ── app version + self-update ─────────────────────────────
  /** This app's version string (from apps/desktop/package.json). */
  getAppVersion(): Promise<string>;
  /** Check the latest GitHub release and compare to the running version. Done
   *  in MAIN (renderer CSP blocks the github.com fetch). Never rejects — a
   *  failed check resolves with `latest: null`. */
  checkForUpdate(): Promise<UpdateStatus>;
  /** Run the official installer (the same `install.sh` flow `hivemind upgrade`
   *  uses) and resolve with its exit status. Does NOT quit — the renderer shows
   *  the result and then calls `relaunchApp()` to restart into the new version.
   *  `ok` is true iff the installer exited 0. */
  runUpgrade(): Promise<{ ok: boolean; code: number | null }>;
  /** Live installer output during `runUpgrade` — the last non-empty line of each
   *  stdout/stderr chunk, so the UI can show real progress instead of a frozen
   *  button. Returns an unsubscribe fn. */
  onUpdateProgress(cb: (line: string) => void): () => void;

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
  /** Local + remote branches for the diff tile's base/head pickers. */
  gitListBranches(repoPath: string): Promise<GitBranchList>;
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
  /** Open a path clicked in the terminal with the OS default app (xdg-open).
   *  Resolves relatives against `cwd`; must exist; refuses `.desktop` + remote. */
  openPathInApp(cwd: string, target: string): Promise<{ ok: boolean; error?: string }>;

  /** Append one diagnostics line to userData/render-diag.log (auto-rotated).
   *  Used by the terminal render-quality probe so blurry-text reports can be
   *  read off disk (incl. over SSH) instead of only on-screen. */
  diagLog(line: string): Promise<void>;

  // ── remote (SSH) frames ───────────────────────────────────
  /** Probe + register auth for an ssh://[user@]host[:port]/ target; returns the
   *  remote home dir + the connection-pool host id. Throws on connect failure.
   *  `remember` saves the host (password encrypted in the OS keychain). */
  sshConnect(uri: string, auth: RemoteAuth, remember?: boolean): Promise<{ home: string; hostId: string }>;
  /** List a remote directory (for the folder picker). Empty dir → remote home. */
  sshListDir(uri: string, dir: string): Promise<{ dir: string; entries: RemoteDirEntry[] }>;
  /** Saved connections (host/user/port + whether a password/key is stored). */
  sshSavedHosts(): Promise<SavedHost[]>;
  /** Connect using a saved host's stored credentials. Returns its home + parts. */
  sshConnectSaved(hostId: string): Promise<{ home: string; host: string; port: number; user: string }>;
  /** Delete a saved connection. */
  sshForgetHost(hostId: string): Promise<void>;

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
  /** Read the persisted notification preferences (normalized onto defaults). */
  getNotificationSettings(): Promise<NotificationSettings>;
  /** Persist + apply notification preferences live (no relaunch needed). */
  setNotificationSettings(s: NotificationSettings): Promise<{ ok: true }>;

  // ── BrowserTile <webview> ↔ agent CDP bridge ──────────────
  /** A BrowserTile reports its guest <webview>'s webContents id (plus its frame
   *  and current URL) so the main process can attach the debugger AND write the
   *  discovery file the `hive-browser` skill reads. Called on dom-ready + on nav. */
  browserRegister(tileId: string, webContentsId: number, frameId: string | null, url: string): void;
  /** Tile unmounted — drop the guest mapping. */
  browserUnregister(tileId: string): void;
  /** Send a raw Chrome DevTools Protocol command to the tile's guest page
   *  (auto-attaches on first use). Navigate / click / read DOM / screenshot /
   *  evaluate — the surface an agent uses to "use" the browser. */
  browserCdp(tileId: string, method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Agent-browser bridge settings for the in-app toggle. `active` = live this
   *  session; `enabled` = persisted choice (applies on next launch). */
  getBrowserSettings(): Promise<{ active: boolean; enabled: boolean; port: string }>;
  /** Persist the agent-browser bridge on/off choice (applies after relaunch). */
  setBrowserCdpEnabled(enabled: boolean): Promise<{ ok: true }>;
  /** Restart the app so a settings change that needs a fresh launch takes hold. */
  relaunchApp(): Promise<void>;

  /** Resolve a blocked plan-review hook. allow → the agent proceeds with the
   *  plan; deny + feedback → the agent stays in plan mode and revises. */
  planReviewDecide(
    requestId: string,
    decision: "allow" | "deny",
    feedback?: string,
  ): Promise<void>;

  /** Reply to a main→renderer HCP command (a control-plane verb that needs the
   *  canvas, e.g. tile.spawn_agent). `id` correlates with the pushed command. */
  hcpResult(id: string, ok: boolean, result?: unknown, errorMessage?: string): Promise<void>;
}

/** A control-plane verb main asks the renderer to execute (request-id correlated
 *  with `hcpResult`). */
export interface HcpCommand {
  id: string;
  method: string;
  params: unknown;
}

/** Pushed main→renderer when an agent pipe is created/removed, so the canvas can
 *  draw/erase the animated "data flow" edge. `dst` is null when ALL of src's
 *  pipes were removed. */
export interface HcpPipeEvent {
  src: string;
  dst: string | null;
  connected: boolean;
}

/** Pushed main→renderer when an agent SPAWNS another agent (tile.spawn_agent /
 *  workflow), so the canvas can draw a persistent parentage "wire" from parent to
 *  child — ALWAYS, independent of the report/data pipe (`hcp:pipe`). `parent` is
 *  null with connected:false to drop every spawn link touching `child` (on close). */
export interface HcpSpawnEvent {
  child: string;
  parent: string | null;
  connected: boolean;
}

/** Pushed main→renderer when a tile enters/leaves a control-plane "wait" state
 *  (e.g. a supervised worker blocked on its parent's approval). `status` is a
 *  TileStatusKind string, or null to clear. The renderer forwards it to the
 *  agent-status bus as an override. */
export interface HcpWaitEvent {
  tileId: string;
  status: string | null;
}

/** Pushed main→renderer when a tile gains/loses in-flight Task subagents (from
 *  the injected SubagentStart/SubagentStop hooks). `busy` true keeps the tile
 *  reading "working" while subagents run — including BACKGROUND agents, where the
 *  main loop returns to the idle prompt and the screen-scrape would read "idle".
 *  Deterministic and correctly attributed (the hook fires in the parent session).
 *  `tileId` is the bare tile id (the status-bus key). */
export interface HcpSubagentEvent {
  tileId: string;
  busy: boolean;
}

/** Pushed main→renderer when claude's `Notification` hook reports a "needs you"
 *  state (permission / interactive question). Deterministic + version-proof
 *  (claude's own signal, not a scraped UI string). SOFT: the renderer lifts an
 *  idle tile to this status and auto-clears it when the scrape shows work
 *  resumed, so it can't get stuck. `tileId` is the bare tile id. */
export interface HcpNotifyEvent {
  tileId: string;
  status: "permission" | "question";
}

/** Pushed main→renderer with claude's HOOK-DRIVEN turn state: `working` on
 *  UserPromptSubmit (turn start), `idle` on Stop (turn end). This is the
 *  deterministic, version-proof replacement for the working/idle screen-scrape —
 *  it can't be fooled by spinner-glyph/wording changes, focus/scroll, or stale
 *  buffer replay on restart (no hook has fired → the tile stays idle). The scrape
 *  remains the fallback for non-claude agents. `tileId` is the bare tile id. */
export interface HcpTurnStateEvent {
  tileId: string;
  state: "working" | "idle";
}

/** Pushed main→renderer when an agent hands off a plan (PreToolUse/ExitPlanMode).
 *  The renderer opens a PlanReviewTile and later calls `planReviewDecide`. */
export interface PlanReviewOpen {
  requestId: string;
  /** The agent tile that produced the plan (so the review opens beside it). */
  tileId: string;
  /** The plan markdown (Claude Code's `tool_input.plan`). */
  plan: string;
  /** The agent's cwd at handoff. */
  cwd: string;
}

/** A notable agent-status transition worth a native OS notification. */
export interface AgentNotice {
  tileId: string;
  /** Human label for the popup, e.g. "claude #2 · plan". */
  label: string;
  /** "needs" = blocked/permission/question (action required); "done" = finished
   *  cleanly (working→idle); "error" = the agent process died while working
   *  (working→exited, non-zero exit / signal). Surfaces crashes, OOM-kills and
   *  failed builds that would otherwise be silent if the user isn't looking. */
  kind: "needs" | "done" | "error";
  /** The frame (workspace) the tile lives in — shown as context so you know
   *  WHICH project's agent wants you. */
  frame?: string;
  /** Tile's repo cwd, if known — basename shown when no frame name. */
  repo?: string;
  /** Process exit code (error kind only) — shown in the body so the user can
   *  tell a 137 OOM-kill from a 1 error-exit at a glance. */
  exitCode?: number;
  /** Free-form one-line detail for the body (error kind). Currently the exit
   *  signal/name when available; kept generic for future failure kinds. */
  detail?: string;
}

/** Pushed main→renderer when a background subsystem hits a NON-fATAL error the
 *  user would otherwise never see (e.g. the PTY daemon couldn't be refreshed,
 *  so agent hooks may be stale). The renderer surfaces these as a non-blocking
 *  toast so nothing fails silently. Fatal errors still go through dialogs. */
export interface AppErrorEvent {
  /** One-line, human message (shown as the toast title). */
  message: string;
  /** Which subsystem surfaced it — shown as muted context (e.g. "pty-daemon"). */
  source: string;
}

export type IpcChannel =
  | keyof HiveIpc
  | `pty:data:${string}`
  | `pty:exit:${string}`
  | `fs:changed:${string}`;
