/**
 * WorkspaceStore — the one owner of each workspace's layout (docs/design/multiplayer-2026-09-28.md,
 * R1, R2, R15): the core layout (frames, tiles in order, their names, tabs and frames), every
 * view's versioned layout and the board's objects, per repo. Each workspace is one Loro document
 * (@hivemind/workspace-doc).
 *
 * Electron main embeds it today and the headless `hive host` will run it (R14), so nothing here
 * imports Electron. The window still sends whole layouts; the document records each as the edits
 * that make it hold that layout, so it keeps only what changed and, once others write too, edits
 * to different things merge.
 *
 * Reads are synchronous: a repo's document is loaded on first use, then served from memory.
 * Every change is written through at once (the window already debounces), so an app that exits
 * a moment after a change has it on disk. A write that fails stays pending: the repo's next
 * change or `flush()` writes it.
 *
 * Undo takes back board edits only, through Loro's UndoManager, which undoes this writer's own
 * edits: the layout, views and imports are committed under `sys:` and never undone (an undo
 * cannot bring back a closed tile's process). Edits made within a second of each other are one
 * step. The history lasts as long as the store does.
 */
import { UndoManager, type LoroDoc } from "loro-crdt";
import { hasCore, readCore, writeCore } from "@hivemind/workspace-doc/core";
import { readObjects, writeObjects } from "@hivemind/workspace-doc/objects";
import { readView, writeView } from "@hivemind/workspace-doc/views";
import type { BoardObject, CoreLayout, ViewLayout } from "@hivemind/workspace-doc/shapes";
import type { LegacyLayout } from "./layout.js";
import { readDoc, writeDoc } from "./doc-file.js";

export type { LegacyLayout } from "./layout.js";
export type { BoardObject, CoreLayout, ViewLayout } from "@hivemind/workspace-doc/shapes";

/** Commit origins: undo skips every one that starts with `sys:`. */
const BOARD = "board";
const LAYOUT = "sys:layout";
const VIEW = "sys:view";
const IMPORT = "sys:import";

interface Workspace {
  doc: LoroDoc;
  history: UndoManager;
}

export interface WorkspaceStoreOptions {
  /** Directory with one file per workspace; created (0700) on the first write. */
  dir: string;
  /** Hears what the embedder should log: a file set aside, a failed write, an import skipped. */
  onWarn?: (message: string) => void;
}

export class WorkspaceStore {
  private readonly workspaces = new Map<string, Workspace>();
  /** Repos whose file is behind their document because a write failed. */
  private readonly unsaved = new Set<string>();

  constructor(private readonly opts: WorkspaceStoreOptions) {}

  /** The core layout, or null when none was ever written. A fresh copy each call. */
  getCore(repo: string): CoreLayout | null {
    return readCore(this.workspace(repo).doc);
  }

  /** One view's layout, or null. A fresh copy each call. */
  getView(repo: string, viewId: string): ViewLayout | null {
    return readView(this.workspace(repo).doc, viewId);
  }

  /** The board's objects, or none. A fresh copy each call. */
  getObjects(repo: string): BoardObject[] {
    return readObjects(this.workspace(repo).doc);
  }

  /** Make `core` the core layout. Malformed entries are dropped; what cannot be a layout is refused. */
  setCore(repo: string, core: unknown): void {
    const { doc } = this.workspace(repo);
    writeCore(doc, core);
    this.commit(repo, doc, LAYOUT);
  }

  setView(repo: string, viewId: string, layout: ViewLayout): void {
    const { doc } = this.workspace(repo);
    writeView(doc, viewId, layout);
    this.commit(repo, doc, VIEW);
  }

  /** Make `objects` the board. A malformed object is dropped; what is not a list is refused. */
  setObjects(repo: string, objects: unknown): void {
    const { doc } = this.workspace(repo);
    writeObjects(doc, objects);
    this.commit(repo, doc, BOARD);
  }

  /** Take back the last board edit not yet taken back. False when there is none. */
  undo(repo: string): boolean {
    const { doc, history } = this.workspace(repo);
    if (!history.undo()) return false;
    this.persist(repo, doc);
    return true;
  }

  /** Make again the last board edit undo took back. False when there is none. */
  redo(repo: string): boolean {
    const { doc, history } = this.workspace(repo);
    if (!history.redo()) return false;
    this.persist(repo, doc);
    return true;
  }

  /**
   * Layout saved before the store existed. Fills only what is empty, so it never replaces a
   * core or a view the store already has, and offering the same layout twice changes nothing.
   * An entry that cannot be a layout is skipped and reported.
   */
  importLegacy(repo: string, legacy: LegacyLayout): void {
    if (typeof legacy !== "object" || legacy === null) throw new TypeError("workspace store: a legacy layout is an object");
    const { doc } = this.workspace(repo);
    let took = false;
    if (!hasCore(doc) && legacy.core !== undefined && legacy.core !== null) took = this.tryImport(repo, () => writeCore(doc, legacy.core)) || took;
    for (const [viewId, layout] of Object.entries(legacy.views ?? {})) {
      // Cast, not checked: writeView refuses what is not a view layout.
      if (readView(doc, viewId) === null) took = this.tryImport(repo, () => writeView(doc, viewId, layout as ViewLayout)) || took;
    }
    if (took) this.commit(repo, doc, IMPORT);
  }

  /** Write every repo whose last write failed. The embedder calls it on quit. */
  flush(): void {
    for (const repo of [...this.unsaved]) this.persist(repo, this.workspaces.get(repo)!.doc);
  }

  private workspace(repo: string): Workspace {
    if (typeof repo !== "string" || repo.length === 0) throw new TypeError("workspace store: repo must be a non-empty string");
    let workspace = this.workspaces.get(repo);
    if (!workspace) {
      const doc = readDoc(this.opts.dir, repo, this.warn);
      workspace = { doc, history: new UndoManager(doc, { excludeOriginPrefixes: ["sys:"] }) };
      this.workspaces.set(repo, workspace);
    }
    return workspace;
  }

  private tryImport(repo: string, write: () => void): boolean {
    try {
      write();
      return true;
    } catch (e) {
      if (!(e instanceof TypeError)) throw e;
      this.warn(`an old layout for ${repo} was not imported: ${e.message}`);
      return false;
    }
  }

  private commit(repo: string, doc: LoroDoc, origin: string): void {
    doc.commit({ origin });
    this.persist(repo, doc);
  }

  private persist(repo: string, doc: LoroDoc): void {
    try {
      writeDoc(this.opts.dir, repo, doc);
      this.unsaved.delete(repo);
    } catch (e) {
      this.unsaved.add(repo);
      this.warn(`cannot write the layout for ${repo} (${e instanceof Error ? e.message : String(e)}); kept in memory until the next write`);
    }
  }

  private readonly warn = (message: string): void => {
    this.opts.onWarn?.(message);
  };
}
