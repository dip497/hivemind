/**
 * A live wallpaper's own thread. Its scene's simulation and drawing run here, on the canvas the
 * page handed over, so the renderer's main thread, where every terminal draws, never waits on them.
 * The page tells it which scene, and what changes: the canvas's size, the theme's colours, the font,
 * the pointer over empty canvas and a click there, and whether to run, hold the last frame or show
 * one settled frame.
 */
import type { LiveSceneId } from "@hivemind/core/settings-schema";
import { SCENE_STEP, SETTLE_STEPS, sceneClock } from "@hivemind/view-sdk/wallpaper";
import type { LiveScene, Look, SceneMode } from "./scene";
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
  | { type: "mode"; mode: SceneMode }
  | { type: "pointer"; x: number; y: number; active: boolean }
  | { type: "click"; x: number; y: number };

const scope = self as unknown as {
  fonts?: FontFaceSet;
  onmessage: ((e: MessageEvent<SceneMessage>) => void) | null;
};

let scene: LiveScene | null = null;

/** The clock every live wallpaper runs on (the SDK's): 30 frames a second while running, nothing
 *  while held, and for motion off the scene let run a few seconds, then that one frame. */
const clock = sceneClock({
  step: (dt) => scene?.step(dt),
  draw: (dt) => scene?.draw(dt),
  settle: () => {
    if (!scene) return;
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
      // Only a scene of the app's own: never a key the table holds by inheritance.
      if (!Object.hasOwn(SCENES, m.scene)) return;
      scene = SCENES[m.scene as LiveSceneId](m.canvas);
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
    case "mode":
      clock.setMode(m.mode);
      if (m.mode !== "run") scene?.pointer(0, 0, false);
      break;
    case "pointer":
      // What lives there notices the pointer only while it moves.
      scene?.pointer(m.x, m.y, m.active && clock.mode === "run");
      break;
    case "click":
      if (clock.mode === "run") scene?.splash(m.x, m.y);
      break;
  }
};
