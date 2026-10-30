/**
 * What a live wallpaper a package ships is told of the workspace, in the page's words before the
 * link (`plugin-engine.ts`) puts it in live wallpaper protocol 1's: each agent's creature, where the
 * tiles are, the colours, and whether to run. A wallpaper may draw the agents, or a world of its own
 * that ignores them (the Live scenes package does).
 */

/** What an agent's creature does, from the agent's status: hunt (at work), cruise (ready), come up
 *  close by its tile (it needs you) or rest (stopped, failed or asleep). */
export type Mood = "hunt" | "cruise" | "surface" | "rest";

/** One agent's creature. `key` is its tile; `variant` (0 to 1) is the same for every agent of one
 *  program; `size` is relative to the biggest. */
export interface CreatureSpec {
  key: string;
  variant: number;
  size: number;
  mood: Mood;
  /** The program's id. */
  agent?: string | null;
}

/** A box on the screen: a tile or a panel. `key` is a tile's id. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  key?: string;
}

/** The theme's page and text colours (0xRRGGBB), and the person's **Colour** switch, for a wallpaper
 *  that draws in colours of its own. */
export interface Look {
  page: number;
  text: number;
  colour: boolean;
}

/** `run` animates; `hold` keeps the last frame (paused); `still` shows one settled frame (motion off). */
export type SceneMode = "run" | "hold" | "still";
