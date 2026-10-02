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
import { execFile, execFileSync } from "node:child_process";
import { canListSessions, isSessionId } from "./catalog.js";
export { canListSessions };
import type { AgentProviderDef, ProviderResumeTransforms, SessionFind, SessionInfo, SessionList, SpawnSpec } from "./types.js";

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

/**
 * Whether the session `id` is where the manifest says sessions are kept. One `*` segment
 * stands for a directory whose name the host does not know. Only a store that can be read
 * and does not have it says no: anything unreadable counts as there, so the agent decides.
 */
export function sessionExists(pattern: string, id: string, home: string = homedir()): boolean {
  if (!/^[\w.-]{1,128}$/.test(id)) return false;
  const full = pattern.replace("{home}", home).replace("{id}", id);
  const star = full.indexOf("/*/");
  try {
    if (star < 0) return statSync(full).isFile();
    const dir = full.slice(0, star);
    const rest = full.slice(star + 3);
    const names = readdirSync(dir);
    if (names.length > MAX_FILES) return true;
    return names.some((n) => { try { return statSync(join(dir, n, rest)).isFile(); } catch { return false; } });
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/** The file of the session `id` where `pattern` (a manifest's `session.resume.exists`) says it is
 *  kept, under `home`; null when it is not there, or cannot be looked for. */
export function sessionFile(pattern: string, id: string, home: string = homedir()): string | null {
  if (!/^[\w.-]{1,128}$/.test(id)) return null;
  const full = pattern.replace("{home}", home).replace("{id}", id);
  const isFile = (at: string) => { try { return statSync(at).isFile(); } catch { return false; } };
  const star = full.indexOf("/*/");
  if (star < 0) return isFile(full) ? full : null;
  const dir = full.slice(0, star);
  const rest = full.slice(star + 3);
  let names: string[];
  try { names = readdirSync(dir); } catch { return null; }
  for (const n of names.slice(0, MAX_FILES)) if (isFile(join(dir, n, rest))) return join(dir, n, rest);
  return null;
}

/** A listing command that hangs must not hold a restore or a caller for long. */
const LIST_TIMEOUT_MS = 15_000;
const LIST_MAX_BYTES = 32 * 1024 * 1024;
const TITLE_MAX = 200;

/** The records an agent's listing printed, as sessions. Rows without an id are dropped. */
export function parseListing(list: SessionList, stdout: string): SessionInfo[] {
  if (!list.idPath) return [];
  let rows: unknown;
  try { rows = JSON.parse(stdout); } catch { return []; }
  if (!Array.isArray(rows)) return [];
  const out: SessionInfo[] = [];
  for (const r of rows) {
    const id = at(r, list.idPath);
    if (!isSessionId(id)) continue;
    const cwd = list.cwdPath ? at(r, list.cwdPath) : undefined;
    const title = titleOf([r], list.titlePath);
    const prompt = titleOf([r], list.promptPath);
    const raw = list.updatedPath ? at(r, list.updatedPath) : undefined;
    const updated = typeof raw === "number" ? raw : typeof raw === "string" ? Date.parse(raw) : NaN;
    out.push({
      id,
      ...(typeof cwd === "string" ? { cwd } : {}),
      ...(title ? { title } : {}),
      ...(prompt ? { prompt } : {}),
      ...(Number.isFinite(updated) ? { updated } : {}),
    });
  }
  return out;
}

/** The first title a path gives, over records in order: its first line, trimmed and capped. */
function titleOf(records: unknown[], paths: string | string[] | undefined): string | undefined {
  for (const p of typeof paths === "string" ? [paths] : paths ?? []) {
    for (const r of records) {
      const v = at(r, p);
      const line = typeof v === "string" ? v.trim().split("\n")[0]!.trim() : "";
      if (line) return line.slice(0, TITLE_MAX);
    }
  }
  return undefined;
}

/** The first `n` JSON records of a file, reading no more than `cap` bytes of it. */
function firstRecords(file: string, n: number, cap = 512 * 1024): unknown[] {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(Math.min(cap, 64 * 1024));
    const dec = new StringDecoder("utf8");
    let text = "";
    let pos = 0;
    while (pos < cap) {
      const k = readSync(fd, buf, 0, buf.length, pos);
      if (k === 0) break;
      text += dec.write(buf.subarray(0, k));
      pos += k;
      if (text.split("\n").length > n) break;
    }
    const out: unknown[] = [];
    for (const line of text.split("\n").slice(0, n)) {
      try { out.push(JSON.parse(line)); } catch { /* a line cut at the cap, or not JSON */ }
    }
    return out;
  } finally {
    closeSync(fd);
  }
}

/** Fields the manifest says are in each session file's first lines, for the newest files. */
function fillFromLines(rows: Array<SessionInfo & { file?: string }>, list: SessionList | undefined): SessionInfo[] {
  const n = list?.lines;
  return rows.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0)).map(({ file, ...s }, i) => {
    if (!n || !file || i >= MAX_READS) return s;
    let records: unknown[];
    try { records = firstRecords(file, n); } catch { return s; }
    const cwd = s.cwd ?? (list!.cwdPath ? records.map((r) => at(r, list!.cwdPath!)).find((v) => typeof v === "string") : undefined);
    const title = titleOf(records, list!.titlePath);
    const prompt = titleOf(records, list!.promptPath);
    return { ...s, ...(typeof cwd === "string" ? { cwd } : {}), ...(title ? { title } : {}), ...(prompt ? { prompt } : {}) };
  });
}

/** Sessions read from the store the manifest describes: one file per session with a header
 *  (`resume.find`), or the path a session is kept at (`resume.exists`), whose file name is the id. */
function storedSessions(def: AgentProviderDef, home: string, cwd?: string): Array<SessionInfo & { file?: string }> {
  const find = def.session?.resume?.find;
  if (find?.strategy === "jsonl-header" && find.idPath) {
    const out: Array<SessionInfo & { file?: string }> = [];
    const files = collectFiles(resolveRoot(find.root, home), find.ext ?? ".jsonl").sort((a, b) => b.mtime - a.mtime);
    for (const f of files.slice(0, MAX_READS)) {
      try {
        const header = JSON.parse(firstLine(f.path)) as unknown;
        if (find.require && Object.entries(find.require).some(([p, want]) => at(header, p) !== want)) continue;
        const id = at(header, find.idPath);
        const at_cwd = find.cwdPath ? at(header, find.cwdPath) : undefined;
        if (isSessionId(id)) out.push({ id, ...(typeof at_cwd === "string" ? { cwd: at_cwd } : {}), updated: f.mtime, file: f.path });
      } catch { /* not a header */ }
    }
    return out;
  }
  if (find?.strategy === "dir-meta") {
    // Kept per workspace, under a name the host derives from the cwd: listable for one cwd only.
    if (!cwd) return [];
    const dir = join(resolveRoot(find.root, home), find.dirKey === "md5-cwd" ? createHash("md5").update(cwd).digest("hex") : cwd);
    try {
      return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && isSessionId(e.name))
        .map((e) => { try { return { id: e.name, cwd, updated: statSync(join(dir, e.name)).mtimeMs }; } catch { return { id: e.name, cwd }; } });
    } catch { return []; }
  }
  const pattern = def.session?.resume?.exists;
  if (!pattern) return [];
  const full = resolveRoot(pattern, home);
  const slash = full.lastIndexOf("/");
  const [dirPart, name] = [full.slice(0, slash), full.slice(slash + 1)];
  const [pre, post] = name.split("{id}") as [string, string | undefined];
  if (post === undefined) return [];
  const star = dirPart.indexOf("/*");
  let dirs: string[] = [dirPart];
  if (star >= 0) {
    const base = dirPart.slice(0, star);
    const rest = dirPart.slice(star + 2);
    try { dirs = readdirSync(base).slice(0, MAX_FILES).map((d) => join(base, d) + rest); } catch { return []; }
  }
  const out: Array<SessionInfo & { file?: string }> = [];
  for (const d of dirs) {
    let names: string[];
    try { names = readdirSync(d); } catch { continue; }
    for (const n of names) {
      if (!n.startsWith(pre) || !n.endsWith(post) || out.length > MAX_FILES) continue;
      const id = n.slice(pre.length, n.length - post.length);
      if (!isSessionId(id)) continue;
      try { out.push({ id, updated: statSync(join(d, n)).mtimeMs, file: join(d, n) }); } catch { /* gone */ }
    }
  }
  return out;
}

/** An agent's sessions, newest first: from its own listing when it has one, else from its
 *  store. Only those in `cwd` when one is given; a session whose cwd is not known is left out. */
export async function listSessions(def: AgentProviderDef, opts: { cwd?: string; limit?: number; home?: string } = {}): Promise<SessionInfo[]> {
  const list = def.session?.list;
  const rows = list?.args
    ? parseListing(list, await new Promise<string>((resolve) => {
        execFile(def.bin, list.args!, { encoding: "utf8", env: process.env, timeout: LIST_TIMEOUT_MS, maxBuffer: LIST_MAX_BYTES }, (err, stdout) => resolve(err ? "" : stdout));
      }))
    : fillFromLines(storedSessions(def, opts.home ?? homedir(), opts.cwd), list);
  return rows.filter((s) => !opts.cwd || s.cwd === opts.cwd)
    .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
    .slice(0, opts.limit ?? 100);
}

// ponytail: a restore asks synchronously and the listing is one process for every tile of the
// agent, so its answer is kept briefly; a listing that fails says nothing (the id counts as there).
const LISTED_TTL_MS = 30_000;
const listed = new Map<string, { at: number; ids: Set<string> | null }>();

/** Whether the agent's own listing still has `id`. True when it cannot be asked. */
export function sessionListed(def: AgentProviderDef, id: string): boolean {
  const list = def.session?.list;
  if (!list?.args) return true;
  const key = [def.bin, ...list.args].join("\0");
  let hit = listed.get(key);
  if (!hit || Date.now() - hit.at > LISTED_TTL_MS) {
    let ids: Set<string> | null = null;
    try {
      const out = execFileSync(def.bin, list.args!, { encoding: "utf8", env: process.env, timeout: LIST_TIMEOUT_MS, maxBuffer: LIST_MAX_BYTES, stdio: ["ignore", "pipe", "ignore"] });
      // Nothing printed is an empty list (some CLIs print no "[]"); anything unparseable says nothing.
      if (out.trim()) JSON.parse(out);
      ids = new Set(parseListing(list, out).map((s) => s.id));
    } catch { /* cannot be asked */ }
    hit = { at: Date.now(), ids };
    listed.set(key, hit);
  }
  return hit.ids === null || hit.ids.has(id);
}
