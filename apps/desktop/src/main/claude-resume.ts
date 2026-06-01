/**
 * claude session resume/tracking — the SessionManager transform hooks that make
 * `claude` tiles deterministically resume across daemon restarts, plus the
 * SessionStart-hook injection that follows `/resume` switches.
 *
 * Extracted from pty-daemon.ts so it's electron-free and unit-testable (the
 * daemon itself imports node-pty, which needs the Electron ABI). The daemon
 * wires these into SessionManager; tests drive them with a fake claude.
 *
 * The model:
 *  - Fresh spawn: inject `--session-id <uuid>` (deterministic id) + a merged
 *    SessionStart hook that records the tile's LIVE session id per-tile.
 *  - Restore: prefer the tracked live id (honors a `/resume <other>` the user
 *    did inside the tile) via `--resume <tracked>`; else swap the original
 *    `--session-id <uuid>` → `--resume <uuid>`.
 *  - Restore retry: if `--resume` errors ("No conversation found"), respawn
 *    once with `--session-id <uuid>` so a missing JSONL doesn't kill the tile.
 */
import { randomUUID } from "node:crypto";
import type { SpawnSpec } from "./pty-session-manager.js";
import { readTrackedSession } from "./tile-session-store.js";

export interface ClaudeResumeDeps {
  /** Absolute path to the generated tracker `.cjs` (daemon writes the file). */
  trackerPath: string;
  /** Per-tile session directory passed to the tracker + read on restore. */
  tileSessionsDir: string;
  /** Legacy shared-map file, read as a migration fallback. */
  legacyMapFile?: string;
  /** Node/electron-as-node binary that runs the tracker hook (process.execPath). */
  execPath: string;
}

const isClaude = (spec: SpawnSpec): boolean => (spec.cmd ?? "").split("/").pop() === "claude";

/** The merged hooks settings JSON for a tile. claude MERGES this with the
 *  project's own hooks (doesn't clobber e.g. claude-mem). One hook:
 *   - SessionStart → records the tile's live session id (resume tracking).
 *  OS notifications are driven separately off the renderer's agent-status bus
 *  (multi-agent, transition-deduped) — see agent-notify.ts — not a claude hook. */
export function trackerSettings(deps: ClaudeResumeDeps, id: string): string {
  const sessionCmd =
    `HIVEMIND_TILE='${id}' ELECTRON_RUN_AS_NODE=1 ` +
    `'${deps.execPath}' '${deps.trackerPath}' '${deps.tileSessionsDir}'`;
  const hooks: Record<string, unknown[]> = {
    SessionStart: [{ hooks: [{ type: "command", command: sessionCmd }] }],
  };
  return JSON.stringify({ hooks });
}

/** Prepend our merged `--settings` (tracker hook) to a claude spec. Idempotent;
 *  skips if the spec already carries `--settings` (user override). */
export function withTracker(deps: ClaudeResumeDeps, spec: SpawnSpec, id: string): SpawnSpec {
  if (!isClaude(spec)) return spec;
  const args = spec.args ?? [];
  if (args.includes("--settings")) return spec;
  return { ...spec, args: ["--settings", trackerSettings(deps, id), ...args] };
}

/** The live session id the tile is currently in (per-tile file, legacy map
 *  fallback). */
export function trackedSession(deps: ClaudeResumeDeps, id: string): string | undefined {
  return readTrackedSession(deps.tileSessionsDir, id, deps.legacyMapFile);
}

export interface ClaudeResumeTransforms {
  transformSpecOnSpawn: (spec: SpawnSpec, id: string) => SpawnSpec;
  transformSpecOnRestore: (spec: SpawnSpec, id: string) => SpawnSpec;
  restoreRetryTransform: (spec: SpawnSpec) => SpawnSpec | null;
  restoreRetryMs: number;
}

export function makeClaudeResumeTransforms(deps: ClaudeResumeDeps): ClaudeResumeTransforms {
  return {
    // BIND-AT-SPAWN: every fresh claude session gets a hivemind-generated UUID via
    // `--session-id`, stored in the snapshot args so restore is deterministic.
    transformSpecOnSpawn: (spec, id) => {
      if (!isClaude(spec)) return spec;
      const args = spec.args ?? [];
      // User-provided session control wins (explicit overrides).
      const claimed = args.some(
        (a) =>
          a === "--session-id" || a === "--resume" || a === "-r" ||
          a === "--continue" || a === "-c" || a === "--from-pr",
      );
      const withId = claimed ? spec : { ...spec, args: ["--session-id", randomUUID(), ...args] };
      return withTracker(deps, withId, id);
    },
    transformSpecOnRestore: (spec, id) => {
      if (!isClaude(spec)) return spec;
      const args = spec.args ?? [];
      // PREFER the live session the tile was last in (tracked via the SessionStart
      // hook) — follows a `/resume <other>` the user did, or any id claude
      // reassigned. Falls through to the snapshot's `--session-id`.
      const tracked = trackedSession(deps, id);
      if (tracked) {
        const sidIdx0 = args.indexOf("--session-id");
        const base = sidIdx0 >= 0 ? [...args.slice(0, sidIdx0), ...args.slice(sidIdx0 + 2)] : args;
        return withTracker(deps, { ...spec, args: ["--resume", tracked, ...base] }, id);
      }
      // Swap `--session-id <uuid>` → `--resume <uuid>`: claude does NOT
      // auto-resume on a bare `--session-id` when the JSONL already exists.
      const sidIdx = args.indexOf("--session-id");
      if (sidIdx >= 0 && sidIdx + 1 < args.length) {
        const uuid = args[sidIdx + 1]!;
        const next = [...args.slice(0, sidIdx), ...args.slice(sidIdx + 2)];
        return withTracker(deps, { ...spec, args: ["--resume", uuid, ...next] }, id);
      }
      // Legacy snapshot (pre-bind era) — fall back to `--continue` best-effort.
      const claimed = args.some(
        (a) => a === "--resume" || a === "-r" || a === "--continue" || a === "-c",
      );
      if (claimed) return withTracker(deps, spec, id);
      return withTracker(deps, { ...spec, args: ["--continue", ...args] }, id);
    },
    // When a restored `--resume` session errors within restoreRetryMs, respawn
    // once with `--session-id <uuid>` (fresh session, same deterministic id) so
    // a missing JSONL doesn't kill the tile.
    restoreRetryMs: 5000,
    restoreRetryTransform: (spec) => {
      if (!isClaude(spec)) return null;
      const args = spec.args ?? [];
      const rIdx = args.indexOf("--resume");
      if (rIdx < 0 || rIdx + 1 >= args.length) return null;
      const uuid = args[rIdx + 1]!;
      const next = [...args.slice(0, rIdx), ...args.slice(rIdx + 2)];
      return { ...spec, args: ["--session-id", uuid, ...next] };
    },
  };
}
