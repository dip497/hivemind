/**
 * A live wallpaper: a scene drawn in characters behind the canvas, whose creatures are the
 * workspace's agents (Shoal's sharks, Koi Pond's koi, Jellyfish's jellies, Fireflies' fireflies).
 * Each runs on the scene's own thread (worker.ts), on a canvas the page handed over; the page
 * tells it what changes (engine.ts, LiveScene.tsx). What every scene is told, and does:
 */

/** What an agent's creature does, from the agent's status: hunt (at work), cruise (ready), come up
 *  close by its tile (it needs you) or rest (stopped, failed or asleep). */
export type Mood = "hunt" | "cruise" | "surface" | "rest";

/** One agent's creature. `key` is its tile; `variant` (0 to 1) is the same for every agent of one
 *  program, and picks which kind of creature it is; `size` is relative to the biggest. */
export interface CreatureSpec {
  key: string;
  variant: number;
  size: number;
  mood: Mood;
  /** The program's id, which a package's wallpaper is told (the app's own scenes go by `variant`). */
  agent?: string | null;
}

/** A box on the screen a scene keeps its life out from under: a tile or a panel. `key` is a tile's id. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  key?: string;
}

/** The colours a scene is drawn in: the theme's page and text (0xRRGGBB), and whether it is drawn in
 *  its own colours instead of in those two. */
export interface Look {
  page: number;
  text: number;
  colour: boolean;
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
  /** The agents' creatures. `instant`, for a still picture or the first: no creature swims in or
   *  off; each is put where its mood has it. */
  setRoster(specs: CreatureSpec[], instant: boolean): void;
  /** Where the tiles (and, unless they are glass, the panels) are, and whether the tiles are
   *  see-through: a creature under a solid one is not drawn, one under a see-through one soft. */
  setBoxes(boxes: Box[], seeThrough: boolean): void;
  /** An agent finished a turn well: its creature shows it. */
  finished(key: string): void;
  pointer(x: number, y: number, active: boolean): void;
  /** A click on the water. */
  splash(x: number, y: number): void;
  /** The agent whose creature is at (x, y) now, or null: the app shows its name there, and a click
   *  goes to its tile. */
  creatureAt(x: number, y: number): string | null;
  /** The simulation, `dt` seconds on. */
  step(dt: number): void;
  /** Draw it as it is; `dt` for what fades with time. */
  draw(dt: number): void;
}
