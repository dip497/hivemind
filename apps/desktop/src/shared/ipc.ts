import type { SessionStatus } from "@hivemind/agent-host/status-store";
/** Typed contract for IPC between main and renderer. */
import type { Issue, IssueSummary, IssueState, AcceptanceItem, Assignee, LinkType, IssuePatch } from "@hivemind/core/types";
import type { ViewManifest } from "@hivemind/view-sdk/manifest";
import type { ActivityLevel, ShareOutcome, ViewHistoryDay, ViewSession, ViewPresence, ViewStatus } from "@hivemind/view-sdk/protocol";
import type { NotificationSettings } from "./notification-settings.js";
import type { ReviewComment } from "@hivemind/core/review";
import type { LegacyLayout, WorkspaceChange } from "@hivemind/workspace-host/layout";
import type { Participant, PresenceState } from "@hivemind/workspace-host/presence";
import type { NetworkHealth, NetworkProfile } from "@hivemind/workspace-host/network-profile";

/** One of the person's other devices, as Settings → Devices lists it (R14, spec/pairing.md). */
export interface PairedDeviceSummary {
  device: string;
  name: string;
  /** "host": `hive host`, always on; "app": someone's own computer. */
  kind: "app" | "host";
  pairedAt: number;
}

/** A workspace one of the person's other devices holds. */
export interface DeviceWorkspace { workspace: string; name: string; repo: string }

/** Someone on a workspace's access list, as the People panel shows them. */
export interface SharedPerson {
  person: string;
  name: string;
  color: string;
  role: string;
  grantedAt: number;
  expires: number | null;
  devices: string[];
  /** Connected now. */
  present: boolean;
}

/** Where the connection to a joined workspace's host is, and what the host last gave. */
export interface SharedStatus {
  state: "connecting" | "connected" | "reconnecting" | "offline" | "left" | "removed";
  access: string;
}
import type { BoardObject, CoreLayout, ViewLayout } from "@hivemind/workspace-doc/shapes";
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

// git and worktrees: what the workspace API's `git.*` and `worktree.*` answer.
export { DIFF_MAX_FILE_BYTES, OVERSIZE_SENTINEL } from "@hivemind/workspace-api/git";
export type {
  DiffPayload,
  DiffScope,
  GitBranchList,
  GitFileEntry,
  GitFileStatus,
  GitRevision,
  GitStatusSnapshot,
  WorktreeCreateOpts,
  WorktreeEntry,
} from "@hivemind/workspace-api/git";
import type { DiffPayload, DiffScope, GitBranchList, GitStatusSnapshot, WorktreeCreateOpts, WorktreeEntry } from "@hivemind/workspace-api/git";
import type { Typist } from "@hivemind/workspace-api/terminals";
import type { Answerer, PlanDecided, PlanReview } from "@hivemind/workspace-api/plans";

// ── machines (saved ssh hosts, shared with `hive machine`) ────────────────
/** One remote directory entry for the folder picker / tree. */
export interface RemoteDirEntry {
  name: string;
  isDir: boolean;
  isSymlink: boolean;
}
/** `attention` needs a person (host key, auth); `no-hive` works without surviving drops. */
export type MachineState = "idle" | "connecting" | "online" | "reconnecting" | "offline" | "attention" | "no-hive";
export interface MachineStatus {
  state: MachineState;
  /** ssh's own words for the last failure. */
  detail?: string;
  /** Daemon round trip, measured while connected. */
  rttMs?: number;
  /** The host offered password auth and we have none it can use — asking for one is the fix. */
  needsPassword?: boolean;
  at: number;
}
export interface MachineInfo {
  id: string;
  label: string;
  /** `alias`, `user@host` or `ssh://user@host:port`. */
  target: string;
  enabled: boolean;
  platform?: string;
  hivePath?: string;
  /** What its frames' ssh:// uris resolve to. */
  hostId: string;
}
export interface MachinesSnapshot {
  machines: MachineInfo[];
  /** By host id, including hosts of frames that are not saved machines, and the person's devices
   *  frames run on (`device:<id>`, M3). */
  status: Record<string, MachineStatus>;
  catalogError?: string;
  /** The person's other devices, where a frame can run too (M3); the window adds them. */
  devices?: PairedDeviceSummary[];
}
export interface MachineProbe {
  platform: string;
  hivePath?: string;
  hiveVersion?: string;
  daemon?: boolean;
}
export interface MachineAddRequest {
  target: string;
  label?: string;
  /** Put this version's `hive` there when it has none (or one too old). */
  install?: boolean;
  /** For hosts without key auth; kept in the OS keychain, never in the catalog. */
  password?: string;
}
export interface MachineAddResult {
  machine: MachineInfo;
  probe: MachineProbe;
  installed: boolean;
  /** Absent unless a password was given and no OS keychain could hold it (it lasts this session only). */
  passwordSaved?: false;
}
/** A terminal session in a machine's daemon. */
export interface SessionSummary {
  id: string;
  state: "live" | "frozen";
  cmd: string;
  args: string[];
  cwd: string;
  viewers: number;
  cols: number;
  rows: number;
  title?: string;
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
  /** The check is off (Settings → Network): nothing was asked. */
  off?: boolean;
  /** A version already downloaded and waiting for a restart to become the one that
   *  runs (the installer could not replace a live app), when it is newer than this one.
   *  Restarting is then the whole of what is left to do — never another download. */
  staged: string | null;
}

import type { Settings } from "@hivemind/core/settings-schema";
import type { CatalogEntry } from "@hivemind/core/plugin-catalog";

/** One community view package as the main process sees it (see main/view-packages.ts). */
export interface ViewPackageInfo {
  id: string;
  dir: string;
  source: "user" | "repo";
  manifest: ViewManifest | null;
  error: string | null;
  url: string | null;
}

// ── full IPC surface ──────────────────────────────────────────────────────

export interface HiveIpc {
  // ── workspace layout (main owns it; see main/workspace-store-ipc.ts) ──
  /** The workspace's core layout blob (frames, tiles, membership, names, tabs), or null. */
  workspaceCoreSync(repo: string): CoreLayout | null;
  /** One view's stored layout, or null. */
  workspaceViewSync(repo: string, viewId: string): ViewLayout | null;
  /** Replace the core layout blob, made from `base` (what this window last read or wrote), so only
   *  what it changed is written. Synchronous, so a write made while the window unloads is kept. */
  workspaceSetCoreSync(repo: string, core: unknown, base?: unknown): void;
  /** Replace one view's layout. Synchronous for the same reason. */
  /** `base`: the layout this window last read or wrote (null: none): only what changed from it is written. */
  workspaceSetViewSync(repo: string, viewId: string, layout: ViewLayout, base?: ViewLayout | null): void;
  /** Offer this window's old localStorage layout; the store keeps only what it lacks. */
  workspaceImportSync(repo: string, legacy: LegacyLayout): void;
  /** The board's objects, a framed one's position relative to its frame; none when there are none. */
  workspaceObjectsSync(repo: string): BoardObject[] | null;
  /** Replace the board. Synchronous, so a write made while the window unloads is kept. */
  /** `base`: the board this window last read or wrote (null: none): only what changed from it is written. */
  workspaceSetObjectsSync(repo: string, objects: BoardObject[], base?: BoardObject[] | null): void;
  /** Take back the last board edit; false when there is none. */
  workspaceUndoSync(repo: string): boolean | null;
  /** Make again the last board edit undo took back; false when there is none. */
  workspaceRedoSync(repo: string): boolean | null;
  /** Another writer (the control plane, another window) changed a workspace. */
  onWorkspaceChanged(cb: (change: Pick<WorkspaceChange, "repo" | "part">) => void): () => void;
  /** The workspace this window shows now (null: none), and the frame the user is in there, for
   *  the control plane to act on when its caller is in no tile. */
  workspaceShown(repo: string | null, frame: string | null): void;
  /** Where this window's person is in the workspace `repo` (M1): their pointer on the board and
   *  what they have selected; null: they left it. */
  boardPresenceSet(repo: string, state: PresenceState | null): void;
  /** Who is in a workspace now, each as they last said, as it changes: every workspace's. */
  onBoardPresence(cb: (repo: string, people: Participant[]) => void): () => void;

  // ── settings.json (main owns it; see main/settings-store.ts) ──
  /** The whole settings object, synchronously (boot: no theme flash). */
  settingsSync(): Settings;
  settingsGet(): Promise<Settings>;
  /** Set one dotted path and persist; resolves with the new settings. */
  settingsSet(path: string, value: unknown): Promise<Settings>;
  /** Apply several dotted-path patches in one locked read/modify/write. The
   *  renderer sends THIS rather than a whole object: a full replace built from a
   *  debounced UI snapshot reverts whatever the CLI (or another window) wrote in
   *  the meantime. Resolves with the settings as written. */
  settingsPatch(patches: readonly { path: string; value: unknown }[]): Promise<Settings>;
  /** Whole-object write (a theme import). Merged onto the file under the same lock. */
  settingsReplace(next: Settings): Promise<Settings>;
  settingsPath(): Promise<string>;
  onSettingsChanged(cb: (s: Settings) => void): () => void;
  // ── community views ───────────────────────────────────────
  /** Installed view packages (user dir + this repo's .hivemind/views), each
   *  with its load URL or the reason it will not load. Rescans on every call. */
  listViews(repoRoot: string | null): Promise<ViewPackageInfo[]>;
  /** Agent providers on disk. Only manifests cross — a def carries detect(). */
  listAgents(repoRoot: string | null): Promise<{
    agents: Array<{ id: string; file: string; source: "user" | "repo"; manifest: unknown; error: string | null; disabled: boolean }>;
    shadowed: Array<{ id: string; by: string; over: string }>;
  }>;
  /** Where each agent's CLI was found on PATH (null = not installed). Runs nothing. */
  agentPresence(): Promise<Record<string, { path: string | null }>>;
  /** Found, and answering `--version` like a CLI (not a same-named program). */
  verifyAgent(id: string): Promise<{ path: string | null; version?: string; mismatch?: string }>;
  /** The values each of an agent's options takes, read from its CLI. Cached per binary version. */
  agentOptionChoices(id: string): Promise<Record<string, { values: string[]; from: "help" | "list" | null; error?: string }>>;
  previewViewInstall(): Promise<{ token: string; package: ViewPackageInfo; replacesVersion: string | null } | null>;
  /** The published plugin catalog (hash-pinned agents and views). */
  pluginCatalog(): Promise<CatalogEntry[]>;
  /** Ids of installed agents whose manifest differs from the one the catalog lists. */
  outdatedAgents(): Promise<string[]>;
  /** Download and verify a catalog plugin, then return it for review. A view installs with
   *  `installViewPackage(token)`, an agent with `installCatalogAgent(token)`. */
  reviewCatalogPlugin(type: CatalogEntry["type"], id: string): Promise<
    | ({ type: "view" } & { token: string; package: ViewPackageInfo; replacesVersion: string | null })
    | { type: "agent"; token: string; id: string; label: string; bin: string; command: string; flags: string[]; worker: boolean; replaces: boolean; does: string[]; reads?: string; install?: { url: string; command?: string } }
  >;
  installCatalogAgent(token: string): Promise<void>;
  /** Remove an agent you installed; a catalog one is then never added automatically again. */
  removeAgent(id: string): Promise<void>;
  /** Add catalog agents whose CLI was found; what was added and what each can do. Runs once per launch. */
  /** Catalog agents found on this machine and added, and ones brought up to the catalog. */
  autoInstallAgents(): Promise<{ added: Array<{ id: string; label: string; does: string[] }>; updated: Array<{ id: string; label: string }> }>;
  installViewPackage(token: string): Promise<void>;
  removeViewPackage(id: string): Promise<void>;
  /** Main's watchdog saw a plugin frame peg a core for several samples. */
  onViewRunaway(cb: (e: { id: string; cpuPct: number }) => void): () => void;
  // ── identity (R3) ─────────────────────────────────────────
  /** This device's id and the id of the person it is, made the first time they are asked for,
   *  and the name to offer while the profile has none (git's `user.name`, else the account's). */
  identity(): Promise<{ deviceId: string; personId: string; suggestedName: string }>;
  // ── sharing and joining (M1) ──────────────────────────────
  /** An invite link to the workspace `repo` for `role`, for `expiresIn` ms, used once unless `reusable`. */
  share(repo: string, role: "view" | "edit" | "terminals", expiresIn: number, reusable: boolean): Promise<string>;
  /** What an invite link offers, to show before joining; null when the text is not one. */
  joinPreview(text: string): Promise<{ workspace: string; host: string } | null>;
  /** Ask the host a link names to let this person in: the role they were given, or why not. */
  join(text: string): Promise<{ ok: true; role: string; workspace: string } | { ok: false; error: string; message?: string }>;
  /** Someone asks to join a workspace shared from here; answer with `answerJoin`. */
  onJoinRequest(cb: (r: { req: number; profile: { name: string; color: string }; role: string; workspace: string }) => void): () => void;
  answerJoin(req: number, allow: boolean): void;
  /** Who is on the workspace `repo`'s access list, under the names they joined with, and whether
   *  each is connected now. */
  people(repo: string): Promise<SharedPerson[]>;
  /** Give someone on `repo`'s list another role; they are reconnected under it. */
  setRole(repo: string, person: string, role: string): Promise<void>;
  /** Take someone off `repo`'s list: they are disconnected, and their link spent. */
  removePerson(repo: string, person: string): Promise<void>;
  /** The workspaces this person joined elsewhere, newest first. */
  joined(): Promise<Array<{ workspace: string; names: { workspace: string; host: string }; role: string; joinedAt: number; ended?: "left" | "removed" }>>;
  /** How the joined workspace `workspace` is: whose, and where its connection is. */
  sharedStatus(workspace: string): Promise<({ names: { workspace: string; host: string } } & SharedStatus) | null>;
  /** A joined workspace's connection changed. */
  onSharedStatus(cb: (workspace: string, status: SharedStatus) => void): () => void;
  /** Leave a joined workspace: its connection closes, and the last copy is kept to read. */
  leave(workspace: string): Promise<void>;
  // ── your devices (R14, M3, spec/pairing.md) ───────────────
  /** The person's devices this app paired with. */
  devices(): Promise<PairedDeviceSummary[]>;
  /** A device was paired with, or forgotten. */
  onDevicesChanged(cb: () => void): () => void;
  /** A code for another of your devices to enter (a host's `hive host pair <link>`, or another
   *  computer's Settings → Devices): it takes your person. */
  pairOffer(): Promise<{ code: string; link: string; expires: number }>;
  /** Enter the code or link another of your devices shows: a host takes your person; another
   *  computer gives its own, and this computer becomes that person (`took`). */
  pairEnter(text: string): Promise<PairedDeviceSummary & { took: boolean }>;
  /** Forget one of your devices: it is no longer you here. */
  unpair(device: string): Promise<void>;
  /** The workspaces each of your other devices holds; null for one that does not answer. */
  deviceWorkspaces(): Promise<Array<{ device: string; name: string; workspaces: DeviceWorkspace[] | null }>>;
  /** Open a workspace another of your devices holds, as yours: its `hive://` name, to open. */
  openDeviceWorkspace(device: string, workspace: string, name: string): Promise<string>;
  // ── this device's network (R16) ───────────────────────────
  /** The network profile in use: a built-in one (`local`, `hosted`) or one its admin signed. */
  network(): Promise<NetworkProfile>;
  /** Whether its relays answer this device. */
  networkHealth(): Promise<NetworkHealth>;
  /** Use another network: a built-in's name, a network link, or a signed profile. */
  useNetwork(given: string): Promise<NetworkProfile>;
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

  // ── review comments ───────────────────────────────────────
  /** Every comment on this repo, resolved ones included. */
  reviewList(repoPath: string): Promise<ReviewComment[]>;
  /** Replace the whole list — what the diff tile does after an edit. */
  reviewSave(repoPath: string, comments: ReviewComment[]): Promise<void>;

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
  /** Update the current branch from upstream (fast-forward only). */
  gitPull(repoPath: string): Promise<void>;
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

  // ── machines ──────────────────────────────────────────────
  machinesGet(): Promise<MachinesSnapshot>;
  onMachines(cb: (s: MachinesSnapshot) => void): () => void;
  /** Probe, optionally install hive, then save. Errors starting `[attention]` need the user to run `ssh <target>` once. */
  machineAdd(req: MachineAddRequest): Promise<MachineAddResult>;
  machineCheck(id: string): Promise<MachineProbe>;
  machineInstall(id: string): Promise<MachineProbe>;
  machineUpdate(id: string, patch: { label?: string; enabled?: boolean }): Promise<void>;
  /** Change where a machine is (tested before it is saved). The frames on it follow: they name the machine. */
  machineEdit(id: string, patch: { target: string; label?: string; password?: string }): Promise<{ machine: MachineInfo }>;
  /** View protocol 1.3: status ledger lines (see workspace/view-events.ts). */
  viewLedgerAppend(lines: unknown[]): void;
  viewLedgerSnapshot(): Promise<LedgerSince[]>;
  viewHistory(layoutKey: string, day: string): Promise<ViewHistoryDay>;
  /** View protocol 1.4: an agent's past sessions in a folder (id, time, the user's first prompt). */
  viewSessions(agent: string, cwd: string): Promise<ViewSession[]>;
  /** View protocol 1.4: type a prompt the user confirmed into an agent tile and submit it. */
  viewPrompt(tileId: string, text: string): Promise<void>;
  /** Bare tile ids whose output level someone watches (main samples only these). */
  ptyActivityWatch(tileIds: string[]): void;
  onPtyActivity(cb: (levels: Record<string, ActivityLevel>) => void): () => void;
  presenceNow(): Promise<ViewPresence>;
  onPresence(cb: (p: ViewPresence) => void): () => void;
  viewSharePrepare(png: ArrayBuffer): Promise<SharePrepared>;
  viewShareCommit(token: string, action: "copy" | "save" | "cancel", suggestedName: string): Promise<ShareOutcome>;
  machineRemove(id: string): Promise<void>;
  /** Store a password for a machine; false when the OS keychain is unavailable (kept in memory only). */
  machineSetPassword(id: string, password: string): Promise<boolean>;
  /** Sessions in the daemon behind `uri`'s host; null = this computer. */
  machineSessions(uri: string | null): Promise<SessionSummary[]>;
  machineReconnect(hostId: string): Promise<void>;
  /** List a remote directory (for the folder picker). Empty dir → remote home. */
  sshListDir(uri: string, dir: string): Promise<{ dir: string; entries: RemoteDirEntry[] }>;

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
    /** A claude spawn's INITIAL task (▶ Work / spawn-with-work). Delivered as
     *  claude's positional argv (which auto-submits), NOT typed into the booting
     *  TUI — see applyInitialPrompt / HIVE_INITIAL_PROMPT. */
    initialPrompt?: string;
    /** `tileId` names an existing daemon session to show; never start one. */
    attachOnly?: boolean;
    /** With attachOnly: a running session only, not one saved before a reboot. */
    liveOnly?: boolean;
  }): Promise<{ pid: number; /** Another window started it: this one only shows it. */ joined?: boolean }>;
  /** Install the agentic stack (hive skills + CLAUDE.md section) into a repo so
   *  a spawned agent can actually work issues with `hive`. Idempotent. */
  installAgentic(dir: string): Promise<{ ok: boolean }>;
  /** `paste`: a message handed to the TUI as one block, not keystrokes. */
  ptyWrite(tileId: string, data: string, paste?: boolean): void;
  /** Whether any view shows this terminal: bytes reach the renderer only while one does. */
  ptyInterest(tileId: string, shown: boolean): void;
  ptyResize(tileId: string, cols: number, rows: number): void;
  ptyKill(tileId: string): void;
  /** Window closed / tile unmounted: keep the session alive (daemon mode) or
   *  kill it (in-process mode). Distinct from ptyKill, which always terminates. */
  ptyDetach(tileId: string): void;
  /** Renderer back-pressure. `paused=true` stops reading the child's output
   *  (it blocks on a full pty buffer) until `paused=false`. TerminalTile flips
   *  it on xterm's write-queue watermarks so a flood (`cat hugefile`, a runaway
   *  build log) can't outrun the parser and balloon renderer memory. */
  ptyFlow(tileId: string, paused: boolean): void;
  /** Ask for a terminal's keyboard (M2): whoever holds it is asked. */
  keyboardAsk(tileId: string): void;
  /** Give a terminal's keyboard, held here (or its host's, from a host's window), to `to`, who asked. */
  keyboardGive(tileId: string, to: string): void;
  /** Take a terminal's keyboard back: its host's windows only. */
  keyboardTake(tileId: string): void;
  /** Who holds a terminal's keyboard now: null while its host does. */
  onKeyboard(cb: (tileId: string, holder: Typist | null) => void): () => void;
  /** Someone asks this window for a terminal's keyboard, which it holds (or its host does). */
  onKeyboardAsked(cb: (tileId: string, asker: Typist) => void): () => void;
  /** A terminal's session took a size: a window whose own differs draws it at that size. */
  onTerminalSize(cb: (tileId: string, cols: number, rows: number) => void): () => void;
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

  /** The plans the agents of `repo` wait on a person for (M2): each opens beside its agent. */
  planReviews(repo: string): Promise<PlanReview[]>;
  /** Answer the plan `requestId` the agent in `tileId` handed off: allow → the agent proceeds with
   *  the plan; deny + feedback → it stays in plan mode and revises. The first answer is the one it
   *  gets: `answered` false, someone else's came first (`by`). */
  planReviewDecide(
    tileId: string,
    requestId: string,
    decision: "allow" | "deny",
    feedback?: string,
  ): Promise<{ answered: boolean; by: Answerer | null }>;
  /** An agent handed off a plan: every window, on every machine the workspace is shared with. */
  onPlanReview(cb: (review: PlanReview) => void): () => void;
  /** A plan was answered, and by whom; or its agent stopped waiting (`decision` null). */
  onPlanDecided(cb: (decided: PlanDecided) => void): () => void;

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

// Agents' status and links: the workspace API's `status.changed`, `link.pipe`, `link.spawn` and
// `tile.opened` events, under the names the window has always used.
export type {
  PipeChange as HcpPipeEvent,
  SpawnChange as HcpSpawnEvent,
  TileOpened as HcpSpawnedEvent,
  StatusChange as HcpStatusEvent,
} from "@hivemind/workspace-api/agents";

/** Where a tile's current status began, as main remembers it across a renderer reload. */
export interface LedgerSince { id: string; bucket: ViewStatus; since: number; exact: boolean }

/** A PNG a view asked to share, checked and re-encoded by main, awaiting the user's choice. */
export interface SharePrepared { token: string; preview: string; width: number; height: number }


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
