/**
 * Live wallpaper protocol 1: a scene drawn behind the canvas whose creatures are the workspace's
 * agents, as a package member (`hivemind-wallpaper.json`) in a sandboxed iframe. The app's own
 * scenes (Shoal, Koi Pond, Jellyfish, Fireflies) are told the same things and keep the same clock.
 *
 *   import { connectWallpaper } from "@hivemind/view-sdk";
 *
 *   const wp = await connectWallpaper();
 *   wp.on("creatures", (cs) => meet(cs));          // one per agent: its id, program, kind, size, state
 *   wp.on("tiles", ({ tiles }) => keepOff(tiles));  // where the tiles are on the screen
 *   wp.hitTest((x, y) => creatureAt(x, y));         // the creature under a point: hover and click
 *   wp.animate({ step, draw });                     // at most 30 frames a second, nothing while held
 *
 * A wallpaper is told less than a view: no tile's name, folder, command or output, and it can do
 * nothing to the workspace. What it sends is two answers: its first frame is up, and the creature
 * under the pointer. The app shows that agent's name there, and a click goes to the agent's tile.
 *
 * The port arrives with the views' handshake (`PORT_HANDSHAKE`); every message is a plain JSON
 * object with a `type`, checked on both sides by the parsers below. The wallpaper's client is
 * `./wallpaper-client.ts`; this module needs no window, so the app's own code and HiveHub read it.
 */
import { isSafeRelativePath } from "./manifest.js";
import { quoted } from "./protocol.js";

export const WALLPAPER_PROTOCOL = 1;
/** The file that makes a folder in a package a live wallpaper. */
export const WALLPAPER_MANIFEST = "hivemind-wallpaper.json";

/** What an agent is doing, said for its creature: at work, ready for a task, waiting on the person
 *  (a permission, a question, a plan to review), or stopped, failed or asleep. */
export type AgentState = "working" | "ready" | "needs-you" | "resting";
export const CREATURE_STATES: readonly AgentState[] = ["working", "ready", "needs-you", "resting"];

/** One agent's creature. `id` is the agent's, opaque, the same until its tile closes. `kind` (0 to
 *  1) is the same for every agent of one program, so all of one program are one kind of creature;
 *  `size` (about 0.78 to 1) is the same for this agent every time. */
export interface WallpaperCreature {
  id: string;
  /** The program's id ("claude", "codex" …), or null when it is not known. */
  agent: string | null;
  kind: number;
  size: number;
  state: AgentState;
}

/** Where something solid is on the screen, in CSS pixels of the wallpaper's viewport: a tile, or a
 *  panel that is not glass. `id` names an agent's tile: its creature's id. */
export interface WallpaperTile { x0: number; y0: number; x1: number; y1: number; id?: string }

/** The colours to draw in, as `#rrggbb`: the theme's page and text, and its "needs you". `colour`
 *  is the person's **Colour** switch: draw in the scene's own colours, not the page and text.
 *  `mono` is the terminals' font, a CSS font-family list; it is the person's choice, and may not
 *  be on this computer, so give it a fallback. */
export interface WallpaperLook { page: string; text: string; attention: string; dark: boolean; colour: boolean; mono: string }

/** `run`: animate. `hold`: keep the last frame (the window is hidden, idle or covered). `still`:
 *  motion is off; show one settled frame, and draw again only when something changes. */
export type WallpaperMode = "run" | "hold" | "still";

export interface WallpaperViewport { w: number; h: number; dpr: number }

export type WallpaperHostMessage =
  | { type: "hello"; protocol: number; viewport: WallpaperViewport; look: WallpaperLook; mode: WallpaperMode; creatures: WallpaperCreature[]; tiles: WallpaperTile[]; seeThrough: boolean }
  | { type: "viewport"; viewport: WallpaperViewport }
  | { type: "look"; look: WallpaperLook }
  | { type: "mode"; mode: WallpaperMode }
  | { type: "creatures"; creatures: WallpaperCreature[] }
  /** `seeThrough`: the tiles are frosted glass; a creature under one may show through it, softly. */
  | { type: "tiles"; tiles: WallpaperTile[]; seeThrough: boolean }
  /** An agent finished a turn well. */
  | { type: "done"; id: string }
  /** The pointer over empty canvas (`over`), or gone from it. */
  | { type: "pointer"; x: number; y: number; over: boolean }
  /** A click on empty canvas, and the creature it opened (the one the wallpaper last said is under
   *  the pointer: the app went to its agent's tile), or null for open water. */
  | { type: "click"; x: number; y: number; id: string | null };

export type WallpaperMessage =
  | { type: "ready"; protocol: number }
  /** The first frame is drawn: the app shows the wallpaper. */
  | { type: "drawn" }
  /** The creature under the pointer now, or none. Sent when it changes. */
  | { type: "hover"; id: string | null };

/** The most creatures the app sends: the water never fills up. */
export const MAX_WALLPAPER_CREATURES = 8;
/** The most tiles a `tiles` message holds. */
export const MAX_WALLPAPER_TILES = 256;
const ID_MAX = 128;

type Parsed<T> = { ok: true; msg: T } | { ok: false; reason: string };
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= ID_MAX;
const isColour = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
const isViewport = (v: unknown): v is WallpaperViewport => isObj(v) && isNum(v.w) && v.w >= 0 && isNum(v.h) && v.h >= 0 && isNum(v.dpr) && v.dpr > 0 && v.dpr <= 4;
const isLook = (v: unknown): v is WallpaperLook => isObj(v) && isColour(v.page) && isColour(v.text) && isColour(v.attention)
  && typeof v.dark === "boolean" && typeof v.colour === "boolean" && typeof v.mono === "string" && v.mono.length <= 512;
const isMode = (v: unknown): v is WallpaperMode => v === "run" || v === "hold" || v === "still";
const isCreature = (v: unknown): v is WallpaperCreature => isObj(v) && isId(v.id) && (v.agent === null || isId(v.agent))
  && isNum(v.kind) && v.kind >= 0 && v.kind <= 1 && isNum(v.size) && v.size > 0 && v.size <= 1 && (CREATURE_STATES as readonly unknown[]).includes(v.state);
const isCreatures = (v: unknown): v is WallpaperCreature[] => Array.isArray(v) && v.length <= MAX_WALLPAPER_CREATURES && v.every(isCreature)
  && new Set(v.map((c: WallpaperCreature) => c.id)).size === v.length;
const isTile = (v: unknown): v is WallpaperTile => isObj(v) && isNum(v.x0) && isNum(v.y0) && isNum(v.x1) && isNum(v.y1) && (v.id === undefined || isId(v.id));
const isTiles = (v: unknown): v is WallpaperTile[] => Array.isArray(v) && v.length <= MAX_WALLPAPER_TILES && v.every(isTile);

/** The wallpaper's side: check a message from the app. */
export function parseWallpaperHostMessage(raw: unknown): Parsed<WallpaperHostMessage> {
  if (!isObj(raw) || typeof raw.type !== "string") return { ok: false, reason: "not an object with a string type" };
  const bad = (why: string): Parsed<WallpaperHostMessage> => ({ ok: false, reason: `${raw.type}: ${why}` });
  const ok = (msg: WallpaperHostMessage): Parsed<WallpaperHostMessage> => ({ ok: true, msg });
  switch (raw.type) {
    case "hello":
      return isNum(raw.protocol) && isViewport(raw.viewport) && isLook(raw.look) && isMode(raw.mode) && isCreatures(raw.creatures) && isTiles(raw.tiles) && typeof raw.seeThrough === "boolean"
        ? ok({ type: "hello", protocol: raw.protocol, viewport: raw.viewport, look: raw.look, mode: raw.mode, creatures: raw.creatures, tiles: raw.tiles, seeThrough: raw.seeThrough })
        : bad("needs protocol, viewport, look, mode, creatures, tiles and seeThrough");
    case "viewport": return isViewport(raw.viewport) ? ok({ type: "viewport", viewport: raw.viewport }) : bad("viewport is {w, h, dpr}");
    case "look": return isLook(raw.look) ? ok({ type: "look", look: raw.look }) : bad("look is {page, text, attention, dark, colour, mono}");
    case "mode": return isMode(raw.mode) ? ok({ type: "mode", mode: raw.mode }) : bad('mode is "run", "hold" or "still"');
    case "creatures": return isCreatures(raw.creatures) ? ok({ type: "creatures", creatures: raw.creatures }) : bad(`creatures is at most ${MAX_WALLPAPER_CREATURES} {id, agent, kind, size, state}, each id once`);
    case "tiles": return isTiles(raw.tiles) && typeof raw.seeThrough === "boolean" ? ok({ type: "tiles", tiles: raw.tiles, seeThrough: raw.seeThrough }) : bad("tiles is a list of {x0, y0, x1, y1, id?} and seeThrough a boolean");
    case "done": return isId(raw.id) ? ok({ type: "done", id: raw.id }) : bad("id must be a string");
    case "pointer": return isNum(raw.x) && isNum(raw.y) && typeof raw.over === "boolean" ? ok({ type: "pointer", x: raw.x, y: raw.y, over: raw.over }) : bad("pointer is {x, y, over}");
    case "click": return isNum(raw.x) && isNum(raw.y) && (raw.id === null || isId(raw.id)) ? ok({ type: "click", x: raw.x, y: raw.y, id: raw.id }) : bad("click is {x, y, id}");
    default: return { ok: false, reason: `unknown message type ${quoted(raw.type)}` };
  }
}

/** The app's side: check a message from a wallpaper, which carries its own keys and no others (the
 *  app reads every message it is sent). What it may say is checked here; whether the app asked for
 *  it (a creature it knows, a click it sent) is the host's to check. */
export function parseWallpaperMessage(raw: unknown): Parsed<WallpaperMessage> {
  if (!isObj(raw) || typeof raw.type !== "string") return { ok: false, reason: "not an object with a string type" };
  const bad = (why: string): Parsed<WallpaperMessage> => ({ ok: false, reason: `${raw.type}: ${why}` });
  const only = (...keys: string[]) => Object.keys(raw).every((k) => k === "type" || keys.includes(k));
  switch (raw.type) {
    case "ready": return isNum(raw.protocol) && only("protocol") ? { ok: true, msg: { type: "ready", protocol: raw.protocol } } : bad("is {type, protocol}, protocol a number");
    case "drawn": return only() ? { ok: true, msg: { type: "drawn" } } : bad("is {type} alone");
    case "hover": return (raw.id === null || isId(raw.id)) && only("id") ? { ok: true, msg: { type: "hover", id: raw.id } } : bad("is {type, id}, id a string or null");
    default: return { ok: false, reason: `unknown message type ${quoted(raw.type)}` };
  }
}

/** Why the app refuses a well-formed message, given the creatures it sent, or null when it takes
 *  it: a wallpaper names only a creature it was told of. */
export function wallpaperRefusal(m: WallpaperMessage, creatures: ReadonlySet<string>): string | null {
  if (m.type === "hover" && m.id !== null && !creatures.has(m.id)) return `hover: ${quoted(m.id)} is not a creature the app sent`;
  return null;
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
  /** It draws in colours of its own when the person turns **Colour** on (Settings shows the switch). */
  colour?: boolean;
  /** A picture of it for the picker: a .png, .jpg or .webp inside the folder. */
  preview?: string;
}

const MANIFEST_FIELDS = new Set(["$schema", "protocol", "name", "entry", "description", "colour", "preview"]);
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
  if (raw.colour !== undefined && typeof raw.colour !== "boolean") errors.push(`"colour" must be true or false`);
  if (raw.preview !== undefined && (typeof raw.preview !== "string" || !isSafeRelativePath(raw.preview) || !/\.(png|jpe?g|webp)$/i.test(raw.preview))) errors.push(`"preview" is a .png, .jpg or .webp inside the folder`);
  if (errors.length) return { ok: false, errors };
  return { ok: true, manifest: {
    protocol: raw.protocol as number, name: (raw.name as string).trim(), entry: raw.entry as string,
    ...(raw.description !== undefined ? { description: (raw.description as string).trim() } : {}),
    ...(raw.colour !== undefined ? { colour: raw.colour as boolean } : {}),
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
