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
 * a moment after a change has it on disk: appended as what changed, and now and then folded into
 * the snapshot (`doc-file.ts`). A write that fails stays pending: the repo's next change or
 * `flush()` writes the document whole.
 *
 * Undo takes back board edits only, through Loro's UndoManager: the layout, views and imports are
 * committed under `sys:` and never undone (an undo cannot bring back a closed tile's process).
 * Each writer has a history of its own, so a window's ⌘Z takes back its own edit, never one
 * another window made since. Each board write is one step — the window writes a burst of typing
 * as one — so edits made a moment apart are never taken back together. A history lasts until its
 * writer is gone (`forgetWriter`: a window closed).
 */
import { LoroDoc, UndoManager, VersionVector, decodeImportBlobMeta, type Frontiers } from "loro-crdt";
import { addFrame, addTile, hasCore, readCore, removeFrame, removeTile, tileIds, writeCore, writeTileName } from "@hivemind/workspace-doc/core";
import { checkedEdit, editObjects, readObjects, readObjectsWithIds } from "@hivemind/workspace-doc/objects";
import { boardEdit } from "@hivemind/workspace-doc/board-edit";
import { readView, readViews, writeView } from "@hivemind/workspace-doc/views";
import { sameJson } from "@hivemind/workspace-doc/rebase";
import { partsChanged, readOwnership, replaceOwnership, stampOwnership, stampSchema, type Ownership } from "@hivemind/workspace-doc/schema";
import type { BoardEdit, BoardObject, CoreLayout, FrameRecord, Frozen, KeptCore, TileRecord, ViewLayout } from "@hivemind/workspace-doc/shapes";
import type { LegacyLayout, WorkspaceChange } from "./layout.js";
import { appendUpdate, readStoredDoc, removeDoc, storedKeys, writeDoc, type StoredDoc } from "./doc-file.js";
import { idOf, newWorkspaceId, workspaceSeed, type Seed } from "./identity.js";

export type { LegacyLayout, WorkspaceChange } from "./layout.js";
export type { BoardEdit, BoardObject, CoreLayout, ViewLayout } from "@hivemind/workspace-doc/shapes";
export type { KeptCore } from "@hivemind/workspace-doc/shapes";

function freeze<T>(value: T): Frozen<T> {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const inner of Object.values(value)) freeze(inner);
    Object.freeze(value);
  }
  return value as Frozen<T>;
}

/** Commit origins: undo skips every one that starts with `sys:`, and each writer's history skips
 *  the others' board edits. The writer is encoded, so no writer's origin begins another's. */
const boardOf = (writer: string): string => `board:${encodeURIComponent(writer)};`;
const WIDGETS = "sys:widgets";

/** The edit's objects with each widget's `state` as `held` has it: what a widget keeps is written
 *  apart from the edit, so undo takes back only edits. A widget not held yet keeps its own. */
function statesAsHeld(objects: Record<string, BoardObject | null>, held: Record<string, BoardObject | null>): Record<string, BoardObject | null> {
  return Object.fromEntries(Object.entries(objects).map(([id, o]) => {
    const was = held[id];
    if (o === null || o.kind !== "widget" || !was) return [id, o];
    const { state: _state, ...rest } = o;
    return [id, was.kind === "widget" && was.state !== undefined ? { ...rest, state: was.state } : rest];
  }));
}

/** The written widgets whose state the writer changed from the one it read (or which it wrote as
 *  given), with that state. */
function statesChanged(edit: Required<BoardEdit>, written: Record<string, BoardObject | null>): Record<string, BoardObject | null> {
  const states: Record<string, BoardObject | null> = {};
  for (const [id, mine] of Object.entries(edit.objects)) {
    const now = written[id];
    if (mine?.kind !== "widget" || now?.kind !== "widget") continue;
    const base = edit.base[id];
    if (id in edit.base && sameJson(base?.kind === "widget" ? base.state : undefined, mine.state)) continue;
    const { state: _state, ...rest } = now;
    states[id] = mine.state !== undefined ? { ...rest, state: mine.state } : rest;
  }
  return states;
}
const LAYOUT = "sys:layout";
const VIEW = "sys:view";
const IMPORT = "sys:import";
const OWNER = "sys:owner";

interface Workspace {
  doc: LoroDoc;
  /** Each writer's board edits, by writer. */
  histories: Map<string, UndoManager>;
  /** For a replica, the version its host last said it has: the file keeps the history since what
   *  the two share, so what was written here since can be written again (`startOver`). */
  hostHas?: VersionVector;
  /** What is on disk of it: the next write appends what changed since. Null: written whole next. */
  stored: StoredDoc["stored"];
  /** A copy of `doc` a guest's change is tried on before it is taken (`importFrom`), brought up
   *  to date with what changed since each time; none until one is checked. */
  trial?: LoroDoc;
}

/** Updates on disk past this many bytes, and past the snapshot's own size, are folded into a new
 *  snapshot once the workspace is quiet: a load then takes about one snapshot's worth, and no
 *  change waits on a whole export. Past four times that, at once. */
const FOLD_UPDATES_AFTER = 256 * 1024;
const FOLD_WHEN_QUIET_MS = 2000;

/** The versions both `a` and `b` include: each peer's changes up to the fewer of the two. */
function shared(a: VersionVector, b: VersionVector): VersionVector {
  const both = new Map<`${number}`, number>();
  for (const [peer, counter] of a.toJSON()) {
    const theirs = b.get(peer);
    if (theirs !== undefined) both.set(peer, Math.min(counter, theirs));
  }
  return new VersionVector(both);
}

/** Whether `bytes` (as `exportSince` gives them) are a whole document, not updates. */
export function isWholeDocument(bytes: Uint8Array): boolean {
  return decodeImportBlobMeta(bytes, false).mode.includes("snapshot");
}

/** What `importFrom` throws for changes its check refused: nothing of them was taken. */
export class RefusedImport extends Error {
  constructor(why: string) {
    super(why);
    this.name = "RefusedImport";
  }
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
  /** The tiles of each open workspace, read from its document when first asked and again after a
   *  change that can open or close one: which workspace holds a tile is asked for every moment of
   *  a terminal's output, for each person watching it. */
  private readonly tiles = new Map<string, Set<string>>();
  /** Repos whose file is behind their document because a write failed. */
  private readonly unsaved = new Set<string>();
  /** Each core layout as last read, until its workspace changes: every agent event asks for all of them. */
  private readonly cores = new Map<string, KeptCore | null>();
  /** The repos stored on disk, read once: this store is the only writer of its folder. */
  private stored: Set<string> | null = null;
  /** Repos whose updates on disk are folded into a snapshot when they go quiet. */
  private readonly folds = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly opts: WorkspaceStoreOptions) {}

  /** The core layout, or null when none was ever written. The same copy until the workspace changes. */
  getCore(repo: string): KeptCore | null {
    let core = this.cores.get(repo);
    if (core === undefined) {
      core = freeze(readCore(this.workspace(repo).doc));
      this.cores.set(repo, core);
    }
    return core;
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

  /**
   * This machine holds `person` now (pairing gave it, spec/pairing.md): a workspace the person
   * held before owned is `person`'s from here on, its document naming `person` as its owner, with
   * the workspace key derived from it; and one made from here on is `person`'s. A workspace
   * someone else owns stays theirs. The folders of the workspaces that moved.
   */
  takePerson(person: Seed): string[] {
    const before = this.opts.person ? idOf(this.opts.person) : null;
    this.opts.person = person;
    if (!before || before === idOf(person)) return [];
    const moved: string[] = [];
    for (const repo of this.repos()) {
      const own = this.ownership(repo);
      if (own?.owner !== before) continue;
      this.write(repo, "core", OWNER, {}, (doc) => replaceOwnership(doc, {
        workspaceId: own.workspaceId,
        owner: idOf(person),
        workspacePublicKey: idOf(workspaceSeed(person, own.workspaceId)),
      }));
      moved.push(repo);
    }
    return moved;
  }

  /** The workspaces this store holds, open or on disk: each one's folder. */
  repos(): string[] {
    this.stored ??= new Set(storedKeys(this.opts.dir));
    return [...new Set([...this.stored, ...this.workspaces.keys()])];
  }

  /** The folder of the workspace whose id is `workspaceId`, or null when this store holds none. */
  repoOf(workspaceId: string): string | null {
    return this.repos().find((repo) => this.ownership(repo)?.workspaceId === workspaceId) ?? null;
  }

  /** The board's objects, or none. A fresh copy each call. */
  getObjects(repo: string): BoardObject[] {
    return readObjects(this.workspace(repo).doc);
  }

  /** The board's objects with these ids, by id (null: not there): what a reader reads when told
   *  which changed. A fresh copy each call. */
  getObjectsWithIds(repo: string, ids: readonly string[]): Record<string, BoardObject | null> {
    return readObjectsWithIds(this.workspace(repo).doc, ids);
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

  /**
   * Write `edit`: the objects a writer changed, each merged with what others changed in it since
   * the one the writer read, or taken away (`BoardEdit`). It costs what it changed, whatever the
   * board's size. A malformed object is dropped; what is not an edit is refused.
   */
  editObjects(repo: string, edit: unknown, from: Writer = {}): void {
    const checked = checkedEdit(edit);
    const writer = from.writer ?? "";
    this.history(repo, writer);
    // What widgets keep is committed apart, under `sys:`, so undo takes back only edits.
    this.write(repo, "board", WIDGETS, from, (doc) => {
      const held = readObjectsWithIds(doc, Object.keys(checked.objects));
      const written = editObjects(doc, { objects: statesAsHeld(checked.objects, held), base: checked.base }, held);
      doc.commit({ origin: boardOf(writer) });
      // A widget's state too is this writer's only where it changed it from the one it read.
      editObjects(doc, { objects: statesChanged(checked, written) }, written);
    });
  }

  /** The workspace this store has open that holds the tile `tileId`, or null: the control plane
   *  knows a tile by its id alone. */
  workspaceOf(tileId: string): string | null {
    for (const repo of this.workspaces.keys()) if (this.tilesOf(repo).has(tileId)) return repo;
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

  /** Add `frame` to the workspace `repo`, under its `parentFrameId`. False when it already holds a
   *  frame with its id. */
  addFrame(repo: string, frame: FrameRecord, from: Writer = {}): boolean {
    let added = false;
    this.write(repo, "core", LAYOUT, from, (doc) => { added = addFrame(doc, frame); });
    return added;
  }

  /** Take the frame `frameId` out of the workspace `repo`, with the frames nested in it; their
   *  tiles stay, in no frame. The ids taken out. */
  removeFrame(repo: string, frameId: string, from: Writer = {}): string[] {
    let gone: string[] = [];
    this.write(repo, "core", LAYOUT, from, (doc) => { gone = removeFrame(doc, frameId); });
    return gone;
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

  /**
   * Keep a workspace another of the owner's devices handed over (a move, spec/hosting.md): its
   * document, as `exportSince` gives it, under `repo` here, merged into what is kept for `repo`
   * already. It says whose it is: it is never stamped as a new workspace of this one's person,
   * which would have two workspace ids for Loro to pick one of.
   */
  adopt(repo: string, bytes: Uint8Array, from: Writer = {}): void {
    if (this.workspaces.has(repo)) return this.importFrom(repo, bytes, from);
    const { doc, stored } = readStoredDoc(this.opts.dir, repo, this.warn);
    doc.import(bytes);
    this.workspaces.set(repo, { doc, histories: new Map(), stored });
    this.persist(repo, doc);
    this.opts.onChange?.({ repo, part: "core", writer: from.writer ?? "" });
  }

  /** Take another replica's changes (updates or a whole document, as `exportSince` gives them) as
   *  `from`'s edit: written, and told like any other change. Throws for bytes that are not a
   *  document's. `check`, when given, sees the core layout as it is and as the changes would make
   *  it, first: a reason it gives refuses them (`RefusedImport`), and nothing is taken. */
  importFrom(repo: string, bytes: Uint8Array, from: Writer = {}, check?: (before: CoreLayout | null, after: CoreLayout | null) => string | null): void {
    const workspace = this.workspace(repo);
    const { doc } = workspace;
    let taken = bytes;
    if (check) {
      const trial = this.trialOf(workspace);
      const tried = trial.frontiers();
      let why: string | null = null;
      try {
        trial.import(bytes);
        // Whose the workspace is is its owner's to say; the layout's rules apply where it changed.
        if (!sameJson(readOwnership(doc), readOwnership(trial))) why = "whose the workspace is is the owner's to say";
        else if (partsChanged(trial, tried).some((p) => p.part === "core")) why = check(readCore(doc), readCore(trial));
      } catch (e) {
        this.dropTrial(workspace);
        throw e;
      }
      // What was refused is in the trial now: the next check starts from a fresh copy.
      if (why) {
        this.dropTrial(workspace);
        throw new RefusedImport(why);
      }
      // What the trial applied and checked, and nothing else: a change that waits on one not
      // sent yet waits there, and is checked when it applies.
      taken = trial.export({ mode: "update", from: doc.oplogVersion() });
    }
    const before = doc.frontiers();
    doc.import(taken);
    if (JSON.stringify(doc.frontiers()) === JSON.stringify(before)) return;
    const parts = partsChanged(doc, before);
    if (parts.some((p) => p.part === "core")) {
      this.tiles.delete(repo);
      this.cores.delete(repo);
    }
    this.persist(repo, doc);
    for (const changed of parts) this.opts.onChange?.({ repo, ...changed, writer: from.writer ?? "" });
  }

  /**
   * As a replica of `repo`, take the host's whole document (`bytes`, a snapshot) when this one
   * already holds changes: a snapshot cannot be merged into a document that lacks history it
   * starts after, and the host cannot take changes built on history it no longer keeps. So this
   * starts over from the host's document, and what was written here since the version the two
   * share (this one's ∩ `hostVersion`) is written again on top, as `from`'s edit, for the replica's
   * sync to send. Each writer's undo history starts over with it.
   */
  startOver(repo: string, bytes: Uint8Array, hostVersion: Uint8Array, from: Writer = {}): void {
    const old = this.workspace(repo);
    old.doc.commit();
    if (old.doc.oplogVersion().length() === 0) return this.importFrom(repo, bytes, from);
    const read = (d: LoroDoc) => ({ core: readCore(d), views: readViews(d), objects: readObjects(d) });
    const mine = read(old.doc);
    let base: ReturnType<typeof read> | null = null;
    try {
      old.doc.checkout(old.doc.vvToFrontiers(shared(old.doc.oplogVersion(), VersionVector.decode(hostVersion))));
      base = read(old.doc);
    } catch (e) {
      this.warn(`what was written to ${repo} while away cannot be merged with its host's (${e instanceof Error ? e.message : String(e)}); the host's is kept`);
    } finally {
      old.doc.checkoutToLatest();
    }
    const doc = new LoroDoc();
    doc.import(bytes);
    for (const history of old.histories.values()) history.free();
    this.dropTrial(old);
    this.workspaces.set(repo, { doc, histories: new Map(), hostHas: VersionVector.decode(hostVersion), stored: null });
    this.tiles.delete(repo);
    this.cores.delete(repo);
    this.persist(repo, doc);
    const writer = from.writer ?? "";
    const views = new Set([...Object.keys(readViews(doc)), ...Object.keys(mine.views)]);
    for (const part of ["core", "board", ...[...views].map((v) => `view:${v}` as const)] as const) this.opts.onChange?.({ repo, part, writer });
    if (!base) return;
    if (mine.core && !sameJson(base.core, mine.core)) this.setCore(repo, mine.core, { ...from, base: base.core });
    for (const [viewId, layout] of Object.entries(mine.views)) {
      if (!sameJson(base.views[viewId], layout)) this.setView(repo, viewId, layout, { ...from, base: base.views[viewId] ?? null });
    }
    this.editObjects(repo, boardEdit(base.objects, mine.objects), from);
  }

  /** As a replica of `repo`: its host has `hostVersion` (encoded). Its file keeps the history since
   *  what the two share. */
  hostHas(repo: string, hostVersion: Uint8Array): void {
    this.workspace(repo).hostHas = VersionVector.decode(hostVersion);
  }

  /** Forget the workspace at `repo`, here and on disk: a copy of one kept elsewhere that is not
   *  wanted any more (M3: a replica of a workspace that is hosted here again). */
  forget(repo: string): void {
    clearTimeout(this.folds.get(repo));
    this.folds.delete(repo);
    const workspace = this.workspaces.get(repo);
    if (workspace) this.dropTrial(workspace);
    this.workspaces.delete(repo);
    this.tiles.delete(repo);
    this.cores.delete(repo);
    this.unsaved.delete(repo);
    this.stored?.delete(repo);
    removeDoc(this.opts.dir, repo);
  }

  /** Write every repo whose last write failed, and fold what waits to be. The embedder calls it on quit. */
  flush(): void {
    for (const repo of [...this.folds.keys()]) this.fold(repo);
    for (const repo of [...this.unsaved]) this.persist(repo, this.workspaces.get(repo)!.doc);
  }

  private workspace(repo: string): Workspace {
    if (typeof repo !== "string" || repo.length === 0) throw new TypeError("workspace store: repo must be a non-empty string");
    let workspace = this.workspaces.get(repo);
    if (!workspace) {
      const { doc, stored } = readStoredDoc(this.opts.dir, repo, this.warn);
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
      workspace = { doc, histories: new Map(), stored };
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
    this.tiles.delete(repo);
    this.cores.delete(repo);
    this.persist(repo, doc);
  }

  private tilesOf(repo: string): Set<string> {
    let tiles = this.tiles.get(repo);
    if (!tiles) this.tiles.set(repo, (tiles = new Set(tileIds(this.workspace(repo).doc))));
    return tiles;
  }

  /**
   * Make an edit, commit it under `origin`, and if it changed anything write the file and tell who
   * listens. A write that changes nothing writes and tells nothing.
   */
  private write(repo: string, part: WorkspaceChange["part"], origin: string, from: Writer, edit: (doc: LoroDoc) => void): void {
    const { doc } = this.workspace(repo);
    const before = doc.frontiers();
    edit(doc);
    doc.commit({ origin });
    if (JSON.stringify(doc.frontiers()) === JSON.stringify(before)) return;
    if (part === "core") {
      this.tiles.delete(repo);
      this.cores.delete(repo);
    }
    this.persist(repo, doc);
    // Which objects changed, from the change itself: a reader reads only those.
    const objects = part === "board" ? partsChanged(doc, before).find((p) => p.part === "board")?.objects : undefined;
    this.opts.onChange?.({ repo, part, writer: from.writer ?? "", ...(objects ? { objects } : {}) });
  }

  private persist(repo: string, doc: LoroDoc): void {
    const workspace = this.workspaces.get(repo)!;
    const { stored } = workspace;
    try {
      const foldAt = stored && Math.max(FOLD_UPDATES_AFTER, stored.snapshotBytes);
      if (stored && stored.updatesBytes <= 4 * foldAt!) {
        stored.updatesBytes += appendUpdate(this.opts.dir, repo, doc.export({ mode: "update", from: stored.version }));
        stored.version = doc.oplogVersion();
        if (stored.updatesBytes > foldAt!) this.foldWhenQuiet(repo);
      } else {
        workspace.stored = { version: doc.oplogVersion(), snapshotBytes: writeDoc(this.opts.dir, repo, doc, this.keepSince(workspace)), updatesBytes: 0 };
      }
      this.unsaved.delete(repo);
    } catch (e) {
      // What is on disk may end in part of an update: the next write replaces it whole.
      workspace.stored = null;
      this.unsaved.add(repo);
      this.warn(`cannot write the layout for ${repo} (${e instanceof Error ? e.message : String(e)}); kept in memory until the next write`);
    }
  }

  /** `workspace`'s trial copy, up to date with it: what changed since its last use is all it takes. */
  private trialOf(workspace: Workspace): LoroDoc {
    if (!workspace.trial) return (workspace.trial = workspace.doc.fork());
    workspace.trial.import(workspace.doc.export({ mode: "update", from: workspace.trial.oplogVersion() }));
    return workspace.trial;
  }

  private dropTrial(workspace: Workspace): void {
    workspace.trial?.free();
    workspace.trial = undefined;
  }

  private foldWhenQuiet(repo: string): void {
    clearTimeout(this.folds.get(repo));
    const timer = setTimeout(() => this.fold(repo), FOLD_WHEN_QUIET_MS);
    timer.unref?.();
    this.folds.set(repo, timer);
  }

  /** Write `repo`'s document whole, its updates on disk folded in. */
  private fold(repo: string): void {
    clearTimeout(this.folds.get(repo));
    this.folds.delete(repo);
    const workspace = this.workspaces.get(repo);
    if (!workspace) return;
    workspace.stored = null;
    this.persist(repo, workspace.doc);
  }

  /** Where the file's history starts: for a replica, at what it shares with its host (or, before
   *  its host says, where its history starts now), so it can start over (`startOver`); else none. */
  private keepSince({ doc, hostHas }: Workspace): Frontiers | undefined {
    if (hostHas) return doc.vvToFrontiers(shared(doc.oplogVersion(), hostHas));
    if (this.opts.person) return undefined;
    return doc.isShallow() ? doc.shallowSinceFrontiers() : [];
  }

  private readonly warn = (message: string): void => {
    this.opts.onWarn?.(message);
  };
}
