/**
 * The agent-provider contract. ONE registration per CLI coding agent, read by
 * the desktop UI, the `hive` CLI and the HCP control plane from a single
 * catalog (catalog.ts). Two halves, split by where the code can run:
 *
 *   - `AgentProviderDef` (this file + providers/<id>.ts) is BROWSER-SAFE: the
 *     identity (id / label / binary / aliases / default args), the explicit
 *     capability set, and the screen-scrape status detector. The renderer,
 *     the CLI and HCP read only this.
 *   - `AgentNodeParts` (providers/<id>.node.ts, wired in node.ts) is the
 *     daemon-side half: spawn-time spec transforms (session resume + signal
 *     hook injection), daemon-start preparation (writing provider assets,
 *     seeding a config-home overlay) and the provider-owned asset sources.
 *
 * Adding a provider = one def file (+ one .node.ts if it has resume/hooks) and
 * one line in catalog.ts (+ one in node.ts). Nothing else names it.
 */

/** herdr's three-state model. "blocked" = needs the human (approval/question). */
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
  /** Tool-permission prompts can be brokered to a supervising agent
   *  (`hive ctl spawn --supervise`). */
  supervise: boolean;
  /** Honours hivemind's `--model` alias at spawn. */
  modelFlag: boolean;
  /** Honours claude-style permission modes (`--permission-mode`, bypass). */
  permissionModes: boolean;
  /** The scrape detector has a "blocked" (needs-you) branch. Without one an
   *  approval prompt reads as idle and the notification says "Finished". */
  blockedDetection: boolean;
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
  /** Screen-scrape status for a rendered viewport. */
  detect: (screen: string) => TileStatus;
  /** One line shown wherever the agent is offered when it cannot be a worker. */
  note?: string;
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
 *  script paths + socket/token, and the provider-prepared paths (`prepare`). A
 *  provider uses whatever subset it supports; unset paths disable that hook. */
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
  /** pi: on-disk path of the generated bridge extension (`pi -e <path>`). */
  piExtPath?: string;
  /** droid: the ephemeral FACTORY_HOME_OVERRIDE overlay. */
  droidHome?: string;
  /** kiro: the ephemeral KIRO_HOME overlay. */
  kiroHome?: string;
  /** kiro: its PreToolUse permission-broker hook (exit-code contract). */
  kiroApprovalHookPath?: string;
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
  /** Daemon start: write assets / seed homes. Returns the ctx fields it filled. */
  prepare?: (paths: DaemonPaths) => Partial<ProviderSpawnContext>;
  /** Provider-owned generated sources (an extension, a hook script), by file name. */
  assets?: Record<string, () => string>;
}
