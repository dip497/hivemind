/**
 * tile-host — the SHARED owner of every tile's live surface (terminal / editor /
 * diff / browser / issues / plan review), independent of which view is showing.
 *
 * The problem this solves: a tile body used to be a child of whichever view was
 * active (a react-flow node in Canvas, a tab panel in Windows). Switching views
 * unmounted every body — TerminalTile's cleanup then ran `ptyDetach`, which main
 * routes to `killRemotePty` for an `ssh://` tile (the daemon-less path), so a
 * view switch silently killed remote agent sessions. Local tiles "only" lost
 * their xterm + WebGL state and replayed; editors lost unsaved buffers; browsers
 * reloaded.
 *
 * Lifetime ownership now: the TileHost renders each surface EXACTLY ONCE, via a
 * `createPortal` into a per-tile DOM element it owns (`surfaceEl(id)`), created
 * lazily and kept for as long as the tile is open. Portal containers never
 * change, so React never remounts the body — the only unmount is the tile
 * closing. Views don't render bodies at all; they render a `<TileSlot>` where a
 * body should appear, and the slot ADOPTS the tile's element by moving it into
 * place (`appendChild`) — the same DOM-reparenting trick tile-fullscreen.tsx
 * already uses to fullscreen a live xterm without recreating it. When no slot
 * claims a surface (a minimized tab, a view that doesn't show it, the instant
 * between two views), it parks in a hidden layer FROZEN at its last slot size —
 * never `display:none` / 0×0 (xterm's fit addon computes garbage) and never
 * full-window (every parked terminal would reflow + resize its PTY). A body is
 * only mounted once a slot has adopted its element, so first mounts happen at
 * real size, exactly once.
 *
 * Known limit: an Electron `<webview>` reloads its page once when its DOM node is
 * reparented (Chromium guest re-attach). React state (tabs, address, history) is
 * preserved; the page's own scroll/form state is not. Fixing that means hosting
 * browser guests as main-process WebContentsViews — tracked in
 * docs/design/workspace-views.md as a follow-up.
 */
import { lazy, memo, Suspense, useEffect, useLayoutEffect, useRef, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { TerminalTile } from "../TerminalTile";
import { BrowserTile } from "../BrowserTile";
import { IssuesTile } from "../IssuesTile";
import { PlanReviewTile } from "../PlanReviewTile";
import { TileErrorBoundary } from "../TileErrorBoundary";
import type { TileSurface, TileSurfaceSpec } from "./tile-surfaces";

const DiffTile = lazy(() => import("../DiffTile").then((m) => ({ default: m.DiffTile })));
const WorkbenchTile = lazy(() => import("../WorkbenchTile").then((m) => ({ default: m.WorkbenchTile })));

export type TileBodyProps = TileSurfaceSpec & { selected: boolean };

// Fallback shown while a lazy-loaded heavy tile (diff/editor) fetches its chunk.
function TileLoading({ label }: { label: string }) {
  return (
    <div className="w-full h-full grid place-items-center rounded-xl border border-[var(--color-line)] bg-[var(--color-bg2)] text-[12px] text-[var(--color-fg3)]">
      {label}
    </div>
  );
}

/**
 * TileBody — the chrome-less body for one tile kind: the pure tile component
 * (TerminalTile / DiffTile / …) with no view shell, resize handles or pin chip.
 * Rendered ONLY by the TileHost below; views never call it directly (they'd
 * create a second React instance of a live session).
 */
export function TileBody(props: TileBodyProps): ReactNode {
  switch (props.type) {
    case "terminal": {
      const { data, selected } = props;
      return (
        <TileErrorBoundary label={data.label ?? "terminal"} onClose={data.onClose}>
          <TerminalTile {...data} selected={selected} />
        </TileErrorBoundary>
      );
    }
    case "diff": {
      const { data } = props;
      return (
        <TileErrorBoundary label="Diff" onClose={data.onClose}>
          <Suspense fallback={<TileLoading label="Loading diff…" />}>
            <DiffTile {...data} />
          </Suspense>
        </TileErrorBoundary>
      );
    }
    case "workbench": {
      const { data } = props;
      return (
        <TileErrorBoundary label="Editor" onClose={data.onClose}>
          <Suspense fallback={<TileLoading label="Loading editor…" />}>
            <WorkbenchTile
              repoPath={data.repoPath}
              tabs={data.tabs}
              onOpenFile={data.onOpenFile}
              onOpenInBrowser={data.onOpenInBrowser}
              onCloseTab={data.onCloseTab}
              onClose={data.onClose}
              pinned={data.pinned}
              onTogglePin={data.onTogglePin}
            />
          </Suspense>
        </TileErrorBoundary>
      );
    }
    case "browser": {
      const { data, selected } = props;
      return (
        <TileErrorBoundary label="Browser" onClose={data.onClose}>
          <BrowserTile
            tileId={data.tileId}
            frameId={data.frameId}
            url={data.url}
            openReq={data.openReq}
            selected={selected}
            onClose={data.onClose}
            pinned={data.pinned}
            onTogglePin={data.onTogglePin}
          />
        </TileErrorBoundary>
      );
    }
    case "issues": {
      const { data, selected } = props;
      return (
        <TileErrorBoundary label="Issues" onClose={data.onClose}>
          <IssuesTile
            root={data.root}
            onClose={data.onClose}
            selected={selected}
            pinned={data.pinned}
            onTogglePin={data.onTogglePin}
          />
        </TileErrorBoundary>
      );
    }
    case "planReview": {
      const { data } = props;
      return (
        <TileErrorBoundary label="Plan review" onClose={data.onClose}>
          <PlanReviewTile {...data} />
        </TileErrorBoundary>
      );
    }
    default:
      return null;
  }
}

// ── surface elements + the parking layer ─────────────────────────────────────
// Module-level (one workspace per window): the element registry must outlive
// any view AND the TileHost's own re-renders, and slots in a different React
// subtree need to reach it without prop-threading.

const PARK_ID = "hm-tile-park";
const surfaces = new Map<string, HTMLDivElement>();
/** Tiles whose element has been adopted by a slot at least once. A body is
 *  mounted only from then on (see SurfacePortal), so its first mount — xterm
 *  open + fit + ptySpawn, a `<webview>` guest — happens at the slot's real
 *  size and exactly once. Cleared when the tile closes. */
const adoptedOnce = new Set<string>();
const adoptListeners = new Set<() => void>();
function notifyAdopted() { for (const l of adoptListeners) l(); }
function subscribeAdopted(l: () => void) { adoptListeners.add(l); return () => { adoptListeners.delete(l); }; }
/** Runtime hooks the shared layer calls back into (set by TileHost). */
const hostCallbacks: { onPointerDown?: (tileId: string) => void } = {};

/** Surface sizing while adopted: fill the slot (slots are `position:relative`). */
const ADOPTED_CSS = "position:absolute;inset:0;display:flex;flex-direction:column;";

/** Lifecycle events dispatched on the surface element (not bubbling) — a body
 *  that cares (TerminalTile) listens on `host.closest(".hm-tile-surface")`. */
export const SURFACE_ADOPTED = "hivemind:surface-adopted";
export const SURFACE_PARKED = "hivemind:surface-parked";

/** The hidden full-window layer un-adopted surfaces live in. Created on first
 *  use, appended to <body> (outside every view's DOM, so a view unmounting can
 *  never take a parked surface with it). */
function park(): HTMLElement {
  let el = document.getElementById(PARK_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = PARK_ID;
    el.setAttribute("aria-hidden", "true");
    // visibility (not display:none) keeps a parked surface laid out; the
    // surface itself is frozen at its last slot size (see parkSurface) so
    // xterm's ResizeObserver has nothing to refit. pointer-events:none so it
    // can't eat clicks.
    el.style.cssText = "position:fixed;inset:0;visibility:hidden;pointer-events:none;z-index:-1;overflow:hidden;";
    document.body.appendChild(el);
  }
  return el;
}

/** The DOM element a tile's body renders into — stable for the tile's life. */
export function surfaceEl(tileId: string): HTMLDivElement {
  let el = surfaces.get(tileId);
  if (!el) {
    el = document.createElement("div");
    el.dataset.surface = tileId;
    el.className = "hm-tile-surface";
    el.style.cssText = ADOPTED_CSS;
    // BLOCKER-1 fix: a body is portaled from the TileHost and only DOM-
    // reparented into a view's slot, so React synthetic events never reach the
    // view's own handlers (xyflow's NodeWrapper onClick → onNodeClick). Native
    // events DO bubble through the real DOM, so selection is decided HERE, on
    // the shared layer, for every view. Primary button only — middle/right on
    // an unselected canvas tile pan the board and must not select.
    el.addEventListener("pointerdown", (e) => { if (e.button === 0) hostCallbacks.onPointerDown?.(tileId); });
    park().appendChild(el);
    surfaces.set(tileId, el);
  }
  return el;
}

/** Freeze a surface at `rect` and return it to the park. Deferred to a
 *  microtask so a view switch — old slot's cleanup + new slot's adoption in the
 *  SAME commit — moves the element straight from one slot to the other with no
 *  park hop in between: each DOM insertion of a `<webview>` re-creates its
 *  guest, so the hop cost a second page load and leaked a WebContents. */
function parkSurface(tileId: string, from: HTMLElement, rect: { w: number; h: number } | null) {
  queueMicrotask(() => {
    const el = surfaces.get(tileId);
    if (!el || el.parentElement !== from) return; // adopted elsewhere (or dropped) meanwhile
    // Hold the last slot size so nothing inside refits/resizes the PTY while
    // parked (a full-window park made every parked terminal reflow twice and
    // re-resize on every window resize). No size known (slot never laid out)
    // → keep the fill-the-park sizing.
    if (rect) el.style.cssText = `position:absolute;left:0;top:0;width:${Math.max(1, rect.w)}px;height:${Math.max(1, rect.h)}px;display:flex;flex-direction:column;`;
    park().appendChild(el);
    el.dispatchEvent(new CustomEvent(SURFACE_PARKED));
  });
}

/** Drop a closed tile's element (its portal has already unmounted the body). */
function dropSurface(tileId: string) {
  const el = surfaces.get(tileId);
  if (!el) return;
  el.remove();
  surfaces.delete(tileId);
  adoptedOnce.delete(tileId);
}

/** True when a live surface exists for this tile (test/diagnostic hook). */
export function hasSurface(tileId: string): boolean {
  return surfaces.has(tileId);
}

/** True once a slot has adopted the tile's element (body may mount). */
function useAdopted(tileId: string): boolean {
  return useSyncExternalStore(subscribeAdopted, () => adoptedOnce.has(tileId));
}

// ── TileHost ────────────────────────────────────────────────────────────────

const SurfacePortal = memo(function SurfacePortal({ surface, selected }: { surface: TileSurface; selected: boolean }) {
  // Nothing mounts until a slot has adopted the element — so the body's first
  // mount happens inside a real slot at its real size, once. (xyflow renders
  // its NodeWrapper one commit after the tile exists; without this gate the
  // body opened at park size and resized a frame later.) Once adopted, the
  // body stays mounted for the tile's life, parked or not.
  const ready = useAdopted(surface.id);
  if (!ready) return null;
  // `surfaceEl` is idempotent — the same element for the same id, forever — so
  // this portal's container never changes and React reconciles in place.
  const { id, kind: _kind, ...spec } = surface;
  return createPortal(<TileBody {...(spec as TileSurfaceSpec)} selected={selected} />, surfaceEl(id));
});

/**
 * Mount point for every open tile's body. Render it ONCE in the workspace
 * runtime. `onSurfacePointerDown` is the shared-layer selection hook (see
 * surfaceEl).
 */
export function TileHost({ surfaces: list, selectedTileId, onSurfacePointerDown }: {
  surfaces: TileSurface[];
  selectedTileId: string | null;
  onSurfacePointerDown?: (tileId: string) => void;
}) {
  hostCallbacks.onPointerDown = onSurfacePointerDown;
  // Reap elements of tiles that closed. Runs after the portals above have
  // unmounted (same commit), so the body's cleanup (kill/detach) already fired.
  const prevIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    const now = new Set(list.map((s) => s.id));
    for (const id of prevIds.current) if (!now.has(id)) dropSurface(id);
    prevIds.current = now;
  }, [list]);
  return (
    <>
      {list.map((s) => (
        <SurfacePortal key={s.id} surface={s} selected={s.id === selectedTileId} />
      ))}
    </>
  );
}

// ── TileSlot ────────────────────────────────────────────────────────────────

/**
 * Where a view wants a tile's body to appear. Adopts the tile's live surface
 * element on mount (moving it out of the park or out of another slot) and
 * parks it again on unmount. Any number of views can render slots for the same
 * tile over time; at most one holds it at once (last adopter wins).
 *
 * The slot is `position:relative` and sized by the caller (`className`/`style`
 * — default fills its parent), and the surface is `absolute; inset:0` inside.
 */
export function TileSlot({ tileId, className, style }: { tileId: string; className?: string; style?: CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null);
  // Layout effect (not passive): adopt BEFORE paint so a freshly-switched view
  // never flashes an empty slot, and before the body's own effects measure.
  useLayoutEffect(() => {
    const slot = ref.current;
    if (!slot) return;
    const el = surfaceEl(tileId);
    el.style.cssText = ADOPTED_CSS;
    if (el.parentElement !== slot) slot.appendChild(el);
    if (!adoptedOnce.has(tileId)) { adoptedOnce.add(tileId); notifyAdopted(); }
    el.dispatchEvent(new CustomEvent(SURFACE_ADOPTED));
    // Track the slot's size through a ResizeObserver ONLY (its first
    // notification arrives right after layout): reading offsetWidth here forced
    // a synchronous layout per tile inside the commit on every view switch.
    let last: { w: number; h: number } | null = null;
    const ro = new ResizeObserver((entries) => {
      const r = entries[entries.length - 1]?.contentRect;
      if (r && r.width > 0 && r.height > 0) last = { w: r.width, h: r.height };
    });
    ro.observe(slot);
    return () => {
      ro.disconnect();
      // The move itself is deferred — see parkSurface.
      parkSurface(tileId, slot, last);
    };
  }, [tileId]);
  return <div ref={ref} data-tile-slot={tileId} className={className ?? "relative w-full h-full"} style={style} />;
}
