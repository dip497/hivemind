/**
 * WorkspaceStore — the one owner of each workspace's layout (docs/design/multiplayer-2026-09-28.md,
 * R1, R2, R15): the core layout (frames, tiles in order, their names, tabs and frames), every
 * view's versioned layout and the board's objects, per repo. Each workspace is one Loro document
 * (@hivemind/workspace-doc).
 *
 * Electron main embeds it today and the headless `hive host` will run it (R14), so nothing here
 * imports Electron. The window still sends whole layouts; the document records each as the edits
 * that make it hold that layout, so it keeps only what changed. Other writers (the control
 * plane, R5) edit it too: a window sends the layout it made its change from, and only that change
 * is written, so a window writing from an older reading never reverts another's edit. Each change
 * is told, with its writer, to whoever listens (main, which tells the other windows).
 *
 * Reads are synchronous: a repo's document is loaded on first use, then served from memory.
 * Every change is written through at once (the window already debounces), so an app that exits
 * a moment after a change has it on disk. A write that fails stays pending: the repo's next
 * change or `flush()` writes it.
 *
 * Undo takes back board edits only, through Loro's UndoManager, which undoes this writer's own
 * edits: the layout, views and imports are committed under `sys:` and never undone (an undo
 * cannot bring back a closed tile's process). Each board write is one step — the window writes a
 * burst of typing as one — so edits made a moment apart are never taken back together. The
 * history lasts as long as the store does.
 */
import { UndoManager, type LoroDoc } from "loro-crdt";
import { hasCore, readCore, writeCore, writeTileName } from "@hivemind/workspace-doc/core";
import { readObjects, writeObjects } from "@hivemind/workspace-doc/objects";
import { readView, writeView } from "@hivemind/workspace-doc/views";
import { stampSchema } from "@hivemind/workspace-doc/schema";
import type { BoardObject, CoreLayout, ViewLayout } from "@hivemind/workspace-doc/shapes";
import type { LegacyLayout, WorkspaceChange } from "./layout.js";
import { readDoc, writeDoc } from "./doc-file.js";

export type { LegacyLayout, WorkspaceChange } from "./layout.js";
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

/** Who writes: told with the change, so the others hear of it and the writer does not. */
export interface Writer {
  writer?: string;
}

export interface WorkspaceStoreOptions {
  /** Directory with one file per workspace; created (0700) on the first write. */
  dir: string;
  /** Hears what the embedder should log: a file set aside, a failed write, an import skipped. */
  onWarn?: (message: string) => void;
  /** Hears each write that changed something, and who wrote it. */
  onChange?: (change: WorkspaceChange) => void;
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

  /**
   * Make `core` the core layout. Malformed entries are dropped; what cannot be a layout is refused.
   * Given `base`, the layout `core` was made from (null: none was read), only what changed from
   * it is written.
   */
  setCore(repo: string, core: unknown, from: Writer & { base?: unknown } = {}): void {
    this.write(repo, "core", LAYOUT, from, (doc) => writeCore(doc, core, from.base));
  }

  setView(repo: string, viewId: string, layout: ViewLayout, from: Writer = {}): void {
    this.write(repo, `view:${viewId}`, VIEW, from, (doc) => writeView(doc, viewId, layout));
  }

  /** Make `objects` the board. A malformed object is dropped; what is not a list is refused. */
  setObjects(repo: string, objects: unknown, from: Writer = {}): void {
    this.write(repo, "board", BOARD, from, (doc) => writeObjects(doc, objects));
  }

  /**
   * Name the tile `tileId` (an empty name takes its name away), in whichever workspace this store
   * has open holds it: the control plane names a tile by its id alone. That workspace, or null.
   */
  renameTile(tileId: string, name: string, from: Writer = {}): string | null {
    for (const repo of this.workspaces.keys()) {
      let held = false;
      this.write(repo, "core", LAYOUT, from, (doc) => { held = writeTileName(doc, tileId, name); });
      if (held) return repo;
    }
    return null;
  }

  /** Take back the last board edit not yet taken back. False when there is none. */
  undo(repo: string, from: Writer = {}): boolean {
    let did = false;
    this.write(repo, "board", null, from, (_doc, history) => { did = history.undo(); });
    return did;
  }

  /** Make again the last board edit undo took back. False when there is none. */
  redo(repo: string, from: Writer = {}): boolean {
    let did = false;
    this.write(repo, "board", null, from, (_doc, history) => { did = history.redo(); });
    return did;
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
      // Stamped before the history starts: a stamp is nobody's edit, so no undo takes it back.
      stampSchema(doc);
      doc.commit();
      workspace = { doc, history: new UndoManager(doc, { mergeInterval: 0, excludeOriginPrefixes: ["sys:"] }) };
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

  /**
   * Make an edit, commit it under `origin` (null: the edit commits itself, as undo does), and if
   * it changed anything write the file and tell who listens. A write that changes nothing writes
   * and tells nothing.
   */
  private write(repo: string, part: WorkspaceChange["part"], origin: string | null, from: Writer,
    edit: (doc: LoroDoc, history: UndoManager) => void): void {
    const { doc, history } = this.workspace(repo);
    const before = JSON.stringify(doc.frontiers());
    edit(doc, history);
    if (origin !== null) doc.commit({ origin });
    if (JSON.stringify(doc.frontiers()) === before) return;
    this.persist(repo, doc);
    this.opts.onChange?.({ repo, part, writer: from.writer ?? "" });
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
