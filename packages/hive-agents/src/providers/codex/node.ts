/**
 * Codex session resume. Unlike claude (which lets us pre-assign `--session-id`
 * at spawn and resume that exact id), codex generates its own session id and
 * exposes NO pre-assign flag + NO hook to push the id out. But it DOES write a
 * durable session file per run: `~/.codex/sessions/<…>/*.jsonl`, whose first
 * line is a `session_meta` record carrying `{ id, cwd }`.
 *
 * So instead of binding at spawn, we resolve at RESTORE: find the newest codex
 * session whose `cwd` matches the tile's cwd and respawn `codex … resume <id>`.
 * No spawn-time changes, no hook, no post-spawn capture needed. Ambiguous only
 * if two codex tiles share one cwd (both resume the newest) — acceptable.
 */
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import type { AgentPlugin, SpawnSpec } from "../../types.js";

export function isCodex(spec: { cmd: string }): boolean {
  return basename(spec.cmd.trim().split(/\s+/)[0] ?? "") === "codex";
}

/** Chunked: the first line embeds the whole system prompt (~22 KB). */
function firstLine(file: string, cap = 4 * 1024 * 1024): string {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(64 * 1024);
    // A chunk boundary can split a multi-byte char.
    const dec = new StringDecoder("utf8");
    let out = "";
    let pos = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (n === 0) return out + dec.end();
      const s = dec.write(buf.subarray(0, n));
      const nl = s.indexOf("\n");
      if (nl !== -1) return out + s.slice(0, nl);
      out += s;
      pos += n;
      if (out.length > cap) return out;
    }
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
 * Newest codex session id whose `cwd` matches `cwd`, or undefined. Scans the
 * most-recent files first and stops at the first cwd match.
 */
export function newestCodexSessionForCwd(
  cwd: string,
  sessionsRoot: string = join(homedir(), ".codex", "sessions"),
): string | undefined {
  const files = collectSessionFiles(sessionsRoot).sort((a, b) => b.mtime - a.mtime);
  for (const f of files.slice(0, 200)) {
    try {
      const meta = JSON.parse(firstLine(f.path)) as { type?: string; payload?: { id?: string; cwd?: string } };
      if (meta?.type === "session_meta" && meta.payload?.cwd === cwd && meta.payload.id) {
        return meta.payload.id;
      }
    } catch { /* not a session_meta line / parse error → skip */ }
  }
  return undefined;
}

export interface CodexResumeTransforms {
  transformSpecOnRestore: (spec: SpawnSpec, id: string) => SpawnSpec;
  restoreRetryTransform: (spec: SpawnSpec) => SpawnSpec | null;
}

export function makeCodexResumeTransforms(
  sessionsRoot?: string,
): CodexResumeTransforms {
  return {
    transformSpecOnRestore: (spec) => {
      if (!isCodex(spec)) return spec;
      const args = spec.args ?? [];
      if (args.includes("resume")) return spec; // already resuming
      const id = newestCodexSessionForCwd(spec.cwd, sessionsRoot);
      if (!id) return spec; // no matching session on disk → fresh start
      // Top-level options (-s/-a) stay BEFORE the `resume` subcommand.
      return { ...spec, args: [...args, "resume", id] };
    },
    // If `codex … resume <id>` dies fast (session file vanished), strip the
    // resume and respawn fresh so a stale id doesn't kill the tile.
    restoreRetryTransform: (spec) => {
      if (!isCodex(spec)) return null;
      const args = spec.args ?? [];
      const i = args.indexOf("resume");
      if (i < 0) return null;
      return { ...spec, args: args.slice(0, i) };
    },
  };
}

import { codex } from "./index.js";

/** The codex plugin: def + newest-session-for-cwd resume. */
export const plugin: AgentPlugin = {
  def: codex,
  resume: () => makeCodexResumeTransforms(),
};
