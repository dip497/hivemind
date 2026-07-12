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
import { INITIAL_PROMPT_ENV } from "../shared/agent-io.js";

export interface ClaudeResumeDeps {
  /** Absolute path to the generated tracker `.cjs` (daemon writes the file). */
  trackerPath: string;
  /** Per-tile session directory passed to the tracker + read on restore. */
  tileSessionsDir: string;
  /** Legacy shared-map file, read as a migration fallback. */
  legacyMapFile?: string;
  /** Node/electron-as-node binary that runs the tracker hook (process.execPath). */
  execPath: string;
  /** Absolute path to the generated plan-review hook `.cjs` (daemon writes it).
   *  When set together with `planBridgeSock`, a PreToolUse(ExitPlanMode) hook is
   *  injected so plan handoffs open the in-canvas review. Omit to disable. */
  planHookPath?: string;
  /** The plan-bridge unix socket the hook connects to (owned by Electron main). */
  planBridgeSock?: string;
  /** Absolute path to the generated HCP Stop hook `.cjs` (daemon writes it). With
   *  `hcpSock`, injects a Stop hook so finished turns are reported to the control
   *  plane (deterministic agent.read). */
  stopHookPath?: string;
  /** Absolute path to the generated HCP subagent hook `.cjs` (daemon writes it).
   *  With `hcpSock`, injects SubagentStart/SubagentStop hooks so a tile reads
   *  "working" while it has in-flight (incl. background) Task subagents — the
   *  case the screen-scrape misses once the main loop returns to the prompt. */
  subagentHookPath?: string;
  /** Absolute path to the generated HCP notification hook `.cjs` (daemon writes
   *  it). With `hcpSock`, injects a Notification hook so claude's own "needs your
   *  permission" / "waiting for your input" signal drives the tile status
   *  deterministically (hardens the screen-scrape; version-proof). */
  notificationHookPath?: string;
  /** Absolute path to the generated HCP UserPromptSubmit hook `.cjs`. With
   *  `hcpSock`, injects a UserPromptSubmit hook so a turn START marks the tile
   *  `working` deterministically (paired with the Stop hook's turn END → idle).
   *  This is the hook-driven replacement for the working/idle screen-scrape. */
  userpromptHookPath?: string;
  /** The HCP control-plane unix socket (owned by Electron main). Injected into
   *  the agent's env as HIVE_HCP_SOCK so its hive MCP can drive the canvas. */
  hcpSock?: string;
  /** The HCP capability token, injected as HCP_TOKEN so the agent's MCP is
   *  authorized to call the control plane. */
  hcpToken?: string;
  /** Absolute path to the generated permission-broker hook `.cjs` (daemon writes
   *  it). With `hcpSock`, a PreToolUse hook is injected ONLY for workers whose
   *  spawn env carries `HIVE_SUPERVISE` — it brokers their tool-permission
   *  decisions to the spawning agent (see hcp/approval-hook-source.ts). */
  approvalHookPath?: string;
}

const isClaude = (spec: SpawnSpec): boolean => (spec.cmd ?? "").split("/").pop() === "claude";

/** POSIX single-quote a value for safe interpolation into a shell command. The
 *  SessionStart hook string is run by the user's shell, and `id` derives from a
 *  renderer-controlled tileId — an unescaped `'` would break out of the quoting
 *  and inject arbitrary commands. Wrapping in single quotes and rewriting any
 *  inner `'` as `'\''` makes ANY string safe (incl. app-owned paths). */
export function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** The merged hooks settings JSON for a tile. claude MERGES this with the
 *  project's own hooks (doesn't clobber e.g. claude-mem). Hooks:
 *   - SessionStart → records the tile's live session id (resume tracking).
 *   - PreToolUse(ExitPlanMode) → opens the in-canvas plan review and blocks the
 *     handoff until the user approves / requests changes (only when the
 *     plan-bridge paths are supplied).
 *  OS notifications are driven separately off the renderer's agent-status bus
 *  (multi-agent, transition-deduped) — see agent-notify.ts — not a claude hook. */
export function trackerSettings(deps: ClaudeResumeDeps, id: string, supervise?: string): string {
  const sessionCmd =
    `HIVEMIND_TILE=${shq(id)} ELECTRON_RUN_AS_NODE=1 ` +
    `${shq(deps.execPath)} ${shq(deps.trackerPath)} ${shq(deps.tileSessionsDir)}`;
  const hooks: Record<string, unknown[]> = {
    SessionStart: [{ hooks: [{ type: "command", command: sessionCmd }] }],
  };
  const preToolUse: unknown[] = [];
  if (deps.planHookPath && deps.planBridgeSock) {
    const planCmd =
      `HIVEMIND_TILE=${shq(id)} ELECTRON_RUN_AS_NODE=1 ` +
      `${shq(deps.execPath)} ${shq(deps.planHookPath)} ${shq(deps.planBridgeSock)}`;
    // `timeout` is SECONDS (Claude Code hook contract). 345600 = 96h, so a long
    // review never trips the hook timeout — same value plannotator uses.
    preToolUse.push(
      { matcher: "ExitPlanMode", hooks: [{ type: "command", command: planCmd, timeout: 345600 }] },
    );
  }
  // Permission broker — ONLY for supervised workers (the spawn env carries
  // HIVE_SUPERVISE). Brokers their tool-permission decisions to the spawning
  // agent. Matcher scopes which tools are brokered ("all" → every tool); the
  // hook double-checks HIVE_SUPERVISE and fails safe to the normal prompt.
  if (deps.approvalHookPath && deps.hcpSock && supervise) {
    const apCmd =
      `HIVEMIND_TILE=${shq(id)} HIVE_SUPERVISE=${shq(supervise)} ELECTRON_RUN_AS_NODE=1 ` +
      `${shq(deps.execPath)} ${shq(deps.approvalHookPath)} ${shq(deps.hcpSock)}`;
    const matcher = supervise === "all" ? "*" : supervise.split(",").map((s) => s.trim()).filter(Boolean).join("|");
    // 600s ceiling: a supervisor has up to ~9min to answer (the hook's own
    // timeout falls through to the normal prompt before this trips).
    preToolUse.push({ matcher, hooks: [{ type: "command", command: apCmd, timeout: 600 }] });
  }
  if (preToolUse.length) hooks.PreToolUse = preToolUse;
  if (deps.stopHookPath && deps.hcpSock) {
    // Reports a finished turn to HCP (deterministic agent.read). Does not block
    // the stop — the agent ends normally; a short hook timeout bounds a hung app.
    const stopCmd =
      `HIVEMIND_TILE=${shq(id)} ELECTRON_RUN_AS_NODE=1 ` +
      `${shq(deps.execPath)} ${shq(deps.stopHookPath)} ${shq(deps.hcpSock)}`;
    hooks.Stop = [{ hooks: [{ type: "command", command: stopCmd, timeout: 10 }] }];
  }
  if (deps.subagentHookPath && deps.hcpSock) {
    // Reports subagent start/stop edges so the tile shows "working" while Task
    // subagents (including BACKGROUND ones) are in flight. Fire-and-forget like
    // Stop — does not block dispatch; a short timeout bounds a hung app. One
    // command for both events; the hook derives the phase from the payload.
    const subCmd =
      `HIVEMIND_TILE=${shq(id)} ELECTRON_RUN_AS_NODE=1 ` +
      `${shq(deps.execPath)} ${shq(deps.subagentHookPath)} ${shq(deps.hcpSock)}`;
    const subHook = [{ hooks: [{ type: "command", command: subCmd, timeout: 10 }] }];
    hooks.SubagentStart = subHook;
    hooks.SubagentStop = subHook;
  }
  if (deps.notificationHookPath && deps.hcpSock) {
    // Reports claude's own Notification events (permission_request / idle_prompt /
    // elicitation) so a "needs you" status is deterministic, not scraped. Fire-
    // and-forget; the renderer auto-clears it when work resumes.
    const notifCmd =
      `HIVEMIND_TILE=${shq(id)} ELECTRON_RUN_AS_NODE=1 ` +
      `${shq(deps.execPath)} ${shq(deps.notificationHookPath)} ${shq(deps.hcpSock)}`;
    hooks.Notification = [{ hooks: [{ type: "command", command: notifCmd, timeout: 10 }] }];
  }
  if (deps.userpromptHookPath && deps.hcpSock) {
    // Turn START → working (deterministic). Paired with the Stop hook (turn END →
    // idle) this replaces the working/idle screen-scrape, which mis-read claude's
    // spinner/wording changes, focus/scroll, and stale buffer replay on restart.
    const upCmd =
      `HIVEMIND_TILE=${shq(id)} ELECTRON_RUN_AS_NODE=1 ` +
      `${shq(deps.execPath)} ${shq(deps.userpromptHookPath)} ${shq(deps.hcpSock)}`;
    hooks.UserPromptSubmit = [{ hooks: [{ type: "command", command: upCmd, timeout: 10 }] }];
  }
  return JSON.stringify({ hooks });
}

/** The HCP env injected into a spawned claude so its hive MCP can drive the
 *  control plane: the socket path + capability token + this agent's own tile id
 *  (so spawns/sends from this agent default to ITS frame) + its spawn depth
 *  (for the anti-fork-bomb gate). */
function hcpEnv(deps: ClaudeResumeDeps, spec: SpawnSpec, id: string): Record<string, string> | undefined {
  if (!deps.hcpSock || !deps.hcpToken) return spec.env;
  return {
    ...spec.env,
    HIVE_HCP_SOCK: deps.hcpSock,
    HCP_TOKEN: deps.hcpToken,
    // The agent's OWN tile id — so its hive_spawn_agent/hive_send default to the
    // frame it lives in (the hook command sets HIVEMIND_TILE only for the hook
    // subprocess; the agent process itself needs it too).
    HIVEMIND_TILE: id,
    // Top-level (user-spawned) agents are depth 0. HCP-spawned children get an
    // incremented value once spawn-env threading lands (Phase 2); default 0.
    HIVE_AGENT_DEPTH: spec.env?.HIVE_AGENT_DEPTH ?? "0",
  };
}

/** Prepend our merged `--settings` (tracker hook) to a claude spec. Idempotent;
 *  skips if the spec already carries `--settings` (user override). */
export function withTracker(deps: ClaudeResumeDeps, spec: SpawnSpec, id: string): SpawnSpec {
  if (!isClaude(spec)) return spec;
  const args = spec.args ?? [];
  // Supervision policy rides the spawn env (set by main's ptySpawn for an agent
  // spawned with `supervise`); gates the permission-broker hook injection.
  const supervise = spec.env?.HIVE_SUPERVISE;
  if (args.includes("--settings")) return { ...spec, env: hcpEnv(deps, spec, id) };
  return { ...spec, args: ["--settings", trackerSettings(deps, id, supervise), ...args], env: hcpEnv(deps, spec, id) };
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
      // A frozen session re-execs from its persisted spec. The spawn env still
      // carries HIVE_INITIAL_PROMPT (the one-time ▶ Work task), which the factory
      // would re-append as claude's positional argv → the task would RUN AGAIN on
      // every restore. Strip it here so a restore only resumes; it never re-submits.
      if (spec.env && INITIAL_PROMPT_ENV in spec.env) {
        const env = { ...spec.env };
        delete env[INITIAL_PROMPT_ENV];
        spec = { ...spec, env };
      }
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
