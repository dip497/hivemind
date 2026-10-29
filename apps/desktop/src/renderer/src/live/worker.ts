/**
 * A live wallpaper's own thread. Its scene's simulation and drawing run here, on the canvas the
 * page handed over, so the renderer's main thread, where every terminal draws, never waits on them.
 * The page tells it which scene, and what changes: the canvas's size, the theme's colours, the
 * agents' creatures, where the tiles are, the pointer over the water, and whether to run, hold the
 * last frame or show one settled frame.
 */
import type { LiveSceneId } from "@hivemind/core/settings-schema";
import type { Box, CreatureSpec, LiveScene, Look, SceneMode } from "./scene";
import { ShoalScene } from "./shoal/scene";

/** The scenes there are, by the id the settings keep. */
const SCENES: Record<LiveSceneId, (canvas: OffscreenCanvas) => LiveScene> = {
  shoal: (canvas) => new ShoalScene(canvas),
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
  | { type: "splash"; x: number; y: number };

const STEP = 1 / 60;
const MAX_STEPS = 4;
/** ASCII reads as smooth at 30 frames a second, and it halves what the scene costs at 60. */
const FRAME_MS = 1000 / 30;

const scope = self as unknown as {
  fonts?: FontFaceSet;
  requestAnimationFrame?: (cb: (now: number) => void) => number;
  cancelAnimationFrame?: (id: number) => void;
  onmessage: ((e: MessageEvent<SceneMessage>) => void) | null;
};
// A worker paces itself on the display's frames where it can, else on a timer.
const nextFrame = (cb: (now: number) => void): number =>
  scope.requestAnimationFrame ? scope.requestAnimationFrame(cb) : (setTimeout(() => cb(performance.now()), FRAME_MS) as unknown as number);
const cancelFrame = (id: number) => (scope.cancelAnimationFrame ? scope.cancelAnimationFrame(id) : clearTimeout(id));

let scene: LiveScene | null = null;
/** The agents' creatures as last told, for a still picture made again from scratch. */
let roster: CreatureSpec[] = [];
/** Whether the scene has had its creatures: the first are already in the water when it starts. */
let stocked = false;
let mode: SceneMode = "hold";
let raf = 0;
let last = 0;
let drawnAt = 0;
let acc = 0;

function frame(now: number) {
  raf = nextFrame(frame);
  if (now - drawnAt < FRAME_MS - 2) return;
  drawnAt = now;
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  acc += dt;
  let steps = 0;
  while (acc >= STEP && steps < MAX_STEPS) {
    scene?.step(STEP);
    acc -= STEP;
    steps++;
  }
  if (steps === MAX_STEPS) acc = 0;
  scene?.draw(dt);
}

const draw = () => scene?.draw(STEP);

/** Motion off: put the creatures where their moods have them, let the scene settle, then show
 *  that one frame. */
function settle() {
  if (!scene) return;
  scene.setRoster(roster, true);
  for (let i = 0; i < 360; i++) scene.step(STEP);
  draw();
}

function setMode(next: SceneMode) {
  if (next === mode) return;
  mode = next;
  cancelFrame(raf);
  if (mode === "run") {
    last = performance.now();
    raf = nextFrame(frame);
  } else if (mode === "still") settle();
}

async function loadFaces(faces: FaceSource[]) {
  const fonts = scope.fonts;
  if (!fonts) return;
  await Promise.all(faces.map(async (f) => {
    const face = new FontFace(f.family, f.src, { weight: f.weight, ...(f.range ? { unicodeRange: f.range } : {}) });
    fonts.add(face);
    await face.load().catch(() => {});
  }));
  if (mode !== "run") draw();
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
      if (mode !== "run") draw();
      break;
    case "roster":
      roster = m.creatures;
      // The agents there when the scene starts are in the water already; one started later swims
      // in. In a still picture only what changed moves: a creature comes, goes or comes up to its tile.
      scene?.setRoster(m.creatures, mode === "still" || !stocked);
      stocked = true;
      if (mode !== "run") draw();
      break;
    case "boxes":
      scene?.setBoxes(m.boxes, m.seeThrough);
      // A still picture shows the tiles where they are now.
      if (mode === "still") draw();
      break;
    case "finished":
      if (mode === "run") scene?.finished(m.key);
      break;
    case "mode":
      setMode(m.mode);
      break;
    case "pointer":
      scene?.pointer(m.x, m.y, m.active && mode === "run");
      break;
    case "splash":
      if (mode === "run") scene?.splash(m.x, m.y);
      break;
  }
};
