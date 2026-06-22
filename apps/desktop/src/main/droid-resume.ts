/**
 * Droid (Factory) provider transforms: session resume AND deterministic-signal
 * hook injection. Droid ships the SAME hook model as Claude Code — `Stop`,
 * `UserPromptSubmit`, `Notification`, `SubagentStop`, … — with a `transcript_path`
 * on `Stop` (Anthropic-format JSONL). So droid is a first-class hook provider,
 * not scrape-only: we inject those hooks so the tile's working/idle is
 * deterministic and `agent.read` / `workflow.run` can gather a CLEAN transcript
 * reply via the turn-tracker (the same path claude uses).
 *
 * Injection seam — droid has NO inline `--settings` flag (claude does). Its hooks
 * are file-based (`<FACTORY_HOME>/.factory/hooks.json`). The binary honors
 * `FACTORY_HOME_OVERRIDE` to relocate that home, so hivemind points droid at an
 * EPHEMERAL per-install home (seeded with symlinks to the user's real ~/.factory
 * for auth/settings/sessions + our own hooks.json) — the user's real ~/.factory
 * is never touched. See hcp/droid-home.ts for the seeding. Because that home (and
 * thus hooks.json) is SHARED across droid tiles, per-tile attribution can't live
 * in the static hook command — it rides the spawn ENV (`HIVEMIND_TILE`), which
 * the hook scripts already read and droid passes through to the hook subprocess.
 *
 * Resume: like codex, droid can't pre-assign a session id, so on restore we
 * resolve the newest ~/.factory/sessions entry matching the tile cwd and respawn
 * `droid --resume <id>`.
 *
 * NOTE: droid exposes `SubagentStop` but NO `SubagentStart`, so background
 * subagent-busy tracking (which needs the start edge) is not wired for droid;
 * turn-level status + gather work fully.
 */
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import type { SpawnSpec } from "./pty-session-manager.js";
import { shq } from "./claude-resume.js";

export interface DroidResumeDeps {
  /** Node/electron-as-node binary that runs the hook scripts (process.execPath). */
  execPath?: string;
  /** The ephemeral FACTORY_HOME_OVERRIDE target (per install). Set → hooks fire. */
  droidHome?: string;
  /** Shared HCP hook scripts (the SAME .cjs files claude uses — droid's Stop
   *  stdin carries `transcript_path` too, so they work verbatim). */
  stopHookPath?: string;
  userpromptHookPath?: string;
  notificationHookPath?: string;
  /** HCP control-plane socket + capability token (injected into the agent env). */
  hcpSock?: string;
  hcpToken?: string;
  /** Override the ~/.factory/sessions scan root (tests). */
  sessionsRoot?: string;
}

export function isDroid(spec: { cmd: string }): boolean {
  return basename(spec.cmd.trim().split(/\s+/)[0] ?? "") === "droid";
}

/** Read just the first line of a (possibly large) jsonl without slurping it. */
function firstLine(file: string): string {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const s = buf.toString("utf8", 0, n);
    const nl = s.indexOf("\n");
    return nl === -1 ? s : s.slice(0, nl);
  } finally {
    closeSync(fd);
  }
}

/** Collect `*.jsonl` files (path + mtime) under a root, bounded depth + count. */
function collectSessionFiles(root: string): Array<{ path: string; mtime: number }> {
  const out: Array<{ path: string; mtime: number }> = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 6 || out.length > 4000) return;
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith(".jsonl")) {
        try { out.push({ path: p, mtime: statSync(p).mtimeMs }); } catch { /* gone */ }
      }
    }
  };
  walk(root, 0);
  return out;
}

/**
 * Newest droid session id whose `cwd` matches `cwd`, or undefined. Scans the
 * most-recent files first and stops at the first cwd match.
 */
export function newestDroidSessionForCwd(
  cwd: string,
  sessionsRoot: string = join(homedir(), ".factory", "sessions"),
): string | undefined {
  const files = collectSessionFiles(sessionsRoot).sort((a, b) => b.mtime - a.mtime);
  for (const f of files.slice(0, 200)) {
    try {
      const meta = JSON.parse(firstLine(f.path)) as { type?: string; id?: string; cwd?: string };
      if (meta?.type === "session_start" && meta.cwd === cwd && meta.id) {
        return meta.id;
      }
    } catch { /* not a session_start line / parse error → skip */ }
  }
  return undefined;
}

/** The contents hivemind writes into the ephemeral droid home's `hooks.json`.
 *  Wires droid's lifecycle events to the SHARED HCP hook scripts. Commands carry
 *  NO tileId (the file is shared across droid tiles) — attribution rides the
 *  spawn env HIVEMIND_TILE, which the scripts read.
 *
 *  IMPORTANT: droid's `hooks.json` holds the event keys at the TOP LEVEL (the
 *  binary persists it as `persistHooksJson(settings.hooks)`, the inner map). The
 *  `{ "hooks": {...} }` wrapper is ONLY for `settings.json` — wrapping hooks.json
 *  makes droid match 0 commands (it logs `[Hooks] Matched commands count: 0`). */
export function droidHooksSettings(deps: DroidResumeDeps): Record<string, unknown[]> {
  const hooks: Record<string, unknown[]> = {};
  if (!deps.execPath || !deps.hcpSock) return hooks;
  const cmd = (hookPath: string) =>
    `ELECTRON_RUN_AS_NODE=1 ${shq(deps.execPath!)} ${shq(hookPath)} ${shq(deps.hcpSock!)}`;
  if (deps.userpromptHookPath) {
    // Turn START → working (deterministic; pairs with Stop's turn END → idle).
    hooks.UserPromptSubmit = [{ hooks: [{ type: "command", command: cmd(deps.userpromptHookPath), timeout: 10 }] }];
  }
  if (deps.stopHookPath) {
    // Turn END → idle + a `turn` event carrying transcript_path → clean gather.
    hooks.Stop = [{ hooks: [{ type: "command", command: cmd(deps.stopHookPath), timeout: 10 }] }];
  }
  if (deps.notificationHookPath) {
    // "needs you" (permission / waiting) → deterministic status.
    hooks.Notification = [{ hooks: [{ type: "command", command: cmd(deps.notificationHookPath), timeout: 10 }] }];
  }
  return hooks;
}

/** Env injected into a spawned droid: the ephemeral home (so it loads OUR hooks
 *  without touching ~/.factory) + the HCP socket/token/tile-id (so its hooks +
 *  hive MCP reach the control plane, attributed to this tile). */
function droidEnv(deps: DroidResumeDeps, spec: SpawnSpec, id: string): Record<string, string> | undefined {
  if (!deps.droidHome && !(deps.hcpSock && deps.hcpToken)) return spec.env;
  const env: Record<string, string> = { ...spec.env };
  if (deps.droidHome) env.FACTORY_HOME_OVERRIDE = deps.droidHome;
  if (deps.hcpSock && deps.hcpToken) {
    env.HIVE_HCP_SOCK = deps.hcpSock;
    env.HCP_TOKEN = deps.hcpToken;
    env.HIVEMIND_TILE = id; // hooks + the agent's own hive MCP attribute to this tile
    env.HIVE_AGENT_DEPTH = spec.env?.HIVE_AGENT_DEPTH ?? "0";
  }
  return env;
}

export interface DroidResumeTransforms {
  transformSpecOnSpawn: (spec: SpawnSpec, id: string) => SpawnSpec;
  transformSpecOnRestore: (spec: SpawnSpec, id: string) => SpawnSpec;
  restoreRetryTransform: (spec: SpawnSpec) => SpawnSpec | null;
}

export function makeDroidResumeTransforms(deps: DroidResumeDeps = {}): DroidResumeTransforms {
  return {
    // Fresh spawn: no arg change (hooks come from the ephemeral home file); inject
    // the home + HCP env so the deterministic hooks fire for THIS tile.
    transformSpecOnSpawn: (spec, id) => {
      if (!isDroid(spec)) return spec;
      return { ...spec, env: droidEnv(deps, spec, id) };
    },
    transformSpecOnRestore: (spec, id) => {
      if (!isDroid(spec)) return spec;
      const withEnv = { ...spec, env: droidEnv(deps, spec, id) };
      const args = withEnv.args ?? [];
      if (args.includes("--resume") || args.includes("-r")) return withEnv; // already resuming
      const sessId = newestDroidSessionForCwd(withEnv.cwd, deps.sessionsRoot);
      if (!sessId) return withEnv; // no matching session on disk → fresh start
      return { ...withEnv, args: [...args, "--resume", sessId] };
    },
    // If `droid --resume <id>` dies fast (session file vanished), strip the resume
    // and respawn fresh so a stale id doesn't kill the tile.
    restoreRetryTransform: (spec) => {
      if (!isDroid(spec)) return null;
      const args = spec.args ?? [];
      const i = args.indexOf("--resume");
      if (i < 0) return null;
      return { ...spec, args: args.slice(0, i) };
    },
  };
}
