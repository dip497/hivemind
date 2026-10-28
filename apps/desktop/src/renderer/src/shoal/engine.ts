/**
 * The page's side of the Shoal. It hands the canvas to the scene's worker (scene.ts), where the
 * simulation and its drawing run, and tells it what changes. What stays on the page is cheap: the
 * canvas's size, the pointer over empty canvas (at most once a frame, and only while it is there),
 * a click on the water, and what the component passes on.
 */
import ShoalWorker from "./scene?worker";
import type { FaceSource, ShoalMessage, ShoalMode } from "./scene";
import type { Box, SharkSpec } from "./world";

export type { ShoalMode };

/** Empty canvas: the pane itself, not a tile, a frame or a panel over it. */
const overWater = (e: PointerEvent) => e.target instanceof Element && e.target.classList.contains("react-flow__pane");

const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, "");

/** The page's @font-face sources for the scene's font at weight 600, latin only (the scene draws
 *  ASCII). A font installed on the computer needs none: the worker sees those as the page does. */
function facesOf(stack: string): FaceSource[] {
  const family = unquote(stack.split(",")[0] ?? "");
  const out: FaceSource[] = [];
  for (const sheet of document.styleSheets) {
    let rules: CSSRuleList;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const r of rules) {
      if (!(r instanceof CSSFontFaceRule) || unquote(r.style.getPropertyValue("font-family")) !== family) continue;
      if (!r.style.getPropertyValue("font-weight").includes("600")) continue;
      const range = r.style.getPropertyValue("unicode-range");
      if (range && !/U\+0+-0*FF\b/i.test(range)) continue;
      const base = sheet.href ?? location.href;
      const src = r.style.getPropertyValue("src").replace(/url\((["']?)([^"')]+)\1\)/g, (_m, _q, u: string) => `url("${new URL(u, base).href}")`);
      out.push({ family, src, ...(range ? { range } : {}) });
    }
  }
  return out;
}

export class ShoalEngine {
  private worker = new ShoalWorker();
  private resizeObserver: ResizeObserver;
  private running = false;
  private pointer = { x: 0, y: 0, active: false };
  private pointerQueued = false;

  constructor(private canvas: HTMLCanvasElement) {
    const font = getComputedStyle(canvas).fontFamily;
    const offscreen = canvas.transferControlToOffscreen();
    this.post({ type: "start", canvas: offscreen, font, faces: facesOf(font) }, [offscreen]);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    window.addEventListener("pointermove", this.onPointerMove, { passive: true });
    window.addEventListener("pointerdown", this.onPointerDown, { passive: true });
    window.addEventListener("blur", this.onLeave);
    document.documentElement.addEventListener("pointerleave", this.onLeave);
    this.resize();
  }

  destroy() {
    this.worker.terminate();
    this.resizeObserver.disconnect();
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("blur", this.onLeave);
    document.documentElement.removeEventListener("pointerleave", this.onLeave);
  }

  setColours(page: number, text: number) {
    this.post({ type: "colours", page, text });
  }

  setRoster(sharks: SharkSpec[]) {
    this.post({ type: "roster", sharks });
  }

  /** Where the tiles and panels are on the screen. */
  setBoxes(boxes: Box[]) {
    this.post({ type: "boxes", boxes });
  }

  /** An agent finished a turn: its shark bites. */
  finished(key: string) {
    this.post({ type: "finished", key });
  }

  setMode(mode: ShoalMode) {
    this.running = mode === "run";
    this.post({ type: "mode", mode });
  }

  private post(m: ShoalMessage, transfer: Transferable[] = []) {
    this.worker.postMessage(m, transfer);
  }

  private resize() {
    const r = this.canvas.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    this.post({ type: "size", width: r.width, height: r.height, dpr: Math.min(window.devicePixelRatio || 1, 2) });
  }

  private onPointerMove = (e: PointerEvent) => {
    if (!this.running) return;
    const active = e.pointerType !== "touch" && overWater(e);
    if (!active && !this.pointer.active) return;
    this.pointer = { x: e.clientX, y: e.clientY, active };
    if (this.pointerQueued) return;
    this.pointerQueued = true;
    requestAnimationFrame(() => {
      this.pointerQueued = false;
      this.post({ type: "pointer", ...this.pointer });
    });
  };

  private onPointerDown = (e: PointerEvent) => {
    if (this.running && e.button === 0 && overWater(e)) this.post({ type: "splash", x: e.clientX, y: e.clientY });
  };

  private onLeave = () => {
    if (!this.pointer.active) return;
    this.pointer = { ...this.pointer, active: false };
    this.post({ type: "pointer", ...this.pointer });
  };
}
