/** Koi Pond: koi under lily pads, one koi per agent, and fry darting between them. The World
 *  swims them as it does Shoal's sharks; the renderer draws the pond. */
import type { LiveScene } from "../scene";
import type { Species } from "../species";
import { SwimScene } from "../swim-scene";
import { World } from "../world";
import { KoiRenderer } from "./render";
import { KOI_KINDS } from "./shapes";

/** The pond's small fish: fry in loose schools, and medaka, which wander. */
const FRY: Species[] = [
  {
    name: "fry",
    cruise: 30, maxSpeed: 58, minSpeed: 12, weight: 2,
    schoolSize: [8, 14], spacing: [1.6, 1.1],
    align: 2.2, cohesion: 1.2, jitter: 40, mill: 0, verticalDrag: 0.8,
  },
  {
    name: "medaka",
    cruise: 24, maxSpeed: 50, minSpeed: 10, weight: 1,
    schoolSize: [5, 9], spacing: [1.8, 1.2],
    align: 1.1, cohesion: 1, jitter: 70, mill: 0, verticalDrag: 0.6,
  },
];

/** Koi are smaller than sharks against the window, and the pond holds a third of the fish. */
export const koiScene = (canvas: OffscreenCanvas): LiveScene =>
  new SwimScene(new World({ share: 0.24, species: FRY, fishArea: 14000 }), new KoiRenderer(canvas), KOI_KINDS);
