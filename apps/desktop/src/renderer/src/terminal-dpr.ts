import type { Terminal } from "@xterm/xterm";

/**
 * Per-instance device-pixel-ratio override for the xterm WebGL renderer — the
 * technique opencove uses to get crisp terminal text, ported + adapted.
 *
 * xterm's WebGL renderer rasterizes each glyph into a texture atlas at
 * `cellPx × devicePixelRatio` device pixels and has no public per-instance DPR
 * knob (it reads `window.devicePixelRatio` through its internal
 * `_coreBrowserService.dpr`). On a HiDPI display (DPR≥2) that's already dense
 * enough to look crisp — which is why opencove (whose users are mostly on retina
 * Macs) looks sharp with a plain `window.devicePixelRatio` policy. On a DPR=1
 * display the atlas is rasterized at 1× and small mono glyphs come out thin/soft,
 * and the react-flow canvas zoom only makes it worse.
 *
 * Fix: override the internal `dpr` getter with a SUPERSAMPLE FLOOR so the atlas
 * is always rasterized at ≥2× device pixels, then fire xterm's DPR-change so it
 * re-rasterizes. The WebGL canvas keeps its logical CSS size, so the dense
 * backing is downsampled to the display — supersampled, crisp at zoom 1, and it
 * survives the canvas zoom-transform far better than a 1× atlas. No CSS scaling,
 * no PTY reflow, no mouse-mapping drift (the host element is untouched).
 *
 * On HiDPI the floor is a no-op (base DPR already ≥2), so we never *lower* a
 * display's native density. The override is reverted on dispose.
 */
const SUPERSAMPLE_FLOOR = 2;
const EPS = 0.001;

/** The DPR we want the renderer to rasterize at: the display's own ratio, but
 *  never below the supersample floor (so DPR=1 screens get retina-class glyphs). */
export function effectiveDpr(baseDpr: number): number {
  const base = Number.isFinite(baseDpr) && baseDpr > 0 ? baseDpr : 1;
  return Math.max(base, SUPERSAMPLE_FLOOR);
}

type InternalTerminal = Terminal & {
  _core?: {
    _coreBrowserService?: Record<string, unknown> & {
      _onDprChange?: { fire?: (value: number) => void };
    };
    _renderService?: { handleDevicePixelRatioChange?: () => void };
  };
};

/**
 * Install the crisp-DPR override on a terminal whose renderer is already loaded
 * (call AFTER term.open() + loadAddon(webgl)). Returns a disposer that restores
 * the original `dpr` property. No-op (returns a noop disposer) if the internal
 * render path isn't present — guards against xterm version drift, never throws.
 */
export function installCrispDpr(terminal: Terminal): () => void {
  const t = terminal as InternalTerminal;
  const cbs = t._core?._coreBrowserService;
  const rs = t._core?._renderService;
  // Without the core-browser service + a render-service DPR hook there's nothing
  // to override or to trigger a re-rasterize — bail to the native behavior.
  if (!cbs || typeof rs?.handleDevicePixelRatioChange !== "function") return () => {};

  const win = terminal.element?.ownerDocument?.defaultView ?? window;
  const hadOwn = Object.prototype.hasOwnProperty.call(cbs, "dpr");
  const prevDesc = hadOwn ? (Object.getOwnPropertyDescriptor(cbs, "dpr") ?? null) : null;

  let applied = -1;
  const apply = () => {
    try {
      const next = effectiveDpr(win?.devicePixelRatio ?? 1);
      if (Math.abs(next - applied) < EPS) return; // idempotent — never re-fires for same DPR
      applied = next;
      // Replace the getter so every reader (incl. the render service) sees our DPR.
      Object.defineProperty(cbs, "dpr", { configurable: true, get: () => next });
      // Notify xterm so it recomputes device cell dimensions + rebuilds the atlas.
      // Wrapped: a renderer hiccup here must never bubble into a resize handler.
      const emitter = cbs._onDprChange;
      if (typeof emitter?.fire === "function") emitter.fire(next);
      else rs.handleDevicePixelRatioChange?.();
    } catch { /* renderer torn down / version drift — leave native dpr in place */ }
  };
  apply();

  // The display's real DPR can change at runtime (drag the window to another
  // monitor, OS scale change) — Chromium signals that via a window resize.
  const onResize = () => apply();
  win?.addEventListener("resize", onResize);

  return () => {
    win?.removeEventListener("resize", onResize);
    if (hadOwn && prevDesc) Object.defineProperty(cbs, "dpr", prevDesc);
    else Reflect.deleteProperty(cbs, "dpr");
  };
}
