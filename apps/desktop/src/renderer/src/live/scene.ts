/**
 * A live wallpaper: a scene drawn in characters behind the canvas, a world of its own (Shoal's sea,
 * Koi Pond's pond, Jellyfish's deep, Fireflies' meadow) whose life goes on by itself and plays with
 * the pointer. It knows nothing of the workspace: not its agents, not where its tiles are; the tiles
 * sit on top of it. Each runs on the scene's own thread (worker.ts), on a canvas the page handed
 * over; the page tells it what changes (engine.ts, LiveWallpaper.tsx). What every scene is told, and
 * does:
 */

/** The theme's page and text colours (0xRRGGBB). A scene draws in its own colours, a light or a dark
 *  version of them by the page's. */
export interface Look {
  page: number;
  text: number;
}

/** `run` animates; `hold` keeps the last frame (paused); `still` shows one settled frame (motion off). */
export type SceneMode = "run" | "hold" | "still";

export interface LiveScene {
  /** The cell the scene draws in, after `resize`. */
  readonly cellWidth: number;
  readonly cellHeight: number;
  resize(width: number, height: number, dpr: number): void;
  setLook(look: Look): void;
  setFontFamily(family: string): void;
  /** The pointer over empty canvas (`active`), or gone from it: what lives there notices it. */
  pointer(x: number, y: number, active: boolean): void;
  /** A click on empty canvas: the scene answers it (a ripple, food dropped, a scatter). */
  splash(x: number, y: number): void;
  /** The simulation, `dt` seconds on. A still picture is a few seconds of it, from where it is. */
  step(dt: number): void;
  /** Draw it as it is; `dt` for what fades with time. */
  draw(dt: number): void;
}
