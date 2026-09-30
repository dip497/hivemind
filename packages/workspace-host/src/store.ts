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
 * Each workspace says whose it is (R3): a document that does not say yet is stamped, when the store
 * opens it, with a new workspace id, this machine's person as its owner and the public half of the
 * workspace key, and it is on disk with the next write.
 *
 * Reads are synchronous: a repo's document is loaded on first use, then served from memory.
 * Every change is written through at once (the window already debounces), so an app that exits
 * a moment after a change has it on disk. A write that fails stays pending: the repo's next
 * change or `flush()` writes it.
 *
 * Undo takes back board edits only, through Loro's UndoManager: the layout, views and imports are
 * committed under `sys:` and never undone (an undo cannot bring back a closed tile's process).
 * Each writer has a history of its own, so a window's ⌘Z takes back its own edit, never one
 * another window made since. Each board write is one step — the window writes a burst of typing
 * as one — so edits made a moment apart are never taken back together. A history lasts until its
 * writer is gone (`forgetWriter`: a window closed).
 */
import { UndoManager, VersionVector, type LoroDoc } from "loro-crdt";
import { addTile, hasCore, holdsTile, readCore, removeTile, writeCore, writeTileName } from "@hivemind/workspace-doc/core";
import { readObjects, writeObjects } from "@hivemind/workspace-doc/objects";
import { readView, readViews, writeView } from "@hivemind/workspace-doc/views";
import { readOwnership, stampOwnership, stampSchema, type Ownership } from "@hivemind/workspace-doc/schema";
import type { BoardObject, CoreLayout, TileRecord, ViewLayout } from "@hivemind/workspace-doc/shapes";
import type { LegacyLayout, WorkspaceChange } from "./layout.js";
import { readDoc, writeDoc } from "./doc-file.js";
import { idOf, newWorkspaceId, workspaceSeed, type Seed } from "./identity.js";

export type { LegacyLayout, WorkspaceChange } from "./layout.js";
export type { BoardObject, CoreLayout, ViewLayout } from "@hivemind/workspace-doc/shapes";

/** Commit origins: undo skips every one that starts with `sys:`, and each writer's history skips
 *  the others' board edits. The writer is encoded, so no writer's origin begins another's. */
const boardOf = (writer: string): string => `board:${encodeURIComponent(writer)};`;
const LAYOUT = "sys:layout";
const VIEW = "sys:view";
const IMPORT = "sys:import";

interface Workspace {
  doc: LoroDoc;
  /** Each writer's board edits, by writer. */
  histories: Map<string, UndoManager>;
}

/** Who writes: told with the change, so the others hear of it and the writer does not. */
export interface Writer {
  writer?: string;
}

export interface WorkspaceStoreOptions {
  /** Directory with one file per workspace; created (0700) on the first write. */
  dir: string;
  /** The person key this machine holds. A workspace whose document does not say whose it is yet is
   *  this person's: it is made here, or was before workspaces had owners. None for a store of
   *  replicas of others' workspaces (M1), which never marks a document: its host's says whose it is. */
  person?: Seed;
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

  /** Every view's layout, by view id. A fresh copy each call. */
  getViews(repo: string): Record<string, ViewLayout> {
    return readViews(this.workspace(repo).doc);
  }

  /** Whose the workspace `repo` is: its id, its owner and its workspace key (R3). */
  ownership(repo: string): Ownership | null {
    return readOwnership(this.workspace(repo).doc);
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

  /** Make `layout` the view `viewId`'s layout. Given `base`, the one it was made from (null: none
   *  was read), only what changed from it is written. */
  setView(repo: string, viewId: string, layout: ViewLayout, from: Writer & { base?: unknown } = {}): void {
    this.write(repo, `view:${viewId}`, VIEW, from, (doc) => writeView(doc, viewId, layout, from.base));
  }

  /** Make `objects` the board. A malformed object is dropped; what is not a list is refused. Given
   *  `base`, the board it was made from (null: none was read), only what changed from it is
   *  written. */
  setObjects(repo: string, objects: unknown, from: Writer & { base?: unknown } = {}): void {
    const writer = from.writer ?? "";
    this.history(repo, writer);
    this.write(repo, "board", boardOf(writer), from, (doc) => writeObjects(doc, objects, from.base));
  }

  /** The workspace this store has open that holds the tile `tileId`, or null: the control plane
   *  knows a tile by its id alone. */
  workspaceOf(tileId: string): string | null {
    for (const [repo, { doc }] of this.workspaces) if (holdsTile(doc, tileId)) return repo;
    return null;
  }

  /** Name the tile `tileId` (an empty name takes its name away) in the workspace that holds it.
   *  That workspace, or null. */
  renameTile(tileId: string, name: string, from: Writer = {}): string | null {
    const repo = this.workspaceOf(tileId);
    if (repo !== null) this.write(repo, "core", LAYOUT, from, (doc) => writeTileName(doc, tileId, name));
    return repo;
  }

  /** Open `tile` in the workspace `repo`, in the frame `at.frame` (none: loose) and named
   *  `at.name`. False when that workspace already holds a tile with its id. */
  addTile(repo: string, tile: TileRecord, at: { frame?: string; name?: string } = {}, from: Writer = {}): boolean {
    let added = false;
    this.write(repo, "core", LAYOUT, from, (doc) => { added = addTile(doc, tile, at); });
    return added;
  }

  /** Take the tile `tileId` out of the workspace that holds it. That workspace and what the tile
   *  was, or null. */
  removeTile(tileId: string, from: Writer = {}): { repo: string; tile: TileRecord } | null {
    const repo = this.workspaceOf(tileId);
    if (repo === null) return null;
    let tile: TileRecord | null = null;
    this.write(repo, "core", LAYOUT, from, (doc) => { tile = removeTile(doc, tileId); });
    return tile && { repo, tile };
  }

  /** A writer that is gone for good (a window closed): its board history in every workspace goes
   *  with it. What it wrote stays. */
  forgetWriter(writer: string): void {
    for (const { histories } of this.workspaces.values()) {
      const history = histories.get(writer);
      if (!history) continue;
      histories.delete(writer);
      history.free();
    }
  }

  /** Take back the writer's last board edit not yet taken back. False when there is none. */
  undo(repo: string, from: Writer = {}): boolean {
    return this.step(repo, from, (history) => history.undo());
  }

  /** Make again the writer's last board edit undo took back. False when there is none. */
  redo(repo: string, from: Writer = {}): boolean {
    return this.step(repo, from, (history) => history.redo());
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

  /** The document's version: what a replica of it has seen, encoded (M1's sync). */
  version(repo: string): Uint8Array {
    return this.workspace(repo).doc.oplogVersion().encode();
  }

  /** What a replica that has seen `since` (an encoded version; null: nothing) needs to catch up: the
   *  updates after it, or the whole document when it is from before the history this one keeps. */
  exportSince(repo: string, since: Uint8Array | null): Uint8Array {
    const { doc } = this.workspace(repo);
    if (since) {
      const seen = VersionVector.decode(since);
      const kept = doc.isShallow() ? seen.compare(doc.shallowSinceVV()) : 1;
      if (kept !== undefined && kept >= 0) return doc.export({ mode: "update", from: seen });
    }
    return doc.export({ mode: "snapshot" });
  }

  /** Take another replica's changes (updates or a whole document, as `exportSince` gives them) as
   *  `from`'s edit: written, and told like any other change. Throws for bytes that are not a
   *  document's. */
  importFrom(repo: string, bytes: Uint8Array, from: Writer = {}): void {
    const { doc } = this.workspace(repo);
    const before = JSON.stringify(doc.frontiers());
    doc.import(bytes);
    if (JSON.stringify(doc.frontiers()) === before) return;
    this.persist(repo, doc);
    const parts: WorkspaceChange["part"][] = ["core", "board", ...Object.keys(readViews(doc)).map((v) => `view:${v}` as const)];
    for (const part of parts) this.opts.onChange?.({ repo, part, writer: from.writer ?? "" });
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
      // Stamped before the history starts: a stamp is nobody's edit, so no undo takes it back. It
      // is on disk with the next write.
      const person = this.opts.person;
      if (person) {
        stampSchema(doc);
        stampOwnership(doc, () => {
          const workspaceId = newWorkspaceId();
          return { workspaceId, owner: idOf(person), workspacePublicKey: idOf(workspaceSeed(person, workspaceId)) };
        });
        doc.commit();
      }
      workspace = { doc, histories: new Map() };
      this.workspaces.set(repo, workspace);
    }
    return workspace;
  }

  /** The writer's board history in `repo`, started before its first board edit. It skips every
   *  other writer's edits, and theirs skip its. */
  private history(repo: string, writer: string): UndoManager {
    const { doc, histories } = this.workspace(repo);
    let history = histories.get(writer);
    if (!history) {
      history = new UndoManager(doc, { mergeInterval: 0, excludeOriginPrefixes: ["sys:", ...[...histories.keys()].map(boardOf)] });
      for (const other of histories.values()) other.addExcludeOriginPrefix(boardOf(writer));
      histories.set(writer, history);
    }
    return history;
  }

  /** An undo or redo in the writer's history, committed as the writer's own board edit. */
  private step(repo: string, from: Writer, move: (history: UndoManager) => boolean): boolean {
    const writer = from.writer ?? "";
    const history = this.history(repo, writer);
    let did = false;
    this.write(repo, "board", boardOf(writer), from, (doc) => {
      doc.setNextCommitOrigin(boardOf(writer));
      did = move(history);
    });
    return did;
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
   * Make an edit, commit it under `origin`, and if it changed anything write the file and tell who
   * listens. A write that changes nothing writes and tells nothing.
   */
  private write(repo: string, part: WorkspaceChange["part"], origin: string, from: Writer, edit: (doc: LoroDoc) => void): void {
    const { doc } = this.workspace(repo);
    const before = JSON.stringify(doc.frontiers());
    edit(doc);
    doc.commit({ origin });
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
