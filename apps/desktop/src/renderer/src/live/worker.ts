/**
 * A live wallpaper's own thread. Its scene's simulation and drawing run here, on the canvas the
 * page handed over, so the renderer's main thread, where every terminal draws, never waits on them.
 * The page tells it which scene, and what changes: the canvas's size, the theme's colours, the
 * agents' creatures, where the tiles are, the pointer over the water, and whether to run, hold the
 * last frame or show one settled frame.
 */
import type { LiveSceneId } from "@hivemind/core/settings-schema";
import { SCENE_STEP, SETTLE_STEPS, sceneClock } from "@hivemind/view-sdk/wallpaper";
import type { Box, CreatureSpec, LiveScene, Look, SceneMode } from "./scene";
import { firefliesScene } from "./fireflies/scene";
import { jellyScene } from "./jelly/scene";
import { koiScene } from "./koi/scene";
import { shoalScene } from "./shoal/scene";

/** The scenes there are, by the id the settings keep. */
const SCENES: Record<LiveSceneId, (canvas: OffscreenCanvas) => LiveScene> = {
  shoal: shoalScene,
  koi: koiScene,
  jellyfish: jellyScene,
  fireflies: firefliesScene,
};
export type SceneId = LiveSceneId;

/** One of the page's font faces for the scene's characters: a worker sees none of the page's web fonts. */
export interface FaceSource {
  family: string;
  src: string;
  weight: string;
  range?: string;
}

export type SceneMessage =
  | { type: "start"; scene: SceneId; canvas: OffscreenCanvas; font: string; faces: FaceSource[] }
  | { type: "font"; font: string; faces: FaceSource[] }
  | { type: "size"; width: number; height: number; dpr: number }
  | { type: "look"; look: Look }
  | { type: "roster"; creatures: CreatureSpec[] }
  | { type: "boxes"; boxes: Box[]; seeThrough: boolean }
  | { type: "finished"; key: string }
  | { type: "mode"; mode: SceneMode }
  | { type: "pointer"; x: number; y: number; active: boolean }
  /** A click on the water, and the creature it opened (the one under the pointer), if any: open
   *  water ripples, a creature's agent is gone to. */
  | { type: "click"; x: number; y: number; opened: string | null };

/** What the scene tells the page: the creature under the pointer, when that changes. */
export type SceneAnswer = { type: "hover"; key: string | null };

const scope = self as unknown as {
  fonts?: FontFaceSet;
  onmessage: ((e: MessageEvent<SceneMessage>) => void) | null;
  postMessage(m: SceneAnswer): void;
};

let scene: LiveScene | null = null;
/** The agents' creatures as last told, for a still picture made again from scratch. */
let roster: CreatureSpec[] = [];
/** Whether the scene has had its creatures: the first are already in the water when it starts. */
let stocked = false;
/** The pointer over the water, and the creature under it as last said. */
let pointer = { x: 0, y: 0, active: false };
let hovered: string | null = null;

/** Say which creature is under the pointer when that changes: one swims in under it, or away. */
function hover() {
  const key = pointer.active && scene ? scene.creatureAt(pointer.x, pointer.y) : null;
  if (key === hovered) return;
  hovered = key;
  scope.postMessage({ type: "hover", key });
}

/** The clock every live wallpaper runs on (the SDK's): 30 frames a second while running, nothing
 *  while held, and for motion off the creatures put where their moods have them and the scene let
 *  settle, then that one frame. */
const clock = sceneClock({
  step: (dt) => scene?.step(dt),
  draw: (dt) => {
    scene?.draw(dt);
    if (pointer.active) hover();
  },
  settle: () => {
    if (!scene) return;
    scene.setRoster(roster, true);
    for (let i = 0; i < SETTLE_STEPS; i++) scene.step(SCENE_STEP);
  },
});
const draw = () => scene?.draw(SCENE_STEP);

async function loadFaces(faces: FaceSource[]) {
  const fonts = scope.fonts;
  if (!fonts) return;
  await Promise.all(faces.map(async (f) => {
    const face = new FontFace(f.family, f.src, { weight: f.weight, ...(f.range ? { unicodeRange: f.range } : {}) });
    fonts.add(face);
    await face.load().catch(() => {});
  }));
  if (clock.mode !== "run") draw();
}

scope.onmessage = ({ data: m }) => {
  switch (m.type) {
    case "start":
      scene = SCENES[m.scene](m.canvas);
      scene.setFontFamily(m.font);
      void loadFaces(m.faces);
      break;
    case "font":
      scene?.setFontFamily(m.font);
      void loadFaces(m.faces);
      draw();
      break;
    case "size":
      scene?.resize(m.width, m.height, m.dpr);
      // Resizing clears the canvas: draw now, not at the next paced frame, so it never shows blank.
      draw();
      break;
    case "look":
      scene?.setLook(m.look);
      if (clock.mode !== "run") draw();
      break;
    case "roster":
      roster = m.creatures;
      // The agents there when the scene starts are in the water already; one started later swims
      // in. In a still picture only what changed moves: a creature comes, goes or comes up to its tile.
      scene?.setRoster(m.creatures, clock.mode === "still" || !stocked);
      stocked = true;
      if (hovered && !m.creatures.some((c) => c.key === hovered)) hover();
      if (clock.mode !== "run") draw();
      break;
    case "boxes":
      scene?.setBoxes(m.boxes, m.seeThrough);
      // A still picture shows the tiles where they are now.
      if (clock.mode === "still") draw();
      break;
    case "finished":
      if (clock.mode === "run") scene?.finished(m.key);
      break;
    case "mode":
      clock.setMode(m.mode);
      if (m.mode === "hold") { pointer = { ...pointer, active: false }; hover(); }
      break;
    case "pointer":
      // The creatures shy from it only while they move; which one it is over, whenever it is shown.
      pointer = { x: m.x, y: m.y, active: m.active };
      scene?.pointer(m.x, m.y, m.active && clock.mode === "run");
      hover();
      break;
    case "click":
      if (!m.opened && clock.mode === "run") scene?.splash(m.x, m.y);
      break;
  }
};
