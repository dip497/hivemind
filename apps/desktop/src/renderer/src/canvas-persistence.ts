/**
 * Canvas persistence — the localStorage layout blob (per repo) plus the canvas
 * data types it round-trips. Pure (no React): load returns a PersistedLayout,
 * save serializes a snapshot. Migrations from the pre-unification shapes live
 * here too, isolated so they're unit-testable. Canvas.tsx owns the React state;
 * this module owns how it sleeps + wakes.
 */
import type { TileKind } from "./tile-kinds";
import { frameColorFor, LEGACY_FRAME_COLOR } from "./frame-color";
import { identifyAgent } from "./agent-state";

/** Linux only. `-i` keeps the shell interactive so it doesn't exit, `-l`
 *  sources the login profile (PATH includes ~/.local/bin → claude resolves). */
export function defaultShell(): { cmd: string; args: string[] } {
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
  /** browser only — last/initial URL so the tile restores where it was. */
  url?: string;
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

// Legacy persisted shapes (pre-unification) — migrated to TileInstance[] on load.
type LegacyVisibility = { tree: boolean; shell: boolean; diff: boolean; issues: boolean };
interface LegacyExtraTerm { id: string; label: string; cmd: string; args: string[]; }

// Persisted layout — survives app restarts. Keyed by repoPath (or a sentinel
// for the no-repo case) so each project's canvas comes back the way the user
// left it. Stored as a single JSON blob per repo to avoid N localStorage keys.
export interface PersistedLayout {
  sizes: Record<string, { width: number; height: number }>;
  positions: Record<string, { x: number; y: number }>;
  frames: FrameState[];
  /** User-renamed tile labels (per tile id). */
  tileNames?: Record<string, string>;
  /** Last-known agent session titles (claude's OSC window-title task summary),
   *  per tile id. Persisted so REATTACHING to a live daemon session (which
   *  replays a serialized screen WITHOUT re-emitting the title OSC) still shows
   *  the resolved name instead of falling back to "claude #N". A live OSC update
   *  overwrites it; a user rename (tileNames) still takes precedence. */
  agentTitles?: Record<string, string>;
  // Open tiles — so a restart resumes exactly where you left off (the PTY is
  // gone, but the tile + a fresh shell/claude respawn in place).
  tiles?: TileInstance[];
  /** Repo-relative paths open as tabs, keyed by editor tile id. */
  editorTabs?: Record<string, string[]>;
  // ── legacy (pre tile-unification) — read for migration, never written. ──
  vis?: LegacyVisibility;
  extras?: LegacyExtraTerm[];
  legacyEditorTabs?: string[];
  /** EXPLICIT tile→frame membership. Authoritative — frame geometry is derived
   *  from this, NOT the reverse. Set when a tile is spawned into or dropped
   *  inside a frame; cleared when dropped outside all frames. Decoupling
   *  membership from geometry avoids the bootstrap deadlock where a big tile
   *  whose center sits outside a collapsed frame never gets claimed. */
  frameOf?: Record<string, string>;
  /** Last viewport position so reopen drops user back where they were instead
   *  of resetting to (16, 24, zoom=1). */
  viewport?: { x: number; y: number; zoom: number };
}

/** The fields a save snapshot must supply (everything round-tripped). */
export type LayoutSnapshot = Required<
  Pick<PersistedLayout, "sizes" | "positions" | "frames" | "tileNames" | "agentTitles" | "tiles" | "editorTabs" | "frameOf">
> & { viewport: PersistedLayout["viewport"] };

export const LAYOUT_KEY = (repoPath: string | null) =>
  `hivemind:canvas-layout:${repoPath ?? "__global__"}`;

// One-time cleanup: an earlier version persisted the no-repo case under
// `__global__`, which leaked test/welcome layouts across unrelated sessions.
// We never persist there anymore — wipe any stale value on startup so old
// installs don't carry forward phantom frames.
if (typeof window !== "undefined") {
  try {
    window.localStorage.removeItem("hivemind:canvas-layout:__global__");
  } catch { /* private mode etc — ignore */ }
}

export function loadLayout(repoPath: string | null): PersistedLayout {
  if (typeof window === "undefined") return { sizes: {}, positions: {}, frames: [] };
  // Only persist when we have a real repo — the no-repo case is transient
  // (welcome screen / e2e bootstrap) and persisting it leaks layouts across
  // unrelated sessions.
  if (!repoPath) return { sizes: {}, positions: {}, frames: [], tileNames: {} };
  try {
    const raw = window.localStorage.getItem(LAYOUT_KEY(repoPath));
    if (!raw) return { sizes: {}, positions: {}, frames: [], tileNames: {} };
    const p = JSON.parse(raw) as Partial<PersistedLayout>;
    // Backfill `z` for frames persisted before z existed, and migrate frames
    // still on the pre-randomization default accent to a distinct hashed color
    // (a user's explicit pick via the header swatch is anything else, so it's
    // preserved).
    const frames = Array.isArray(p.frames)
      ? p.frames.map((f, i) => ({
          ...f,
          z: typeof f.z === "number" ? f.z : i,
          color: f.color === LEGACY_FRAME_COLOR ? frameColorFor(f.id) : f.color,
        })) as FrameState[]
      : [];
    const positions = p.positions ?? {};
    const sizes = p.sizes ?? {};
    // Migration: layouts saved before explicit `frameOf` existed have no
    // membership map. Seed it ONCE from geometry (tile center inside the
    // topmost frame) — a one-time snapshot, not a runtime feedback loop. After
    // this, membership is tracked explicitly on drop/spawn.
    let frameOf = p.frameOf;
    if (!frameOf && frames.length > 0) {
      frameOf = {};
      const sorted = [...frames].sort((a, b) => b.z - a.z);
      for (const [tid, pos] of Object.entries(positions)) {
        const s = sizes[tid] ?? { width: 700, height: 480 };
        const cx = pos.x + s.width / 2;
        const cy = pos.y + s.height / 2;
        const owner = sorted.find((f) => cx >= f.x && cx <= f.x + f.w && cy >= f.y && cy <= f.y + f.h);
        if (owner) frameOf[tid] = owner.id;
      }
    }
    // Tiles: new format persists a `tiles` array. Old layouts persisted
    // `vis` (singleton editor/diff/issues) + `extras` (instanced claude/shell)
    // + a single `editorTabs` array — migrate them to instances, REUSING the
    // canonical fixed ids so the saved sizes/positions/frameOf keep resolving.
    let tiles: TileInstance[];
    let editorTabs: Record<string, string[]>;
    if (Array.isArray(p.tiles)) {
      tiles = p.tiles;
      editorTabs = (p.editorTabs && typeof p.editorTabs === "object" && !Array.isArray(p.editorTabs))
        ? (p.editorTabs as Record<string, string[]>)
        : {};
    } else {
      tiles = [];
      editorTabs = {};
      for (const e of Array.isArray(p.extras) ? p.extras : []) {
        const kind: TileKind = identifyAgent(e.cmd) === "claude" ? "claude" : "shell";
        tiles.push({ id: e.id, kind, label: e.label, cmd: e.cmd, args: e.args });
      }
      const v = p.vis;
      if (v?.tree) {
        tiles.push({ id: WORKBENCH_TILE_ID, kind: "editor", label: "Editor" });
        const legacyTabs = Array.isArray(p.editorTabs)
          ? (p.editorTabs as unknown as string[])
          : Array.isArray((p as { fileTiles?: { file: string }[] }).fileTiles)
            ? (p as { fileTiles: { file: string }[] }).fileTiles.map((f) => f.file)
            : [];
        if (legacyTabs.length) editorTabs[WORKBENCH_TILE_ID] = legacyTabs;
      }
      if (v?.shell) {
        const sh = defaultShell();
        tiles.push({ id: "tile-terminal-1", kind: "shell", label: "shell", cmd: sh.cmd, args: sh.args });
      }
      if (v?.diff) tiles.push({ id: "tile-diff-1", kind: "diff", label: "Diff" });
      if (v?.issues) tiles.push({ id: "tile-issues-1", kind: "issues", label: "Issues" });
    }
    return {
      sizes,
      positions,
      frames,
      frameOf,
      tileNames: p.tileNames ?? {},
      agentTitles: p.agentTitles ?? {},
      tiles,
      editorTabs,
      viewport: p.viewport && typeof p.viewport.x === "number" && typeof p.viewport.y === "number"
        ? { x: p.viewport.x, y: p.viewport.y, zoom: Number(p.viewport.zoom) || 1 }
        : undefined,
    };
  } catch {
    return { sizes: {}, positions: {}, frames: [], tileNames: {} };
  }
}

/** Serialize + write a layout snapshot for a repo (best-effort; swallows
 *  Quota/private-mode errors). The single writer — Canvas's debounced effect AND
 *  the beforeunload flush both call this, so the blob shape lives in one place. */
export function saveLayout(repoPath: string | null, snap: LayoutSnapshot): void {
  if (typeof window === "undefined" || !repoPath) return;
  // planReview tiles are ephemeral (tied to a live, blocked agent hook) — drop
  // them so a reload doesn't resurrect a dead review with a stale requestId.
  const persisted: LayoutSnapshot = snap.tiles
    ? { ...snap, tiles: snap.tiles.filter((t) => t.kind !== "planReview") }
    : snap;
  try {
    window.localStorage.setItem(LAYOUT_KEY(repoPath), JSON.stringify(persisted));
  } catch {
    // QuotaExceeded / private-mode etc — swallow; layout is best-effort.
  }
}
