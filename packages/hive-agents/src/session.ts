/**
 * Resuming a session, declared rather than coded. Every CLI that can resume keeps its
 * sessions on disk in one of two shapes, and three of ours differed only in which
 * directory, which field and which flag.
 *
 * Node-only: it reads the session store. The daemon does the reading; a manifest only
 * says where to look, so an agent that resumes is no longer an agent we had to write.
 */
import { createHash } from "node:crypto";
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { AgentProviderDef, ProviderResumeTransforms, SessionFind, SpawnSpec } from "./types.js";

/** Bounds, not preferences: a session store nobody pruned must never stall a restore. */
const MAX_DEPTH = 6;
const MAX_FILES = 4000;
const MAX_READS = 200;

/** `a.b.c` through plain objects. Missing link → undefined, never a throw. */
function at(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** The first line, read in chunks: a session header can carry a whole system prompt. */
function firstLine(file: string, cap = 4 * 1024 * 1024): string {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(64 * 1024);
    const dec = new StringDecoder("utf8"); // a chunk boundary can split a character
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

function collectFiles(root: string, ext: string): Array<{ path: string; mtime: number }> {
  const out: Array<{ path: string; mtime: number }> = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || out.length > MAX_FILES) return;
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith(ext)) {
        try { out.push({ path: p, mtime: statSync(p).mtimeMs }); } catch { /* gone mid-scan */ }
      }
    }
  };
  walk(root, 0);
  return out;
}

/** `{home}` is the only placeholder a store path may use. */
export function resolveRoot(root: string, home = homedir()): string {
  return root.replace(/\{home\}/g, home);
}

/** The newest session this CLI wrote for `cwd`, or undefined to start fresh. */
export function findSession(find: SessionFind, cwd: string, root?: string): string | undefined {
  const dir = root ?? resolveRoot(find.root);
  return find.strategy === "dir-meta" ? newestByMeta(find, cwd, dir) : newestByHeader(find, cwd, dir);
}

/** One file per session, its first line a JSON header naming the session and its cwd. */
function newestByHeader(find: SessionFind, cwd: string, root: string): string | undefined {
  const files = collectFiles(root, find.ext ?? ".jsonl").sort((a, b) => b.mtime - a.mtime);
  for (const f of files.slice(0, MAX_READS)) {
    try {
      const header = JSON.parse(firstLine(f.path)) as unknown;
      if (find.require && Object.entries(find.require).some(([path, want]) => at(header, path) !== want)) continue;
      if (!find.cwdPath || !find.idPath) return undefined;
      if (at(header, find.cwdPath) !== cwd) continue;
      const id = at(header, find.idPath);
      if (isSessionId(id)) return id;
    } catch { /* not a header, or unreadable → next file */ }
  }
  return undefined;
}

/** One directory per session under a per-workspace directory, each with a metadata file. */
function newestByMeta(find: SessionFind, cwd: string, root: string): string | undefined {
  const dir = join(root, find.dirKey === "md5-cwd" ? createHash("md5").update(cwd).digest("hex") : cwd);
  let entries: import("node:fs").Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return undefined; } // nothing for this workspace yet
  let best: { id: string; at: number } | undefined;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const meta = JSON.parse(readFileSync(join(dir, e.name, find.meta ?? "meta.json"), "utf8")) as unknown;
      if (find.skipWhen && Object.entries(find.skipWhen).some(([path, skip]) => at(meta, path) === skip)) continue;
      const when = (find.newestBy ?? []).map((p) => at(meta, p)).find((v) => typeof v === "number") as number | undefined;
      const stamp = when ?? 0;
      if (!isSessionId(e.name)) continue;
      if (!best || stamp > best.at) best = { id: e.name, at: stamp };
    } catch { /* no metadata, or unparseable → skip */ }
  }
  return best?.id;
}

/** A session id goes on a command line. Anything that is not shaped like one — a path, a
 *  sentence, a secret that happened to sit in the field a manifest named — never does. */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const isSessionId = (v: unknown): v is string => typeof v === "string" && SESSION_ID_RE.test(v);

const binOfSpec = (spec: { cmd: string }): string => basename((spec.cmd ?? "").trim().split(/\s+/)[0] ?? "");

/** Is this spec launching that agent? The binary only: an alias can name a different
 *  product (`cursor` is the IDE, `cursor-agent` is the agent), and resuming the wrong one
 *  hands a session id to something that never wrote it. */
export function specIsAgent(def: AgentProviderDef, spec: { cmd: string }): boolean {
  return binOfSpec(spec) === def.bin;
}

/**
 * The resume half of a manifest, as transforms. Restore appends the agent's own resume
 * tokens; a spec that is already resuming is left alone, and a session that has since
 * vanished is stripped on the retry rather than killing the tile.
 */
export function resumeFromManifest(def: AgentProviderDef, root?: string): ProviderResumeTransforms | undefined {
  const session = def.session;
  if (!session?.resume) return undefined;
  const { args: tokens, find } = session.resume;
  const marker = tokens[0]!;
  return {
    transformSpecOnRestore: (spec: SpawnSpec): SpawnSpec => {
      if (!specIsAgent(def, spec)) return spec;
      const args = spec.args ?? [];
      if (args.includes(marker)) return spec; // already resuming
      const id = find ? findSession(find, spec.cwd, root) : undefined;
      if (!id) return spec; // nothing to resume → a fresh session
      return { ...spec, args: [...args, ...tokens.map((t) => t.replace(/\{id\}/g, id))] };
    },
    restoreRetryTransform: (spec: SpawnSpec): SpawnSpec | null => {
      if (!specIsAgent(def, spec)) return null;
      const args = spec.args ?? [];
      const i = args.indexOf(marker);
      if (i < 0) return null;
      // Drop the marker and the id it carried; anything the user passed after it stays.
      const drop = i + 1 < args.length && !args[i + 1]!.startsWith("-") ? 2 : 1;
      return { ...spec, args: [...args.slice(0, i), ...args.slice(i + drop)] };
    },
  };
}
