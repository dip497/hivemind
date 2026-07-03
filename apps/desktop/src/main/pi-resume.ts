/**
 * Pi (pi.dev — @earendil-works/pi-coding-agent) session resume. Pi can't
 * pre-assign a session id and exposes NO hook system (it's a minimal harness:
 * no Stop/UserPromptSubmit/Notification like claude/droid), so — like codex — it
 * has no spawn-time binding and no deterministic signals. It DOES write a
 * durable session file per run: `~/.pi/agent/sessions/--<cwd-with-/-as-->--/
 * <timestamp>_<uuid>.jsonl`, whose FIRST line is a `session` header carrying
 * `{ id, cwd }` (pi's SessionHeader — see packages/coding-agent/docs/session-format.md).
 *
 * So instead of binding at spawn, we resolve at RESTORE: find the newest pi
 * session whose header `cwd` matches the tile's cwd and respawn
 * `pi --session <id>`. Ambiguous only if two pi tiles share one cwd (both
 * resume the newest) — acceptable, same tradeoff codex makes.
 *
 * DETERMINISTIC SIGNALS: pi has no claude-style hook system, but it DOES load an
 * ESM extension via `pi -e <path>`. hivemind writes a lifecycle-bridge extension
 * (hcp/pi-ext-source.ts) and injects it — plus the HCP socket/token/tile-id env —
 * into every pi spawn AND restore (mirroring droid-resume's droidEnv). That
 * extension bridges pi's agent_start/message_end/agent_end to the HCP `status`/
 * `turn` topics, so a pi tile reports turn-completion + status + its inline reply
 * deterministically (the screen-scrape detector remains the fallback).
 */
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import type { SpawnSpec } from "./pty-session-manager.js";

export function isPi(spec: { cmd: string }): boolean {
  return basename(spec.cmd.trim().split(/\s+/)[0] ?? "") === "pi";
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
 * Newest pi session id whose header `cwd` matches `cwd`, or undefined. Scans the
 * most-recent files first and stops at the first cwd match. The header is pi's
 * `SessionHeader` (`{ type: "session", id, cwd, … }`) — id + cwd are top-level,
 * unlike codex's nested `payload`.
 */
export function newestPiSessionForCwd(
  cwd: string,
  sessionsRoot: string = join(homedir(), ".pi", "agent", "sessions"),
): string | undefined {
  const files = collectSessionFiles(sessionsRoot).sort((a, b) => b.mtime - a.mtime);
  for (const f of files.slice(0, 200)) {
    try {
      const header = JSON.parse(firstLine(f.path)) as { type?: string; id?: string; cwd?: string };
      if (header?.type === "session" && header.cwd === cwd && header.id) {
        return header.id;
      }
    } catch { /* not a session header / parse error → skip */ }
  }
  return undefined;
}

export interface PiResumeDeps {
  /** Override the ~/.pi/agent/sessions scan root (tests). */
  sessionsRoot?: string;
  /** HCP control-plane socket + capability token (injected into the pi env so
   *  its bridge extension can reach the control plane, attributed to this tile). */
  hcpSock?: string;
  hcpToken?: string;
  /** On-disk path of the generated pi HCP-bridge extension; appended as `-e
   *  <path>` to the pi spawn. Set → pi reports turn/status/reply deterministically. */
  piExtPath?: string;
}

export interface PiResumeTransforms {
  transformSpecOnSpawn: (spec: SpawnSpec, id: string) => SpawnSpec;
  transformSpecOnRestore: (spec: SpawnSpec, id: string) => SpawnSpec;
  restoreRetryTransform: (spec: SpawnSpec) => SpawnSpec | null;
}

/** Env injected into a spawned pi: the HCP socket/token/tile-id so its bridge
 *  extension reaches the control plane, attributed to this tile (mirrors
 *  droid-resume's droidEnv). Returns spec.env unchanged if HCP isn't wired. */
function piEnv(deps: PiResumeDeps, spec: SpawnSpec, id: string): Record<string, string> | undefined {
  if (!(deps.hcpSock && deps.hcpToken)) return spec.env;
  const env: Record<string, string> = { ...spec.env };
  env.HIVE_HCP_SOCK = deps.hcpSock;
  env.HCP_TOKEN = deps.hcpToken;
  env.HIVEMIND_TILE = id; // the bridge extension + the agent's hive MCP attribute to this tile
  env.HIVE_AGENT_DEPTH = spec.env?.HIVE_AGENT_DEPTH ?? "0";
  return env;
}

/** Append `-e <piExtPath>` to a pi spawn (once — guard against a double-add if a
 *  restored spec already carries it). No-op if no extension path is configured. */
function withPiExt(deps: PiResumeDeps, args: string[]): string[] {
  if (!deps.piExtPath) return args;
  const i = args.indexOf("-e");
  if (i >= 0 && args[i + 1] === deps.piExtPath) return args; // already injected
  return [...args, "-e", deps.piExtPath];
}

/** Apply the deterministic-signal injection (HCP env + `-e` bridge extension) a
 *  pi spawn needs. Shared by transformSpecOnSpawn AND transformSpecOnRestore so a
 *  restored pi session gets the same wiring (mirrors droid applying droidEnv in
 *  both). No-op for specs pi doesn't own, or if nothing is configured. */
function injectPi(deps: PiResumeDeps, spec: SpawnSpec, id: string): SpawnSpec {
  if (!isPi(spec)) return spec;
  if (!(deps.hcpSock && deps.hcpToken) && !deps.piExtPath) return spec;
  return { ...spec, env: piEnv(deps, spec, id), args: withPiExt(deps, spec.args ?? []) };
}

export function makePiResumeTransforms(
  deps: PiResumeDeps = {},
): PiResumeTransforms {
  return {
    // Fresh spawn: inject the HCP env + the `-e` bridge extension so pi reports
    // turn/status/reply for THIS tile (no session-resume arg — that's restore).
    transformSpecOnSpawn: (spec, id) => injectPi(deps, spec, id),
    transformSpecOnRestore: (spec, id) => {
      if (!isPi(spec)) return spec;
      const withInjection = injectPi(deps, spec, id);
      const args = withInjection.args ?? [];
      if (args.includes("--session")) return withInjection; // already resuming a specific session
      const sessId = newestPiSessionForCwd(withInjection.cwd, deps.sessionsRoot);
      if (!sessId) return withInjection; // no matching session on disk → fresh start
      // `pi --session <id>` resumes by UUID (or path); appends after any
      // existing top-level flags, mirroring codex's `resume <id>` append.
      return { ...withInjection, args: [...args, "--session", sessId] };
    },
    // If `pi --session <id>` dies fast (session file vanished), strip the
    // --session flag AND its value so a stale id doesn't kill the tile.
    restoreRetryTransform: (spec) => {
      if (!isPi(spec)) return null;
      const args = spec.args ?? [];
      const i = args.indexOf("--session");
      if (i < 0) return null;
      return { ...spec, args: args.filter((_, idx) => idx !== i && idx !== i + 1) };
    },
  };
}
