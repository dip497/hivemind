/**
 * Canvas "camera" subsystem — viewport focus / fit / pan-inertia / crisp-snap.
 * These are all tiny components (or one hook) rendered INSIDE <ReactFlow> so the
 * `useReactFlow` hooks resolve; each is driven by a nonce/`req` prop bumped by
 * Canvas. Pure presentational adapters with no Canvas state — extracted to keep
 * Canvas.tsx focused on orchestration.
 */
import { useCallback, useEffect } from "react";
import { useReactFlow, useStore } from "@xyflow/react";

/** Snap a settled viewport so canvas-rendered text stays crisp: round the pan to
 *  whole DEVICE pixels (fractional CSS translate puts the xterm bitmap on
 *  sub-pixels → blur) and pull a near-1 zoom to exactly 1.0 (the only zoom where
 *  the bitmap maps 1:1 to screen pixels). Pure; only applied at rest. */
export function snapViewportCrisp(vp: { x: number; y: number; zoom: number }): {
  x: number;
  y: number;
  zoom: number;
} {
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  const zoom = Math.abs(vp.zoom - 1) < 0.02 ? 1 : vp.zoom;
  return { zoom, x: Math.round(vp.x * dpr) / dpr, y: Math.round(vp.y * dpr) / dpr };
}

/** Focus mode: fitView to ONE node (req.id) or to ALL nodes (req.id === null).
 *  Maximize FITS the tile to the screen (zoom to fill, up to 1.6× for small
 *  tiles). Selection stays accurate at any zoom thanks to the zoom-aware mouse
 *  patch (terminal-mouse-patch.ts), so terminals no longer need to be pinned to
 *  100% here. */
export function FocusMode({ req }: { req: { id: string | null; n: number } | null }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (!req) return;
    if (req.id) {
      // Near-fullscreen: tiny padding so the tile fills the window edge-to-edge,
      // maxZoom 1.6 so a small tile enlarges to fill. Big tiles land at zoom<1 and
      // show whole — the maximized feel.
      void fitView({ nodes: [{ id: req.id }], padding: 0.03, duration: 400, maxZoom: 1.6 });
    } else {
      void fitView({ padding: 0.2, duration: 400 });
    }
  }, [req, fitView]);
  return null;
}

/** Pans the viewport to a requested tile once it has mounted + been measured.
 *  Polls a few rAF ticks because a freshly-spawned node isn't laid out on the
 *  same frame the request fires. Rendered inside <ReactFlow>. */
export function FocusOnTile({
  req,
}: {
  req: { id: string; cx: number; cy: number; w?: number; h?: number; n: number; exact?: boolean } | null;
}) {
  const { setCenter, getZoom, getNode, fitView } = useReactFlow();
  // Pane size (CSS px). At the exact-path's zoom 1, flow units == screen px, so
  // we can frame the tile against the viewport directly.
  const paneW = useStore((s) => s.width);
  const paneH = useStore((s) => s.height);
  useEffect(() => {
    if (!req) return;
    // `exact`: text tiles (terminal/editor/diff) need EXACTLY 100% — xterm
    // selection + DOM-text crispness are only pixel-accurate at 1:1. Pan to the
    // tile at zoom 1 in a SINGLE animation; do NOT chase it with a fitView
    // (which lands at ≤ 1) — running both raced the viewport to the wrong place.
    if (req.exact) {
      // Centering is right when the tile FITS, but a tile WIDER/TALLER than the
      // viewport would center-clip its edges — and for a terminal the LEFT edge
      // (prompt + line starts) is exactly what you need to read. When the tile
      // overflows an axis, anchor that axis to the tile's left/top edge (+pad) so
      // the content corner stays on screen instead of hanging off the left.
      const PAD = 24;
      const w = req.w ?? 0;
      const h = req.h ?? 0;
      let tx = req.cx;
      let ty = req.cy;
      // Guard paneW/paneH > 0: the store reports 0 until the pane is measured;
      // clamping against 0 would shove the tile hard off-screen.
      if (paneW > 0 && w > paneW - 2 * PAD) tx = req.cx - w / 2 + paneW / 2 - PAD; // left-anchor
      if (paneH > 0 && h > paneH - 2 * PAD) ty = req.cy - h / 2 + paneH / 2 - PAD; // top-anchor
      void setCenter(tx, ty, { zoom: 1, duration: 400 });
      return;
    }
    // Two-stage focus, same end result as the "." focus-selected hotkey but
    // robust for a brand-new tile that isn't DOM-measured yet:
    //   1. setCenter on the resolved absolute coords NOW — needs no
    //      measurement/render, so the viewport pans to the tile immediately.
    //   2. once xyflow has measured the node, fitView to frame it nicely
    //      (zoom-to-fit, the focus-selected feel). Poll up to ~1s.
    const z0 = Math.min(Math.max(getZoom(), 0.5), 1);
    void setCenter(req.cx, req.cy, { zoom: z0, duration: 400 });
    let raf = 0;
    let tries = 0;
    const tick = () => {
      const n = getNode(req.id);
      if (n && n.measured?.width && n.measured?.height) {
        void fitView({ nodes: [{ id: req.id }], padding: 0.18, duration: 400, maxZoom: 1 });
        return;
      }
      if (tries++ < 60) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [req, setCenter, getZoom, getNode, fitView]);
  return null;
}

/** Pan inertia: on `req` ({vx,vy} px/ms from the release flick), glide the
 *  viewport to a stop with velocity decay instead of dying instantly.
 *  `activeRef` flips true while flinging so the parent's onMove sampler ignores
 *  our own setViewport calls (no feedback loop). Rendered inside <ReactFlow>. */
export function PanMomentum({
  req,
  activeRef,
  onSettle,
}: {
  req: { vx: number; vy: number; n: number } | null;
  activeRef: React.MutableRefObject<boolean>;
  onSettle?: () => void;
}) {
  const { getViewport, setViewport } = useReactFlow();
  useEffect(() => {
    if (!req) return;
    let raf = 0;
    // Gentle glide: damp the release velocity (×0.45) and cap it so a fast
    // flick doesn't launch the canvas across the screen, and decay quickly
    // (0.85/frame ≈ stops in ~0.25s) so it settles instead of coasting far.
    const cap = (v: number) => Math.max(-1.2, Math.min(1.2, v * 0.45));
    let vx = cap(req.vx);
    let vy = cap(req.vy);
    let last = performance.now();
    activeRef.current = true;
    const tick = (t: number) => {
      const dt = Math.min(t - last, 32);
      last = t;
      vx *= 0.85;
      vy *= 0.85;
      if (Math.abs(vx) < 0.02 && Math.abs(vy) < 0.02) {
        activeRef.current = false;
        onSettle?.(); // glide stopped → snap the resting viewport crisp
        return;
      }
      const vp = getViewport();
      setViewport({ x: vp.x + vx * dt, y: vp.y + vy * dt, zoom: vp.zoom });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      activeRef.current = false;
    };
  }, [req, getViewport, setViewport, activeRef, onSettle]);
  return null;
}

/** Reset zoom to exactly 100% (around the viewport center) when `req` bumps —
 *  fired when a terminal tile is selected. xterm maps the mouse to a cell using
 *  the UNSCALED cell size, so at zoom ≠ 1 selection and link clicks land on the
 *  wrong row; at 100% they're pixel-accurate. Skips if already at 1. Rendered
 *  inside <ReactFlow> so useReactFlow resolves. */
export function SelectZoomReset({ req }: { req: number }) {
  const { getZoom, zoomTo } = useReactFlow();
  useEffect(() => {
    if (req === 0) return;
    if (Math.abs(getZoom() - 1) > 0.001) void zoomTo(1, { duration: 150 });
  }, [req, getZoom, zoomTo]);
  return null;
}

/** Snaps the LIVE viewport transform to whole device pixels (and a near-1 zoom
 *  to exactly 1) whenever `req` bumps — the real fix for blurry tiles under the
 *  CSS-transformed viewport (xyflow#3282). `activeRef` (shared with the fling)
 *  tells the parent's onMove/onMoveEnd to ignore our own setViewport. Rendered
 *  inside <ReactFlow> so useReactFlow resolves. */
export function ViewportSnap({
  req,
  activeRef,
}: {
  req: number;
  activeRef: React.MutableRefObject<boolean>;
}) {
  const { getViewport, setViewport } = useReactFlow();
  useEffect(() => {
    if (req === 0) return;
    const vp = getViewport();
    const snapped = snapViewportCrisp(vp);
    if (snapped.x === vp.x && snapped.y === vp.y && snapped.zoom === vp.zoom) return;
    activeRef.current = true;
    setViewport(snapped);
    const raf = requestAnimationFrame(() => { activeRef.current = false; });
    return () => { cancelAnimationFrame(raf); activeRef.current = false; };
  }, [req, getViewport, setViewport, activeRef]);
  return null;
}

/** Fly the viewport to a tile by id (used by chip + toast clicks + the Layers
 *  panel). Must be called inside <ReactFlow> so useReactFlow resolves.
 *  `opts.exact` forces zoom to EXACTLY 100% (minZoom = maxZoom = 1) in a SINGLE
 *  animation — used for terminal/editor/diff tiles, which are only pixel-accurate
 *  (xterm selection, DOM-text crispness) at 1:1. Doing it in one fitView avoids a
 *  second racing zoom-to-1 animation that left the tile mis-positioned. */
export function useTileFocus(): (id: string, opts?: { exact?: boolean }) => void {
  const { fitView, getNode } = useReactFlow();
  return useCallback(
    (id: string, opts?: { exact?: boolean }) => {
      // For PARENTED tiles, `n.position` is RELATIVE to the parent — setCenter
      // on relative coords pans to the wrong place. fitView resolves absolute
      // internally and handles both parented and free nodes. Same fix shape as
      // FocusOnTile / onNodeDragStop's positionAbsolute fallback.
      const n = getNode(id);
      if (!n) return;
      void fitView({
        nodes: [{ id }],
        padding: 0.3,
        duration: 400,
        maxZoom: 1,
        ...(opts?.exact ? { minZoom: 1 } : {}),
      });
    },
    [getNode, fitView],
  );
}
