/**
 * WorkspaceStore — the one owner of each workspace's layout (docs/design/multiplayer-2026-09-28.md,
 * R1): the core blob (frames, tiles, membership, names, editor tabs) and every view's versioned
 * layout, per repo.
 *
 * Electron main embeds it today and the headless `hive host` will run it (R14), so nothing here
 * imports Electron. Values are opaque JSON (the window normalises what it reads) until the Loro
 * document (R2) gives them a schema. Every caller's input is checked here, once, whatever
 * transport it came over.
 *
 * Reads are synchronous: a repo's file is read on first use, then served from memory. Every
 * change is written through at once (the window already debounces), so an app that exits a
 * moment after a change has it on disk. A write that fails stays pending: the repo's next
 * change or `flush()` writes it.
 */
import { isViewLayout, type LegacyLayout, type ViewLayout } from "./layout.js";
import { readRecord, writeRecord, type WorkspaceRecord } from "./record-file.js";

export type { LegacyLayout, ViewLayout } from "./layout.js";

export interface WorkspaceStoreOptions {
  /** Directory with one file per workspace; created (0700) on the first write. */
  dir: string;
  /** Hears what the embedder should log: a file set aside, a failed write. */
  onWarn?: (message: string) => void;
}

const MAX_VIEW_ID = 256;

export class WorkspaceStore {
  private readonly records = new Map<string, WorkspaceRecord>();
  /** Repos whose file is behind memory because a write failed. */
  private readonly unsaved = new Set<string>();

  constructor(private readonly opts: WorkspaceStoreOptions) {}

  /** The core blob, or null. A copy: changing it changes nothing stored. */
  getCore(repo: string): unknown {
    return structuredClone(this.record(repo).core);
  }

  /** One view's layout, or null. A copy. */
  getView(repo: string, viewId: string): ViewLayout | null {
    checkViewId(viewId);
    const layout = this.record(repo).views[viewId];
    return layout ? structuredClone(layout) : null;
  }

  setCore(repo: string, core: unknown): void {
    this.record(repo).core = structuredClone(core ?? null);
    this.save(repo);
  }

  setView(repo: string, viewId: string, layout: ViewLayout): void {
    checkViewId(viewId);
    if (!isViewLayout(layout)) throw new TypeError("workspace store: a view layout is { v: number, data }");
    this.record(repo).views[viewId] = { v: layout.v, data: structuredClone(layout.data) };
    this.save(repo);
  }

  /**
   * Layout saved before the store existed. Fills only what is empty, so it never replaces a
   * core or a view the store already has, and offering the same layout twice changes nothing.
   */
  importLegacy(repo: string, legacy: LegacyLayout): void {
    if (typeof legacy !== "object" || legacy === null) throw new TypeError("workspace store: a legacy layout is an object");
    const r = this.record(repo);
    let took = false;
    if (r.core === null && legacy.core !== undefined && legacy.core !== null) {
      r.core = structuredClone(legacy.core);
      took = true;
    }
    for (const [viewId, layout] of Object.entries(legacy.views ?? {})) {
      if (!isViewId(viewId) || viewId in r.views || !isViewLayout(layout)) continue;
      r.views[viewId] = { v: layout.v, data: structuredClone(layout.data) };
      took = true;
    }
    if (took) this.save(repo);
  }

  /** Write every repo whose last write failed. The embedder calls it on quit. */
  flush(): void {
    for (const repo of [...this.unsaved]) this.save(repo);
  }

  private record(repo: string): WorkspaceRecord {
    if (typeof repo !== "string" || repo.length === 0) throw new TypeError("workspace store: repo must be a non-empty string");
    let r = this.records.get(repo);
    if (!r) {
      r = readRecord(this.opts.dir, repo, this.warn);
      this.records.set(repo, r);
    }
    return r;
  }

  private save(repo: string): void {
    try {
      writeRecord(this.opts.dir, repo, this.records.get(repo)!);
      this.unsaved.delete(repo);
    } catch (e) {
      this.unsaved.add(repo);
      this.warn(`cannot write the layout for ${repo} (${(e as Error).message}); kept in memory until the next write`);
    }
  }

  private readonly warn = (message: string): void => {
    this.opts.onWarn?.(message);
  };
}

const isViewId = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= MAX_VIEW_ID;

function checkViewId(x: unknown): asserts x is string {
  if (!isViewId(x)) throw new TypeError(`workspace store: a view id is a non-empty string of at most ${MAX_VIEW_ID} characters`);
}
