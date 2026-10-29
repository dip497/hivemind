/** Shoal: fish and sharks in characters, one shark per agent. */
import type { LiveScene } from "../scene";
import { SwimScene } from "../swim-scene";
import { World } from "../world";
import { ShoalRenderer } from "./render";
import type { SharkKind } from "./shapes";

/** Which shark each program's agents are: a `variant` of 0 to 1 picks one. */
const KINDS: SharkKind[] = ["classic", "hammerhead", "tiger", "mako", "thresher", "zebra", "greathammer", "nurse"];

export const shoalScene = (canvas: OffscreenCanvas): LiveScene => new SwimScene(new World(), new ShoalRenderer(canvas), KINDS);
