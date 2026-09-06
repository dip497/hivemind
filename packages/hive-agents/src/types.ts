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

/** The three-state model ported from herdr (the Rust agent multiplexer the
 *  scrape detectors come from). "blocked" = needs the human (approval/question). */
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
  /** Honours hivemind's `--model` alias at spawn. */
  modelFlag: boolean;
  /** Honours claude-style permission modes (`--permission-mode`, bypass). */
  permissionModes: boolean;
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
  /** The agent's mark as inline SVG: the viewBox, the inner markup (paths /
   *  shapes using `currentColor`) and any root attributes (fill / stroke /
   *  fillRule). Rendered by the UI generically — no per-provider React code. */
  icon: AgentIcon;
  /** One line shown wherever the agent is offered when it cannot be a worker. */
  note?: string;
  /** Declares that this provider needs NO node half even though its capabilities
   *  (resume / turn signal) would normally require one — e.g. a runtime whose own
   *  CLI resumes and reports without any injection. The drift test accepts the
   *  flag in place of a NODE_PARTS entry. */
  noNodeHalf?: true;
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
