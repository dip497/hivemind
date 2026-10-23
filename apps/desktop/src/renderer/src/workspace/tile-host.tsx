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
 * mounted once a slot has adopted its element, so first mounts happen at real
 * size, exactly once — except a terminal no view claims: after a short grace it
 * mounts in the park at its kind's default size, so its session runs unseen.
 *
 * Every move goes through `moveInto`, which never takes a surface out of the
 * document: an Electron `<webview>` that is disconnected, even for one commit,
 * destroys its guest and loads the page again.
 */
import { lazy, memo, Suspense, useEffect, useLayoutEffect, useRef, useSyncExternalStore, type ComponentType, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { TileErrorBoundary } from "../TileErrorBoundary";
import type { TileSurface } from "./tile-surfaces";
import { tileKind, tilePlugin, type TileBodyArgs, type TilePlugin } from "../tiles";
import "../tiles/bodies";

export type TileBodyProps = { type: string; data: unknown; selected: boolean };

/** One lazy component per plugin, so a body's module loads once. */
const bodies = new WeakMap<TilePlugin, ComponentType<TileBodyArgs<unknown>>>();
function bodyOf(plugin: TilePlugin): ComponentType<TileBodyArgs<unknown>> {
  let body = bodies.get(plugin);
  if (!body) {
    body = plugin.lazy ? lazy(plugin.body as () => Promise<{ default: ComponentType<TileBodyArgs<unknown>> }>) : plugin.body as ComponentType<TileBodyArgs<unknown>>;
    bodies.set(plugin, body);
  }
  return body;
}

/**
 * TileBody — the chrome-less body for one tile: its plugin's component, with no
 * view shell, resize handles or pin chip. Rendered ONLY by the TileHost below;
 * views never call it directly (they'd create a second React instance of a live
 * session).
 */
export function TileBody({ type, data, selected }: TileBodyProps): ReactNode {
  const plugin = tilePlugin(type);
  if (!plugin) return null;
  const Body = bodyOf(plugin);
  const Fallback = plugin.fallback;
  const onClose = (data as { onClose?: () => void }).onClose;
  return (
    <TileErrorBoundary label={(data as { label?: string }).label ?? plugin.name} onClose={onClose}>
      <Suspense fallback={Fallback ? <Fallback /> : null}>
        <Body data={data} selected={selected} />
      </Suspense>
    </TileErrorBoundary>
  );
}

// ── surface elements + the parking layer ─────────────────────────────────────
// Module-level (one workspace per window): the element registry must outlive
// any view AND the TileHost's own re-renders, and slots in a different React
// subtree need to reach it without prop-threading.

const PARK_ID = "hm-tile-park";
const surfaces = new Map<string, HTMLDivElement>();
/** Tiles whose element has been adopted by a slot at least once, or mounted
 *  unseen (see mountUnseen). A body is mounted only from then on (see
 *  SurfacePortal), so its first mount — xterm open + fit + ptySpawn, a
 *  `<webview>` guest — happens at a real size and exactly once. Cleared when
 *  the tile closes. */
const adoptedOnce = new Set<string>();
/** Bumped on every adoption, so a park queued before a re-adoption is dropped. */
const adoptGen = new Map<string, number>();
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

/** The last size a NON-transient slot (a view's own arrangement) gave each
 *  tile. A transient slot — a dock pane, a hole-punch overlay — parks the
 *  surface back at this size, so the next switch to the arranging view finds
 *  the tile already at its size and refits nothing (the "geometry of a parked
 *  tile" gap: a terminal parked at the dock's size paid a ~300 ms WebGL refit
 *  on the first switch back). */
const stableSize = new Map<string, { w: number; h: number }>();

/** Put `el` under `parent` while keeping it connected (`moveBefore`), so a
 *  `<webview>` inside keeps its page (see public/webview-move.js). A detached
 *  element can only be inserted. */
function moveInto(parent: HTMLElement, el: HTMLElement) {
  if (el.parentElement === parent) return;
  if (el.isConnected && parent.isConnected) parent.moveBefore(el, null);
  else parent.appendChild(el);
}

/** Freeze a surface at `rect` and return it to the park. Runs in the slot's
 *  layout-effect cleanup, which React calls before it removes the slot's DOM:
 *  waiting any longer lets the surface leave the document with the slot. The
 *  `SURFACE_PARKED` event waits a microtask and is dropped when a slot adopts
 *  the surface again in the same commit (a view switch). */
function parkSurface(tileId: string, from: HTMLElement, rect: { w: number; h: number } | null, transient: boolean) {
  const el = surfaces.get(tileId);
  // Already adopted by another slot.
  if (!el || el.parentElement !== from) return;
  // Hold the last slot size so nothing inside refits/resizes the PTY while
  // parked (a full-window park made every parked terminal reflow twice and
  // re-resize on every window resize). No size known (slot never laid out)
  // → keep the fill-the-park sizing. Leaving a transient slot: restore the
  // arranging view's size instead, and tell the body it changed (it refits
  // NOW, while hidden — on the cheap renderer the selected tile uses).
  if (rect && !transient) stableSize.set(tileId, rect);
  const size = transient ? stableSize.get(tileId) ?? rect : rect;
  if (size) el.style.cssText = `position:absolute;left:0;top:0;width:${Math.max(1, size.w)}px;height:${Math.max(1, size.h)}px;display:flex;flex-direction:column;`;
  moveInto(park(), el);
  const resized = !!(rect && size && (size.w !== rect.w || size.h !== rect.h));
  const gen = adoptGen.get(tileId);
  queueMicrotask(() => {
    if (adoptGen.get(tileId) !== gen || el.parentElement !== park()) return;
    el.dispatchEvent(new CustomEvent(SURFACE_PARKED, { detail: { resized } }));
  });
}

/** Drop a closed tile's element (its portal has already unmounted the body). */
function dropSurface(tileId: string) {
  const el = surfaces.get(tileId);
  if (!el) return;
  el.remove();
  surfaces.delete(tileId);
  adoptedOnce.delete(tileId);
  adoptGen.delete(tileId);
  stableSize.delete(tileId);
}

/** How long a terminal waits for a view to show it before it starts unseen. */
export const UNSEEN_MOUNT_MS = 1500;

/** A terminal no view shows still has to run — an agent started while another view
 *  is active, a worker spawned by another agent. Mount its body in the park at its
 *  kind's default size; the first slot that shows it adopts it and refits once. */
function mountUnseen(tileId: string, kind: string) {
  if (adoptedOnce.has(tileId)) return;
  const { width, height } = tileKind(kind).size;
  const el = surfaceEl(tileId);
  if (el.parentElement !== park()) return;
  el.style.cssText = `position:absolute;left:0;top:0;width:${width}px;height:${height}px;display:flex;flex-direction:column;`;
  adoptedOnce.add(tileId);
  notifyAdopted();
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
  const terminal = !!tilePlugin(surface.type)?.runsUnseen;
  useEffect(() => {
    if (ready || !terminal) return;
    const t = setTimeout(() => mountUnseen(surface.id, surface.kind), UNSEEN_MOUNT_MS);
    return () => clearTimeout(t);
  }, [ready, terminal, surface.id, surface.kind]);
  if (!ready) return null;
  // `surfaceEl` is idempotent — the same element for the same id, forever — so
  // this portal's container never changes and React reconciles in place.
  return createPortal(<TileBody type={surface.type} data={surface.data} selected={selected} />, surfaceEl(surface.id));
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
 * `SURFACE_PARKED` carries `{ resized }` — true when the park restored a size
 * other than the slot's (leaving a transient slot).
 */
export function TileSlot({ tileId, className, style, transient = false }: {
  tileId: string;
  className?: string;
  style?: CSSProperties;
  /** A slot that is not the view's arrangement — a dock pane, an overlay. On
   *  unmount the surface parks at the size the ARRANGING view last gave it,
   *  not this slot's, so the switch back refits nothing. */
  transient?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Layout effect (not passive): adopt BEFORE paint so a freshly-switched view
  // never flashes an empty slot, and before the body's own effects measure.
  useLayoutEffect(() => {
    const slot = ref.current;
    if (!slot) return;
    const el = surfaceEl(tileId);
    el.style.cssText = ADOPTED_CSS;
    moveInto(slot, el);
    adoptGen.set(tileId, (adoptGen.get(tileId) ?? 0) + 1);
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
      parkSurface(tileId, slot, last, transient);
    };
  }, [tileId, transient]);
  return <div ref={ref} data-tile-slot={tileId} className={className ?? "relative w-full h-full"} style={style} />;
}
