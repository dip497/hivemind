/**
 * The agent-provider contract. ONE registration per CLI coding agent, read by
 * the desktop UI, the `hive` CLI and the HCP control plane from a single
 * catalog (catalog.ts). Two halves, split by where the code can run:
 *
 *   - `AgentProviderDef` is BROWSER-SAFE: the identity (id / label / binary /
 *     aliases / default args), the explicit capability set, and the
 *     screen-scrape status detector — all read from the agent's manifest.
 *   - `AgentNodeParts` (wired in node.ts) is the daemon-side half: spawn-time
 *     spec transforms (session resume + signal hook injection), daemon-start
 *     preparation (writing provider assets, seeding a config-home overlay) and
 *     the provider-owned asset sources. Built from the same manifest.
 *
 * An agent is one directory: its `agent.yaml` and the files that manifest names.
 */

/** "blocked" = needs the human (approval or question). */
export type AgentState = "idle" | "working" | "blocked";

/** UI status buckets a tile renders. claude distinguishes permission/question;
 *  every other agent collapses both into "blocked". */
export type TileStatus = "working" | "idle" | "blocked" | "permission" | "question";

/** What a provider can and cannot do — declared, typed, and surfaced: the UI
 *  labels a non-worker, the CLI/HCP refuse what a provider cannot deliver
 *  instead of timing out. Every field is required so an absence is a decision,
 *  never an omission. */
export interface AgentCapabilities {
  /** How the initial task reaches the agent: a trailing positional argv the CLI
   *  auto-submits (deterministic), or typed into its TUI once it reads idle. */
  promptDelivery: "argv" | "typed";
  /** Emits deterministic turn events (a Stop hook / a bridge extension) — the
   *  precondition for being an HCP WORKER: `hive ctl read` and `workflow` can
   *  gather its reply. false = scrape-only status; drive it by hand. */
  turnSignal: boolean;
  /** Session resume across a daemon restart: none, the newest session for the
   *  tile's cwd, or the tile's OWN session (a captured / pre-assigned id). */
  resume: "none" | "cwd" | "tile";
  /** What `hive ctl spawn --supervise` can do for this runtime:
   *  - "broker": its tool-permission prompts are brokered to the supervising
   *    agent (a blocking pre-tool hook), falling back to the human.
   *  - "human": it has its own permission prompts but no broker hook — a
   *    supervise request is accepted and the prompts stay with the human.
   *  - "none": it has NO permission system at all, so there is nothing to
   *    gate or fall back to; a supervise request is refused at spawn. */
  supervise: "broker" | "human" | "none";
  /** The scrape detector has a "blocked" (needs-you) branch. Without one an
   *  approval prompt reads as idle and the notification says "Finished". */
  blockedDetection: boolean;
}

export interface AgentIcon {
  viewBox: string;
  /** Inner SVG markup. App-owned constants, never user input. */
  body: string;
  /** Root <svg> attributes (e.g. fill, stroke, strokeWidth, fillRule). */
  attrs?: Record<string, string>;
}

/** A launch setting an agent offers. The agent declares the flag; the values
 *  are read from its CLI at runtime (see options.ts). `model` and `mode` are the
 *  ids `hive ctl spawn --model/--mode` address. */
export interface AgentOption {
  id: string;
  label: string;
  /** A chosen value is passed as `flag value`. Absent: only `values` are accepted. */
  flag?: string;
  /** Values that need other argv than `flag value` (e.g. `yolo: ["--yolo"]`). */
  values?: Record<string, string[]>;
  /** Hivemind's posture when nothing is chosen; unset passes nothing. */
  default?: string;
  /** A subcommand listing the values, one per line (it runs a command, so the review names it). */
  list?: { args: string[]; skip?: number; format?: string };
  /** What a worker with no human at its tile runs with. */
  unattended?: string;
}

export interface AgentInstall {
  /** The vendor's install page (https). */
  url: string;
  /** A one-line install command to copy. */
  command?: string;
}

/** Option id → value for one launch. Unset or "" = not chosen. */
export type SpawnOptions = Partial<Record<string, string>>;

/** How to find a session this CLI wrote. Two shapes cover every CLI we have met. */
export interface SessionFind {
  /** `jsonl-header`: one file per session, first line a JSON header.
   *  `dir-meta`: a directory per session under a per-workspace directory. */
  strategy: "jsonl-header" | "dir-meta";
  /** Store root; `{home}` is the only placeholder. */
  root: string;
  /** jsonl-header: file extension to consider (default `.jsonl`). */
  ext?: string;
  /** jsonl-header: dotted paths into the header. */
  cwdPath?: string;
  idPath?: string;
  /** jsonl-header: header fields that must equal these values for the line to count. */
  require?: Record<string, string>;
  /** dir-meta: how the per-workspace directory is named. */
  dirKey?: "md5-cwd" | "cwd";
  /** dir-meta: the metadata file in each session directory (default `meta.json`). */
  meta?: string;
  /** dir-meta: timestamp fields, newest wins; first one present is used. */
  newestBy?: string[];
  /** dir-meta: skip a session whose metadata has these values. */
  skipWhen?: Record<string, unknown>;
}

export interface AgentSession {
  /** Give a fresh session an id we choose, so a restore can ask for it by name. */
  bind?: {
    /** Tokens placed before the tile's own; `{newId}` is the generated id. */
    args: string[];
    /** Arguments that mean the user is steering the session themselves — leave it alone. */
    unless?: string[];
  };
  resume?: {
    /** Tokens appended on restore; `{id}` is the session to resume. */
    args: string[];
    /** Where the session store is, when the id has to be found on disk. */
    find?: SessionFind;
    /** Where else the id may come from, in order of preference. */
    from?: {
      /** The live session our tracker hook recorded for this tile. */
      tracked?: boolean;
      /** The id bound at spawn, whose flag is removed as the resume is added. */
      bound?: string;
    };
    /** Nothing known: a best-effort argument rather than a fresh session. */
    fallback?: string[];
    /** Where the resume goes: `before` the tile's own arguments, `beforeLaunch` after them
     *  but ahead of what the launch adds, or last of all (the default). */
    position?: "before" | "beforeLaunch" | "after";
  };
}

/** A file inside the overlay that Hivemind writes rather than links. */
export interface AgentHomeFile {
  name: string;
  /** Start from the file of the same name in the real directory, if it exists. */
  merge?: boolean;
  /** JSON keys forced on top. */
  set?: Record<string, unknown>;
}

/**
 * A private home for an agent whose CLI reads its configuration from one. Every child of
 * the real directory is linked in, so login, sessions and history stay shared; only the
 * files named here are ours.
 */
export interface AgentHome {
  /** Directory under the agent's private directory that the CLI is pointed at. */
  root: string;
  /** The configuration directory inside it. */
  dir: string;
  /** The real directory whose children are linked in. */
  mirror: string;
  /** The environment variable that points the CLI at the overlay. */
  env: string;
  /** Files Hivemind writes into the overlay instead of linking. */
  own?: AgentHomeFile[];
}

/** One hook of ours, wired into an agent's own configuration format. */
export interface AgentHookEntry {
  /** Which of Hivemind's hook scripts (`tracker`, `stop`, `userPrompt`, …). */
  hook: string;
  /** Seconds, in the agent's own hook contract. */
  timeout?: number;
  /** Which tools it applies to; `supervise` derives it from the supervision policy. */
  matcher?: string;
  /** `supervised` includes this entry only for a tile that runs under supervision. */
  when?: "supervised";
}

/** How an agent is told to call our hooks: which events, and where the config goes. */
export interface AgentHooks {
  /** Event name → the hooks it fires. An entry whose script is unavailable is dropped. */
  events: Record<string, AgentHookEntry | AgentHookEntry[]>;
  /** The document shape; `{events}` is where the rendered events go. */
  template?: string;
  /** One command, in this agent's shape. `{command}` is the command line; `{timeout}` and
   *  any other placeholder is dropped when the event did not ask for it. */
  entry?: Record<string, unknown>;
  /** How one event's commands are wrapped — `{entries}` is the list. `false` for an agent
   *  whose events are simply a list of commands. */
  group?: Record<string, unknown> | false;
  /** Delivered as this argument, with the document inline. */
  arg?: string;
  /** Or written to this asset name instead. */
  file?: string;
}

/** A file an agent needs on disk before it runs: a bridge extension, a hook script, a
 *  config its CLI reads. Written into that agent's private directory, never anywhere else. */
export interface AgentAsset {
  /** File name inside the agent's private directory. */
  name: string;
  /** The file beside the manifest whose contents are written. */
  file: string;
  /** A hook this script is: `events` may name it like one of ours, and it runs with the control-plane socket. */
  hook?: string;
}

/** What a launch needs beyond the command itself. */
export interface AgentLaunch {
  /** Give it the control plane: socket, token, tile id, agent id, depth. Only when the
   *  daemon actually has a socket and token — otherwise the agent runs without them. */
  hcp?: boolean;
  /** Appended at spawn unless already there. `{asset:name}` resolves to a written file. */
  args?: string[];
  /** A subcommand this agent is always launched through, added when the command line does
   *  not already have it (`kiro chat …`). */
  subcommand?: string;
  /** These arguments select something that lives in the private home — skip them when the
   *  home is not there, so a failed overlay degrades the agent instead of breaking it. */
  requiresHome?: boolean;
  /** Extra environment; values take the same placeholders. */
  env?: Record<string, string>;
}

export interface AgentProviderDef {
  /** Stable id — the tile/detector/CLI key ("claude", "codex", …). */
  id: string;
  /** Human label (pickers, tooltips). */
  label: string;
  /** The binary hivemind spawns. Spec matching is by basename equality. */
  bin: string;
  /** Other basenames that identify a USER-RUN instance of this agent for status
   *  scraping only (never spawned by hivemind). */
  aliases?: string[];
  /** Default args layered under the spawn (permission posture etc.). */
  defaultArgs?: string[];
  /** Spawnable from the UI / CLI today. false = recognised for status only. */
  enabled: boolean;
  caps: AgentCapabilities;
  /** Screen-scrape status for a rendered viewport. A def WITHOUT one is not
   *  recognised for status at all (a user-run tile of it is treated like any
   *  unknown program): it exists for `hive agent detect` / `--assignee` only,
   *  until real screen text is captured. */
  detect?: (screen: string) => TileStatus;
  /** The agent's mark as inline SVG: the viewBox, the inner markup (paths /
   *  shapes using `currentColor`) and any root attributes (fill / stroke /
   *  fillRule). Rendered by the UI generically — no per-provider React code. */
  icon: AgentIcon;
  /** One line shown wherever the agent is offered when it cannot be a worker. */
  note?: string;
  options?: readonly AgentOption[];
  /** Where to get the CLI when this machine does not have it. Shown, never run. */
  install?: AgentInstall;
  /** Where this CLI keeps its sessions, so a restore can find the one for a cwd. */
  session?: AgentSession;
  /** How this CLI is told to call our hooks. */
  hooks?: AgentHooks;
  /** A private configuration home this agent runs with. */
  home?: AgentHome;
  /** Files this agent needs written before it can run. */
  assets?: readonly AgentAsset[];
  /** Arguments and environment every launch of this agent gets. */
  launch?: AgentLaunch;
  /** The repo whose `.hivemind/agents/` this came from. Set by the loader, never read
   *  from a manifest: it is what keeps a repo's agent to that repo's own tiles. */
  sourceRoot?: string;
  /** The folder this manifest was read from, so the daemon can find the files it ships
   *  beside it. Set by the loader, never read from a manifest. Absent for the agents
   *  compiled into the binary — their files are compiled in too. */
  dir?: string;
  /** Window-title templates (see ManifestSpawn.titles). */
  titles?: readonly string[];
  /** The tile label for the n-th spawn (default `"<label> #<n>"`). */
  spawnLabel?: (n: number, opts: SpawnOptions) => string;
}

// ── daemon-side ──────────────────────────────────────────────────────────────

/** A PTY spawn request (mirrors the daemon's SessionManager spec). */
export interface SpawnSpec {
  cwd: string;
  cmd: string;
  args: string[];
  cols: number;
  rows: number;
  env?: Record<string, string>;
}

/** Spawn-time spec transforms a provider contributes. Each MUST no-op for specs
 *  it doesn't own (basename check) so providers compose by simple chaining. */
export interface ProviderResumeTransforms {
  /** Fresh spawn: bind a deterministic session id + inject signal hooks. */
  transformSpecOnSpawn?: (spec: SpawnSpec, id: string) => SpawnSpec;
  /** Restore after a daemon restart: resume the prior session. */
  transformSpecOnRestore?: (spec: SpawnSpec, id: string) => SpawnSpec;
  /** A restored session died fast → respawn once with this transformed spec. */
  restoreRetryTransform?: (spec: SpawnSpec) => SpawnSpec | null;
  /** Window in which a fast death triggers `restoreRetryTransform`. */
  restoreRetryMs?: number;
}

/** Everything the daemon generated that a provider might wire into a spawn: the
 *  electron-as-node exec path, the per-tile session dir, the shared HCP hook
 *  script paths + socket/token — provider-agnostic — plus each provider's own
 *  prepared paths under `providers[id]`. A provider uses whatever subset it
 *  supports; an unset path disables that hook. */
export interface ProviderSpawnContext {
  execPath: string;
  trackerPath: string;
  tileSessionsDir: string;
  legacyMapFile?: string;
  planHookPath?: string;
  planBridgeSock?: string;
  stopHookPath?: string;
  approvalHookPath?: string;
  subagentHookPath?: string;
  notificationHookPath?: string;
  userpromptHookPath?: string;
  hcpSock?: string;
  hcpToken?: string;
  /** Provider-private paths, keyed by provider id — whatever that provider's
   *  `prepare()` returned at daemon start (an extension file, a config-home
   *  overlay, its own hook script). Opaque to everything but the owning
   *  provider: `resume(ctx)` reads only `ctx.providers?.[ownId]`, so a new
   *  provider never edits this shared type. */
  providers?: Record<string, Record<string, string>>;
}

/** What the daemon hands a provider at start so it can write its assets and
 *  seed its config-home overlay (best-effort; a failure only disables that
 *  provider's deterministic signals). */
export interface DaemonPaths {
  userDataDir: string;
  execPath: string;
  trackerPath: string;
  tileSessionsDir: string;
  stopHookPath: string;
  userpromptHookPath: string;
  notificationHookPath: string;
  hcpSock: string;
}

export interface AgentNodeParts {
  /** Build this provider's spawn-time transforms from the daemon's context. */
  resume?: (ctx: ProviderSpawnContext) => ProviderResumeTransforms;
  /** Daemon start: write assets / seed homes. Returns this provider's private
   *  paths; the daemon stores them at `ctx.providers[id]` for `resume`. */
  prepare?: (paths: DaemonPaths) => Record<string, string>;
  /** Provider-owned generated sources (an extension, a hook script), by file name. */
  assets?: Record<string, () => string>;
}
