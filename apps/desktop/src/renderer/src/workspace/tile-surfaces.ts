/**
 * tile-surfaces — the pure, VIEW-INDEPENDENT description of every open tile's
 * body. A "surface" is what a tile renders (terminal / editor / diff / browser /
 * issues / plan review) plus the repo scope it runs in; it deliberately knows
 * nothing about WHERE the tile is drawn (canvas position, tab order, 3D
 * coordinates — that is a view's business).
 *
 * This module is where the "effective repo" invariant lives (formerly baked
 * into canvas-node-build's `mkTile`): a tile's cwd / repoPath / root come from
 * its owner frame's zone (`worktreePath ?? workspacePath`) else the workspace's
 * global repo. It is how a tile "becomes" local / worktree / remote without the
 * tile component knowing the difference. Gate editor/diff on THIS repo, never
 * on the global one.
 *
 * Consumed by the TileHost (renders each surface exactly once for the life of
 * the tile — see tile-host.tsx) and by every view via `TileSlot`.
 */
import type { FrameState, TileInstance } from "../canvas-persistence";
import { pluginOfKind, tileKind, type PinRect, type TileHostState } from "../tiles";

export type { PinRect } from "../tiles";
export type { TerminalTileData } from "../tiles/terminal";
export { autoNameFromCmd } from "../tiles/terminal";

/** One open tile's body, keyed by the tile id that stays stable across views. `type` is the
 *  drawing plugin's surface, which doubles as the canvas node type (CSS + e2e depend on it). */
export type TileSurface = { id: string; kind: string; type: string; data: unknown };
export type TileSurfaceType = string;

/** The repo a tile effectively runs in: owner frame's zone repo (worktree wins
 *  over a bound workspace folder) else the global repo. One helper so the
 *  surface builder, the canvas node builder and the Layers panel can't drift. */
export function effectiveRepoOf(
  tileId: string,
  frameOf: Record<string, string>,
  frames: readonly FrameState[],
  repoPath: string | null,
): string | null {
  const owner = frameOf[tileId] ? frames.find((f) => f.id === frameOf[tileId]) : undefined;
  return owner?.worktreePath ?? owner?.workspacePath ?? repoPath ?? null;
}

export interface TileSurfaceCtx extends TileHostState {
  repoPath: string | null;
  root: string | null;
  cwd: string;
  tiles: TileInstance[];
  frames: FrameState[];
  frameOf: Record<string, string>;
  /** Tile ids currently pinned (the tile shows its header pin as active). */
  pinnedIds: Set<string>;
  closeTile: (id: string) => void;
  /** Toggle a tile's pinned state. `rect` is the tile's SCREEN rect (top-left +
   *  size) captured from its DOM at click time (ignored when unpinning). */
  onTogglePin: (id: string, rect: PinRect) => void;
}

/** One cache per workspace. Reusing a surface also preserves its bound handlers,
 * allowing TileHost's memo to skip untouched bodies. Inputs follow the immutable
 * workspace state contract; callback changes must invalidate too. Frame geometry
 * is deliberately absent: moving a frame does not change its tiles' contents. */
export function createTileSurfaceBuilder(): (ctx: TileSurfaceCtx) => TileSurface[] {
  type Entry = { inputs: readonly unknown[]; surface: TileSurface | undefined };
  let previous = new Map<string, Entry>();
  return (ctx) => {
    // First frame wins per id — must match the pure builder's `frames.find`.
    const owners = new Map<string, FrameState>();
    for (const frame of ctx.frames) if (!owners.has(frame.id)) owners.set(frame.id, frame);
    const next = new Map<string, Entry>();
    const surfaces: TileSurface[] = [];
    for (const tile of ctx.tiles) {
      const frameId = ctx.frameOf[tile.id];
      const owner = frameId ? owners.get(frameId) : undefined;
      const inputs: readonly unknown[] = [
        tile, ctx.repoPath, ctx.root, ctx.cwd, ctx.frameOf[tile.id],
        owner?.worktreePath, owner?.workspacePath, owner?.workspaceRoot,
        ctx.pinnedIds.has(tile.id), ctx.editorTabs[tile.id],
        ctx.browserOpenReqs[tile.id], ctx.tileNames[tile.id], ctx.agentTitles[tile.id],
        ctx.openFileInTile, ctx.openUrlInBrowser, ctx.openFileFromTerminal,
        ctx.closeTabInTile, ctx.closeTile, ctx.renameTile, ctx.onTogglePin,
      ];
      const cached = previous.get(tile.id);
      const entry = cached && inputs.every((value, i) => Object.is(value, cached.inputs[i]))
        ? cached
        : { inputs, surface: buildTileSurfaces({ ...ctx, tiles: [tile], frames: owner ? [owner] : [] })[0] };
      next.set(tile.id, entry);
      if (entry.surface) surfaces.push(entry.surface);
    }
    // Closed tiles and their callbacks must not accumulate across a long session.
    previous = next;
    return surfaces;
  };
}

/**
 * Build the surface list for every open tile: each from the plugin that draws its kind. A tile
 * whose plugin has nothing to show (one that needs a repo where there is none), or that no
 * installed plugin draws, has no body. Order follows `tiles` (open order), which is also the
 * order views like the tab strip show them in.
 */
export function buildTileSurfaces(ctx: TileSurfaceCtx): TileSurface[] {
  const { repoPath, root, cwd, tiles, frames, frameOf, pinnedIds, closeTile, onTogglePin } = ctx;
  const out: TileSurface[] = [];
  for (const t of tiles) {
    const plugin = pluginOfKind(t.kind);
    if (!plugin) continue;
    const owner = frameOf[t.id] ? frames.find((f) => f.id === frameOf[t.id]) : undefined;
    // Zone repo for tiles inside a frame: a worktree (branch zone) wins, else a
    // bound workspace folder, else nothing (keep base repoPath/cwd/root).
    const zoneRepo = owner?.worktreePath ?? owner?.workspacePath ?? null;
    // A workspace zone is a DIFFERENT repo bound to the frame. A worktree zone
    // is the SAME repo on another branch (no .hivemind of its own — issues stay
    // the project's, so it keeps the base root).
    const isWorkspaceZone = !owner?.worktreePath && owner?.workspacePath != null;
    const effRepo = zoneRepo ?? repoPath ?? null;
    if (tileKind(t.kind).needsRepo && !effRepo) continue;
    const data = plugin.data(t, {
      repoPath: effRepo,
      cwd: zoneRepo ?? cwd,
      // Never fall through to the base root for a workspace zone: that leaked the
      // launch repo's issues board into an unrelated frame.
      root: isWorkspaceZone ? (owner?.workspaceRoot ?? null) : root,
      zoneRepo,
      frameId: frameOf[t.id] ?? null,
      pin: { pinned: pinnedIds.has(t.id), onTogglePin },
      onClose: () => closeTile(t.id),
    }, ctx);
    if (data !== null) out.push({ id: t.id, kind: t.kind, type: plugin.surface, data });
  }
  return out;
}
