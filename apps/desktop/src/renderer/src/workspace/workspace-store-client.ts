/**
 * Where a window's layouts live (docs/design/multiplayer-2026-09-28.md, R1, R15).
 *
 * Main's workspace store owns every workspace's layout: the core blob (canvas-persistence.ts),
 * each view's versioned layout (view-layout-store.ts) and the board's objects, which it can also
 * undo and redo. Those modules shape the data; this one only moves it. Reads and writes reach main synchronously, so a window builds its first
 * state in one pass and a save made while it unloads is kept.
 *
 * Others write too (the control plane renames a tile, another window, R5). A core layout, a view's
 * layout and the board are each written with the one this window last read or wrote, so the store
 * writes only what the window changed and never reverts theirs; `onStoreChange` says when they
 * did, for the window to read again.
 *
 * What is one person's own (where their camera is, the tab they are on, what they pinned to their
 * screen) is kept on this device, in localStorage, and never in the workspace document.
 *
 * Before the store, a window kept these in localStorage. The first read of a repo offers main
 * what is there, and main keeps only what it lacks, so an upgrade loses nothing and nothing
 * newer is overwritten. localStorage is left as it was, so an older version still finds it.
 *
 * Without the bridge (the renderer in a plain browser) localStorage is the store, under the
 * same keys, with no undo. Everything here is best-effort: a failure reads as "nothing stored".
 */
import { isViewLayout, type BoardObject, type ViewLayout } from "@hivemind/workspace-doc/shapes";
import type { LegacyLayout } from "@hivemind/workspace-host/layout";
import type { HiveIpc } from "../../../shared/ipc";

const BRIDGE = [
  "workspaceCoreSync", "workspaceViewSync", "workspaceSetCoreSync", "workspaceSetViewSync", "workspaceImportSync",
  "workspaceObjectsSync", "workspaceSetObjectsSync", "workspaceUndoSync", "workspaceRedoSync", "onWorkspaceChanged",
  "workspaceShown",
] as const;
type Bridge = Pick<HiveIpc, (typeof BRIDGE)[number]>;

// The keys earlier versions wrote, and the store without the bridge.
const coreKey = (repo: string): string => `hivemind:canvas-layout:${repo}`;
const VIEW_PREFIX = "hivemind:view-layout:";
const viewKey = (viewId: string, repo: string): string => `${VIEW_PREFIX}${viewId}:${repo}`;
const boardKey = (repo: string): string => `hivemind:board:${repo}`;
const personalKey = (viewId: string, repo: string): string => `hivemind:personal:${viewId}:${repo}`;

function bridge(): Bridge | null {
  const hive = globalThis.window?.hive as Partial<Record<(typeof BRIDGE)[number], unknown>> | undefined;
  return hive && BRIDGE.every((m) => typeof hive[m] === "function") ? (hive as Bridge) : null;
}

function storage(): Storage | null {
  try { return globalThis.window?.localStorage ?? null; } catch { return null; }
}

function readJson(key: string): unknown {
  try {
    const raw = storage()?.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try { storage()?.setItem(key, JSON.stringify(value)); } catch { /* quota, private mode */ }
}

/** What this window kept in localStorage for `repo` before the store. Main checks each entry. */
function readLegacy(repo: string): LegacyLayout {
  const legacy: LegacyLayout = {};
  const core = readJson(coreKey(repo));
  if (core !== null) legacy.core = core;
  const views: Record<string, unknown> = {};
  const suffix = `:${repo}`;
  try {
    const ls = storage();
    for (let i = 0; ls && i < ls.length; i++) {
      const key = ls.key(i);
      if (!key?.startsWith(VIEW_PREFIX) || !key.endsWith(suffix)) continue;
      // View ids have no ":", so an id with one is another repo's key that ends like this one.
      const viewId = key.slice(VIEW_PREFIX.length, -suffix.length);
      if (viewId && !viewId.includes(":")) views[viewId] = readJson(key);
    }
  } catch { /* storage went away: offer what was read */ }
  if (Object.keys(views).length > 0) legacy.views = views;
  return legacy;
}

const offered = new Set<string>();

/** Offer main this window's old layout for `repo`, once per repo per window. */
function importOnce(b: Bridge, repo: string): void {
  if (offered.has(repo)) return;
  offered.add(repo);
  const legacy = readLegacy(repo);
  if (legacy.core === undefined && legacy.views === undefined) return;
  try { b.workspaceImportSync(repo, legacy); } catch { /* the store stays as it was */ }
}

/** Per repo, the core layout this window last read or wrote: what its next write is made from. */
const coreBase = new Map<string, unknown>();
/** The same for each view's layout (per repo, then view) and for the board. */
const viewBase = new Map<string, Map<string, ViewLayout | null>>();
const boardBase = new Map<string, BoardObject[]>();
const viewBaseOf = (repo: string): Map<string, ViewLayout | null> => {
  let bases = viewBase.get(repo);
  if (!bases) viewBase.set(repo, (bases = new Map()));
  return bases;
};

/** The core blob stored for `repo`, or null. */
export function readCore(repo: string): unknown {
  const b = bridge();
  if (!b) return readJson(coreKey(repo));
  importOnce(b, repo);
  let core: unknown = null;
  try { core = b.workspaceCoreSync(repo) ?? null; } catch { /* nothing stored */ }
  coreBase.set(repo, core);
  return core;
}

/**
 * The core blob stored for `repo` again, now that another writer changed it, and the one this
 * window last read or wrote before (null: none): what the window's state was made from.
 */
export function rereadCore(repo: string): { base: unknown; core: unknown } {
  const base = coreBase.get(repo) ?? null;
  return { base, core: readCore(repo) };
}

export function writeCore(repo: string, core: unknown): void {
  const b = bridge();
  if (!b) return writeJson(coreKey(repo), core);
  try { b.workspaceSetCoreSync(repo, core, coreBase.get(repo)); } catch { /* best-effort */ }
  coreBase.set(repo, core);
}

/** Another writer changed a workspace: the control plane, another window. None without the bridge. */
export function onStoreChange(cb: (change: { repo: string; part: string }) => void): () => void {
  const b = bridge();
  return b ? b.onWorkspaceChanged(cb) : () => {};
}

/** Tell main which workspace this window shows now (null: none), and the frame the user is in. */
export function showWorkspace(repo: string | null, frame: string | null): void {
  try { bridge()?.workspaceShown(repo, frame); } catch { /* best-effort */ }
}

/** One view's layout stored for `repo`, or null. */
export function readView(repo: string, viewId: string): ViewLayout | null {
  const b = bridge();
  let stored: unknown = null;
  if (!b) stored = readJson(viewKey(viewId, repo));
  else {
    importOnce(b, repo);
    try { stored = b.workspaceViewSync(repo, viewId); } catch { /* nothing stored */ }
  }
  const layout = isViewLayout(stored) ? stored : null;
  viewBaseOf(repo).set(viewId, layout);
  return layout;
}

/**
 * One view's layout stored for `repo` again, now that another writer changed it, and the one this
 * window last read or wrote before (null: none): what the window's state was made from.
 */
export function rereadView(repo: string, viewId: string): { base: ViewLayout | null; view: ViewLayout | null } {
  const base = viewBase.get(repo)?.get(viewId) ?? null;
  return { base, view: readView(repo, viewId) };
}

export function writeView(repo: string, viewId: string, layout: ViewLayout): void {
  const b = bridge();
  if (!b) return writeJson(viewKey(viewId, repo), layout);
  const bases = viewBaseOf(repo);
  try { b.workspaceSetViewSync(repo, viewId, layout, bases.get(viewId)); } catch { /* best-effort */ }
  bases.set(viewId, layout);
}

/** One person's own state for a view in `repo` (a camera, the tab they are on), kept on this
 *  device, or null. */
export function readPersonal(repo: string, viewId: string): ViewLayout | null {
  const stored = readJson(personalKey(viewId, repo));
  return isViewLayout(stored) ? stored : null;
}

export function writePersonal(repo: string, viewId: string, layout: ViewLayout): void {
  writeJson(personalKey(viewId, repo), layout);
}

/** The board stored for `repo`: its objects, a framed one's position relative to its frame. */
export function readBoard(repo: string): BoardObject[] {
  const b = bridge();
  let stored: unknown = null;
  if (!b) stored = readJson(boardKey(repo));
  else {
    try { stored = b.workspaceObjectsSync(repo); } catch { /* nothing stored */ }
  }
  const board = Array.isArray(stored) ? (stored as BoardObject[]) : [];
  boardBase.set(repo, board);
  return board;
}

/** The board stored for `repo` again, now that another writer changed it, and the one this window
 *  last read or wrote before (none: empty): what the window's board was made from. */
export function rereadBoard(repo: string): { base: BoardObject[]; board: BoardObject[] } {
  const base = boardBase.get(repo) ?? [];
  return { base, board: readBoard(repo) };
}

export function writeBoard(repo: string, objects: BoardObject[]): void {
  const b = bridge();
  if (!b) return writeJson(boardKey(repo), objects);
  try { b.workspaceSetObjectsSync(repo, objects, boardBase.get(repo)); } catch { /* best-effort */ }
  boardBase.set(repo, objects);
}

/** Take back the last board edit. False when there is none, or no store to ask. */
export function undoBoard(repo: string): boolean {
  try { return bridge()?.workspaceUndoSync(repo) === true; } catch { return false; }
}

/** Make again the last board edit undo took back. False when there is none, or no store to ask. */
export function redoBoard(repo: string): boolean {
  try { return bridge()?.workspaceRedoSync(repo) === true; } catch { return false; }
}
