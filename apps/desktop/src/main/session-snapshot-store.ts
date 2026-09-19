/** Session snapshots on disk: private files, no control-plane token, and
 *  listed by filename at boot so a file is read only when its tile attaches. */
import fs from "node:fs";
import path from "node:path";
import type { SessionSnapshot } from "./pty-session-manager.js";

const TOKEN_ENV = "HCP_TOKEN";
export const TOKEN_PLACEHOLDER = "@hivemind/hcp-token";

/** Matches claude's default transcript retention; past it only an old screen is left. */
export const SNAPSHOT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function fileNameForId(id: string): string {
  return `${Buffer.from(id).toString("base64url")}.json`;
}

/** Round-trips because base64url decoding never throws on junk. */
export function idFromFileName(name: string): string | null {
  if (!name.endsWith(".json")) return null;
  const stem = name.slice(0, -5);
  if (!stem) return null;
  const id = Buffer.from(stem, "base64url").toString("utf8");
  return fileNameForId(id) === name ? id : null;
}

export function redactSnapshot(snap: SessionSnapshot): SessionSnapshot {
  const env = snap.spec.env;
  if (!env || env[TOKEN_ENV] === undefined) return snap;
  return { ...snap, spec: { ...snap.spec, env: { ...env, [TOKEN_ENV]: TOKEN_PLACEHOLDER } } };
}

/** Replaces a placeholder or stale token; drops the variable when there is none. */
export function rehydrateSnapshot(snap: SessionSnapshot, token: string | undefined): SessionSnapshot {
  const env = snap.spec.env;
  if (!env || env[TOKEN_ENV] === undefined) return snap;
  const next = { ...env };
  if (token) next[TOKEN_ENV] = token;
  else delete next[TOKEN_ENV];
  return { ...snap, spec: { ...snap.spec, env: next } };
}

export function secureDir(dir: string): void {
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { /* exists / readonly */ }
  try { fs.chmodSync(dir, 0o700); } catch { /* not ours to change */ }
}

export interface SnapshotEntry {
  id: string;
  file: string;
  mtimeMs: number;
}

/** Lists without reading; tightens files older versions left 0664. */
export function listSnapshotFiles(dir: string): SnapshotEntry[] {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out: SnapshotEntry[] = [];
  for (const name of names) {
    const id = idFromFileName(name);
    if (id === null) continue;
    const file = path.join(dir, name);
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) continue;
      if ((st.mode & 0o077) !== 0) { try { fs.chmodSync(file, 0o600); } catch { /* not ours */ } }
      out.push({ id, file, mtimeMs: st.mtimeMs });
    } catch { /* vanished between readdir and stat */ }
  }
  return out;
}

/** Sync on purpose: an await in the attach path would let a second attach spawn fresh. */
export function readSnapshot(file: string, expectedId?: string): SessionSnapshot | undefined {
  try {
    const snap = JSON.parse(fs.readFileSync(file, "utf8")) as SessionSnapshot;
    if (!snap || typeof snap.id !== "string" || typeof snap.replay !== "string" || !snap.spec) return undefined;
    if (expectedId !== undefined && snap.id !== expectedId) return undefined;
    return snap;
  } catch {
    return undefined;
  }
}

/** Unclaimed AND old: a canvas not opened this session keeps its tiles. */
export function staleSnapshotIds(
  entries: readonly SnapshotEntry[],
  unclaimed: Iterable<string>,
  now: number,
  retentionMs: number = SNAPSHOT_RETENTION_MS,
): string[] {
  const open = new Set(unclaimed);
  const cutoff = now - retentionMs;
  return entries.filter((e) => open.has(e.id) && e.mtimeMs < cutoff).map((e) => e.id);
}
