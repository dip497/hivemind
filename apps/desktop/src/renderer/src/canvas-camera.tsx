/**
 * Canvas "camera" subsystem — viewport focus / fit / pan-inertia / crisp-snap.
 * These are all tiny components (or one hook) rendered INSIDE <ReactFlow> so the
 * `useReactFlow` hooks resolve; each is driven by a nonce/`req` prop bumped by
 * Canvas. Pure presentational adapters with no Canvas state — extracted to keep
 * Canvas.tsx focused on orchestration.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useReactFlow, useStoreApi } from "@xyflow/react";
import { cameraFor, roomLeftOfCards } from "./camera-fit";
import { useChromeState } from "./workspace/chrome-store";
import { widgetBand } from "./board-objects/widget-band";
import { tilePlugin } from "./tiles";

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
// Text/terminal tiles are crisp + mouse-accurate only at exactly 100% on a DPR=1
// panel (no supersample — see terminal-dpr.ts). So `.` focus PINS them to 100%
// (centered; sharp). Non-text tiles (issues/browser/planReview) zoom-to-fill.
// (A full-screen-CRISP maximize would have to grow the tile's rows/cols rather
// than zoom — that fought the frame layout and is deferred.)
// A browser tile is an out-of-process <webview>: once the canvas is still, the tile redraws its
// page at the canvas zoom and shrinks it back by the same amount (BrowserTile), so it is sharp at
// any zoom. While the canvas moves it shows the last drawing, stretched.
/** One camera move between tiles: a straight, short ease-out. The default "smooth" path zooms
 *  out mid-flight and back in, so going terminal to terminal at 100% dipped, blurred every
 *  terminal and took 400ms. Reduced motion jumps. */
const reduceMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
export const FLY = {
  duration: reduceMotion ? 0 : 220,
  interpolate: "linear" as const,
  ease: (t: number) => 1 - (1 - t) ** 3,
};

/** Camera moves, counted by the canvas: a flight from the moment it is asked for, a gesture as it
 *  starts. Work asked for after a move (the crisp snap) stands down if another has begun since,
 *  since it would cut that one short. Provided by the canvas around its <ReactFlow>. */
export const CameraMoves = createContext<{ current: number }>({ current: 0 });

/** The react-flow camera's flights, each counted in CameraMoves when it is asked for: its
 *  move-start comes only once it begins, which can be a while. */
export function useCamera() {
  const { fitView, setCenter, zoomTo, zoomIn, zoomOut } = useReactFlow();
  const moves = useContext(CameraMoves);
  return useMemo(() => {
    const fly = <A extends unknown[], R>(f: (...a: A) => R) => (...a: A): R => { moves.current++; return f(...a); };
    return { fitView: fly(fitView), setCenter: fly(setCenter), zoomTo: fly(zoomTo), zoomIn: fly(zoomIn), zoomOut: fly(zoomOut) };
  }, [moves, fitView, setCenter, zoomTo, zoomIn, zoomOut]);
}

export function FocusMode({ req }: { req: { id: string | null; n: number } | null }) {
  const { getNode } = useReactFlow();
  const { fitView } = useCamera();
  useEffect(() => {
    if (!req) return;
    if (req.id) {
      const plugin = tilePlugin(getNode(req.id)?.type ?? "");
      const exact = !!plugin && Object.values(plugin.kinds).some((k) => k.wholePixels);
      void fitView({
        nodes: [{ id: req.id }],
        padding: 0.05,
        ...FLY,
        ...(exact ? { minZoom: 1, maxZoom: 1 } : { maxZoom: 1.6 }),
      });
    } else {
      void fitView({ padding: 0.2, ...FLY });
    }
  }, [req, fitView, getNode]);
  return null;
}

/** The requests a canvas has flown: a canvas mounted later flies only one still waiting, as one
 *  asked for from another view is. */
const flown = new WeakSet<object>();

/** Flies the camera to the box a `flyTo` asked for, whole and in the middle of the room the
 *  widget cards and the tool island leave, once the pane is measured. The box comes from state, so
 *  nothing needs measuring first. Rendered inside <ReactFlow>. */
export function FocusOnTile({
  req,
}: {
  req: { id: string; cx: number; cy: number; w?: number; h?: number; n: number; exact?: boolean } | null;
}) {
  const { setCenter } = useCamera();
  const flow = useStoreApi();
  const chrome = useChromeState();
  const chromeRef = useRef(chrome);
  chromeRef.current = chrome;
  useEffect(() => {
    if (!req || flown.has(req)) return undefined;
    // Read when asked, as the pane size is: the cards or the window moving must not re-fly an old request.
    const fly = () => {
      flown.add(req);
      const { width: paneW, height: paneH, domNode } = flow.getState();
      const pane = domNode?.getBoundingClientRect();
      const band = widgetBand();
      const paneRight = pane?.right ?? window.innerWidth;
      const roomW = band.edge === "right" && paneW > 0 ? roomLeftOfCards(paneW, band.width, window.innerWidth - paneRight) : paneW;
      const { topInset, bottomInset } = chromeRef.current;
      const top = Math.max(0, topInset - (pane?.top ?? 0));
      const bottom = Math.max(0, bottomInset - (window.innerHeight - (pane?.bottom ?? window.innerHeight)));
      const w = req.w ?? 0;
      const h = req.h ?? 0;
      const cam = cameraFor({ x: req.cx - w / 2, y: req.cy - h / 2, w, h }, { paneW, paneH, roomW, top, bottom }, !!req.exact);
      void setCenter(cam.x, cam.y, { zoom: cam.zoom, ...FLY });
    };
    const ready = () => { const s = flow.getState(); return s.width > 0 && s.height > 0 && !!s.panZoom; };
    if (ready()) { fly(); return undefined; }
    const stop = flow.subscribe(() => { if (ready()) { stop(); fly(); } });
    return stop;
  }, [req, setCenter, flow]);
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

/** Snaps the LIVE viewport transform to whole device pixels (and a near-1 zoom
 *  to exactly 1) whenever the canvas asks (`ask`) — the real fix for blurry tiles under the
 *  CSS-transformed viewport (xyflow#3282). `activeRef` (shared with the fling)
 *  tells the parent's onMove/onMoveEnd to ignore our own setViewport. Rendered
 *  inside <ReactFlow> so useReactFlow resolves. An instant setViewport cuts a flight
 *  short, so a move started after the request (`moveSeq` past the ask's) wins: its own
 *  end asks again. */
export function ViewportSnap({
  ask,
  moveSeq,
  activeRef,
}: {
  /** Set here to what asks for a snap: the ask is this component's state, so it re-renders alone. */
  ask: React.MutableRefObject<() => void>;
  moveSeq: React.MutableRefObject<number>;
  activeRef: React.MutableRefObject<boolean>;
}) {
  const { getViewport, setViewport } = useReactFlow();
  const [req, setReq] = useState<{ n: number; seq: number } | null>(null);
  useEffect(() => {
    ask.current = () => setReq((r) => ({ n: (r?.n ?? 0) + 1, seq: moveSeq.current }));
    return () => { ask.current = () => {}; };
  }, [ask, moveSeq]);
  useEffect(() => {
    if (!req || moveSeq.current !== req.seq) return;
    const vp = getViewport();
    const snapped = snapViewportCrisp(vp);
    if (snapped.x === vp.x && snapped.y === vp.y && snapped.zoom === vp.zoom) return;
    activeRef.current = true;
    setViewport(snapped);
    const raf = requestAnimationFrame(() => { activeRef.current = false; });
    return () => { cancelAnimationFrame(raf); activeRef.current = false; };
  }, [req, moveSeq, getViewport, setViewport, activeRef]);
  return null;
}
