/**
 * One workspace's layout on disk: `<dir>/<first 32 hex of sha256(repo)>.json` holding
 * `{ v: 1, repo, core, views }`. The name is a hash, so any repo path (a local path, an ssh
 * uri, `../..`) is a safe file name inside `dir`. Writes are atomic and private. A file that
 * cannot be read as this repo's record is renamed aside, never overwritten.
 *
 * The name and the format are a contract with files already on users' disks: change either
 * only with a migration (R2 replaces the format with a Loro snapshot and imports these).
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { isViewLayout, type ViewLayout } from "./layout.js";

/** One workspace's layout. `core` is null until something writes it. */
export interface WorkspaceRecord {
  core: unknown;
  views: Record<string, ViewLayout>;
}

const FORMAT = 1;

interface StoredFile {
  v: typeof FORMAT;
  repo: string;
  core: unknown;
  views: Record<string, ViewLayout>;
}

function fileFor(dir: string, repo: string): string {
  return path.join(dir, `${createHash("sha256").update(repo).digest("hex").slice(0, 32)}.json`);
}

/** The record stored for `repo`, or an empty one. `warn` hears about a file set aside. */
export function readRecord(dir: string, repo: string, warn: (message: string) => void): WorkspaceRecord {
  const file = fileFor(dir, repo);
  try {
    return parse(fs.readFileSync(file, "utf8"), repo);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { core: null, views: {} };
    const aside = `${file}.corrupt-${Date.now()}`;
    try { fs.renameSync(file, aside); } catch { /* leave it where it is */ }
    warn(`the layout file for ${repo} was unreadable (${(e as Error).message}); kept as ${aside}, starting empty`);
    return { core: null, views: {} };
  }
}

function parse(raw: string, repo: string): WorkspaceRecord {
  const f = JSON.parse(raw) as Partial<StoredFile> | null;
  if (f?.v !== FORMAT) throw new Error(`unknown format ${JSON.stringify(f?.v)}`);
  if (f.repo !== repo) throw new Error("it belongs to another repo");
  if (typeof f.views !== "object" || f.views === null || Array.isArray(f.views)) throw new Error("no views");
  const views: Record<string, ViewLayout> = {};
  for (const [viewId, layout] of Object.entries(f.views)) if (isViewLayout(layout)) views[viewId] = layout;
  return { core: f.core ?? null, views };
}

/** Replace the stored record: a private temp file renamed over the old one. Throws when it cannot. */
export function writeRecord(dir: string, repo: string, record: WorkspaceRecord): void {
  const file = fileFor(dir, repo);
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const body: StoredFile = { v: FORMAT, repo, core: record.core, views: record.views };
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    throw e;
  }
}
