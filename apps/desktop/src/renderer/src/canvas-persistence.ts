/**
 * Workspace core persistence — the blob (per repo) holding what EVERY view
 * shares: frames (identity + bindings + their canvas rect, see FrameState),
 * open tiles, tile→frame membership, user renames, editor tabs.
 * Pure (no React): load returns a PersistedLayout, save serializes a snapshot.
 * Workspace.tsx owns the React state; this module owns the blob's shape, and
 * workspace/workspace-store-client.ts where it is kept (main's workspace store).
 * The canvas view's geometry (tile positions / sizes / viewport) is the canvas
 * view's own layout blob (workspace/views/canvas-layout.ts), like every view's.
 */
import type { TileKind } from "./tile-kinds";
import { readCore, writeCore } from "./workspace/workspace-store-client";

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

export interface TileInstance {
  id: string;
  kind: TileKind;
  label: string;
  /** claude / shell only. */
  cmd?: string;
  args?: string[];
  /** Agent only: what it was started to do, from its first prompt. Shown until the agent says. */
  task?: string;
  /** browser only — last/initial URL so the tile restores where it was. */
  url?: string;
  /** Terminal only: an existing daemon session it shows (started by `hive run` or another device); never spawns one. */
  session?: string;
  /** Pinned = the tile becomes a TRUE screen-fixed floating panel: its content is
   *  portaled out of react-flow's transformed viewport into a fixed full-window
   *  layer, so it holds a constant screen position + size, unaffected by canvas
   *  pan/zoom. `pinAnchor` is the panel's top-left in SCREEN pixels (viewport
   *  coordinates); `pinSize` is its rendered size in SCREEN pixels (captured from
   *  the tile's DOM rect at pin time). All three persist so a pinned tile comes
   *  back pinned in place at the same size. */
  pinned?: boolean;
  pinAnchor?: { sx: number; sy: number };
  pinSize?: { w: number; h: number };
  /** planReview only — the live plan handoff this tile is reviewing. Ephemeral:
   *  tied to a blocked agent hook, so planReview tiles are NEVER persisted (a
   *  reloaded requestId is dead — the hook already failed open). `requestId`
   *  routes the decision to the plan-bridge hook; `hcpCmdId` routes it to a
   *  blocked HCP `review.open` caller instead (one or the other is set). */
  review?: { requestId?: string; plan: string; cwd: string; hcpCmdId?: string; agentTileId?: string };
}

export interface FrameState {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  color: string;
  z: number;
  /** Bound git branch — tiles inside this frame run isolated on it. */
  branch?: string;
  /** Worktree dir for `branch`; tiles inside use it as their cwd. */
  worktreePath?: string;
  /** Short HEAD sha of the bound worktree — shown in the worktree pill. */
  head?: string;
  /** Workspace zone: an arbitrary repo folder. Tiles inside run in this repo
   *  (cwd/repoPath) — lets multiple projects live on one canvas. */
  workspacePath?: string;
  /** The `.hivemind` root for `workspacePath` (for Issues/diff/tree scope). */
  workspaceRoot?: string | null;
  /** When set, this is a WORKTREE sub-frame nested inside the repo frame
   *  `parentFrameId`. It carries {branch, worktreePath, head}; tiles inside
   *  scope to the worktree. The parent stays the repo (workspace/base) zone. */
  parentFrameId?: string;
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
  const p = readCore(repoPath) as Partial<PersistedLayout> | null;
  if (!p || typeof p !== "object") return { frames: [], tileNames: {} };
  return {
    frames: Array.isArray(p.frames) ? p.frames : [],
    frameOf: p.frameOf,
    tileNames: p.tileNames ?? {},
    tiles: Array.isArray(p.tiles) ? p.tiles : [],
    editorTabs: p.editorTabs && typeof p.editorTabs === "object" && !Array.isArray(p.editorTabs) ? p.editorTabs : {},
  };
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
