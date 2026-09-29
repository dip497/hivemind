/**
 * Workspace core persistence — the blob (per repo) holding what EVERY view
 * shares: frames (identity + bindings + their canvas rect, see FrameState),
 * open tiles, tile→frame membership, user renames, editor tabs.
 * Pure (no React): load returns a PersistedLayout, save serializes a snapshot,
 * and reload merges what another writer changed into the window's state.
 * Workspace.tsx owns the React state; this module owns the blob's shape, and
 * workspace/workspace-store-client.ts where it is kept (main's workspace store).
 * The canvas view's geometry (tile positions / sizes / viewport) is the canvas
 * view's own layout blob (workspace/views/canvas-layout.ts), like every view's.
 */
import { rebaseFields, rebaseRecords } from "@hivemind/workspace-doc/rebase";
import type { FrameRecord, TileRecord } from "@hivemind/workspace-doc/shapes";
import type { TileKind } from "./tile-kinds";
import { pinsOfTiles, type LegacyPin, type Pins } from "./workspace/pins";
import { readCore, rereadCore, writeCore } from "./workspace/workspace-store-client";

/** On POSIX: `-i` keeps the shell interactive so it doesn't exit, `-l` sources
 *  the login profile (PATH includes ~/.local/bin → claude resolves). Windows
 *  gets powershell.exe -NoLogo, which loads the profile by default. */
export function defaultShell(): { cmd: string; args: string[] } {
  // powershell.exe (5.1) ships with every supported Windows; pwsh may not.
  // Main repairs a spec that came from another OS (see repairShellSpec), so a
  // canvas.json carrying the wrong shell still opens — this just gets NEW tiles
  // right. The ?? keeps browser-mode renders (no bridge) on the POSIX default.
  if (globalThis.window?.hive?.platform === "win32") return { cmd: "powershell.exe", args: ["-NoLogo"] };
  return { cmd: "/bin/bash", args: ["-il"] };
}

/** Single workbench tile id — there is only ever one workbench (explorer +
 *  tabbed editor, attached) on the canvas. */
export const WORKBENCH_TILE_ID = "tile-workbench-1";

/** A tile as the window keeps it, and the layout saves it (a plan review aside): the layout's
 *  record (TileRecord: its id, kind, label, what runs in it), and the rest. */
export interface TileInstance extends TileRecord {
  kind: TileKind;
  /** Agent and shell only: the program's arguments. */
  args?: string[];
  /** browser only — last/initial URL so the tile restores where it was. */
  url?: string;
  /** planReview only — the live plan handoff this tile is reviewing. Ephemeral:
   *  tied to a blocked agent hook, so planReview tiles are NEVER persisted (a
   *  reloaded requestId is dead — the hook already failed open). `requestId`
   *  routes the decision to the plan-bridge hook; `hcpCmdId` routes it to a
   *  blocked HCP `review.open` caller instead (one or the other is set). */
  review?: { requestId?: string; plan: string; cwd: string; hcpCmdId?: string; agentTileId?: string };
}

/** A frame as the window keeps it: the layout's record (FrameRecord: its id, title and where its
 *  tiles run), and its place on the canvas and what the window shows of it. */
export interface FrameState extends FrameRecord {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  z: number;
  /** Short HEAD sha of the bound worktree — shown in the worktree pill. */
  head?: string;
  /** The `.hivemind` root for `workspacePath` (for Issues/diff/tree scope). */
  workspaceRoot?: string | null;
}

// Persisted layout — survives app restarts. Keyed by repoPath so each
// project's canvas comes back the way the user left it.
export interface PersistedLayout {
  frames: FrameState[];
  /** User-renamed tile labels (per tile id). */
  tileNames?: Record<string, string>;
  // Open tiles — so a restart resumes exactly where you left off (the PTY is
  // gone, but the tile + a fresh shell/claude respawn in place).
  tiles?: TileInstance[];
  /** Repo-relative paths open as tabs, keyed by editor tile id. */
  editorTabs?: Record<string, string[]>;
  /** EXPLICIT tile→frame membership. Authoritative — frame geometry is derived
   *  from this, NOT the reverse. Set when a tile is spawned into or dropped
   *  inside a frame; cleared when dropped outside all frames. Decoupling
   *  membership from geometry avoids the bootstrap deadlock where a big tile
   *  whose center sits outside a collapsed frame never gets claimed. */
  frameOf?: Record<string, string>;
  /** Pins the tiles carried while a pin was the workspace's (before R5): where this device's pins
   *  start when it has none. Not saved: a pin is one person's now (workspace/pins.ts). */
  pins?: Pins;
}

/** The fields a save snapshot must supply (everything the core round-trips). */
export type LayoutSnapshot = Required<
  Pick<PersistedLayout, "frames" | "tileNames" | "tiles" | "editorTabs" | "frameOf">
>;

export function loadLayout(repoPath: string | null): PersistedLayout {
  // Only persist when we have a real repo — the no-repo case is transient
  // (welcome screen / e2e bootstrap) and persisting it leaks layouts across
  // unrelated sessions.
  if (!repoPath) return { frames: [], tileNames: {} };
  const stored = readCore(repoPath);
  const tiles = (stored as { tiles?: unknown } | null)?.tiles;
  return { ...layoutOf(stored), pins: pinsOfTiles(Array.isArray(tiles) ? tiles : []) };
}

/** What another writer changed, as the window takes it: each part of the layout as an update of
 *  the window's own, and the tiles that writer closed. */
export interface LayoutReload {
  frames: (mine: FrameState[]) => FrameState[];
  tileNames: (mine: Record<string, string>) => Record<string, string>;
  tiles: (mine: TileInstance[]) => TileInstance[];
  editorTabs: (mine: Record<string, string[]>) => Record<string, string[]>;
  frameOf: (mine: Record<string, string>) => Record<string, string>;
  /** The window closes these as its own × does. */
  closed: string[];
}

/**
 * Another writer changed `repoPath`'s core layout: read it again. Each part comes as an update of
 * the window's own, which takes the layout as stored and keeps what the window changed since it
 * last read or wrote, so an edit it has not saved, or not yet rendered, is not lost (a plan
 * review, never saved, is one). Write what is pending first: what the window last wrote is then
 * what its state was made from.
 */
export function reloadLayout(repoPath: string): LayoutReload {
  const { base, core } = rereadCore(repoPath);
  const was = layoutOf(base);
  const now = layoutOf(core);
  const open = new Set(now.tiles.map((t) => t.id));
  return {
    frames: (mine) => rebaseRecords(was.frames, mine, now.frames),
    tileNames: (mine) => rebaseFields(was.tileNames, mine, now.tileNames),
    tiles: (mine) => rebaseRecords(was.tiles, mine, now.tiles),
    editorTabs: (mine) => rebaseFields(was.editorTabs, mine, now.editorTabs),
    frameOf: (mine) => rebaseFields(was.frameOf, mine, now.frameOf),
    closed: was.tiles.filter((t) => !open.has(t.id)).map((t) => t.id),
  };
}

/** A stored core blob as the window reads it: a part missing or malformed is empty. */
function layoutOf(stored: unknown): LayoutSnapshot {
  const p = (typeof stored === "object" && stored !== null ? stored : {}) as Partial<PersistedLayout>;
  return {
    frames: Array.isArray(p.frames) ? p.frames : [],
    frameOf: p.frameOf ?? {},
    tileNames: p.tileNames ?? {},
    tiles: Array.isArray(p.tiles) ? p.tiles.map(withoutPin) : [],
    editorTabs: p.editorTabs && typeof p.editorTabs === "object" && !Array.isArray(p.editorTabs) ? p.editorTabs : {},
  };
}

/** A tile without the pin it carried while a pin was the workspace's: the window's next save
 *  takes it out of the document. */
function withoutPin(tile: TileInstance & LegacyPin): TileInstance {
  if (!("pinned" in tile || "pinAnchor" in tile || "pinSize" in tile)) return tile;
  const { pinned: _pinned, pinAnchor: _anchor, pinSize: _size, ...rest } = tile;
  return rest;
}

/** Write a layout snapshot for a repo (best-effort). The single writer — Canvas's
 *  debounced effect AND the beforeunload flush both call this, so the blob shape
 *  lives in one place. */
export function saveLayout(repoPath: string | null, snap: LayoutSnapshot): void {
  if (!repoPath) return;
  // planReview tiles are ephemeral (tied to a live, blocked agent hook) — drop
  // them so a reload doesn't resurrect a dead review with a stale requestId.
  writeCore(repoPath, { ...snap, tiles: snap.tiles.filter((t) => t.kind !== "planReview") });
}
