/**
 * WindowsView — the "editor-like" alternative to the infinite canvas. Same
 * session, different lens: the graph rail on the LEFT (the existing LayersPanel,
 * frames → worktrees → tiles), a SINGLE tab strip across the top (one tab per
 * open tile, tinted by its frame's color), and the active tile's body filling
 * the rest. VS Code / editor muscle memory.
 *
 * EVERY open tab's body renders from the SAME `nodes` array the canvas builds
 * (`buildBaseNodes`), via the shared `TileBody`, keyed by tile id — ALL of
 * them stay mounted for as long as the tile is open (not just the active
 * one), and only the active tab is shown; the rest are hidden with
 * `visibility:hidden` + `pointer-events:none` at full size (never `display:
 * none` — a 0×0 box makes xterm's fit addon compute garbage — and never
 * unmounted). This mirrors the invariant Canvas.tsx keeps for react-flow
 * (`onlyRenderVisibleElements={false}`): our tiles wrap LIVE PTY sessions, and
 * remounting one is only harmless for a LOCAL tile (it reattaches to its
 * persistent daemon by id, scrollback replayed). A REMOTE (`ssh://`) tile has
 * no daemon to reattach to — unmount sends `ptyDetach`, which main routes to
 * `killRemotePty` for a remote tile, so a tab switch would silently kill the
 * agent session. Keeping every tab's body mounted is what makes that safe.
 *
 * Minimizing a tab hides it from the strip but NOT from the graph rail — the
 * tile stays in LayersPanel, and clicking it there restores + activates it
 * (and remounts its body, same as opening any other closed tile).
 */
import { useMemo, type CSSProperties, type ReactNode } from "react";
import { X, Minus, Globe } from "lucide-react";
import type { Node } from "@xyflow/react";
import { LayersPanel, type LayerTile, type LayerFrame } from "./LayersPanel";
import {
  TileBody,
  type TileBodyProps,
  type TerminalNodeData,
  type DiffNodeData,
  type WorkbenchNodeData,
  type BrowserNodeData,
  type IssuesNodeData,
  type PlanReviewNodeData,
} from "./canvas-nodes";
import { AgentIcon } from "./agents";
import type { FrameActions } from "./FrameRailMenu";

// react-flow types a node's `data` loosely (effectively `Record<string,
// unknown>`); this is the ONE place in windowed mode we narrow it back to
// `TileBody`'s discriminated union — every node wrapper in canvas-nodes.tsx
// already has statically-typed data and never needs this. Returns null for a
// node type TileBody doesn't render a body for (e.g. "frame" — frames never
// appear in `tabTiles` anyway).
function toTileBodyProps(node: Node, selected: boolean): TileBodyProps | null {
  switch (node.type) {
    case "terminal": return { type: "terminal", data: node.data as TerminalNodeData, selected };
    case "diff": return { type: "diff", data: node.data as DiffNodeData, selected };
    case "workbench": return { type: "workbench", data: node.data as WorkbenchNodeData, selected };
    case "browser": return { type: "browser", data: node.data as BrowserNodeData, selected };
    case "issues": return { type: "issues", data: node.data as IssuesNodeData, selected };
    case "planReview": return { type: "planReview", data: node.data as PlanReviewNodeData, selected };
    default: return null;
  }
}

// Inactive tab bodies stay mounted at FULL SIZE — visibility:hidden (not
// display:none, which would collapse the box to 0×0 and make xterm's fit
// addon compute garbage) + pointer-events:none so a hidden tile can't eat
// clicks/keys meant for the active one.
const HIDDEN_TAB_STYLE: CSSProperties = { visibility: "hidden", pointerEvents: "none" };

/** Same monochrome kind glyphs the Layers panel uses, so a tab and its rail row
 *  read as the same object. Agent + browser get real icons (see below). */
const KIND_GLYPH: Record<LayerTile["kind"], string> = {
  claude: "✦",
  terminal: "›_",
  editor: "{}",
  diff: "±",
  issues: "◔",
  browser: "",
  planReview: "▤",
  workbench: "▥",
};

function TabGlyph({ tile }: { tile: LayerTile }): ReactNode {
  if (tile.kind === "claude") return <AgentIcon id={tile.agent ?? "claude"} size={13} />;
  if (tile.kind === "browser") return <Globe size={12} aria-hidden />;
  return (
    <span aria-hidden className="font-mono text-[11px] text-[var(--color-fg3)]">
      {KIND_GLYPH[tile.kind]}
    </span>
  );
}

interface Props {
  /** react-flow nodes (from buildBaseNodes) — the source of each tile's body
   *  `data`. We look up by id and render `TileBody` with the node's type+data. */
  nodes: Node[];
  /** Frame forest for the graph rail (also the source of per-tab tint color). */
  frames: LayerFrame[];
  /** Every open tile — the full list the graph rail shows. */
  tiles: LayerTile[];
  /** Tiles shown as tabs (open minus minimized), in strip order. */
  tabTiles: LayerTile[];
  activeTabId: string | null;
  selectedTileId: string | null;
  onSelectTab: (id: string) => void;
  onMinimizeTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  /** Rail click: a minimized tile restores + activates; a visible one activates. */
  onFocusTile: (id: string) => void;
  onFocusFrame: (id: string) => void;
  /** Right-click-a-frame rail actions (spawn/worktree/workspace/remote/…). */
  frameActions?: FrameActions;
}

export function WindowsView({
  nodes,
  frames,
  tiles,
  tabTiles,
  activeTabId,
  selectedTileId,
  onSelectTab,
  onMinimizeTab,
  onCloseTab,
  onFocusTile,
  onFocusFrame,
  frameActions,
}: Props) {
  // Fast lookups: tile id → its react-flow node (body data) and → frame color.
  const nodeById = useMemo(() => {
    const m = new Map<string, Node>();
    for (const n of nodes) m.set(n.id, n);
    return m;
  }, [nodes]);
  const frameColor = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of frames) m.set(f.id, f.color);
    return m;
  }, [frames]);

  return (
    <div className="flex-1 min-h-0 flex flex-row">
      {/* Left graph rail — the SAME panel as canvas mode. Clicking a tile here
          restores it if minimized (onFocusTile handles both). Gated on FRAMES
          (not tiles) — a frame with no tiles yet still needs the rail visible
          so "restore one from the rail" (the tab strip's empty-state copy)
          is actually reachable. */}
      {frames.length > 0 && (
        <LayersPanel
          frames={frames}
          tiles={tiles}
          selectedTileId={selectedTileId}
          onFocusTile={onFocusTile}
          onFocusFrame={onFocusFrame}
          frameActions={frameActions}
        />
      )}

      <div className="relative flex-1 min-h-0 flex flex-col bg-[var(--color-bg)]">
        {/* Single tab strip — one tab per non-minimized tile, tinted by frame.
            `pr-24` keeps the strip clear of App's top-right New/Settings cluster
            (the view-mode toggle now lives in Settings + ⌘E). */}
        <div className="shrink-0 flex items-stretch h-9 border-b border-[var(--color-line)] bg-[var(--color-bg2)] pr-24">
          <div
            role="tablist"
            aria-label="Open tiles"
            className="flex-1 min-w-0 flex items-stretch gap-1 px-2 overflow-x-auto"
          >
          {tabTiles.length === 0 && (
            <div className="flex items-center px-2 text-[12px] text-[var(--color-fg3)]">
              No open tabs — restore one from the rail, or spawn a tile.
            </div>
          )}
          {tabTiles.map((t) => {
            const active = t.id === activeTabId;
            // Frame tint identifies which workspace the tab belongs to. A loose
            // tile (no frame) gets a neutral marker.
            const tint = (t.frameId && frameColor.get(t.frameId)) || "var(--color-fg3)";
            return (
              <div
                key={t.id}
                role="tab"
                aria-selected={active}
                tabIndex={0}
                onClick={() => onSelectTab(t.id)}
                onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onMinimizeTab(t.id); } }}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelectTab(t.id); } }}
                title={t.name}
                className={`group relative flex items-center gap-2 pl-2.5 pr-1.5 my-1 rounded-lg cursor-pointer select-none max-w-[220px] transition-colors ${
                  active
                    ? "bg-[var(--surface-4)] text-[var(--color-fg)]"
                    : "text-[var(--color-fg2)] hover:bg-[var(--surface-3)] hover:text-[var(--color-fg)]"
                }`}
              >
                {/* Frame-color marker — the tab's identity to its workspace. */}
                <span
                  aria-hidden
                  className="shrink-0 size-2 rounded-full"
                  style={{ background: tint }}
                />
                <span className="shrink-0 grid place-items-center w-4"><TabGlyph tile={t} /></span>
                <span className="truncate text-[12px] font-medium">{t.name}</span>
                {/* Minimize — hide from the strip, keep in the graph rail. */}
                <button
                  onClick={(e) => { e.stopPropagation(); onMinimizeTab(t.id); }}
                  className="shrink-0 size-5 grid place-items-center rounded text-[var(--color-fg3)] opacity-0 group-hover:opacity-100 hover:text-[var(--color-fg)] hover:bg-[var(--color-bg3)] transition-opacity"
                  title="Minimize (still in the graph rail)"
                  aria-label={`Minimize ${t.name}`}
                >
                  <Minus size={13} />
                </button>
                {/* Close — kill the tile (same as the canvas close). */}
                <button
                  onClick={(e) => { e.stopPropagation(); onCloseTab(t.id); }}
                  className="shrink-0 size-5 grid place-items-center rounded text-[var(--color-fg3)] opacity-0 group-hover:opacity-100 hover:text-[var(--color-err)] hover:bg-[var(--color-bg3)] transition-opacity"
                  title="Close tile"
                  aria-label={`Close ${t.name}`}
                >
                  <X size={13} />
                </button>
              </div>
            );
          })}
          </div>
        </div>

        {/* EVERY open tab's body, all mounted at once, keyed by tile id — only
            the active one is shown. This is the load-bearing fix: a tab switch
            (or minimize/restore) must never unmount a tile's body. Unmounting
            calls window.hive.ptyDetach, which main routes to killRemotePty for
            a remote (`ssh://`) tile — so a naive "only render the active tab"
            approach silently kills every non-active agent session on a tab
            click. Inactive bodies are hidden via `visibility` at FULL SIZE
            (see HIDDEN_TAB_STYLE) rather than removed or 0×0'd. */}
        <div className="relative flex-1 min-h-0 overflow-hidden">
          {tabTiles.map((t) => {
            const node = nodeById.get(t.id);
            const active = t.id === activeTabId;
            const body = node && toTileBodyProps(node, active);
            if (!body) return null;
            return (
              <div
                key={t.id}
                data-tile-id={t.id}
                aria-hidden={!active}
                className="absolute inset-0 flex flex-col"
                style={active ? undefined : HIDDEN_TAB_STYLE}
              >
                <TileBody {...body} />
              </div>
            );
          })}
          {!activeTabId && (
            <div className="absolute inset-0 grid place-items-center text-[13px] text-[var(--color-fg3)]">
              {tabTiles.length === 0
                ? "Nothing open. Spawn a tile (1–7) or restore one from the rail."
                : "Select a tab to view it."}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
