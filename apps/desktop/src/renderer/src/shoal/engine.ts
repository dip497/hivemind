/**
 * The page's side of the Shoal. It puts a canvas in its host, hands it to the scene's worker
 * (scene.ts), where the simulation and its drawing run, and tells it what changes. What stays on
 * the page is cheap: the canvas's size and pixel ratio, the font, the pointer over empty canvas (at
 * most once a frame, and only while it is there), a click on the water, and what the component
 * passes on. Each engine makes its own canvas: one can be handed to a worker only once.
 */
import ShoalWorker from "./scene?worker";
import type { FaceSource, ShoalMessage, ShoalMode } from "./scene";
import type { Box, SharkSpec } from "./world";

export type { ShoalMode };

/** Empty canvas: the pane itself, not a tile, a frame or a panel over it. */
const overWater = (e: PointerEvent) => e.target instanceof Element && e.target.classList.contains("react-flow__pane");

const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, "");

const weightOf = (w: string) => (w === "bold" ? 700 : w === "normal" || w === "" ? 400 : Number(w));

/** The page's @font-face sources for the scene's font, latin only (the scene draws ASCII): its faces
 *  that cover weight 600, which the scene draws in, else all it has (the nearest is used). A font
 *  installed on the computer needs none: the worker sees those as the page does. */
function facesOf(stack: string): FaceSource[] {
  const family = unquote(stack.split(",")[0] ?? "");
  const all: (FaceSource & { bold: boolean })[] = [];
  for (const sheet of document.styleSheets) {
    let rules: CSSRuleList;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const r of rules) {
      if (!(r instanceof CSSFontFaceRule) || unquote(r.style.getPropertyValue("font-family")) !== family) continue;
      const range = r.style.getPropertyValue("unicode-range");
      if (range && !/U\+0+-0*FF\b/i.test(range)) continue;
      const weight = r.style.getPropertyValue("font-weight").trim() || "normal";
      const [lo = 400, hi = lo] = weight.split(/\s+/).map(weightOf);
      const base = sheet.href ?? location.href;
      const src = r.style.getPropertyValue("src").replace(/url\((["']?)([^"')]+)\1\)/g, (_m, _q, u: string) => `url("${new URL(u, base).href}")`);
      all.push({ family, src, weight, bold: lo <= 600 && 600 <= hi, ...(range ? { range } : {}) });
    }
  }
  const at600 = all.filter((f) => f.bold);
  return (at600.length ? at600 : all).map(({ bold: _bold, ...f }) => f);
}

export class ShoalEngine {
  private worker = new ShoalWorker();
  private canvas = document.createElement("canvas");
  private font: string;
  private resizeObserver: ResizeObserver;
  private running = false;
  private pointer = { x: 0, y: 0, active: false };
  private pointerQueued = false;
  private stopRatio = () => {};

  constructor(private host: HTMLElement) {
    host.appendChild(this.canvas);
    this.font = getComputedStyle(host).fontFamily;
    const offscreen = this.canvas.transferControlToOffscreen();
    this.post({ type: "start", canvas: offscreen, font: this.font, faces: facesOf(this.font) }, [offscreen]);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas);
    window.addEventListener("pointermove", this.onPointerMove, { passive: true });
    window.addEventListener("pointerdown", this.onPointerDown, { passive: true });
    window.addEventListener("blur", this.onLeave);
    document.documentElement.addEventListener("pointerleave", this.onLeave);
    this.watchRatio();
    this.resize();
  }

  destroy() {
    this.worker.terminate();
    this.resizeObserver.disconnect();
    this.stopRatio();
    this.canvas.remove();
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("blur", this.onLeave);
    document.documentElement.removeEventListener("pointerleave", this.onLeave);
  }

  /** The terminal's font changed (Settings): the scene's characters follow it. */
  fontChanged() {
    const font = getComputedStyle(this.host).fontFamily;
    if (font === this.font) return;
    this.font = font;
    this.post({ type: "font", font, faces: facesOf(font) });
  }

  setColours(page: number, text: number) {
    this.post({ type: "colours", page, text });
  }

  setRoster(sharks: SharkSpec[]) {
    this.post({ type: "roster", sharks });
  }

  /** Where the tiles and panels are on the screen, and whether the tiles are see-through. */
  setBoxes(boxes: Box[], seeThrough: boolean) {
    this.post({ type: "boxes", boxes, seeThrough });
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

  /** A window moved to a screen of another pixel ratio is not resized: watch the ratio itself. */
  private watchRatio() {
    const ratio = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    const changed = () => {
      this.resize();
      this.watchRatio();
    };
    ratio.addEventListener("change", changed, { once: true });
    this.stopRatio = () => ratio.removeEventListener("change", changed);
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
