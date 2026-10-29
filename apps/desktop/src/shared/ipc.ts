import type { SessionStatus } from "@hivemind/agent-host/status-store";
/** Typed contract for IPC between main and renderer. */
import type { PageFrame, PageInput } from "./page-input.js";
import type { Issue, IssueSummary, IssueState, AcceptanceItem, Assignee, LinkType, IssuePatch } from "@hivemind/core/types";
import type { ViewManifest } from "@hivemind/view-sdk/manifest";
import type { ServiceState } from "@hivemind/host/services";
import type { ActivityLevel, HostMessage, PluginMessage, ShareOutcome, SurfaceRect, ViewHistoryDay, ViewSession, ViewPresence, ViewStatus } from "@hivemind/view-sdk/protocol";
import type { ViewScreen } from "@hivemind/workspace-api/views";
import type { StartImage } from "@hivemind/workspace-api/agents";
import type { NotificationSettings } from "./notification-settings.js";
import type { RecentSound, SoundMoment, SoundResult } from "@hivemind/workspace-api/notifications";
import type { ReviewComment } from "@hivemind/core/review";
import type { MachineKind } from "@hivemind/core";
import type { LegacyLayout, WorkspaceChange } from "@hivemind/workspace-host/layout";
import type { Participant, PresenceState } from "@hivemind/workspace-host/presence";
import type { NetworkHealth, NetworkProfile } from "@hivemind/workspace-host/network-profile";
import type { Grant } from "@hivemind/host/machine-share";
import type { ClientGrant, NewGrant } from "@hivemind/workspace-api/grants";
export type { Grant };

/** One of the person's other devices, as Settings → Connect lists it (R14, spec/pairing.md). */
export interface PairedDeviceSummary {
  device: string;
  name: string;
  /** "host": `hive host`, always on; "app": someone's own computer; "phone": the phone app, which
   *  runs nothing (spec/pairing.md 0.3). */
  kind: "app" | "host" | "phone";
  pairedAt: number;
}

/** What the person answers a device asking to connect (spec/pairing.md 0.10). */
export type ConnectAnswer = { as: "me" } | { as: "guest"; role: "view" | "edit" | "terminals" } | { as: "no" };

/** A device asking to connect, as the prompt shows it. */
export interface ConnectAsking {
  id: string;
  name: string;
  kind: "app" | "host" | "phone";
  /** Who it says it is: none from a phone. */
  profile: { name: string; color: string } | null;
  /** The words its screen shows too. */
  words: string[];
  /** The answers it may be given besides no: it's me, and someone else. */
  me: boolean;
  guest: boolean;
  /** Told it's me, and waiting on its own person to say the words match. */
  confirming: boolean;
}

/** The offer to connect this app made, while it can be used; the requests; and how the last ended. */
export interface ConnectState {
  offer: { code: string; link: string; page?: string; expires: number } | null;
  requests: ConnectAsking[];
  last: { name: string; as: "me" | "guest" | "refused" } | null;
}

/** Using another computer's offer to connect, as this computer's window shows it: that computer's
 *  name and the words both screens show; and, once it says this computer is its person's, who
 *  that is, for the person here to say whether the words match. */
export interface ConnectEntering {
  name: string;
  words: string[];
  theirs: { name: string; color: string } | null;
}

/** What the join form was given, as `joinPreview` reads it. */
export type JoinPreview =
  | { kind: "join"; workspace: string; host: string }
  | { kind: "connect" | "pair"; name: string }
  | { kind: "words" }
  | null;

/** What using an offer came to: this computer is that person's now; or it was let into their
 *  workspace (its `hive://` name); or the words found a host's code, and it paired as pairEnter. */
export type ConnectEntered =
  | { as: "me"; device: PairedDeviceSummary }
  | { as: "guest"; workspace: string; role: string; names: { workspace: string; host: string } }
  | { as: "paired"; device: PairedDeviceSummary & { took: boolean } };

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
import type { BoardEdit, BoardObject, CoreLayout, ViewLayout } from "@hivemind/workspace-doc/shapes";
export type { NotificationSettings };
export type { AgentChange, AgentEvent, AgentItem } from "@hivemind/workspace-api/agents";
import type { AgentAnswer, AgentChange, AgentEvent, AgentItem, Answerer, PipeChange, SleepAnswer, SpawnChange, StatusChange, TileOpened, WakeAnswer } from "@hivemind/workspace-api/agents";

export type { WidgetOption, WidgetPackage } from "@hivemind/core/widget-format";
import type { WidgetPackage } from "@hivemind/core/widget-format";

export type { ToolPackage } from "@hivemind/core/tool-format";
import type { ToolPackage } from "@hivemind/core/tool-format";
import type { MemberChange } from "@hivemind/core/package-install";
import type { MemberRuns } from "@hivemind/hub";
import type { PackageOf } from "@hivemind/core/plugin-settings";
/** A tool plugin's tile running a program in its folder: found on PATH, no shell. `maxAgeMs`
 *  shares one answer that young between tiles asking the same thing. */
export type ToolRun = { bin: string; args: string[]; cwd: string; maxAgeMs?: number; stdin?: string };
export type ToolRunResult = { code: number; stdout: string; stderr: string };

// IssuePatch is owned by @hivemind/core/types (node-free) — re-export so renderer
// modules keep importing it from the IPC contract, with no hand-maintained copy.
export type { IssuePatch };

/** A registered workspace (subset of the core registry entry — display shape
 *  for the renderer; avoids pulling node-only registry deps into the web tsconfig). */
export interface WorkspaceSummary { repo: string; title: string; tiles: number; needsYou: number; working: number }

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
import type { DiffPayload, DiffScope, GitBranchList, GitStatusSnapshot, HandedOff, WorktreeCreateOpts, WorktreeEntry } from "@hivemind/workspace-api/git";
import type { LastLines, TerminalOpts, Typist } from "@hivemind/workspace-api/terminals";

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
  /** What kind of computer it said it is when last checked. */
  kind?: MachineKind;
  hivePath?: string;
  /** What its frames' ssh:// uris resolve to. */
  hostId: string;
}
export interface MachinesSnapshot {
  machines: MachineInfo[];
  /** What kind of computer this one is, when it says. */
  thisComputerKind?: MachineKind;
  /** By host id, including hosts of frames that are not saved machines, and the person's devices
   *  frames run on (`device:<id>`, M3). */
  status: Record<string, MachineStatus>;
  catalogError?: string;
  /** The person's other devices, where a frame can run too (M3); the window adds them. */
  devices?: PairedDeviceSummary[];
  /** This device's id, which a frame on it in a workspace hosted elsewhere names (M3). */
  self?: string;
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
  /** The check is off (Settings → About and updates): nothing was asked. */
  off?: boolean;
  /** A version already downloaded and waiting for a restart to become the one that
   *  runs (the installer could not replace a live app), when it is newer than this one.
   *  Restarting is then the whole of what is left to do — never another download. */
  staged: string | null;
}

import type { Settings, SharedAppearance } from "@hivemind/core/settings-schema";
import type { CatalogEntry, SkippedEntry } from "@hivemind/hub";

/** An installed package, as the Plugins page lists it: each member with where its code runs, and
 *  the version before this one when there is one to roll back to. */
export interface InstalledPackageInfo {
  id: string; name: string; version: string; on: boolean;
  members: Array<{ kind: string; id: string; runs: MemberRuns }>;
  previous: { version: string; on: boolean } | null;
}

/** What installing a package would do, found by installing nothing (`installPackage` with
 *  `dryRun`, as `hive plugins install --dry-run`): each member, where it runs and what it asks
 *  for, and how each differs from the version installed. Installed with its `token`. */
export interface PackageReview {
  token: string; id: string; name: string; version: string;
  /** Whether it is on once installed. */
  on: boolean;
  /** The version it replaces, and whether that one is on. */
  replaces: { version: string; on: boolean } | null;
  /** The view it opens with (its manifest's `startup.view`), which the app offers once it is installed. */
  opens: { id: string; name: string } | null;
  /** The live wallpaper it offers as the background (its manifest's `startup.wallpaper`), which the
   *  app offers once it is installed. */
  wallpaper: { id: string; name: string } | null;
  members: Array<{ kind: string; id: string; name: string; permissions: string[]; runs: MemberRuns }>;
  changes: Array<MemberChange & { name: string; runs: MemberRuns }>;
}

/** A live wallpaper an installed package holds, as main lists it (main/wallpaper-packages.ts). */
export interface WallpaperPackageInfo {
  /** `@owner/package/name`: what `appearance.wallpaper.kind` holds to draw it. */
  id: string;
  name: string;
  description: string | null;
  /** It draws in colours of its own when the person turns Colour on. */
  colour: boolean;
  /** Its picture for the picker, as a data URL. */
  preview: string | null;
  package: { id: string; name: string; on: boolean };
  /** Where its frame loads from: null when its package is off or it cannot be read. */
  url: string | null;
  /** Why it cannot be used, or null. */
  error: string | null;
}

/** One community view package as the main process sees it (see main/view-packages.ts). */

export interface ViewPackageInfo {
  id: string;
  dir: string;
  source: "user" | "repo" | "app" | "host";
  manifest: ViewManifest | null;
  /** Its manifest's .svg icon, as a data URL. */
  icon?: string;
  error: string | null;
  url: string | null;
  /** The package it was installed with, for one installed. */
  package?: PackageOf;
}

// ── full IPC surface ──────────────────────────────────────────────────────

/** Settings → Advanced → In a browser: whether the app is served, at which link, or why not. */
/** `url` is this computer's link; `others`, the same key at each of the person's other names. */
export interface BrowserAppStatus { on: boolean; url: string | null; others: string[]; error: string | null }

/** A Browser tile's page asks for something (`permissions`: "camera", "microphone", "geolocation",
 *  "notifications"…) and the tile showing page `pageId` asks the person; or that ask is over
 *  (`done`), answered or not. */
export type BrowserPermissionEvent =
  | { askId: number; pageId: number; site: string; permissions: string[] }
  | { askId: number; done: true };

/** A right a site in a Browser tile may be given ("notifications", "camera",
 *  "openExternal:mailto"…) and the person's answer for it, until the app quits: "ask" when none. */
export interface SiteRight { right: string; answer: "allow" | "block" | "ask" }

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
  /** The board's objects with these ids, by id (null: not there). */
  workspaceObjectsWithIdsSync(repo: string, ids: string[]): Record<string, BoardObject | null> | null;
  /** Write the objects this window changed, each with the one it changed it from. Synchronous, so a
   *  write made while the window unloads is kept. */
  workspaceEditObjectsSync(repo: string, edit: BoardEdit): void;
  /** Take back the last board edit; false when there is none. */
  workspaceUndoSync(repo: string): boolean | null;
  /** Make again the last board edit undo took back; false when there is none. */
  workspaceRedoSync(repo: string): boolean | null;
  /** Another writer (the control plane, another window) changed a workspace. */
  onWorkspaceChanged(cb: (change: Pick<WorkspaceChange, "repo" | "part" | "objects">) => void): () => void;
  /** The workspace this window shows now (null: none), and the frame the user is in there, for
   *  the control plane to act on when its caller is in no tile. */
  workspaceShown(repo: string | null, frame: string | null): void;
  /** Where this window's person is in the workspace `repo` (M1): their pointer on the board and
   *  what they have selected; null: they left it. */
  boardPresenceSet(repo: string, state: PresenceState | null): void;
  /** Who is in a workspace now, each as they last said, as it changes: every workspace's. */
  onBoardPresence(cb: (repo: string, people: Participant[]) => void): () => void;
  /** The widget `id` in `repo` drew `tree` (its code runs in this window). */
  widgetDraw(repo: string, id: string, tree: unknown): void;
  /** What each widget in `repo` last drew, by id. */
  widgetsDrawn(repo: string): Promise<Record<string, unknown>>;
  onWidgetDrawn(cb: (repo: string, id: string, tree: unknown) => void): () => void;
  /** A widget pressed where its code does not run: told to the window that runs it. */
  widgetPress(repo: string, id: string, press: { action: unknown } | { click: true }): void;
  onWidgetPressed(cb: (repo: string, id: string, press: { action?: unknown; click?: true }) => void): () => void;
  /** Whether this window runs `repo`'s widgets (one window per workspace does). */
  widgetRun(repo: string): Promise<boolean>;
  /** The widgets installed where `repo` is hosted (its host's, for one joined from elsewhere). */
  widgetPackagesOf(repo: string): Promise<WidgetPackage[]>;
  widgetRelease(repo: string): void;
  /** Nobody runs `repo`'s widgets now. */
  onWidgetRunner(cb: (repo: string) => void): () => void;

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
  settingsPath(): Promise<string>;
  onSettingsChanged(cb: (s: Settings) => void): () => void;
  // ── community views ───────────────────────────────────────
  /** Installed view packages (user dir + this repo's .hivemind/views), each
   *  with its load URL or the reason it will not load. Rescans on every call. */
  listViews(repoRoot: string | null): Promise<ViewPackageInfo[]>;
  /** The live wallpapers installed packages hold, each with where its frame loads from or why it
   *  cannot be used. Rescans on every call. */
  listWallpapers(): Promise<WallpaperPackageInfo[]>;
  viewOpen(id: string, workspace: string, screen: ViewScreen): Promise<{ session: string }>;
  viewPost(session: string, message: PluginMessage, workspace: string): void;
  viewScreen(session: string, screen: ViewScreen, workspace: string): void;
  viewClose(session: string, workspace: string): Promise<{ closed: boolean }>;
  onViewSaid(cb: (session: string, message: HostMessage) => void): () => void;
  onViewRects(cb: (session: string, rects: SurfaceRect[]) => void): () => void;
  onViewEnded(cb: (session: string, why: string) => void): () => void;
  /** Agent providers on disk. Only manifests cross — a def carries detect(). */
  listAgents(repoRoot: string | null): Promise<{
    agents: Array<{ id: string; file: string; source: "user" | "repo"; manifest: unknown; error: string | null; disabled: boolean }>;
    shadowed: Array<{ id: string; by: string; over: string }>;
  }>;
  /** Where each agent's CLI was found on PATH (null = not installed). Runs nothing. */
  agentPresence(): Promise<Record<string, { path: string | null }>>;
  /** Found, and answering `--version` like a CLI (not a same-named program). */
  verifyAgent(id: string): Promise<{ path: string | null; version?: string; mismatch?: string; searchedPath?: string }>;
  /** The values each of an agent's options takes, read from its CLI. Cached per binary version. */
  agentOptionChoices(id: string): Promise<Record<string, { values: string[]; from: "help" | "list" | null; error?: string }>>;
  /** The published plugin catalog (hash-pinned agents and views). */
  pluginCatalog(): Promise<CatalogEntry[]>;
  /** The catalog's entries this app cannot read, each with why; the rest are listed. */
  pluginCatalogSkipped(): Promise<SkippedEntry[]>;
  /** A plugin's README: from its folder here (`dir`), or from the catalog for one not installed. */
  pluginReadme(from: { dir: string } | { catalog: { type: CatalogEntry["type"]; id: string } }): Promise<string | null>;
  /** The widget packages installed on this machine. */
  listWidgets(): Promise<WidgetPackage[]>;
  removeWidget(id: string): Promise<void>;
  /** An image of the widget package `widget`, as the host of `repo` has it: for a guest without it. */
  widgetAsset(repo: string, widget: string, name: string): Promise<string | null>;
  /** The agents in the workspace at `repo`, and the feed's position (the workspace API's `agent.list`). */
  agentList(repo: string): Promise<{ seq: number; agents: AgentItem[] }>;
  /** What `repo`'s agent readers were told after `seq`; null: list again. */
  agentSince(repo: string, seq: number): Promise<{ seq: number; changes: AgentChange[]; events: AgentEvent[] } | null>;
  /** Answer what the agent in `tile` waits on, the wait that began at `since`: a plan, a
   *  supervised tool use, its screen. `answered` false: it waits on that no more, or someone
   *  answered first (`by`). */
  agentAnswer(tile: string, since: number, answer: AgentAnswer): Promise<{ answered: boolean; by?: Answerer }>;
  /** Put to sleep the agents of `target` in the workspace at `repo` (a tile or a frame; none: all). */
  agentSleep(repo: string, target?: string, force?: boolean): Promise<SleepAnswer>;
  /** Wake the sleeping agents of `target` in the workspace at `repo` (none: all). */
  agentWake(repo: string, target?: string): Promise<WakeAnswer>;
  onAgentChanged(cb: (repo: string, change: AgentChange) => void): () => void;
  onAgentEvent(cb: (repo: string, event: AgentEvent) => void): () => void;
  /** The installed widget packages changed. */
  onWidgetsChanged(cb: () => void): () => void;
  /** The tool plugins installed here, and whether the app started in safe mode (every one off). */
  toolPackages(): Promise<{ packages: ToolPackage[]; safeMode: boolean }>;
  /** What each host module a tool plugin imports exports, by name (once, before the first loads). */
  toolHostExports(map: Record<string, string[]>): Promise<void>;
  removeToolPackage(id: string): Promise<void>;
  /** A tool plugin's tile running a program in its folder. */
  toolRun(call: ToolRun): Promise<ToolRunResult>;
  /** The installed tool plugins changed. */
  onToolsChanged(cb: () => void): () => void;
  /** The folders of the workspaces on this machine: what a program's grant may name. */
  hostWorkspaces(): Promise<string[]>;
  /** How each tool plugin's service is. */
  services(): Promise<ServiceState[]>;
  /** The end of what a tool plugin's service printed. */
  serviceLog(plugin: string): Promise<string>;
  /** A service started, stopped or is starting again. */
  onServicesChanged(cb: () => void): () => void;
  /** Ids of installed agents whose manifest differs from the one the catalog lists. */
  outdatedAgents(): Promise<string[]>;
  /** Download and verify a catalog plugin, then return it for review. A view installs with
   *  `installViewPackage(token)`, an agent with `installCatalogAgent(token)`, a widget with
   *  `installCatalogWidget(token)`, a tool with `installCatalogTool(token)`, a package with
   *  `installCatalogPackage(token)`. */
  reviewCatalogPlugin(type: CatalogEntry["type"], id: string): Promise<
    | ({ type: "view" } & { token: string; package: ViewPackageInfo; replacesVersion: string | null })
    | { type: "agent"; token: string; id: string; label: string; bin: string; command: string; flags: string[]; worker: boolean; replaces: boolean; does: string[]; reads?: string; install?: { url: string; command?: string } }
    | { type: "widget"; token: string; id: string; name: string; permissions: string[]; code: boolean; replaces: boolean }
    | { type: "tool"; token: string; id: string; name: string; permissions: string[]; tools: string[]; service?: string; replacesVersion: string | null }
    | ({ type: "package" } & PackageReview)
  >;
  installCatalogAgent(token: string): Promise<void>;
  installCatalogWidget(token: string): Promise<void>;
  /** Installed off, as every tool plugin is until switched on. */
  installCatalogTool(token: string): Promise<void>;
  /** Every member at once; on or off as the review said. */
  installCatalogPackage(token: string): Promise<void>;
  /** Remove an agent you installed; a catalog one is then never added automatically again. */
  removeAgent(id: string): Promise<void>;
  /** Add catalog agents whose CLI was found; what was added and what each can do. Runs once per launch. */
  /** Catalog agents found on this machine and added, and ones brought up to the catalog. */
  autoInstallAgents(): Promise<{ added: Array<{ id: string; label: string; does: string[] }>; updated: Array<{ id: string; label: string }> }>;
  installViewPackage(token: string): Promise<void>;
  removeViewPackage(id: string): Promise<void>;
  /** Switch a plugin you added on or off: with its package, which a package of one is all of. */
  switchPlugin(kind: "view" | "widget" | "tool", id: string, on: boolean): Promise<void>;
  /** The packages installed here, each with its switch and its members by kind and id. */
  installedPackages(): Promise<InstalledPackageInfo[]>;
  /** Switch a whole package on or off. */
  switchPackage(id: string, on: boolean): Promise<void>;
  /** Put back the version of a package in use before its last update, switched as it was. */
  rollbackPackage(id: string): Promise<void>;
  /** Review a folder the person picks, a package or one plugin, as an install would check it;
   *  null when they pick none. */
  reviewPackageFolder?(): Promise<PackageReview | null>;
  /** Install the folder last reviewed. */
  installPackageFolder?(token: string): Promise<void>;
  /** The packages whose start view (`startup.view`) or live wallpaper (`startup.wallpaper`) this
   *  window should offer now, given the views it loaded, the one it shows and the background it
   *  draws; each is recorded as offered, so it is offered once. Only the window the person is at is
   *  offered any. */
  startViewOffers?(registered: string[], showing: string | null, background?: string): Promise<Array<{ package: string; name: string; view: string | null; wallpaper: string | null }>>;
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
  /** What `text` is, before using it: an invite link (whose workspace), another computer's offer
   *  to connect or a host's pairing link (the device's name), six words, or nothing to use. */
  joinPreview(text: string): Promise<JoinPreview>;
  /** Ask the host a link names to let this person in: the role they were given, or why not. */
  join(text: string): Promise<{ ok: true; role: string; workspace: string } | { ok: false; error: string; message?: string }>;
  /** Someone asks to join a workspace of this person's (`repo`: as this window names it): answer
   *  with `answerJoin`. */
  onJoinRequest(cb: (r: { repo: string; req: number; profile: { name: string; color: string }; role: string; workspace: string }) => void): () => void;
  /** A question about someone asking to join was answered, here or at another of the person's
   *  devices, or nobody answered it in time. */
  onJoinAnswered(cb: (repo: string, req: number) => void): () => void;
  answerJoin(repo: string, req: number, allow: boolean): void;
  /** Who is on the workspace `repo`'s access list, under the names they joined with, and whether
   *  each is connected now. */
  people(repo: string): Promise<SharedPerson[]>;
  /** Give someone on `repo`'s list another role; they are reconnected under it. */
  setRole(repo: string, person: string, role: string): Promise<void>;
  /** Take someone off `repo`'s list: they are disconnected, and their link spent. */
  removePerson(repo: string, person: string): Promise<void>;
  /** The programs let drive workspaces here (the drive socket). */
  grants(): Promise<ClientGrant[]>;
  /** Let a program drive workspaces here: its grant, and its token, shown this once. */
  grantCreate(grant: NewGrant): Promise<{ grant: ClientGrant; token: string }>;
  /** Take a program's grant back; its connections close. */
  grantRevoke(id: string): Promise<{ revoked: boolean }>;
  /** The workspaces this person joined elsewhere, newest first. */
  joined(): Promise<Array<{ workspace: string; names: { workspace: string; host: string }; role: string; joinedAt: number; ended?: "left" | "removed" }>>;
  /** How the joined workspace `workspace` is: whose, and where its connection is. */
  sharedStatus(workspace: string): Promise<({ names: { workspace: string; host: string } } & SharedStatus) | null>;
  /** A joined workspace's connection changed. */
  onSharedStatus(cb: (workspace: string, status: SharedStatus) => void): () => void;
  /** How the joined workspace `workspace`'s host looks, checked; null before it says. */
  sharedLooks(workspace: string): Promise<SharedAppearance | null>;
  /** A joined workspace's host changed how it looks. */
  onSharedLooks(cb: (workspace: string, appearance: SharedAppearance) => void): () => void;
  /** Leave a joined workspace: its connection closes, and the last copy is kept to read. */
  leave(workspace: string): Promise<void>;
  /** What this person lets the people in the joined workspace `workspace` do on this computer, in
   *  frames of theirs here (M4): watch, type into what runs here, or run agents here too. */
  machineGrant(workspace: string): Promise<Grant>;
  /** Let them do `grant` here from now on; the workspace's host is told at once. */
  setMachineGrant(workspace: string, grant: Grant): Promise<void>;
  /** Hand off the branch checked out in this person's frame `uri` on this computer to the host of
   *  the joined workspace `workspace` (M4): the branch it landed as there, which a Diff tile on the
   *  board shows against the host's. */
  handOff(workspace: string, uri: string): Promise<HandedOff>;
  // ── your devices (R14, M3, spec/pairing.md) ───────────────
  /** The person's devices this app paired with. */
  /** The app in a browser: served or not, and the link that signs a tab in. */
  browserAppStatus(): Promise<BrowserAppStatus>;
  onBrowserAppChanged(cb: (status: BrowserAppStatus) => void): () => void;
  devices(): Promise<PairedDeviceSummary[]>;
  /** A device was paired with, or forgotten. */
  onDevicesChanged(cb: () => void): () => void;
  /** Offer to connect (spec/pairing.md 0.10), from the window showing `repo` (null: Home): a code,
   *  its link and the phone page's address for it. Whoever uses it only asks; the person answers
   *  each request with `connectAnswer`. A new offer voids the last. */
  connectOffer(repo: string | null): Promise<NonNullable<ConnectState["offer"]>>;
  connectCancel(): Promise<void>;
  connectState(): Promise<ConnectState>;
  onConnectChanged(cb: (state: ConnectState) => void): () => void;
  connectAnswer(id: string, answer: ConnectAnswer): Promise<void>;
  /** Use another computer's offer, its link or its words (the words of a host's code pair with
   *  it, as pairEnter): `onConnectEntering` says what to show meanwhile, and `connectSure` is the
   *  person's word that the words match, once that computer says this one is its person's. */
  connectEnter(text: string): Promise<ConnectEntered>;
  onConnectEntering(cb: (entering: ConnectEntering | null) => void): () => void;
  connectSure(yes: boolean): Promise<void>;
  /** The hash of the phone page at `page`, worked out from what its server serves, and of the
   *  page this build goes with (null: a build made without one). */
  phonePage(page: string): Promise<{ served: string; shipped: string | null }>;
  /** Enter the code or link another of your devices shows: a host takes your person; another
   *  computer gives its own, and this computer becomes that person (`took`). */
  pairEnter(text: string): Promise<PairedDeviceSummary & { took: boolean }>;
  /** Forget one of your devices: it is no longer you here. */
  unpair(device: string): Promise<void>;
  /** The workspaces each of your other devices holds; null for one that does not answer. */
  deviceWorkspaces(): Promise<Array<{ device: string; name: string; workspaces: DeviceWorkspace[] | null }>>;
  /** Open a workspace another of your devices holds, as yours: its `hive://` name, to open. */
  openDeviceWorkspace(device: string, workspace: string, name: string): Promise<string>;
  /** Move the workspace `repo`, hosted here, to another of your devices (M3): whoever is in it
   *  follows, and its frames here stay here. Its `hive://` name, to open it by from now on. */
  moveHosting(repo: string, device: string): Promise<string>;
  /** This computer's folder of `workspace`, when it was moved from here to another of your devices
   *  (M3); null for any other. */
  folderHere(workspace: string): Promise<string | null>;
  /** Move `workspace`, moved from here, back from the device hosting it (M3): whoever is in it
   *  follows. Its folder, to open it by again. */
  moveHostingHere(workspace: string): Promise<string>;
  /** Host `workspace`, moved from here, on this computer again from the copy kept here, while the
   *  device hosting it cannot be reached (M3): whoever is in it finds it here. Its folder. */
  takeOver(workspace: string): Promise<string>;
  // ── this device's network (R16) ───────────────────────────
  /** The network profile in use: a built-in one (`local`, `hosted`) or one its admin signed. */
  network(): Promise<NetworkProfile>;
  /** Whether its relays answer this device. */
  networkHealth(): Promise<NetworkHealth>;
  /** Use another network: a built-in's name, a network link, or a signed profile. */
  useNetwork(given: string): Promise<NetworkProfile>;
  /** The network in use changed, here or by `hive network use`. */
  onNetworkChanged(cb: () => void): () => void;
  // ── app version + self-update ─────────────────────────────
  /** This app's version string (from apps/desktop/package.json). */
  getAppVersion(): Promise<string>;
  /** Check the latest GitHub release and compare to the running version. Done
   *  in MAIN (renderer CSP blocks the github.com fetch). Never rejects — a
   *  failed check resolves with `latest: null`. */
  checkForUpdate?(): Promise<UpdateStatus>;
  /** Run the official installer (the same `install.sh` flow `hivemind upgrade`
   *  uses) and resolve with its exit status. Does NOT quit — the renderer shows
   *  the result and then calls `relaunchApp()` to restart into the new version.
   *  `ok` is true iff the installer exited 0. */
  runUpgrade?(): Promise<{ ok: boolean; code: number | null }>;
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
  pickProjectFolder?(): Promise<string | null>;
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
  /** Every workspace here, with how many tiles it has and how many of them need you or work. */
  workspaceSummaries(): Promise<WorkspaceSummary[]>;
  /** Delete the board of the workspace at `repo` from this computer; its folder stays. Refused
   *  while a terminal of it runs. */
  removeWorkspace(repo: string): Promise<void>;
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
  openPathInApp?(cwd: string, target: string): Promise<{ ok: boolean; error?: string }>;

  /** Append one diagnostics line to userData/render-diag.log (auto-rotated).
   *  Used by the terminal render-quality probe so blurry-text reports can be
   *  read off disk (incl. over SSH) instead of only on-screen. */
  diagLog(line: string): Promise<void>;

  // ── machines ──────────────────────────────────────────────
  machinesGet(): Promise<MachinesSnapshot>;
  onMachines(cb: (s: MachinesSnapshot) => void): () => void;
  /** Reach it, put this version's hive there, then save. Errors starting `[attention]` need the user to run `ssh <target>` once. */
  machineAdd(req: MachineAddRequest): Promise<MachineAddResult>;
  machineCheck(id: string): Promise<MachineProbe>;
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
  /** Watch the last lines of these tiles (bare ids), in place of those this window watched (none:
   *  it watches none). Answered with each one's line now, for those that showed one. */
  tileLinesWatch(tileIds: string[]): Promise<{ lines: LastLines }>;
  /** The last lines of these tiles now, once, watching nothing: an agent's words read first. */
  tileLinesRead(tileIds: string[]): Promise<{ lines: LastLines }>;
  /** The watched tiles whose last line changed, each with its line now ("": it shows none). */
  onTileLines(cb: (change: { lines: LastLines }) => void): () => void;
  presenceNow(): Promise<ViewPresence>;
  onPresence(cb: (p: ViewPresence) => void): () => void;
  viewSharePrepare?(png: ArrayBuffer): Promise<SharePrepared>;
  viewShareCommit?(token: string, action: "copy" | "save" | "cancel", suggestedName: string): Promise<ShareOutcome>;
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
  ptySpawn(opts: TerminalOpts): Promise<{ pid: number; /** Another window started it: this one only shows it. */ joined?: boolean; /** It sleeps: nothing was started. */ asleep?: true }>;
  /** What the agent in `tileId`, put to sleep, last showed, with its newest `lines`; null when it does not sleep. */
  ptySaved(tileId: string, lines?: number): Promise<string | null>;
  /** Install the agentic stack (hive skills + CLAUDE.md section) into a repo so
   *  a spawned agent can actually work issues with `hive`. Idempotent. */
  installAgentic(dir: string): Promise<{ ok: boolean }>;
  /** `paste`: a message handed to the TUI as one block, not keystrokes. */
  ptyWrite(tileId: string, data: string, paste?: boolean): void;
  /** A photo pasted into the terminal, kept on the machine its session runs on: its path. */
  ptyPhoto(tileId: string, image: StartImage): Promise<{ path: string }>;
  /** Whether any view shows this terminal: bytes reach the renderer only while one does. */
  ptyInterest(tileId: string, shown: boolean): void;
  /** Send this terminal's screen again with `lines` of its scrollback. */
  ptyHistory(tileId: string, lines: number): void;
  ptyResize(tileId: string, cols: number, rows: number): void;
  /** Size the session to this window's `cols` × `rows` now, as typing here would. */
  ptyFit(tileId: string, cols: number, rows: number): void;
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
  /** Someone types into a terminal this window shows: at most once a second while they type on. */
  onTyping(cb: (tileId: string, by: Typist) => void): () => void;

  // ── notifications ─────────────────────────────────────────
  /** Forward a notable agent-status transition to main's notice desk, which dedupes every
   *  window's copy, shows the OS pop-up while no window has the focus, and picks the window that
   *  plays a sound (notice-desk.ts). Fire-and-forget. */
  notifyAgent?(notice: AgentNotice): void;
  /** Main asks this window to play a sound (`notify:sound`); answer with `soundResult`. */
  onSound?(cb: (sound: SoundRequest) => void): () => void;
  /** What became of sound `id`: played (with the theme's pack, if it was one), or blocked and why. */
  soundResult?(result: SoundResult): void;
  /** The last 10 bursts the desk saw: their moment, agents, sound and pop-ups (newest first):
   *  the workspace API's `notifications.recentSounds`. */
  recentSounds?(): Promise<RecentSound[]>;
  /** Play `moment`'s sound now in the window the person is at, as Settings' Play does: the
   *  workspace API's `notifications.play`. */
  playSound?(moment: SoundMoment): Promise<SoundResult>;
  /** The bytes of one of the applied theme's sounds (its `hivemedia:` URL), which a window cannot
   *  fetch itself; any other URL is refused. */
  themeSoundBytes?(url: string): Promise<Uint8Array>;
  /** A widget's `hive.notify`, from the window that runs its code: main shows it as an OS notice
   *  when the notification settings allow, at most one per widget in 10 s. Fire-and-forget. */
  notifyWidget?(notice: WidgetNotice): void;
  /** What the Layers panel shows of the workspace in `repo`: its tiles in the order listed, and
   *  the pinned ones (the person's phone's Home lists them so). */
  layersShown(repo: string, shown: { order: string[]; pinned: string[] }): void;
  /** The folders the person opened lately, here and on saved machines (`machine://`), newest
   *  first: their phone starts agents there. */
  recentFolders(folders: string[]): void;

  // ── BrowserTile <webview> ↔ agent CDP bridge ──────────────
  /** A BrowserTile reports its guest <webview>'s webContents id (plus its frame
   *  and current URL) so the main process can attach the debugger AND write the
   *  discovery file the `hive-browser` skill reads. Called on dom-ready + on nav. */
  browserRegister?(tileId: string, webContentsId: number, frameId: string | null, url: string): void;
  /** Send a raw Chrome DevTools Protocol command to the tile's guest page
   *  (auto-attaches on first use). Navigate / click / read DOM / screenshot /
   *  evaluate — the surface an agent uses to "use" the browser. */
  browserCdp?(tileId: string, method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Watch a tile's page from where there is no web view (a browser tab the app serves): its
   *  pictures arrive through `onBrowserFrame`, each acknowledged with `browserFrameShown` once
   *  drawn. Says whether the app window holding it draws (not minimized or hidden). */
  browserWatch(tileId: string): Promise<{ shown: boolean }>;
  browserUnwatch(tileId: string): void;
  browserFrameShown(tileId: string): void;
  /** Click, scroll, type or go somewhere on a watched page. */
  browserInput(tileId: string, input: PageInput): Promise<void>;
  onBrowserFrame: (cb: (tileId: string, frame: PageFrame) => void) => () => void;
  /** The app window holding a watched page started or stopped drawing it. */
  onBrowserPageShown: (cb: (tileId: string, shown: boolean) => void) => () => void;
  /** A watched page closed. */
  onBrowserPageGone: (cb: (tileId: string) => void) => () => void;
  /** In the app window: a tile's page is watched from elsewhere, so it must keep drawing. */
  onBrowserWatched: (cb: (tileId: string, watched: boolean) => void) => () => void;
  /** The person's answer to a Browser tile page's ask (`onBrowserPermission`). */
  answerBrowserPermission?(askId: number, allowed: boolean): void;
  /** The rights a site (an origin) in a Browser tile is asked about, each with the person's answer. */
  browserSiteRights?(site: string): Promise<SiteRight[]>;
  /** Answer for `site` before it asks, or change or forget ("ask") an answer. */
  setBrowserSiteRight?(site: string, right: string, answer: SiteRight["answer"]): Promise<void>;
  /** Agent-browser bridge settings for the in-app toggle. `active` = live this
   *  session; `enabled` = persisted choice (applies on next launch). */
  getBrowserSettings?(): Promise<{ active: boolean; enabled: boolean; port: string }>;
  /** Persist the agent-browser bridge on/off choice (applies after relaunch). */
  setBrowserCdpEnabled?(enabled: boolean): Promise<{ ok: true }>;
  /** Restart the app so a settings change that needs a fresh launch takes hold. */
  relaunchApp?(): Promise<void>;
  /** Quit as a person does: asks first when agents or terminals run here (`onQuitAsk`). */
  quit?(): Promise<void>;
  /** Quit and stop every agent and terminal here, without asking. */
  quitAndStopEverything?(): Promise<void>;
  /** The answer to `onQuitAsk`. */
  answerQuit?(answer: QuitAnswer): Promise<void>;
  /** Main asks whether what runs here keeps running after the app quits. */
  onQuitAsk?(cb: (q: QuitQuestion) => void): () => void;


  /** Reply to a main→renderer HCP command (a control-plane verb that needs the
   *  canvas, e.g. plugin.open). `id` correlates with the pushed command. */
  /** `code`: why it failed, as the workspace API says it (`NOT_FOUND`, `TIMEOUT` …); another is FAILED. */
  hcpResult?(id: string, ok: boolean, result?: unknown, errorMessage?: string, code?: string): Promise<void>;
}

/** What runs as the person quits: agents and terminals on this computer, and agents on other
 *  machines, which keep running there whatever the answer. */
export interface QuitQuestion {
  agents: number;
  terminals: number;
  elsewhere: number;
  /** The background process did not say what runs in it, so the counts are not known. */
  uncounted?: true;
}
/** `remember`: keep the choice in settings and stop asking. */
export interface QuitAnswer { choice: "keep-running" | "stop-everything" | "cancel"; remember: boolean }

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


/** A widget's `hive.notify`: the widget `widget` on the board of `repo`, its name as the title, and
 *  the text its code sent, as it sent it. */
export interface WidgetNotice { repo: string; widget: string; title: string; text: unknown }

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
  /** The tile is selected in the window that sent this (main counts it only while that window
   *  has the focus): a finished sound for it is skipped. */
  selected?: boolean;
  /** When the host saw the state start (`SessionStatus.since`), the same in every window: copies
   *  with it are one change however late one comes. Absent for a status only the window knows. */
  since?: number;
}

/** A sound main asks a window to play (`notify:sound`). */
export interface SoundRequest {
  id: number;
  moment: AgentNotice["kind"];
  /** How many agents it stands for. */
  count: number;
  /** 0–1. */
  volume: number;
  /** The applied theme's sound for this moment (a `hivemedia:` URL) and the theme's name; none:
   *  the built-in sound. */
  theme?: { url: string; pack: string };
}

/** What became of a sound (`notify:sound-result`), and one burst of Recent: the drive socket's
 *  shapes (workspace-api notifications.ts). */
export type { RecentSound, SoundResult } from "@hivemind/workspace-api/notifications";

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

/** `window.hive`: the IPC surface, and what only a window has. */
/** Installed themes as Settings ▸ Appearance lists them (`theme-apply.ts`). */
export interface ThemesInfo {
  themes: Array<{ id: string; name: string; mode: "dark" | "light"; swatches: string[]; package: { id: string; name: string; version: string } }>;
  /** The applied theme against what is installed: a newer version, or its package gone. */
  status: { update: string | null; removed: boolean } | null;
}

export type HiveApi = HiveIpc & {
  /** Host OS, exposed synchronously so the first canvas can pick a shell. */
  platform: NodeJS.Platform;
  /** This window is a browser tab the app serves: its clipboard is the viewer's, not the host's. */
  inABrowserTab?: true;
  /** Main asks the renderer to run a control-plane canvas verb (HCP). */
  onHcpCommand: (cb: (cmd: HcpCommand) => void) => () => void;
  /** An agent pipe was created or removed. */
  onHcpPipe: (cb: (e: PipeChange) => void) => () => void;
  /** An agent spawned another, or that link ended. */
  onHcpSpawn: (cb: (e: SpawnChange) => void) => () => void;
  /** The control plane is opening a tile: its prompt, and whether to bring it forward. */
  onHcpSpawned: (cb: (e: TileOpened) => void) => () => void;
  /** An agent session's status changed (the host's status store). */
  onHcpStatus: (cb: (e: StatusChange) => void) => () => void;
  /** Every agent session's status now — what a (re)loaded window starts from. */
  hcpStatusAll: () => Promise<Array<{ tileId: string; status: StatusChange["status"] }>>;
  /** The agent pipes and spawn wires there are now — what a (re)loaded window starts from. */
  hcpLinks: () => Promise<{ pipes: Array<{ src: string; dst: string }>; spawns: Array<{ parent: string; child: string }> }>;
  /** A background subsystem hit a non-fatal error → surface as a toast. */
  onAppError: (cb: (e: AppErrorEvent) => void) => () => void;
  onPtyData: (tileId: string, cb: (data: string) => void) => () => void;
  onPtyExit: (
    tileId: string,
    /** `slept`: it was put to sleep, and is not gone. */
    cb: (info: { code: number; signal?: number; slept?: true }) => void
  ) => () => void;
  onFsChanged: (
    repoPath: string,
    cb: (info: { paths: string[] }) => void
  ) => () => void;
  /** The sessions (agents mid-turn) a terminal daemon of another protocol waits on before it is
   *  replaced; null when none waits. */
  daemonWaitingOn?: () => Promise<string[] | null>;
  onDaemonWaiting: (cb: (ids: string[] | null) => void) => () => void;
  /** Stop waiting: those agents are put to sleep now, ending their turns, and woken in the new daemon. */
  restartAgentsNow?: () => Promise<void>;
  /** Path passed on the CLI (`hivemind .` / `hivemind /repo`), or null. */
  getLaunchTarget?: () => Promise<string | null>;
  /** Another window, on the workspace this one shows. */
  newWindow?: () => Promise<void>;
  /** A second `hivemind <path>` invocation asks the running window to switch. */
  onOpenProject: (cb: (path: string) => void) => () => void;
  /** A key main took before the page, as its keymap action (shared/keymap.ts). */
  onMenuShortcut?: (cb: (action: string) => void) => () => void;
  /** Resolve a picked File's absolute path (persistent video wallpaper). */
  getPathForFile?: (file: File) => string;
  /** Where this window loads a URL of the app's schemes (a view, a tool's module, a wallpaper):
   *  the URL itself in an app window, a path on the browser server in a tab. */
  resourceUrl(url: string): string;
  /** The themes installed packages hold, and how the applied one stands (an update, a removed package). */
  themes?: {
    list(): Promise<ThemesInfo>;
    /** Apply an installed theme over the look in use; the settings broadcast carries the result. */
    apply(id: string): Promise<void>;
    /** Back to the look before the theme. */
    revert(): Promise<void>;
  };
  /** Pick a custom media file for a canvas layer (background/overlay) → copied
   *  into userData/media and served via the sandboxed hivemedia:// protocol. */
  pickMedia?: (slot: string) => Promise<{ url: string; kind: "video" | "image"; name: string } | null>;
  /** A BrowserTile guest requested a popup/new window (target=_blank,
   *  window.open) — the owning tile opens it as a new tab. */
  onBrowserPopup: (cb: (p: { fromId: number; url: string }) => void) => () => void;
  /** A BrowserTile guest asks for the camera, the location… (or that ask is over): the owning tile
   *  asks the person. */
  onBrowserPermission: (cb: (e: BrowserPermissionEvent) => void) => () => void;
};
