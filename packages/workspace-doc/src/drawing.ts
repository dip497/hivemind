/**
 * Drawings on the board, as data: what an agent asks to have drawn, where it goes, how a shape is
 * outlined and how the board looks as a picture. Nothing here imports Loro, Node or Electron: the
 * host places what an agent draws, the window outlines what a person draws, and a phone is sent
 * the picture.
 */
import { ARROW_ROUTES, MAX_ALT, MAX_SHAPE_POINTS, SHAPE_COLORS, SHAPE_DASHES, SHAPE_FORMS, SHAPE_TEXT_SIZES, SHAPE_WEIGHTS, isStroke, type ArrowObject, type ArrowRoute, type BoardImage, type BoardObject, type ShapeColor, type ShapeDash, type ShapeForm, type ShapeObject, type ShapeTextSize, type ShapeWeight, type Side } from "./shapes.js";
import { dashPattern } from "./stroke-smooth.js";

export interface Point { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }

/** The most one call may draw, and the most shapes a board holds: a runaway agent stops here. */
export const MAX_SHAPES_DRAWN = 500;
export const MAX_SHAPES_ON_BOARD = 5000;
const MAX_TEXT = 2000;
const MAX_COORD = 10_000_000;

// ── geometry ─────────────────────────────────────────────────────────

/** The sides two rects face each other on: along the axis their centres are furthest apart on. */
export function facingSides(from: Rect, to: Rect): [Side, Side] {
  const dx = to.x + to.w / 2 - (from.x + from.w / 2);
  const dy = to.y + to.h / 2 - (from.y + from.h / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? ["right", "left"] : ["left", "right"];
  return dy >= 0 ? ["bottom", "top"] : ["top", "bottom"];
}

/** Where an arrow meets a rect's side: the middle of it. */
export function sidePoint(r: Rect, side: Side): Point {
  switch (side) {
    case "top": return { x: r.x + r.w / 2, y: r.y };
    case "right": return { x: r.x + r.w, y: r.y + r.h / 2 };
    case "bottom": return { x: r.x + r.w / 2, y: r.y + r.h };
    case "left": return { x: r.x, y: r.y + r.h / 2 };
  }
}

export const rectsTouch = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** The smallest rect around `rects`, or null when there are none. */
export function boundsOf(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) - x, h: Math.max(...rects.map((r) => r.y + r.h)) - y };
}

/** The box around a line's or a stroke's points on the canvas, and those points from its corner. */
export function strokeBox(points: ReadonlyArray<readonly [number, number]>): Rect & { points: Array<[number, number]> } {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    x, y, w: Math.max(Math.max(...xs) - x, 1), h: Math.max(Math.max(...ys) - y, 1),
    points: points.map((p): [number, number] => [tenth(p[0] - x), tenth(p[1] - y)]),
  };
}

const tenth = (n: number): number => Math.round(n * 10) / 10;

/** A hand's many points as the few that draw the same line (Ramer-Douglas-Peucker), within `within` pixels. */
export function simplifyPoints(points: ReadonlyArray<readonly [number, number]>, within: number): Array<[number, number]> {
  if (points.length <= 2) return points.map((p) => [p[0], p[1]]);
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [from, to] = stack.pop()!;
    let far = -1;
    let most = within;
    for (let i = from + 1; i < to; i++) {
      const d = distanceToSegment(points[i]![0], points[i]![1], points[from]!, points[to]!);
      if (d > most) { most = d; far = i; }
    }
    if (far >= 0) {
      keep[far] = 1;
      stack.push([from, far], [far, to]);
    }
  }
  const kept = points.filter((_, i) => keep[i]).map((p): [number, number] => [p[0], p[1]]);
  // A stroke too long for one shape keeps its ends and an even spread between them.
  if (kept.length <= MAX_SHAPE_POINTS) return kept;
  const step = (kept.length - 1) / (MAX_SHAPE_POINTS - 1);
  return Array.from({ length: MAX_SHAPE_POINTS }, (_, i) => kept[Math.round(i * step)]!);
}

function distanceToSegment(x: number, y: number, a: readonly [number, number], b: readonly [number, number]): number {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const along = dx === 0 && dy === 0 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (a[0] + along * dx), y - (a[1] + along * dy));
}

/** A shape's points as drawn at its box's size now: they were kept at `from`'s size. */
export function scaledPoints(points: ReadonlyArray<readonly [number, number]>, from: { w: number; h: number }, to: { w: number; h: number }): Array<[number, number]> {
  const [sx, sy] = [to.w / Math.max(from.w, 1), to.h / Math.max(from.h, 1)];
  return points.map((p): [number, number] => [tenth(p[0] * sx), tenth(p[1] * sy)]);
}

/** The outline of a shape whose box is at the origin, as SVG path data: each form one path. */
export function shapeOutline(o: Pick<ShapeObject, "form" | "w" | "h" | "points">): string {
  const { w, h } = o;
  switch (o.form) {
    case "rect": {
      const r = Math.min(10, w / 2, h / 2);
      return `M${r} 0H${w - r}A${r} ${r} 0 0 1 ${w} ${r}V${h - r}A${r} ${r} 0 0 1 ${w - r} ${h}H${r}A${r} ${r} 0 0 1 0 ${h - r}V${r}A${r} ${r} 0 0 1 ${r} 0Z`;
    }
    case "ellipse": return `M0 ${h / 2}A${w / 2} ${h / 2} 0 1 1 ${w} ${h / 2}A${w / 2} ${h / 2} 0 1 1 0 ${h / 2}Z`;
    case "text": return "";
    case "image": return `M0 0H${w}V${h}H0Z`;
    case "line": return (o.points ?? []).map((p, i) => `${i ? "L" : "M"}${p[0]} ${p[1]}`).join("");
    case "pen": return smoothPath(o.points ?? []);
    case "cylinder": {
      const cap = cylinderCap(w, h);
      return `M0 ${cap}A${w / 2} ${cap} 0 0 1 ${w} ${cap}V${h - cap}A${w / 2} ${cap} 0 0 1 0 ${h - cap}ZM0 ${cap}A${w / 2} ${cap} 0 0 0 ${w} ${cap}`;
    }
    case "cloud": {
      const at = CLOUD_BUMPS.map(([x, y]): [number, number] => [tenth(x * w), tenth(y * h)]);
      return `${at.map((p, i) => {
        if (i === 0) return `M${p[0]} ${p[1]}`;
        const reach = Math.hypot(CLOUD_BUMPS[i]![0] - CLOUD_BUMPS[i - 1]![0], CLOUD_BUMPS[i]![1] - CLOUD_BUMPS[i - 1]![1]) / 2;
        return `A${tenth(reach * w)} ${tenth(reach * h)} 0 0 1 ${p[0]} ${p[1]}`;
      }).join("")}Z`;
    }
    case "diamond":
    case "triangle":
    case "hexagon":
    case "star":
    case "parallelogram":
      return `${cornersOf(o.form, w, h).map((p, i) => `${i ? "L" : "M"}${p[0]} ${p[1]}`).join("")}Z`;
  }
}

const cylinderCap = (w: number, h: number): number => tenth(Math.min(h / 5, w / 4, 18));

/** Where a cloud's bumps meet, as fractions of its box, clockwise from the bottom left: each pair is joined by a half circle. */
const CLOUD_BUMPS: ReadonlyArray<readonly [number, number]> = [[0.22, 0.88], [0.18, 0.5], [0.4, 0.28], [0.74, 0.28], [0.83, 0.52], [0.79, 0.88]];

/** The corners of a form with straight sides, in a box at the origin. */
function cornersOf(form: ShapeForm, w: number, h: number): Array<[number, number]> {
  switch (form) {
    case "diamond": return [[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]];
    case "triangle": return [[w / 2, 0], [w, h], [0, h]];
    case "hexagon": {
      const cut = Math.min(w / 4, h / 2);
      return [[cut, 0], [w - cut, 0], [w, h / 2], [w - cut, h], [cut, h], [0, h / 2]];
    }
    case "parallelogram": {
      const lean = Math.min(w / 4, h / 2);
      return [[lean, 0], [w, 0], [w - lean, h], [0, h]];
    }
    case "star": {
      // Five points on a circle stretched to the box, each dip 0.4 of the way out.
      const [low, wide] = [Math.cos(Math.PI / 5), Math.cos(Math.PI / 10)];
      return Array.from({ length: 10 }, (_, i): [number, number] => {
        const angle = -Math.PI / 2 + (i * Math.PI) / 5;
        const out = i % 2 ? 0.4 : 1;
        return [tenth((w / 2) * (1 + (out * Math.cos(angle)) / wide)), tenth((h * (1 + out * Math.sin(angle))) / (1 + low))];
      });
    }
    default: return [[0, 0], [w, 0], [w, h], [0, h]];
  }
}

/** A curve through a hand's points: each point bends it, and it passes through the midpoints between them. */
function smoothPath(points: ReadonlyArray<readonly [number, number]>): string {
  if (points.length === 0) return "";
  if (points.length < 3) return points.map((p, i) => `${i ? "L" : "M"}${p[0]} ${p[1]}`).join("");
  let d = `M${points[0]![0]} ${points[0]![1]}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [a, b] = [points[i]!, points[i + 1]!];
    d += `Q${a[0]} ${a[1]} ${tenth((a[0] + b[0]) / 2)} ${tenth((a[1] + b[1]) / 2)}`;
  }
  const last = points[points.length - 1]!;
  return `${d}L${last[0]} ${last[1]}`;
}

/** Whether a point on the canvas is on a shape, within `within` pixels of what is drawn. */
export function shapeHit(o: ShapeObject, p: Point, within: number): boolean {
  const [x, y] = [p.x - o.x, p.y - o.y];
  if (x < -within || y < -within || x > o.w + within || y > o.h + within) return false;
  if (isStroke(o.form)) {
    const points = o.points ?? [];
    return points.some((a, i) => i > 0 && distanceToSegment(x, y, points[i - 1]!, a) <= within);
  }
  if (o.form === "text" || o.form === "image" || o.filled || o.text) return true;
  if (o.form === "ellipse") {
    const [rx, ry] = [o.w / 2, o.h / 2];
    return Math.abs(Math.hypot((x - rx) / Math.max(rx, 1), (y - ry) / Math.max(ry, 1)) - 1) * Math.min(rx, ry) <= within;
  }
  if (o.form === "diamond") {
    const [rx, ry] = [o.w / 2, o.h / 2];
    return Math.abs(Math.abs(x - rx) / Math.max(rx, 1) + Math.abs(y - ry) / Math.max(ry, 1) - 1) * Math.min(rx, ry) <= within;
  }
  if (o.form === "triangle" || o.form === "hexagon" || o.form === "star" || o.form === "parallelogram") {
    const corners = cornersOf(o.form, o.w, o.h);
    return corners.some((a, i) => distanceToSegment(x, y, corners[(i + corners.length - 1) % corners.length]!, a) <= within);
  }
  return Math.min(Math.abs(x), Math.abs(y), Math.abs(o.w - x), Math.abs(o.h - y)) <= within;
}

// ── what an agent asks for ───────────────────────────────────────────

/** The forms a box may take: every form that fills its box and holds words. */
export const BOX_FORMS = ["rect", "ellipse", "diamond", "triangle", "hexagon", "cylinder", "cloud", "star", "parallelogram"] as const;
export type BoxForm = (typeof BOX_FORMS)[number];

export interface DrawnBox { id: string; text: string; form?: BoxForm; color?: ShapeColor; filled?: boolean; dash?: ShapeDash; weight?: ShapeWeight; rough?: boolean; image?: BoardImage; alt?: string; width?: number }
/** How wide and tall a picture in a drawing is drawn at most, and one placed on its own. */
export const DRAWN_IMAGE_MOST = 320;
export const PLACED_IMAGE_MOST = 640;
/** A picture's size on the board: its own, made smaller to fit `most` on its long side. */
export function imageBoxSize(image: Pick<BoardImage, "width" | "height">, most: number): { w: number; h: number } {
  const scale = Math.min(1, most / Math.max(image.width, image.height));
  return { w: Math.max(1, Math.round(image.width * scale)), h: Math.max(1, Math.round(image.height * scale)) };
}
export interface DrawnLink { from: string; to: string; label?: string; route?: ArrowRoute; dash?: ShapeDash; weight?: ShapeWeight; tail?: boolean }
export interface DrawnShape {
  form: ShapeForm;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  text?: string;
  size?: ShapeTextSize;
  points?: Array<[number, number]>;
  head?: boolean;
  filled?: boolean;
  color?: ShapeColor;
  dash?: ShapeDash;
  weight?: ShapeWeight;
  rough?: boolean;
  /** A stroke of the pen drawn as a highlighter. */
  marker?: boolean;
}

/** What an agent asks to have drawn (`board.draw`): boxes and links placed for it, or shapes it places itself, or both. */
export interface DrawAsked {
  title?: string;
  direction?: "right" | "down";
  boxes?: DrawnBox[];
  links?: DrawnLink[];
  shapes?: DrawnShape[];
  /** Where its top-left corner goes on the canvas; else beside `near`, or beside the agent. */
  at?: Point;
  /** A tile, frame or object to draw beside. */
  near?: string;
  /** The frame it moves with; else the frame of what it is drawn beside. `none`: no frame. */
  frame?: string;
  /** A drawing this one updates: its boxes found by key keep their place, new ones are placed, the rest erased. */
  update?: string;
  /** With `update`: what else of the drawing stays as it is, by id (what boxes and links cannot say, as a pen stroke). */
  keep?: string[];
}

const refuse = (why: string): never => { throw new TypeError(why); };
const fields = (x: unknown, what: string): Record<string, unknown> => (typeof x === "object" && x !== null && !Array.isArray(x) ? x as Record<string, unknown> : refuse(`${what} must be an object`));
const coord = (x: unknown, what: string): number => (typeof x === "number" && Number.isFinite(x) && Math.abs(x) <= MAX_COORD ? x : refuse(`${what} must be a number`));
const words = (x: unknown, what: string): string => (typeof x === "string" && x.length <= MAX_TEXT ? x : refuse(`${what} must be text of at most ${MAX_TEXT} characters`));
const colorOf = (x: unknown, what: string): ShapeColor | undefined => {
  if (x === undefined) return undefined;
  return (SHAPE_COLORS as readonly unknown[]).includes(x) ? x as ShapeColor : refuse(`${what}.color must be one of ${SHAPE_COLORS.join(", ")}`);
};
const yes = (x: unknown): boolean | undefined => (x === undefined ? undefined : x === true);
const oneOf = <T extends string>(x: unknown, allowed: readonly T[], what: string): T | undefined => {
  if (x === undefined) return undefined;
  return (allowed as readonly unknown[]).includes(x) ? x as T : refuse(`${what} must be one of ${allowed.join(", ")}`);
};
/** The line style asked for a box, a shape or a link, only what was said. */
function lineStyleOf(x: Record<string, unknown>, what: string): { dash?: ShapeDash; weight?: ShapeWeight; rough?: boolean } {
  const dash = oneOf(x.dash, SHAPE_DASHES, `${what}.dash`);
  const weight = oneOf(x.weight, SHAPE_WEIGHTS, `${what}.weight`);
  return { ...(dash ? { dash } : {}), ...(weight ? { weight } : {}), ...(x.rough === true ? { rough: true } : {}) };
}

function pointsOf(x: unknown, what: string): Array<[number, number]> {
  if (!Array.isArray(x) || x.length < 2 || x.length > MAX_SHAPE_POINTS) return refuse(`${what}.points must be 2 to ${MAX_SHAPE_POINTS} [x, y] pairs`);
  return x.map((p): [number, number] => (Array.isArray(p) && p.length === 2 ? [coord(p[0], `${what}.points`), coord(p[1], `${what}.points`)] : refuse(`${what}.points must be [x, y] pairs`)));
}

/** `value` as what an agent may ask to have drawn; what it may not is refused, saying why (a TypeError).
 *  A box's `image` names a picture kept for the board by its hash, which `imageOf` finds. */
export function readDrawAsked(value: unknown, imageOf: (hash: string) => BoardImage | null = () => null): DrawAsked {
  const v = fields(value, "a drawing");
  const list = (x: unknown, what: string): unknown[] => (x === undefined ? [] : Array.isArray(x) ? x : refuse(`${what} must be a list`));
  const boxes = list(v.boxes, "boxes").map((raw, i): DrawnBox => {
    const what = `boxes[${i}]`;
    const b = fields(raw, what);
    const form = oneOf(b.form, BOX_FORMS, `${what}.form`);
    if (typeof b.id !== "string" || !b.id) refuse(`${what}.id must name it, so links can`);
    const color = colorOf(b.color, what);
    const filled = yes(b.filled);
    if (b.image !== undefined) {
      // A hash, or a picture as read back from the board: either way found again here, never taken as given.
      const hash = typeof b.image === "string" ? b.image : (b.image as { hash?: unknown } | null)?.hash;
      if (typeof hash !== "string") refuse(`${what}.image must be a picture's hash, from \`board.keepImage\``);
      const image = imageOf(hash as string) ?? refuse(`${what}.image: no picture ${String(hash)} is kept for this board: keep it first (\`hive ctl draw --image <file>\`)`);
      const alt = b.alt === undefined ? b.text : b.alt;
      const width = b.width === undefined ? undefined : coord(b.width, `${what}.width`);
      if (width !== undefined && !(width >= 8)) refuse(`${what}.width must be at least 8`);
      return { id: b.id as string, text: "", image, ...(alt ? { alt: words(alt, `${what}.alt`).slice(0, MAX_ALT) } : {}), ...(width ? { width } : {}) };
    }
    return { id: b.id as string, text: words(b.text ?? "", `${what}.text`), ...(form ? { form } : {}), ...(color ? { color } : {}), ...(filled !== undefined ? { filled } : {}), ...lineStyleOf(b, what) };
  });
  if (new Set(boxes.map((b) => b.id)).size !== boxes.length) refuse("each box needs an id of its own");
  const links = list(v.links, "links").map((raw, i): DrawnLink => {
    const what = `links[${i}]`;
    const pair: Record<string, unknown> = Array.isArray(raw) ? { from: raw[0], to: raw[1], label: raw[2] } : fields(raw, what);
    if (typeof pair.from !== "string" || typeof pair.to !== "string") refuse(`${what} must say from and to: a box's id, a tile's, a frame's or an object's`);
    const route = oneOf(pair.route, ARROW_ROUTES, `${what}.route`);
    const { dash, weight } = lineStyleOf(pair, what);
    return {
      from: pair.from as string, to: pair.to as string, ...(pair.label !== undefined ? { label: words(pair.label, `${what}.label`) } : {}),
      ...(route ? { route } : {}), ...(dash ? { dash } : {}), ...(weight ? { weight } : {}), ...(pair.tail === true ? { tail: true } : {}),
    };
  });
  const shapes = list(v.shapes, "shapes").map((raw, i): DrawnShape => {
    const what = `shapes[${i}]`;
    const s = fields(raw, what);
    if (s.form === "image") refuse(`${what}: a picture is a box, { id, image, alt }`);
    if (!(SHAPE_FORMS as readonly unknown[]).includes(s.form)) refuse(`${what}.form must be one of ${SHAPE_FORMS.filter((f) => f !== "image").join(", ")}`);
    const form = s.form as ShapeForm;
    const color = colorOf(s.color, what);
    if (s.size !== undefined && !(SHAPE_TEXT_SIZES as readonly unknown[]).includes(s.size)) refuse(`${what}.size must be one of ${SHAPE_TEXT_SIZES.join(", ")}`);
    const size = s.size as ShapeTextSize | undefined;
    const filled = yes(s.filled);
    const head = yes(s.head);
    const style = lineStyleOf(s, what);
    if (isStroke(form)) return { form, points: pointsOf(s.points, what), ...(color ? { color } : {}), ...(head !== undefined ? { head } : {}), ...style, ...(form === "pen" && s.marker === true ? { marker: true } : {}) };
    const text = s.text === undefined ? undefined : words(s.text, `${what}.text`);
    if (form === "text" && !text) refuse(`${what} is text: say it`);
    return {
      form, x: coord(s.x ?? 0, `${what}.x`), y: coord(s.y ?? 0, `${what}.y`),
      ...(s.w !== undefined ? { w: coord(s.w, `${what}.w`) } : {}), ...(s.h !== undefined ? { h: coord(s.h, `${what}.h`) } : {}),
      ...(text !== undefined ? { text } : {}), ...(size ? { size } : {}), ...(color ? { color } : {}), ...(filled !== undefined ? { filled } : {}), ...style,
    };
  });
  const keep = list(v.keep, "keep").map((id, i) => (typeof id === "string" && id ? id : refuse(`keep[${i}] must be an id`)));
  if (boxes.length + links.length + shapes.length + keep.length === 0 && !v.title) refuse("nothing to draw: give boxes and links, or shapes");
  if (boxes.length + links.length + shapes.length + 1 > MAX_SHAPES_DRAWN) refuse(`a drawing takes at most ${MAX_SHAPES_DRAWN} shapes and links`);
  if (v.direction !== undefined && v.direction !== "right" && v.direction !== "down") refuse("direction must be right or down");
  const at = v.at === undefined ? undefined : fields(v.at, "at");
  return {
    ...(v.title !== undefined ? { title: words(v.title, "title") } : {}),
    ...(v.direction ? { direction: v.direction as DrawAsked["direction"] & string } : {}),
    boxes, links, shapes,
    ...(at ? { at: { x: coord(at.x, "at.x"), y: coord(at.y, "at.y") } } : {}),
    ...(typeof v.near === "string" ? { near: v.near } : {}),
    ...(typeof v.frame === "string" ? { frame: v.frame } : {}),
    ...(typeof v.update === "string" ? { update: v.update } : {}),
    ...(keep.length ? { keep } : {}),
  };
}

// ── placing boxes and links ──────────────────────────────────────────

const RANK_GAP = 112;
const RANK_GAP_DOWN = 72;
const ROW_GAP = 40;
const LABEL_ROOM = 6;
const CHAR = 7.4;
const LINE = 20;

/** A box big enough for its words, in wrapped lines. */
export function boxSizeFor(text: string): { w: number; h: number } {
  const lines = wrapLines(text, 28);
  const longest = Math.max(0, ...lines.map((l) => l.length));
  return { w: Math.min(280, Math.max(120, Math.ceil(longest * CHAR) + 36)), h: Math.max(56, lines.length * LINE + 28) };
}

/** A box's size grown for a form whose slanted or curved sides leave its words less room. */
function roomFor(form: BoxForm | undefined, size: { w: number; h: number }): { w: number; h: number } {
  switch (form) {
    case "triangle":
    case "star": return { w: Math.round(size.w * 1.5), h: Math.round(size.h * 1.6) };
    case "hexagon":
    case "parallelogram": return { w: Math.round(size.w * 1.25), h: size.h };
    case "cloud": return { w: Math.round(size.w * 1.3), h: Math.round(size.h * 1.5) };
    case "cylinder": return { w: size.w, h: size.h + 28 };
    default: return size;
  }
}

/** Words as lines of at most `width` characters, breaking inside only a word too long for one. */
export function wrapLines(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      let rest = word;
      if (line && line.length + 1 + rest.length > width) { out.push(line); line = ""; }
      while (rest.length > width) { out.push(rest.slice(0, width)); rest = rest.slice(width); }
      line = line ? `${line} ${rest}` : rest;
    }
    out.push(line);
  }
  return out;
}

/**
 * Where each box goes, from a corner at the origin: in ranks along `direction` by the links
 * between them, a link's target after its source, and each rank ordered to keep links short. A
 * link that closes a cycle is left out of the ranking, not refused.
 */
export function placeBoxes(boxes: readonly DrawnBox[], links: readonly DrawnLink[], direction: "right" | "down" = "right"): Map<string, Rect> {
  const ids = new Set(boxes.map((b) => b.id));
  const after = new Map<string, string[]>(boxes.map((b) => [b.id, []]));
  const seen = new Map<string, "going" | "done">();
  const inner = links.filter((l) => ids.has(l.from) && ids.has(l.to) && l.from !== l.to);
  for (const l of inner) after.get(l.from)!.push(l.to);
  const acyclic: Array<[string, string]> = [];
  const walk = (id: string): void => {
    seen.set(id, "going");
    for (const next of after.get(id)!) {
      if (seen.get(next) === "going") continue;
      acyclic.push([id, next]);
      if (!seen.has(next)) walk(next);
    }
    seen.set(id, "done");
  };
  const hasSource = new Set(inner.map((l) => l.to));
  for (const b of boxes) if (!hasSource.has(b.id) && !seen.has(b.id)) walk(b.id);
  for (const b of boxes) if (!seen.has(b.id)) walk(b.id);

  // Longest path from a box nothing leads to.
  const rank = new Map<string, number>(boxes.map((b) => [b.id, 0]));
  for (let pass = 0; pass < boxes.length; pass++) {
    let moved = false;
    for (const [from, to] of acyclic) {
      if (rank.get(to)! <= rank.get(from)!) { rank.set(to, rank.get(from)! + 1); moved = true; }
    }
    if (!moved) break;
  }

  const ranks: string[][] = [];
  for (const b of boxes) (ranks[rank.get(b.id)!] ??= []).push(b.id);
  const before = new Map<string, string[]>(boxes.map((b) => [b.id, []]));
  for (const [from, to] of acyclic) before.get(to)!.push(from);
  const onward = new Map<string, string[]>(boxes.map((b) => [b.id, []]));
  for (const [from, to] of acyclic) onward.get(from)!.push(to);
  // Fewer crossings: each box by the middle of what leads to it, then of what it leads to, then the first again.
  const place = new Map<string, number>();
  ranks.forEach((list) => list?.forEach((id, i) => place.set(id, i)));
  for (const neighbours of [before, onward, before]) {
    const lists = neighbours === onward ? [...ranks].reverse() : ranks;
    for (const list of lists) {
      if (!list) continue;
      const middle = (id: string): number => {
        const beside = neighbours.get(id)!;
        return beside.length ? beside.reduce((sum, n) => sum + place.get(n)!, 0) / beside.length : place.get(id)!;
      };
      const order = new Map(list.map((id) => [id, middle(id)]));
      list.sort((a, b) => order.get(a)! - order.get(b)!);
      list.forEach((id, i) => place.set(id, i));
    }
  }

  const sizes = new Map(boxes.map((b) => [b.id, b.image ? (b.width ? { w: Math.round(b.width), h: Math.max(1, Math.round((b.width * b.image.height) / b.image.width)) } : imageBoxSize(b.image, DRAWN_IMAGE_MOST)) : roomFor(b.form, boxSizeFor(b.text))]));
  const across = direction === "right" ? "h" : "w";
  const along = direction === "right" ? "w" : "h";
  const extents = ranks.map((list) => (list ?? []).reduce((sum, id) => sum + sizes.get(id)![across] + ROW_GAP, -ROW_GAP));
  const widest = Math.max(0, ...extents);
  const labelled = links.some((l) => l.label);
  const out = new Map<string, Rect>();
  let far = 0;
  ranks.forEach((list, r) => {
    if (!list) return;
    let near = (widest - extents[r]!) / 2;
    const deepest = Math.max(...list.map((id) => sizes.get(id)![along]));
    for (const id of list) {
      const s = sizes.get(id)!;
      const inRank = far + (deepest - s[along]) / 2;
      out.set(id, direction === "right" ? { x: inRank, y: near, ...s } : { x: near, y: inRank, ...s });
      near += s[across] + ROW_GAP;
    }
    far += deepest + (direction === "right" ? RANK_GAP : RANK_GAP_DOWN) + (labelled ? LABEL_ROOM * 4 : 0);
  });
  return out;
}

/** A corner for a `size` box at `start` or further along where nothing in `taken` is. */
export function freeCorner(start: Point, size: { w: number; h: number }, taken: readonly Rect[], gap = 48): Point {
  let x = start.x;
  for (let tries = 0; tries <= taken.length; tries++) {
    const box = { x: x - gap, y: start.y - gap, w: size.w + gap * 2, h: size.h + gap * 2 };
    const blockers = taken.filter((t) => rectsTouch(box, t));
    if (!blockers.length) break;
    x = Math.max(...blockers.map((t) => t.x + t.w)) + gap;
  }
  return { x, y: start.y };
}

/** What is drawn, from a corner at the origin, not yet on the board. `end`s name a box or something already there. */
export interface Sketch {
  shapes: Array<Omit<ShapeObject, "id" | "kind" | "z"> & { box?: string }>;
  links: DrawnLink[];
  size: { w: number; h: number };
}

const TITLE_ROOM = 44;

const lineStyleSaid = (s: { dash?: ShapeDash; weight?: ShapeWeight; rough?: boolean }): { dash?: ShapeDash; weight?: ShapeWeight; rough?: boolean } =>
  ({ ...(s.dash ? { dash: s.dash } : {}), ...(s.weight ? { weight: s.weight } : {}), ...(s.rough ? { rough: true } : {}) });

/** `asked` as shapes in place from the origin: its title, its boxes where `placeBoxes` puts them, and its shapes where it says. */
export function sketchOf(asked: DrawAsked): Sketch {
  const boxes = asked.boxes ?? [];
  const links = asked.links ?? [];
  const places = placeBoxes(boxes, links, asked.direction);
  const down = asked.title ? TITLE_ROOM : 0;
  const shapes: Sketch["shapes"] = [];
  if (asked.title) {
    shapes.push({ form: "text", x: 0, y: 0, w: Math.max(200, asked.title.length * 12), h: 32, text: asked.title, size: "large" });
  }
  for (const b of boxes) {
    const r = places.get(b.id)!;
    if (b.image) {
      shapes.push({ form: "image", x: r.x, y: r.y + down, w: r.w, h: r.h, image: b.image, box: b.id, ...(b.alt ? { alt: b.alt } : {}) });
      continue;
    }
    shapes.push({ form: b.form ?? "rect", x: r.x, y: r.y + down, w: r.w, h: r.h, text: b.text, filled: b.filled ?? true, box: b.id, ...(b.color ? { color: b.color } : {}), ...lineStyleSaid(b) });
  }
  for (const s of asked.shapes ?? []) {
    if (s.points) {
      const box = strokeBox(s.points);
      shapes.push({ form: s.form, x: box.x, y: box.y + down, w: box.w, h: box.h, points: box.points, ...(s.color ? { color: s.color } : {}), ...(s.head ? { head: true } : {}), ...lineStyleSaid(s), ...(s.marker ? { marker: true } : {}) });
      continue;
    }
    const size = s.text ? boxSizeFor(s.text) : { w: 160, h: 80 };
    shapes.push({
      form: s.form, x: s.x ?? 0, y: (s.y ?? 0) + down, w: s.w ?? size.w, h: s.h ?? size.h,
      ...(s.text !== undefined ? { text: s.text } : {}), ...(s.size ? { size: s.size } : {}), ...(s.color ? { color: s.color } : {}), ...(s.filled ? { filled: true } : {}), ...lineStyleSaid(s),
    });
  }
  const bounds = boundsOf(shapes) ?? { x: 0, y: 0, w: 0, h: 0 };
  return { shapes, links, size: { w: bounds.x + bounds.w, h: bounds.y + bounds.h } };
}

// ── the board as a picture ───────────────────────────────────────────

export type PictureTheme = "dark" | "light";

/** How each colour is drawn on each theme. */
export const SHAPE_INK: Record<PictureTheme, Record<ShapeColor, string>> = {
  dark: { ink: "#d7d9de", blue: "#7cb3ff", green: "#6fd08c", yellow: "#e9c46a", orange: "#f4a261", red: "#f07167", purple: "#b794f6" },
  light: { ink: "#27272a", blue: "#2563eb", green: "#15803d", yellow: "#a16207", orange: "#c2410c", red: "#b91c1c", purple: "#7e22ce" },
};
const PICTURE_PAPER: Record<PictureTheme, { paper: string; line: string; muted: string }> = {
  dark: { paper: "#17181b", line: "#3a3c42", muted: "#8b8e96" },
  light: { paper: "#fbfbfa", line: "#d4d4d8", muted: "#71717a" },
};

export const inkOf = (color: string | undefined, theme: PictureTheme): string =>
  SHAPE_INK[theme][(SHAPE_COLORS as readonly string[]).includes(color ?? "") ? color as ShapeColor : "ink"];

/** A shape's text size, in pixels. */
export const textPixels = (size: ShapeTextSize | undefined): number => (size === "large" ? 22 : size === "small" ? 12 : 14);

/** A line's width, in pixels. One with no weight said keeps the width lines always had. */
export const strokePixels = (weight: ShapeWeight | undefined): number => (weight === "thin" ? 1.5 : weight === "medium" ? 2.5 : weight === "thick" ? 4.5 : 2);

const dashesOf = (dash: ShapeDash | undefined, px: number): string => {
  const pattern = dash && dash !== "solid" ? dashPattern(dash, px) : [];
  return pattern.length ? ` stroke-dasharray="${pattern.join(" ")}"` : "";
};

const escapeXml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Something else on the canvas a picture shows faintly: a tile, a frame, a note. */
export interface PictureAnchor extends Rect { id: string; name: string }

function curve(from: Point, fromSide: Side, to: Point, toSide: Side): string {
  const pull = (p: Point, side: Side, by: number): Point => ({
    x: p.x + (side === "left" ? -by : side === "right" ? by : 0),
    y: p.y + (side === "top" ? -by : side === "bottom" ? by : 0),
  });
  const by = Math.max(Math.hypot(to.x - from.x, to.y - from.y) / 3, 24);
  const [a, b] = [pull(from, fromSide, by), pull(to, toSide, by)];
  return `M${tenth(from.x)} ${tenth(from.y)}C${tenth(a.x)} ${tenth(a.y)} ${tenth(b.x)} ${tenth(b.y)} ${tenth(to.x)} ${tenth(to.y)}`;
}

/** Where an arrow meets a rect: the point said as fractions of its box, else the middle of the side. */
const endPoint = (r: Rect, side: Side, at: readonly [number, number] | undefined): Point =>
  (at ? { x: r.x + at[0] * r.w, y: r.y + at[1] * r.h } : sidePoint(r, side));

/** Straight runs with square turns: out of one side, across, and into the other. */
function elbow(from: Point, fromSide: Side, to: Point, toSide: Side): string {
  const flat = (side: Side): boolean => side === "left" || side === "right";
  const start = `M${tenth(from.x)} ${tenth(from.y)}`;
  const finish = `L${tenth(to.x)} ${tenth(to.y)}`;
  if (flat(fromSide) && flat(toSide)) {
    const turn = tenth((from.x + to.x) / 2);
    return `${start}H${turn}V${tenth(to.y)}${finish}`;
  }
  if (!flat(fromSide) && !flat(toSide)) {
    const turn = tenth((from.y + to.y) / 2);
    return `${start}V${turn}H${tenth(to.x)}${finish}`;
  }
  return flat(fromSide) ? `${start}H${tenth(to.x)}${finish}` : `${start}V${tenth(to.y)}${finish}`;
}

function textLines(text: string, box: Rect, px: number, color: string, centred: boolean): string {
  const lines = wrapLines(text, Math.max(4, Math.floor((box.w - 16) / (px * 0.53))));
  const height = px * 1.35;
  const top = centred ? box.y + box.h / 2 - ((lines.length - 1) * height) / 2 : box.y + px;
  const x = centred ? box.x + box.w / 2 : box.x;
  return `<text font-family="system-ui,sans-serif" font-size="${px}"${px > 18 ? ' font-weight="600"' : ""} fill="${color}"${centred ? ' text-anchor="middle" dominant-baseline="middle"' : ""}>${lines.map((l, i) => `<tspan x="${tenth(x)}" y="${tenth(top + i * height)}">${escapeXml(l)}</tspan>`).join("")}</text>`;
}

/**
 * The board as one SVG with plain colours, on the canvas's coordinates: its shapes and arrows on
 * `anchors` drawn faintly. `objects` hold canvas coordinates. Nothing in it runs or loads anything:
 * a picture is drawn from the `data:` URL `imageData` gives for it, else as a box with its alt text.
 */
export function boardPicture(objects: readonly BoardObject[], anchors: readonly PictureAnchor[], theme: PictureTheme = "dark", imageData: (image: BoardImage) => string | undefined = () => undefined): { svg: string; width: number; height: number } {
  const paper = PICTURE_PAPER[theme];
  const shapes = objects.filter((o): o is ShapeObject => o.kind === "shape");
  const arrows = objects.filter((o): o is ArrowObject => o.kind === "arrow");
  const rectOf = new Map<string, Rect>([...anchors.map((a): [string, Rect] => [a.id, a]), ...shapes.map((s): [string, Rect] => [s.id, s])]);
  const drawn = [...anchors, ...shapes];
  const bounds = boundsOf(drawn) ?? { x: 0, y: 0, w: 320, h: 180 };
  const pad = 32;
  const [x0, y0] = [bounds.x - pad, bounds.y - pad];
  const [width, height] = [Math.ceil(bounds.w + pad * 2), Math.ceil(bounds.h + pad * 2)];
  const parts: string[] = [`<rect x="${x0}" y="${y0}" width="${width}" height="${height}" fill="${paper.paper}"/>`];
  for (const a of anchors) {
    parts.push(`<rect x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" rx="10" fill="none" stroke="${paper.line}" stroke-width="2" stroke-dasharray="6 6"/>`);
    parts.push(textLines(a.name, { x: a.x + 12, y: a.y + 8, w: a.w - 24, h: 20 }, 13, paper.muted, false));
  }
  const markers = new Set<string>();
  const marker = (color: string): string => {
    const id = `head-${color.slice(1)}`;
    if (!markers.has(color)) {
      markers.add(color);
      parts.push(`<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${color}"/></marker>`);
    }
    return id;
  };
  for (const a of arrows) {
    const [from, to] = [rectOf.get(a.from.id), rectOf.get(a.to.id)];
    if (!from || !to) continue;
    const [p, q] = [endPoint(from, a.from.side, a.fromAt), endPoint(to, a.to.side, a.toAt)];
    const ink = inkOf(a.color, theme);
    const px = strokePixels(a.weight);
    const d = a.route === "straight" ? `M${tenth(p.x)} ${tenth(p.y)}L${tenth(q.x)} ${tenth(q.y)}`
      : a.route === "elbow" ? elbow(p, a.from.side, q, a.to.side)
        : curve(p, a.from.side, q, a.to.side);
    parts.push(`<path d="${d}" fill="none" stroke="${ink}" stroke-width="${px}" stroke-linejoin="round"${dashesOf(a.dash, px)}${a.tail ? ` marker-start="url(#${marker(ink)})"` : ""} marker-end="url(#${marker(ink)})"/>`);
    if (a.label) {
      const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
      // A label is one line, as wide as its words.
      const w = a.label.length * 7 + 12;
      parts.push(`<rect x="${tenth(mid.x - w / 2)}" y="${tenth(mid.y - 10)}" width="${w}" height="20" rx="4" fill="${paper.paper}"/>`);
      parts.push(`<text x="${tenth(mid.x)}" y="${tenth(mid.y)}" font-family="system-ui,sans-serif" font-size="12" fill="${ink}" text-anchor="middle" dominant-baseline="middle">${escapeXml(a.label)}</text>`);
    }
  }
  for (const s of [...shapes].sort((a, b) => (a.z ?? 0) - (b.z ?? 0))) {
    if (s.form === "image") {
      const data = s.image ? imageData(s.image) : undefined;
      if (data?.startsWith("data:image/")) {
        parts.push(`<image x="${tenth(s.x)}" y="${tenth(s.y)}" width="${tenth(s.w)}" height="${tenth(s.h)}" preserveAspectRatio="xMidYMid meet" href="${escapeXml(data)}"${s.alt ? ` aria-label="${escapeXml(s.alt)}"` : ""}/>`);
      } else {
        parts.push(`<rect x="${tenth(s.x)}" y="${tenth(s.y)}" width="${tenth(s.w)}" height="${tenth(s.h)}" fill="none" stroke="${paper.muted}" stroke-width="1.5" stroke-dasharray="4 4"/>`);
        parts.push(textLines(`Image: ${s.alt || "no description"}`, s, 13, paper.muted, true));
      }
      continue;
    }
    const ink = inkOf(s.color, theme);
    const d = shapeOutline(s);
    if (d) {
      const stroke = isStroke(s.form);
      const end = s.head ? ` marker-end="url(#${marker(ink)})"` : "";
      const highlighter = s.form === "pen" && s.marker === true;
      const px = highlighter ? strokePixels(s.weight) * 7 : strokePixels(s.weight);
      parts.push(`<path transform="translate(${tenth(s.x)} ${tenth(s.y)})" d="${d}" fill="${!stroke && s.filled ? ink : "none"}"${!stroke && s.filled ? ' fill-opacity="0.14"' : ""} stroke="${ink}" stroke-width="${px}"${highlighter ? ' stroke-opacity="0.35"' : ""} stroke-linecap="round" stroke-linejoin="round"${dashesOf(s.dash, px)}${end}/>`);
    }
    if (s.text) parts.push(textLines(s.text, s, textPixels(s.size), ink, s.form !== "text"));
  }
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0} ${y0} ${width} ${height}" width="${width}" height="${height}">${parts.join("")}</svg>`, width, height };
}
