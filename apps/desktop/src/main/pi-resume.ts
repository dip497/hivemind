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
 * `pi --session <id>`. No spawn-time changes, no hook, no post-spawn capture.
 * Status falls through to the renderer screen-scrape detector (agent-state.ts
 * `detectPi`). Ambiguous only if two pi tiles share one cwd (both resume the
 * newest) — acceptable, same tradeoff codex makes.
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

export interface PiResumeTransforms {
  transformSpecOnRestore: (spec: SpawnSpec, id: string) => SpawnSpec;
  restoreRetryTransform: (spec: SpawnSpec) => SpawnSpec | null;
}

export function makePiResumeTransforms(
  sessionsRoot?: string,
): PiResumeTransforms {
  return {
    transformSpecOnRestore: (spec) => {
      if (!isPi(spec)) return spec;
      const args = spec.args ?? [];
      if (args.includes("--session")) return spec; // already resuming a specific session
      const id = newestPiSessionForCwd(spec.cwd, sessionsRoot);
      if (!id) return spec; // no matching session on disk → fresh start
      // `pi --session <id>` resumes by UUID (or path); appends after any
      // existing top-level flags, mirroring codex's `resume <id>` append.
      return { ...spec, args: [...args, "--session", id] };
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
