/**
 * The page's side of a live wallpaper, whoever draws it: the app's own scene on its worker
 * (engine.ts) or a package's in a sandboxed frame (plugin-engine.ts). What every one gets from the
 * page is here once: its size and pixel ratio, the pointer over empty canvas (at most once a frame,
 * and only while it is there), a click on the water, and which creature is under the pointer, which
 * the scene says. A click on that creature goes to its agent's tile; anywhere else, the water is the
 * scene's to answer.
 *
 * What a scene says is under the pointer counts only while the pointer is over the water, and its
 * name goes with the pointer: a click can open only the agent named where the person clicks.
 */
import type { Box, CreatureSpec, Look, SceneMode } from "./scene";

/** The colours a scene is drawn in, with what a package's wallpaper is also told: the theme's
 *  "needs you" colour (0xRRGGBB), whether the theme is dark, and the terminals' font. */
export interface PageLook extends Look {
  attention: number;
  dark: boolean;
  mono: string;
}

/** What a scene tells the component that shows it. */
export interface SceneEvents {
  /** The creature under the pointer, and where the pointer is; null when there is none. */
  hover(key: string | null, at: { x: number; y: number }): void;
  /** The pointer moved while over that creature (at most once a frame). */
  move(at: { x: number; y: number }): void;
  /** A click landed on this creature: go to its agent. */
  open(key: string): void;
  /** It misbehaved and is off for the session (a package's wallpaper). */
  disable?(reason: string): void;
}

/** What the component drives, whoever draws the scene. */
export interface SceneEngine {
  setLook(look: PageLook): void;
  fontChanged(): void;
  setRoster(creatures: CreatureSpec[]): void;
  /** Where the tiles and panels are on the screen, and whether the tiles are see-through. */
  setBoxes(boxes: Box[], seeThrough: boolean): void;
  /** An agent finished a turn: its creature shows it. */
  finished(key: string): void;
  setMode(mode: SceneMode): void;
  destroy(): void;
}

/** Empty canvas: the pane itself, not a tile, a frame or a panel over it. */
const overWater = (e: PointerEvent) => e.target instanceof Element && e.target.classList.contains("react-flow__pane");

/** A press that moved further than this is a pan, not a click. */
const CLICK_SLOP = 5;

export abstract class PageScene implements SceneEngine {
  protected mode: SceneMode = "hold";
  private pointer = { x: 0, y: 0, active: false };
  private pointerQueued = false;
  private hovered: string | null = null;
  /** A press on a creature, kept until it is a click (or a pan). */
  private press: { key: string; x: number; y: number } | null = null;
  private resizeObserver: ResizeObserver;
  private stopRatio = () => {};

  /** `surface` is what the scene draws on, whose size it is told. */
  constructor(protected readonly host: HTMLElement, protected readonly surface: HTMLElement, protected readonly events: SceneEvents) {
    host.appendChild(surface);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(surface);
    window.addEventListener("pointermove", this.onPointerMove, { passive: true });
    window.addEventListener("pointerdown", this.onPointerDown, { passive: true });
    window.addEventListener("click", this.onClick);
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
    window.removeEventListener("click", this.onClick);
    window.removeEventListener("blur", this.onLeave);
    document.documentElement.removeEventListener("pointerleave", this.onLeave);
    if (this.hovered) this.hover(null);
  }

  setMode(mode: SceneMode) {
    this.mode = mode;
    this.sendMode(mode);
    // Held: the window is away or covered, and nothing under the pointer is shown.
    if (mode === "hold") this.onLeave();
  }

  abstract setLook(look: PageLook): void;
  abstract fontChanged(): void;
  abstract setRoster(creatures: CreatureSpec[]): void;
  abstract setBoxes(boxes: Box[], seeThrough: boolean): void;
  abstract finished(key: string): void;
  protected abstract sendMode(mode: SceneMode): void;
  protected abstract sendSize(width: number, height: number, dpr: number): void;
  protected abstract sendPointer(x: number, y: number, active: boolean): void;
  /** A click on the water, and the creature it opened, if any. */
  protected abstract sendClick(x: number, y: number, opened: string | null): void;

  /** The scene says which creature is under the pointer: none, while the pointer is not over the water. */
  protected hover(key: string | null) {
    if (!this.pointer.active) key = null;
    if (key === this.hovered) return;
    this.hovered = key;
    this.events.hover(key, { x: this.pointer.x, y: this.pointer.y });
  }

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
    // Onto a tile or a panel: no creature is under the pointer there, whatever the scene says next.
    if (!active && this.hovered) this.hover(null);
    if (!active && !this.pointer.active) return;
    this.pointer = { x: e.clientX, y: e.clientY, active };
    if (this.pointerQueued) return;
    this.pointerQueued = true;
    requestAnimationFrame(() => {
      this.pointerQueued = false;
      this.sendPointer(this.pointer.x, this.pointer.y, this.pointer.active);
      if (this.hovered) this.events.move({ x: this.pointer.x, y: this.pointer.y });
    });
  };

  // Over a creature, a press waits to be a click; anywhere else on the water it ripples at once.
  private onPointerDown = (e: PointerEvent) => {
    this.press = null;
    if (this.mode === "hold" || e.button !== 0 || !overWater(e)) return;
    if (this.hovered) this.press = { key: this.hovered, x: e.clientX, y: e.clientY };
    else this.sendClick(e.clientX, e.clientY, null);
  };

  // After the canvas has had the click (which clears its selection), so going to the tile stays.
  private onClick = (e: MouseEvent) => {
    const p = this.press;
    this.press = null;
    if (!p || Math.hypot(e.clientX - p.x, e.clientY - p.y) > CLICK_SLOP) return;
    this.sendClick(e.clientX, e.clientY, p.key);
    this.events.open(p.key);
  };

  private onLeave = () => {
    this.press = null;
    if (this.hovered) this.hover(null);
    if (!this.pointer.active) return;
    this.pointer = { ...this.pointer, active: false };
    this.sendPointer(this.pointer.x, this.pointer.y, false);
  };
}
