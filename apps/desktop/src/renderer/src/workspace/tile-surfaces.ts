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
import { defaultShell } from "../canvas-persistence";
import { identifyAgent } from "../agent-state";
import type { TileKind } from "../tile-kinds";

/** Screen-space rect captured from a tile's DOM at pin time (SCREEN pixels). */
export type PinRect = { sx: number; sy: number; w: number; h: number };

export type TerminalTileData = {
  tileId: string;
  cwd: string;
  cmd: string;
  args?: string[];
  label?: string;
  name?: string;
  onRename?: (id: string, name: string) => void;
  onAgentTitle?: (id: string, title: string) => void;
  onOpenInBrowser?: (url: string) => void;
  onOpenInEditor?: (path: string) => void;
  onClose?: () => void;
  pinned?: boolean;
  onTogglePin?: (id: string, rect: PinRect) => void;
};

export type DiffTileData = {
  repoPath: string;
  initialMode?: "working" | "branch";
  initialBase?: string;
  onClose?: () => void;
  pinned?: boolean;
  onTogglePin?: (id: string, rect: PinRect) => void;
};

export type WorkbenchTileData = {
  repoPath: string;
  tabs: string[];
  onOpenFile: (path: string) => void;
  onOpenInBrowser?: (url: string) => void;
  onCloseTab: (path: string) => void;
  onClose: () => void;
  pinned?: boolean;
  onTogglePin?: (id: string, rect: PinRect) => void;
};

export type BrowserTileData = {
  tileId: string;
  frameId?: string | null;
  url?: string;
  openReq?: { url: string; seq: number } | null;
  onClose?: () => void;
  pinned?: boolean;
  onTogglePin?: (id: string, rect: PinRect) => void;
};

export type IssuesTileData = {
  root: string | null;
  onClose: () => void;
  pinned?: boolean;
  onTogglePin?: (id: string, rect: PinRect) => void;
};

export type PlanReviewTileData = {
  requestId?: string;
  hcpCmdId?: string;
  plan: string;
  cwd: string;
  agentTileId?: string;
  onClose?: () => void;
};

/** Discriminated union of every tile kind's body. The `type` tag doubles as the
 *  canvas node type (`.react-flow__node-<type>` — CSS + e2e depend on it). */
export type TileSurfaceSpec =
  | { type: "terminal"; data: TerminalTileData }
  | { type: "diff"; data: DiffTileData }
  | { type: "workbench"; data: WorkbenchTileData }
  | { type: "browser"; data: BrowserTileData }
  | { type: "issues"; data: IssuesTileData }
  | { type: "planReview"; data: PlanReviewTileData };

export type TileSurfaceType = TileSurfaceSpec["type"];

/** One open tile's body, keyed by the tile id that stays stable across views. */
export type TileSurface = TileSurfaceSpec & { id: string; kind: TileKind };

/** Auto-derive a short tile name from the command. Uses identifyAgent for known
 *  agents (claude, codex, gemini, …), falls back to the cmd basename. */
export function autoNameFromCmd(cmd: string): string {
  const agent = identifyAgent(cmd);
  if (agent) return agent;
  return cmd.split("/").pop()?.split(/\s+/)[0] ?? "terminal";
}

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

export interface TileSurfaceCtx {
  repoPath: string | null;
  root: string | null;
  cwd: string;
  tiles: TileInstance[];
  frames: FrameState[];
  frameOf: Record<string, string>;
  /** Tile ids currently pinned (the tile shows its header pin as active). */
  pinnedIds: Set<string>;
  editorTabs: Record<string, string[]>;
  browserOpenReqs: Record<string, { url: string; seq: number }>;
  tileNames: Record<string, string>;
  openFileInTile: (tileId: string, file: string) => void;
  openUrlInBrowser: (sourceTileId: string, url: string) => void;
  openFileFromTerminal: (sourceTileId: string, path: string) => void;
  closeTabInTile: (tileId: string, file: string) => void;
  closeTile: (id: string) => void;
  renameTile: (id: string, name: string) => void;
  setAgentTitle: (id: string, title: string) => void;
  /** Toggle a tile's pinned state. `rect` is the tile's SCREEN rect (top-left +
   *  size) captured from its DOM at click time (ignored when unpinning). */
  onTogglePin: (id: string, rect: PinRect) => void;
}

/**
 * Build the surface list for every open tile. editor/diff need a repo — they're
 * skipped only if NO repo is available (global or zone). Order follows `tiles`
 * (open order), which is also the order views like the tab strip show them in.
 */
export function buildTileSurfaces(ctx: TileSurfaceCtx): TileSurface[] {
  const {
    repoPath, root, cwd, tiles, frames, frameOf, pinnedIds, editorTabs, browserOpenReqs, tileNames,
    openFileInTile, openUrlInBrowser, openFileFromTerminal, closeTabInTile, closeTile, renameTile, setAgentTitle,
    onTogglePin,
  } = ctx;
  const out: TileSurface[] = [];
  for (const t of tiles) {
    const owner = frameOf[t.id] ? frames.find((f) => f.id === frameOf[t.id]) : undefined;
    // Zone repo for tiles inside a frame: a worktree (branch zone) wins, else a
    // bound workspace folder, else nothing (keep base repoPath/cwd/root).
    const zoneRepo = owner?.worktreePath ?? owner?.workspacePath;
    // A workspace zone is a DIFFERENT repo bound to the frame. A worktree zone
    // is the SAME repo on another branch (no .hivemind of its own — issues stay
    // the project's, so it keeps the base root).
    const isWorkspaceZone = !owner?.worktreePath && owner?.workspacePath != null;
    const effRepo = zoneRepo ?? repoPath ?? null;
    const effCwd = zoneRepo ?? cwd;
    // Issues/diff/tree scope by `root` (.hivemind). For a workspace zone, point
    // them at THAT repo's root. CRITICAL: never fall through to the base root
    // here (that leaked the launch repo's issues board into an unrelated frame —
    // the cross-repo leak bug).
    const effRoot = isWorkspaceZone ? (owner?.workspaceRoot ?? null) : root;
    const pin = { pinned: pinnedIds.has(t.id), onTogglePin };
    if ((t.kind === "editor" || t.kind === "diff") && !effRepo) continue;
    switch (t.kind) {
      case "editor":
      case "workbench":
        out.push({
          id: t.id, kind: t.kind, type: "workbench",
          data: {
            repoPath: effRepo!,
            tabs: editorTabs[t.id] ?? [],
            onOpenFile: (file: string) => openFileInTile(t.id, file),
            onOpenInBrowser: (url: string) => openUrlInBrowser(t.id, url),
            onCloseTab: (file: string) => closeTabInTile(t.id, file),
            onClose: () => closeTile(t.id),
            ...pin,
          },
        });
        break;
      case "diff":
        out.push({
          id: t.id, kind: t.kind, type: "diff",
          data: { repoPath: effRepo!, initialMode: "working", initialBase: "origin/main", onClose: () => closeTile(t.id), ...pin },
        });
        break;
      case "issues":
        out.push({ id: t.id, kind: t.kind, type: "issues", data: { root: effRoot, onClose: () => closeTile(t.id), ...pin } });
        break;
      case "browser":
        // No repo needed — a browser tile is repo-agnostic.
        out.push({
          id: t.id, kind: t.kind, type: "browser",
          data: {
            tileId: t.id, frameId: frameOf[t.id] ?? null, url: t.url,
            openReq: browserOpenReqs[t.id] ?? null, onClose: () => closeTile(t.id), ...pin,
          },
        });
        break;
      case "planReview": {
        // Ephemeral plan-handoff review (data carried on the tile's `review`).
        // Guard a stale/malformed persisted tile so it never crashes the build.
        const r = t.review ?? { plan: "", cwd: "" };
        out.push({
          id: t.id, kind: t.kind, type: "planReview",
          data: {
            requestId: r.requestId, hcpCmdId: r.hcpCmdId, plan: r.plan,
            // planReview carries the agent's cwd; a zone rebinds it like any tile.
            cwd: zoneRepo ?? r.cwd, agentTileId: r.agentTileId,
            onClose: () => closeTile(t.id),
          },
        });
        break;
      }
      default: {
        // claude / shell — both render as a TerminalTile.
        const cmd = t.cmd ?? defaultShell().cmd;
        const args = t.args ?? defaultShell().args;
        out.push({
          id: t.id, kind: t.kind, type: "terminal",
          data: {
            tileId: t.id, cwd: effCwd, cmd, args, label: t.label,
            // NOTE: the live agent OSC title is deliberately NOT used here. It
            // updates ~every 600ms while an agent streams; feeding it into tile
            // data re-rendered every host — cursor-flicker + focus loss. Live
            // titles show in the Layers panel (its own memo) and the status line.
            name: tileNames[t.id] ?? autoNameFromCmd(cmd),
            onRename: renameTile,
            onAgentTitle: setAgentTitle,
            onOpenInBrowser: (url: string) => openUrlInBrowser(t.id, url),
            onOpenInEditor: (path: string) => openFileFromTerminal(t.id, path),
            onClose: () => closeTile(t.id),
            ...pin,
          },
        });
      }
    }
  }
  return out;
}
