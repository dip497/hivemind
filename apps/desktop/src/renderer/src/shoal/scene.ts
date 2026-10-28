/**
 * The Shoal's own thread. The simulation and its drawing run here, on the canvas the page handed
 * over, so the renderer's main thread, where every terminal draws, never waits on them. The page
 * tells it what changes: the canvas's size, the theme's colours, the agents' sharks, where the
 * tiles are, the pointer over the water, and whether to run, hold the last frame or show one
 * settled frame.
 */
import { AsciiRenderer } from "./render";
import { World, type Box, type SharkSpec } from "./world";

/** `run` animates; `hold` keeps the last frame (paused); `still` shows one settled frame (motion off). */
export type ShoalMode = "run" | "hold" | "still";

/** One of the page's font faces for the scene's characters: a worker sees none of the page's web fonts. */
export interface FaceSource {
  family: string;
  src: string;
  weight: string;
  range?: string;
}

export type ShoalMessage =
  | { type: "start"; canvas: OffscreenCanvas; font: string; faces: FaceSource[] }
  | { type: "font"; font: string; faces: FaceSource[] }
  | { type: "size"; width: number; height: number; dpr: number }
  | { type: "colours"; page: number; text: number }
  | { type: "roster"; sharks: SharkSpec[] }
  | { type: "boxes"; boxes: Box[] }
  | { type: "finished"; key: string }
  | { type: "mode"; mode: ShoalMode }
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
  onmessage: ((e: MessageEvent<ShoalMessage>) => void) | null;
};
// A worker paces itself on the display's frames where it can, else on a timer.
const nextFrame = (cb: (now: number) => void): number =>
  scope.requestAnimationFrame ? scope.requestAnimationFrame(cb) : (setTimeout(() => cb(performance.now()), FRAME_MS) as unknown as number);
const cancelFrame = (id: number) => (scope.cancelAnimationFrame ? scope.cancelAnimationFrame(id) : clearTimeout(id));

const world = new World();
let renderer: AsciiRenderer | null = null;
/** The agents' sharks as last told, for a still picture made again from scratch. */
let roster: SharkSpec[] = [];
/** Whether the scene has had its sharks: the first are already in the water when it starts. */
let stocked = false;
let mode: ShoalMode = "hold";
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
    world.step(STEP);
    acc -= STEP;
    steps++;
  }
  if (steps === MAX_STEPS) acc = 0;
  renderer?.render(world, dt);
}

const draw = () => renderer?.render(world, STEP);

/** Motion off: put the sharks where their moods have them, let the schools form, then show that
 *  one frame. */
function settle() {
  world.setRoster(roster, true);
  for (let i = 0; i < 360; i++) world.step(STEP);
  draw();
}

function setMode(next: ShoalMode) {
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
      renderer = new AsciiRenderer(m.canvas);
      renderer.setFontFamily(m.font);
      void loadFaces(m.faces);
      break;
    case "font":
      renderer?.setFontFamily(m.font);
      void loadFaces(m.faces);
      draw();
      break;
    case "size":
      if (!renderer) return;
      renderer.resize(m.width, m.height, m.dpr);
      world.resize(m.width, m.height, renderer.cellWidth, renderer.cellHeight);
      // Resizing clears the canvas: draw now, not at the next paced frame, so it never shows blank.
      draw();
      break;
    case "colours":
      renderer?.setColours(m.page, m.text);
      if (mode !== "run") draw();
      break;
    case "roster":
      roster = m.sharks;
      // The agents there when the scene starts are in the water already; one started later swims
      // in. In a still picture only what changed moves: a shark comes, goes or comes up to its tile.
      world.setRoster(m.sharks, mode === "still" || !stocked);
      stocked = true;
      if (mode !== "run") draw();
      break;
    case "boxes":
      world.setBoxes(m.boxes);
      renderer?.setBoxes(m.boxes);
      break;
    case "finished":
      if (mode === "run") world.finished(m.key);
      break;
    case "mode":
      setMode(m.mode);
      break;
    case "pointer":
      world.pointer.x = m.x;
      world.pointer.y = m.y;
      world.pointer.active = m.active && mode === "run";
      break;
    case "splash":
      if (mode === "run") world.splash(m.x, m.y);
      break;
  }
};
