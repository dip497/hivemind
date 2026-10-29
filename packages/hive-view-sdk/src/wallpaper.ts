/**
 * Live wallpaper protocol 2: a scene drawn behind the canvas, a world of its own whose life goes on
 * by itself and plays with the pointer, as a package member (`hivemind-wallpaper.json`) in a
 * sandboxed iframe. The app's own scenes (Shoal, Koi Pond, Jellyfish, Fireflies) are told the same
 * things and keep the same clock.
 *
 *   import { connectWallpaper } from "@hivemind/view-sdk";
 *
 *   const wp = await connectWallpaper();
 *   wp.on("viewport", ({ w, h, dpr }) => size(w, h, dpr));
 *   wp.on("pointer", ({ x, y, over }) => notice(x, y, over)); // over empty canvas, or gone
 *   wp.on("click", ({ x, y }) => splash(x, y));               // a click on empty canvas
 *   wp.animate({ step, draw });                               // at most 30 frames a second, nothing while held
 *
 * A wallpaper is told nothing of the workspace: not its agents, its tiles, their names or what they
 * show, and it can do nothing to it. It says two things back: it speaks this protocol, and its
 * first frame is up.
 *
 * The port arrives with the views' handshake (`PORT_HANDSHAKE`); every message is a plain JSON
 * object with a `type`, checked on both sides by the parsers below. The wallpaper's client is
 * `./wallpaper-client.ts`; this module needs no window, so the app's own code and HiveHub read it.
 */
import { isSafeRelativePath } from "./manifest.js";
import { quoted } from "./protocol.js";

export const WALLPAPER_PROTOCOL = 2;
/** The file that makes a folder in a package a live wallpaper. */
export const WALLPAPER_MANIFEST = "hivemind-wallpaper.json";

/** The theme, as `#rrggbb`: its page and text colours, and whether it is dark. A wallpaper draws in
 *  its own colours, a light or a dark version by `dark`. `mono` is the terminals' font, a CSS
 *  font-family list; it is the person's choice, and may not be on this computer, so give it a
 *  fallback. */
export interface WallpaperLook { page: string; text: string; dark: boolean; mono: string }

/** `run`: animate. `hold`: keep the last frame (the window is hidden, not focused or covered). `still`:
 *  motion is off; show one settled frame, and draw again only when something changes. */
export type WallpaperMode = "run" | "hold" | "still";

export interface WallpaperViewport { w: number; h: number; dpr: number }

export type WallpaperHostMessage =
  | { type: "hello"; protocol: number; viewport: WallpaperViewport; look: WallpaperLook; mode: WallpaperMode }
  | { type: "viewport"; viewport: WallpaperViewport }
  | { type: "look"; look: WallpaperLook }
  | { type: "mode"; mode: WallpaperMode }
  /** The pointer over empty canvas (`over`), or gone from it. */
  | { type: "pointer"; x: number; y: number; over: boolean }
  /** A click on empty canvas. */
  | { type: "click"; x: number; y: number };

export type WallpaperMessage =
  | { type: "ready"; protocol: number }
  /** The first frame is drawn: the app shows the wallpaper. */
  | { type: "drawn" };

type Parsed<T> = { ok: true; msg: T } | { ok: false; reason: string };
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isColour = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
const isViewport = (v: unknown): v is WallpaperViewport => isObj(v) && isNum(v.w) && v.w >= 0 && isNum(v.h) && v.h >= 0 && isNum(v.dpr) && v.dpr > 0 && v.dpr <= 4;
const isLook = (v: unknown): v is WallpaperLook => isObj(v) && isColour(v.page) && isColour(v.text)
  && typeof v.dark === "boolean" && typeof v.mono === "string" && v.mono.length <= 512;
const isMode = (v: unknown): v is WallpaperMode => v === "run" || v === "hold" || v === "still";

/** The wallpaper's side: check a message from the app. */
export function parseWallpaperHostMessage(raw: unknown): Parsed<WallpaperHostMessage> {
  if (!isObj(raw) || typeof raw.type !== "string") return { ok: false, reason: "not an object with a string type" };
  const bad = (why: string): Parsed<WallpaperHostMessage> => ({ ok: false, reason: `${raw.type}: ${why}` });
  const ok = (msg: WallpaperHostMessage): Parsed<WallpaperHostMessage> => ({ ok: true, msg });
  switch (raw.type) {
    case "hello":
      return isNum(raw.protocol) && isViewport(raw.viewport) && isLook(raw.look) && isMode(raw.mode)
        ? ok({ type: "hello", protocol: raw.protocol, viewport: raw.viewport, look: raw.look, mode: raw.mode })
        : bad("needs protocol, viewport, look and mode");
    case "viewport": return isViewport(raw.viewport) ? ok({ type: "viewport", viewport: raw.viewport }) : bad("viewport is {w, h, dpr}");
    case "look": return isLook(raw.look) ? ok({ type: "look", look: raw.look }) : bad("look is {page, text, dark, mono}");
    case "mode": return isMode(raw.mode) ? ok({ type: "mode", mode: raw.mode }) : bad('mode is "run", "hold" or "still"');
    case "pointer": return isNum(raw.x) && isNum(raw.y) && typeof raw.over === "boolean" ? ok({ type: "pointer", x: raw.x, y: raw.y, over: raw.over }) : bad("pointer is {x, y, over}");
    case "click": return isNum(raw.x) && isNum(raw.y) ? ok({ type: "click", x: raw.x, y: raw.y }) : bad("click is {x, y}");
    default: return { ok: false, reason: `unknown message type ${quoted(raw.type)}` };
  }
}

/** The app's side: check a message from a wallpaper, which carries its own keys and no others (the
 *  app reads every message it is sent). */
export function parseWallpaperMessage(raw: unknown): Parsed<WallpaperMessage> {
  if (!isObj(raw) || typeof raw.type !== "string") return { ok: false, reason: "not an object with a string type" };
  const bad = (why: string): Parsed<WallpaperMessage> => ({ ok: false, reason: `${raw.type}: ${why}` });
  const only = (...keys: string[]) => Object.keys(raw).every((k) => k === "type" || keys.includes(k));
  switch (raw.type) {
    case "ready": return isNum(raw.protocol) && only("protocol") ? { ok: true, msg: { type: "ready", protocol: raw.protocol } } : bad("is {type, protocol}, protocol a number");
    case "drawn": return only() ? { ok: true, msg: { type: "drawn" } } : bad("is {type} alone");
    default: return { ok: false, reason: `unknown message type ${quoted(raw.type)}` };
  }
}

// ── the manifest ──────────────────────────────────────────────────────────

/** A checked `hivemind-wallpaper.json`. Its id is not in it: it is `@owner/package/<folder>`. */
export interface WallpaperManifest {
  protocol: number;
  name: string;
  /** The page, or a script the app wraps in a page of its own, inside the folder. */
  entry: string;
  /** One sentence the picker shows under its name. */
  description?: string;
  /** A picture of it for the picker: a .png, .jpg or .webp inside the folder. */
  preview?: string;
}

const MANIFEST_FIELDS = new Set(["$schema", "protocol", "name", "entry", "description", "preview"]);
const UNSAFE_TEXT = /[\u0000-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

/** Check a parsed `hivemind-wallpaper.json`, naming every problem. */
export function validateWallpaperManifest(raw: unknown): { ok: true; manifest: WallpaperManifest } | { ok: false; errors: string[] } {
  if (!isObj(raw)) return { ok: false, errors: [`${WALLPAPER_MANIFEST} must be a JSON object`] };
  const errors: string[] = [];
  for (const k of Object.keys(raw)) if (!MANIFEST_FIELDS.has(k)) errors.push(`there is no field ${quoted(k, 60)}; it takes ${[...MANIFEST_FIELDS].filter((f) => f !== "$schema").join(", ")}`);
  if (!Number.isInteger(raw.protocol) || (raw.protocol as number) < 1) errors.push(`"protocol" is a whole number; this SDK speaks ${WALLPAPER_PROTOCOL}`);
  const text = (k: string, max: number, required: boolean) => {
    const v = raw[k];
    if (v === undefined && !required) return;
    if (typeof v !== "string" || !v.trim() || v.length > max || UNSAFE_TEXT.test(v)) errors.push(`"${k}" is up to ${max} characters of plain text`);
  };
  text("name", 60, true);
  text("description", 200, false);
  if (typeof raw.entry !== "string" || !isSafeRelativePath(raw.entry) || !/\.(html?|m?js)$/i.test(raw.entry)) errors.push(`"entry" is an .html page or a .js script inside the folder`);
  if (raw.preview !== undefined && (typeof raw.preview !== "string" || !isSafeRelativePath(raw.preview) || !/\.(png|jpe?g|webp)$/i.test(raw.preview))) errors.push(`"preview" is a .png, .jpg or .webp inside the folder`);
  if (errors.length) return { ok: false, errors };
  return { ok: true, manifest: {
    protocol: raw.protocol as number, name: (raw.name as string).trim(), entry: raw.entry as string,
    ...(raw.description !== undefined ? { description: (raw.description as string).trim() } : {}),
    ...(raw.preview !== undefined ? { preview: raw.preview as string } : {}),
  } };
}

// ── the clock ─────────────────────────────────────────────────────────────

/** What a scene does on the clock: move on `dt` seconds, draw as it is (`dt` for what fades with
 *  time), and, for a still frame, put everything where it would be after a while. */
export interface SceneSteps {
  step(dt: number): void;
  draw(dt: number): void;
  settle?(): void;
}

export interface SceneClock {
  /** Run, hold the last frame, or show one settled frame. */
  setMode(mode: WallpaperMode): void;
  readonly mode: WallpaperMode;
  /** Something the scene shows changed: a held or still frame is drawn again (a still one settled
   *  first); a running one shows it at its next frame. */
  changed(): void;
  stop(): void;
}

/** The simulation's step: 60 a second whatever the frame rate, so a scene moves the same at 30 and 60. */
export const SCENE_STEP = 1 / 60;
/** A scene that falls this far behind (a busy computer) drops the rest, rather than racing. */
const MAX_STEPS = 4;
/** A still frame is the scene this long after it was set up. */
export const SETTLE_STEPS = 360;

const g = globalThis as unknown as { requestAnimationFrame?: (cb: (now: number) => void) => number; cancelAnimationFrame?: (id: number) => void };

/** The clock every live wallpaper runs on, the app's and a package's: at most `fps` frames a second
 *  (30 unless asked; ASCII reads smooth at 30 and costs half of 60), steps of `SCENE_STEP`, nothing
 *  at all while held, one settled frame while still. Starts held. */
export function sceneClock(scene: SceneSteps, opts: { fps?: number } = {}): SceneClock {
  const frameMs = 1000 / Math.max(1, Math.min(60, opts.fps ?? 30));
  // The display's frames where there are any (a page, a worker drawing to an OffscreenCanvas), else a timer.
  const frames = {
    request: (cb: (now: number) => void): number => (g.requestAnimationFrame ? g.requestAnimationFrame(cb) : (setTimeout(() => cb(performance.now()), frameMs) as unknown as number)),
    cancel: (id: number) => (g.cancelAnimationFrame ? g.cancelAnimationFrame(id) : clearTimeout(id)),
    now: () => performance.now(),
  };
  let mode: WallpaperMode = "hold";
  let raf = 0;
  let last = 0;
  let drawnAt = -Infinity;
  let acc = 0;
  const settle = () => {
    if (scene.settle) scene.settle();
    else for (let i = 0; i < SETTLE_STEPS; i++) scene.step(SCENE_STEP);
    scene.draw(SCENE_STEP);
  };
  const frame = (now: number) => {
    raf = frames.request(frame);
    // A display faster than the cap: skip frames until it is time (2 ms early is on time).
    if (now - drawnAt < frameMs - 2) return;
    drawnAt = now;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    acc += dt;
    let steps = 0;
    while (acc >= SCENE_STEP && steps < MAX_STEPS) {
      scene.step(SCENE_STEP);
      acc -= SCENE_STEP;
      steps++;
    }
    if (steps === MAX_STEPS) acc = 0;
    scene.draw(dt);
  };
  return {
    get mode() { return mode; },
    setMode(next) {
      if (next === mode) return;
      mode = next;
      frames.cancel(raf);
      if (mode === "run") {
        last = frames.now();
        drawnAt = -Infinity;
        raf = frames.request(frame);
      } else if (mode === "still") settle();
    },
    changed() {
      if (mode === "still") settle();
      else if (mode === "hold") scene.draw(SCENE_STEP);
    },
    stop() {
      frames.cancel(raf);
      mode = "hold";
    },
  };
}
