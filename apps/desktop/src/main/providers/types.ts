/**
 * Agent provider abstraction. An "agent provider" is a CLI coding agent hivemind
 * can drive in a tile — claude, codex, and (in future) others. Each provider
 * declares how to drive ITS process; the rest of the app stays provider-agnostic.
 *
 * Two capability surfaces, split by the process boundary:
 *  - MAIN (here): spawn-time spec transforms — session resume/restore AND
 *    deterministic-signal injection (the hooks that emit canonical HCP events:
 *    `turn`, `subagent`, `notification`). claude injects a `--settings` hook
 *    block; a future provider injects whatever ITS runtime supports.
 *  - RENDERER (agent-state.ts): a screen-scrape status detector, keyed by the
 *    SAME provider `id`. This is the universal fallback every provider has, even
 *    one with no deterministic signals.
 *
 * The canonical event vocabulary (turn / subagent / notification) and its
 * consumers (the HCP trackers + the renderer status bus) know nothing about any
 * specific provider — a provider's only job is to PRODUCE those events however it
 * can. So adding a provider is: implement {@link AgentProvider} in a new file +
 * register it (providers/registry.ts) + add a renderer scrape detector with the
 * same id. No edits to the daemon, the trackers, or the status bus.
 */
import type { SpawnSpec } from "../pty-session-manager.js";

/** Spawn-time spec transforms a provider contributes. Each MUST no-op for specs
 *  it doesn't own (basename check) so providers compose by simple chaining. All
 *  fields optional: a provider implements only the capabilities it has. */
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
 *  electron-as-node exec path, the per-tile session dir, and the HCP hook script
 *  paths + socket/token. A provider uses whatever subset it supports; unset paths
 *  simply disable the corresponding hook. */
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
  /** On-disk path of the generated pi HCP-bridge extension (`hive-pi-ext.mjs`),
   *  passed to `pi -e <path>` so a spawned pi tile reports turn/status/reply to
   *  the control plane. Unset → pi runs raw (screen-scrape status only). */
  piExtPath?: string;
  /** The ephemeral FACTORY_HOME_OVERRIDE home for droid hook injection (the
   *  daemon seeds it + writes droid's hooks.json there). Unset → droid runs with
   *  its normal home and no injected hooks (screen-scrape status only). */
  droidHome?: string;
}

export interface AgentProvider {
  /** Stable id. MUST match the renderer scrape-detector id (agent-state.ts) so
   *  the two capability surfaces refer to the same provider. */
  id: string;
  /** Does this provider drive the given spawn command? (basename match.) */
  matches: (cmd: string) => boolean;
  /** Build this provider's spawn-time transforms from the daemon's hook context.
   *  Omit if the provider needs no spawn-time handling. */
  resume?: (ctx: ProviderSpawnContext) => ProviderResumeTransforms;
}
