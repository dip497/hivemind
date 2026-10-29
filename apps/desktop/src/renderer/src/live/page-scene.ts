/**
 * The page's side of a live wallpaper, whoever draws it: the app's own scene on its worker
 * (engine.ts) or a package's in a sandboxed frame (plugin-engine.ts). What every one gets from the
 * page is here once: its size and pixel ratio, the pointer over empty canvas (at most once a frame,
 * and only while it is there) and a click there, to play with. Nothing else of the workspace.
 */
import type { Look, SceneMode } from "./scene";

/** The colours a scene is drawn in, with what a package's wallpaper is also told: whether the
 *  theme is dark, and the terminals' font. */
export interface PageLook extends Look {
  dark: boolean;
  mono: string;
}

/** What a scene tells the component that shows it. */
export interface SceneEvents {
  /** It misbehaved and is off for the session (a package's wallpaper). */
  disable?(reason: string): void;
}

/** What the component drives, whoever draws the scene. */
export interface SceneEngine {
  setLook(look: PageLook): void;
  fontChanged(): void;
  setMode(mode: SceneMode): void;
  destroy(): void;
}

/** Empty canvas: the pane itself, not a tile, a frame or a panel over it. */
const overWater = (e: PointerEvent) => e.target instanceof Element && e.target.classList.contains("react-flow__pane");

export abstract class PageScene implements SceneEngine {
  protected mode: SceneMode = "hold";
  private pointer = { x: 0, y: 0, active: false };
  private pointerQueued = false;
  private resizeObserver: ResizeObserver;
  private stopRatio = () => {};

  /** `surface` is what the scene draws on, whose size it is told. */
  constructor(protected readonly host: HTMLElement, protected readonly surface: HTMLElement, protected readonly events: SceneEvents) {
    host.appendChild(surface);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(surface);
    window.addEventListener("pointermove", this.onPointerMove, { passive: true });
    window.addEventListener("pointerdown", this.onPointerDown, { passive: true });
    window.addEventListener("blur", this.onLeave);
    document.documentElement.addEventListener("pointerleave", this.onLeave);
    this.watchRatio();
  }

  destroy() {
    this.resizeObserver.disconnect();
    this.stopRatio();
    this.surface.remove();
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("blur", this.onLeave);
    document.documentElement.removeEventListener("pointerleave", this.onLeave);
  }

  setMode(mode: SceneMode) {
    this.mode = mode;
    this.sendMode(mode);
    // Held: the window is away or covered, and the pointer is not over the scene.
    if (mode === "hold") this.onLeave();
  }

  abstract setLook(look: PageLook): void;
  abstract fontChanged(): void;
  protected abstract sendMode(mode: SceneMode): void;
  protected abstract sendSize(width: number, height: number, dpr: number): void;
  protected abstract sendPointer(x: number, y: number, active: boolean): void;
  protected abstract sendClick(x: number, y: number): void;

  protected resize() {
    const r = this.surface.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    this.sendSize(r.width, r.height, Math.min(window.devicePixelRatio || 1, 2));
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

  private onPointerMove = (e: PointerEvent) => {
    if (this.mode === "hold") return;
    const active = e.pointerType !== "touch" && overWater(e);
    if (!active && !this.pointer.active) return;
    this.pointer = { x: e.clientX, y: e.clientY, active };
    if (this.pointerQueued) return;
    this.pointerQueued = true;
    requestAnimationFrame(() => {
      this.pointerQueued = false;
      this.sendPointer(this.pointer.x, this.pointer.y, this.pointer.active);
    });
  };

  // A press on empty canvas is the scene's to answer at once (a ripple, a scatter); the canvas
  // still has it too (a pan, clearing the selection).
  private onPointerDown = (e: PointerEvent) => {
    if (this.mode === "hold" || e.button !== 0 || !overWater(e)) return;
    this.sendClick(e.clientX, e.clientY);
  };

  private onLeave = () => {
    if (!this.pointer.active) return;
    this.pointer = { ...this.pointer, active: false };
    this.sendPointer(this.pointer.x, this.pointer.y, false);
  };
}
