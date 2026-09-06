/**
 * WindowsView — the "editor-like" view plugin. Same workspace, different lens:
 * the graph rail on the LEFT (the shared LayersPanel: frames → worktrees →
 * tiles), a SINGLE tab strip across the top (one tab per open tile, tinted by its
 * frame's color), and the active tile's body filling the rest. VS Code / editor
 * muscle memory.
 *
 * Bodies come from the shared TileHost: this view renders a `<TileSlot>` per
 * tab and the host moves the tile's live surface into it — so a tab switch, a
 * minimize, or switching to/from the canvas never mounts or unmounts a terminal
 * (a remote `ssh://` tile has no daemon to reattach to; its unmount would kill
 * the agent). Inactive tabs stay laid out at full size and hidden with
 * `visibility:hidden` (never `display:none` — a 0×0 box makes xterm's fit addon
 * compute garbage). Minimized tiles simply have no slot; their surface parks in
 * the host's hidden layer, still alive.
 *
 * Selection is ONE fact — the runtime's `selectedTileId` — and the active tab
 * is a projection of it: whatever selects a tile (a tab click here, a spawn,
 * "open in editor" from a terminal, an HCP `tile.focus`, a toast, the rail)
 * becomes the visible tab, un-minimizing it if needed. The stored
 * `activeTabId` is only a fallback for when nothing is selected (first mount,
 * the selected tile closed). Owns minimized set + that fallback in its own
 * versioned per-repo layout blob (windows-layout.ts).
 */
import { useCallback, useEffect, useMemo, type CSSProperties, type ReactNode } from "react";
import { X, Minus, Globe, PanelsTopLeft } from "lucide-react";
import { LayersPanel, type LayerTile } from "../../LayersPanel";
import { AgentIcon } from "../../agents";
import { nextActiveTab } from "../../windows-view-state";
import { TileSlot } from "../tile-host";
import { useViewLayout } from "../view-layout-store";
import type { WorkspaceViewPlugin, WorkspaceViewProps } from "../workspace-view";
import { WINDOWS_LAYOUT } from "./windows-layout";

// Inactive tab bodies stay laid out at FULL SIZE — visibility:hidden (not
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

export function WindowsView({ model, commands }: WorkspaceViewProps) {
  const { layerFrames: frames, layerTiles: tiles, selectedTileId, frameActions, layoutKey } = model;
  const [layout, setLayout] = useViewLayout(WINDOWS_LAYOUT, layoutKey);
  const minimized = useMemo(() => new Set(layout.minimized), [layout.minimized]);
  const openIds = useMemo(() => new Set(tiles.map((t) => t.id)), [tiles]);

  // A runtime selection of a minimized tile un-minimizes it (the selected tile
  // must be the visible one — its body has the keyboard).
  const selectedIsMinimized = !!selectedTileId && minimized.has(selectedTileId);
  useEffect(() => {
    if (selectedIsMinimized) setLayout((l) => ({ ...l, minimized: l.minimized.filter((m) => m !== selectedTileId) }));
  }, [selectedIsMinimized, selectedTileId, setLayout]);

  // Tabs shown in the strip: every open tile (as the Layers panel sees them),
  // minus the minimized set. Order follows layerTiles (tiles in open order).
  const tabTiles = useMemo(() => tiles.filter((t) => !minimized.has(t.id) || t.id === selectedTileId), [tiles, minimized, selectedTileId]);
  // The active tab is DERIVED: the selected tile when it's open, else the
  // stored fallback if still visible, else the first tab.
  const activeTabId = useMemo(
    () => (selectedTileId && openIds.has(selectedTileId) ? selectedTileId : nextActiveTab(layout.activeTabId, tabTiles.map((t) => t.id))),
    [selectedTileId, openIds, layout.activeTabId, tabTiles],
  );
  // Fallback chosen (nothing selected / selection closed) → make it the
  // selection so its body takes the keyboard; and remember it for next time.
  useEffect(() => {
    if (activeTabId && activeTabId !== selectedTileId) commands.selectTile(activeTabId);
    setLayout((l) => (l.activeTabId === activeTabId ? l : { ...l, activeTabId }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId]);

  const selectTab = useCallback((id: string) => commands.selectTile(id), [commands]);
  const minimizeTab = useCallback((id: string) => {
    setLayout((l) => (l.minimized.includes(id) ? l : { ...l, minimized: [...l.minimized, id] }));
    // Minimizing the active tab hands selection to a neighbour (derivation
    // above picks it) — clear so the fallback rule runs.
    if (id === selectedTileId) commands.selectTile(null);
  }, [setLayout, selectedTileId, commands]);
  /** Rail click: a minimized tile restores + activates; a visible one activates. */
  const restoreTab = useCallback((id: string) => commands.selectTile(id), [commands]);
  const focusFrame = useCallback((id: string) => {
    commands.selectFrame(id);
    commands.selectTile(null);
    commands.focusTile(id);
  }, [commands]);

  // Fast lookup: frame id → color (per-tab tint).
  const frameColor = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of frames) m.set(f.id, f.color);
    return m;
  }, [frames]);

  return (
    <div className="flex-1 min-h-0 flex flex-row">
      {/* Left graph rail — the SAME panel as canvas mode. Clicking a tile here
          restores it if minimized (restoreTab handles both). Gated on FRAMES
          (not tiles) — a frame with no tiles yet still needs the rail visible
          so "restore one from the rail" (the tab strip's empty-state copy)
          is actually reachable. */}
      {frames.length > 0 && (
        <LayersPanel
          frames={frames}
          tiles={tiles}
          selectedTileId={selectedTileId}
          onFocusTile={restoreTab}
          onFocusFrame={focusFrame}
          frameActions={frameActions}
        />
      )}

      <div className="relative flex-1 min-h-0 flex flex-col bg-[var(--color-bg)]">
        {/* Single tab strip — one tab per non-minimized tile, tinted by frame.
            `pr-24` keeps the strip clear of App's top-right New/Settings cluster
            (the view switcher lives in Settings + ⌘E). */}
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
                onClick={() => selectTab(t.id)}
                onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); minimizeTab(t.id); } }}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectTab(t.id); } }}
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
                  onClick={(e) => { e.stopPropagation(); minimizeTab(t.id); }}
                  className="shrink-0 size-5 grid place-items-center rounded text-[var(--color-fg3)] opacity-0 group-hover:opacity-100 hover:text-[var(--color-fg)] hover:bg-[var(--color-bg3)] transition-opacity"
                  title="Minimize (still in the graph rail)"
                  aria-label={`Minimize ${t.name}`}
                >
                  <Minus size={13} />
                </button>
                {/* Close — kill the tile (same as the canvas close). */}
                <button
                  onClick={(e) => { e.stopPropagation(); commands.closeTile(t.id); }}
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

        {/* One full-size slot per tab, all laid out at once, keyed by tile id —
            only the active one is visible. The TileHost owns the bodies; a slot
            just borrows the live surface. Inactive slots are hidden via
            `visibility` at FULL SIZE (see HIDDEN_TAB_STYLE), never removed or
            0×0'd, so xterm keeps a sane grid and nothing ever remounts. */}
        <div className="relative flex-1 min-h-0 overflow-hidden">
          {tabTiles.map((t) => {
            const active = t.id === activeTabId;
            return (
              <div
                key={t.id}
                data-tile-id={t.id}
                aria-hidden={!active}
                className="absolute inset-0 flex flex-col"
                style={active ? undefined : HIDDEN_TAB_STYLE}
              >
                <TileSlot tileId={t.id} className="relative flex-1 min-h-0" />
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

export const windowsViewPlugin: WorkspaceViewPlugin = {
  id: "windows",
  label: "Windows",
  hint: "Tabs + one active tile",
  icon: PanelsTopLeft,
  component: WindowsView,
};
