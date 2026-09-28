/**
 * WorkspaceStore — the one owner of each workspace's shared layout: the core blob (frames,
 * tiles, membership, names, editor tabs) and every view's own versioned layout blob, per repo.
 *
 * It takes over from the renderer's localStorage as the place this state lives
 * (docs/design/multiplayer-2026-09-28.md, R1). Electron main embeds it today; the headless
 * `hive host` will run it later (R14), so nothing here may import Electron. Values are opaque
 * JSON: the renderer still normalises what it reads, and the typed schema arrives with the
 * Loro document (R2).
 *
 * Reads are synchronous — a repo's file is read once, then served from memory — so a window
 * can still initialise its state in one pass. Writes are debounced to disk and atomic (a temp
 * file renamed over the old one). Every write is announced with the writer's `origin`, so a
 * second window can mirror it without echoing its own edits back.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

/** A view's layout as it has always been stored: a schema version and the view's own data. */
export interface ViewEnvelope {
  v: number;
  data: unknown;
}

/** What the store holds for one workspace. `core` is null until something writes it. */
export interface WorkspaceRecord {
  core: unknown;
  views: Record<string, ViewEnvelope>;
}

export type WorkspaceChange =
  | { repo: string; part: "core"; origin?: string }
  | { repo: string; part: "view"; viewId: string; origin?: string };

export interface WorkspaceStoreOptions {
  /** Directory with one JSON file per workspace; created (0700) on the first write. */
  dir: string;
  /** How long a change waits before it is written (ms). Default 250; 0 writes at once. */
  flushMs?: number;
  /** Something went wrong that the caller should log: an unreadable file, a failed write. */
  onWarn?: (message: string) => void;
  /** Clock for `savedAt` (tests). */
  now?: () => number;
}

/** The file format. Bump `v` only with a migration. */
interface StoredFile {
  v: 1;
  repo: string;
  core: unknown;
  views: Record<string, ViewEnvelope>;
  savedAt: number;
}

const FILE_VERSION = 1;
const DEFAULT_FLUSH_MS = 250;

/** The file a workspace lives in: a hash of its repo path, so any path makes a safe name. */
export function recordFile(dir: string, repo: string): string {
  return path.join(dir, `${createHash("sha256").update(repo).digest("hex").slice(0, 32)}.json`);
}

function isEnvelope(x: unknown): x is ViewEnvelope {
  return typeof x === "object" && x !== null && !Array.isArray(x)
    && typeof (x as ViewEnvelope).v === "number" && Number.isFinite((x as ViewEnvelope).v)
    && "data" in x;
}

function checkRepo(repo: unknown): asserts repo is string {
  if (typeof repo !== "string" || repo.length === 0) throw new TypeError("workspace store: repo must be a non-empty string");
}

function checkViewId(viewId: unknown): asserts viewId is string {
  if (typeof viewId !== "string" || viewId.length === 0 || viewId.length > 256) {
    throw new TypeError("workspace store: viewId must be a non-empty string of at most 256 characters");
  }
}

const copy = <T>(value: T): T => (value === undefined ? value : structuredClone(value));

export class WorkspaceStore {
  private readonly records = new Map<string, WorkspaceRecord>();
  private readonly dirty = new Set<string>();
  private readonly listeners = new Set<(change: WorkspaceChange) => void>();
  private readonly flushMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private readonly opts: WorkspaceStoreOptions) {
    this.flushMs = opts.flushMs ?? DEFAULT_FLUSH_MS;
  }

  /** Everything stored for `repo`, as a copy the caller may keep or change. */
  load(repo: string): WorkspaceRecord {
    const r = this.record(repo);
    return { core: copy(r.core), views: copy(r.views) };
  }

  getCore(repo: string): unknown {
    return copy(this.record(repo).core);
  }

  getView(repo: string, viewId: string): ViewEnvelope | null {
    checkViewId(viewId);
    const env = this.record(repo).views[viewId];
    return env ? copy(env) : null;
  }

  setCore(repo: string, core: unknown, origin?: string): void {
    this.assertOpen();
    const r = this.record(repo);
    r.core = copy(core ?? null);
    this.changed({ repo, part: "core", ...(origin ? { origin } : {}) });
  }

  setView(repo: string, viewId: string, env: ViewEnvelope, origin?: string): void {
    this.assertOpen();
    checkViewId(viewId);
    if (!isEnvelope(env)) throw new TypeError("workspace store: a view layout is { v: number, data }");
    const r = this.record(repo);
    r.views[viewId] = { v: env.v, data: copy(env.data) };
    this.changed({ repo, part: "view", viewId, ...(origin ? { origin } : {}) });
  }

  /**
   * One-time import of layout saved before this store existed. Fills only what is empty —
   * never overwrites a core or a view the store already has — and reports what it took.
   */
  importLegacy(repo: string, legacy: { core?: unknown; views?: Record<string, unknown> }, origin?: string): { core: boolean; views: string[] } {
    this.assertOpen();
    const r = this.record(repo);
    const took = { core: false, views: [] as string[] };
    if (r.core === null && legacy.core !== undefined && legacy.core !== null) {
      r.core = copy(legacy.core);
      took.core = true;
      this.changed({ repo, part: "core", ...(origin ? { origin } : {}) });
    }
    for (const [viewId, env] of Object.entries(legacy.views ?? {})) {
      if (typeof viewId !== "string" || viewId.length === 0 || viewId.length > 256) continue;
      if (viewId in r.views || !isEnvelope(env)) continue;
      r.views[viewId] = { v: env.v, data: copy(env.data) };
      took.views.push(viewId);
      this.changed({ repo, part: "view", viewId, ...(origin ? { origin } : {}) });
    }
    return took;
  }

  /** Called after every change, synchronously. Returns an unsubscribe. */
  onChange(listener: (change: WorkspaceChange) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Write every pending change now. */
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    for (const repo of [...this.dirty]) this.write(repo);
  }

  /** Write what is pending and refuse further changes (app quit, host shutdown). */
  close(): void {
    this.flush();
    this.closed = true;
    this.listeners.clear();
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private assertOpen(): void {
    if (this.closed) throw new Error("workspace store: closed");
  }

  private record(repo: string): WorkspaceRecord {
    checkRepo(repo);
    let r = this.records.get(repo);
    if (!r) {
      r = this.read(repo);
      this.records.set(repo, r);
    }
    return r;
  }

  /** A repo's stored record, or an empty one. An unreadable file is kept aside, never lost. */
  private read(repo: string): WorkspaceRecord {
    const file = recordFile(this.opts.dir, repo);
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.warn(`cannot read ${file}: ${(e as Error).message}`);
      return { core: null, views: {} };
    }
    try {
      const parsed = JSON.parse(raw) as Partial<StoredFile>;
      if (parsed?.v !== FILE_VERSION || parsed.repo !== repo || typeof parsed.views !== "object" || parsed.views === null || Array.isArray(parsed.views)) {
        throw new Error("unexpected shape");
      }
      const views: Record<string, ViewEnvelope> = {};
      for (const [id, env] of Object.entries(parsed.views)) if (isEnvelope(env)) views[id] = env;
      return { core: parsed.core ?? null, views };
    } catch (e) {
      const aside = `${file}.corrupt-${this.now()}`;
      try { fs.renameSync(file, aside); } catch { /* leave it where it is */ }
      this.warn(`workspace file for ${repo} was unreadable (${(e as Error).message}); kept as ${aside}, starting empty`);
      return { core: null, views: {} };
    }
  }

  private changed(change: WorkspaceChange): void {
    this.dirty.add(change.repo);
    this.schedule();
    for (const l of this.listeners) {
      try { l(change); } catch (e) { this.warn(`change listener threw: ${(e as Error).message}`); }
    }
  }

  private schedule(): void {
    if (this.flushMs === 0) { this.flush(); return; }
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.flushMs);
    this.timer.unref?.();
  }

  private write(repo: string): void {
    const r = this.records.get(repo);
    if (!r) { this.dirty.delete(repo); return; }
    const file = recordFile(this.opts.dir, repo);
    const body: StoredFile = { v: FILE_VERSION, repo, core: r.core, views: r.views, savedAt: this.now() };
    const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    try {
      fs.mkdirSync(this.opts.dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
      fs.renameSync(tmp, file);
      this.dirty.delete(repo);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
      this.warn(`cannot write ${file}: ${(e as Error).message}; will retry`);
      if (!this.closed && this.flushMs > 0 && !this.timer) {
        this.timer = setTimeout(() => { this.timer = null; this.flush(); }, Math.max(this.flushMs, 1000));
        this.timer.unref?.();
      }
    }
  }

  private warn(message: string): void {
    this.opts.onWarn?.(message);
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }
}
