/** What is wrong with a drawing as it sits on the board, said so an agent can fix it. Pure. */
import { boxSizeFor, textPixels, wrapLines, type Rect } from "./drawing.js";
import { isStroke, type BoardObject, type ShapeObject } from "./shapes.js";

export interface DrawProblem {
  kind: "overlap" | "text-overflow" | "loose-arrow" | "off-frame" | "too-small";
  ids: string[];
  say: string;
  fix: string;
}

export interface DrawSurroundings {
  /** Each frame's place on the canvas: a shape outside its own is a problem only when this is given. */
  frames?: ReadonlyMap<string, Rect>;
  /** Everything else an arrow may end on, by id (tiles, frames): an end on nothing is looked for only when this is given. */
  ends?: ReadonlySet<string>;
}

export const MAX_DRAW_PROBLEMS = 200;
const CELL = 256;
const SMALLEST = 24;
const PADDING = 36;

const named = (o: { id: string; text?: string }): string => {
  const first = (o.text ?? "").split("\n")[0]!.trim();
  return first ? `"${first.length > 40 ? `${first.slice(0, 40)}…` : first}" (${o.id})` : o.id;
};
const round = (n: number): number => Math.round(n);
const inside = (inner: Rect, outer: Rect): boolean =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
const overlapArea = (a: Rect, b: Rect): number =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/** The size a box needs for its words at its own width, or null when they fit. */
function roomNeeded(s: ShapeObject): { w: number; h: number } | null {
  if (!s.text) return null;
  const px = textPixels(s.size);
  const perLine = Math.floor((s.w - PADDING) / (px * 0.53));
  const lineHeight = px * 1.43;
  const lines = perLine >= 1 ? wrapLines(s.text, perLine) : [];
  const longestWord = Math.max(0, ...s.text.split(/\s+/).map((w) => w.length));
  const fits = perLine >= 1 && lines.length * lineHeight + 16 <= s.h && Math.min(longestWord, 28) <= perLine;
  if (fits) return null;
  const wanted = boxSizeFor(s.text);
  const scale = px / 14;
  return { w: Math.max(round(wanted.w * scale), round(s.w)), h: Math.max(round(wanted.h * scale), round(s.h)) };
}

/** Pairs of boxes that sit on each other, found through a grid so a full board is not compared pair by pair. */
function overlapping(boxes: readonly ShapeObject[]): Array<[ShapeObject, ShapeObject]> {
  const cells = new Map<string, number[]>();
  const pairs: Array<[ShapeObject, ShapeObject]> = [];
  const seen = new Set<number>();
  boxes.forEach((b, i) => {
    seen.clear();
    const [x0, x1, y0, y1] = [Math.floor(b.x / CELL), Math.floor((b.x + b.w) / CELL), Math.floor(b.y / CELL), Math.floor((b.y + b.h) / CELL)];
    // A box that covers a great many cells is a backdrop: it holds things, it does not collide with them.
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096) return;
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const key = `${cx}:${cy}`;
        const held = cells.get(key);
        if (!held) { cells.set(key, [i]); continue; }
        for (const j of held) {
          if (seen.has(j)) continue;
          seen.add(j);
          const other = boxes[j]!;
          const shared = overlapArea(b, other);
          if (shared <= 0 || inside(b, other) || inside(other, b)) continue;
          // A corner that only just touches is not worth a redraw.
          if (shared < 0.02 * Math.min(b.w * b.h, other.w * other.h)) continue;
          pairs.push([other, b]);
        }
        held.push(i);
      }
    }
  });
  return pairs;
}

/**
 * What is wrong with `objects`, in canvas coordinates: boxes on each other, words that do not fit,
 * arrows that end on nothing, shapes outside their frame and boxes too small to read. At most
 * MAX_DRAW_PROBLEMS, the first found.
 */
export function drawProblems(objects: readonly BoardObject[], around: DrawSurroundings = {}): DrawProblem[] {
  const problems: DrawProblem[] = [];
  const shapes = objects.filter((o): o is ShapeObject => o.kind === "shape");
  const boxes = shapes.filter((s) => !isStroke(s.form));

  for (const [a, b] of overlapping(boxes)) {
    const sideways = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const upDown = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    const move = sideways <= upDown
      ? { x: round(b.x >= a.x ? a.x + a.w + 24 : a.x - b.w - 24), y: round(b.y) }
      : { x: round(b.x), y: round(b.y >= a.y ? a.y + a.h + 24 : a.y - b.h - 24) };
    problems.push({
      kind: "overlap", ids: [a.id, b.id],
      say: `${named(a)} and ${named(b)} sit on top of each other.`,
      fix: `Move one clear of the other: hive ctl board move ${b.id} --to ${move.x},${move.y}`,
    });
  }

  for (const s of boxes) {
    if (s.form === "text") continue;
    if (s.w < SMALLEST || s.h < SMALLEST) {
      problems.push({
        kind: "too-small", ids: [s.id],
        say: `${named(s)} is ${round(s.w)} by ${round(s.h)}: too small to read.`,
        fix: s.text ? `Draw it again at least ${boxSizeFor(s.text).w} by ${boxSizeFor(s.text).h}.` : `Draw it again at least ${SMALLEST * 2} by ${SMALLEST * 2}, or erase it: hive ctl erase ${s.id}`,
      });
      continue;
    }
    const room = roomNeeded(s);
    if (room) {
      problems.push({
        kind: "text-overflow", ids: [s.id],
        say: `The words in ${named(s)} do not fit its ${round(s.w)} by ${round(s.h)} box.`,
        fix: `Make the box at least ${room.w} by ${room.h}, or say it in fewer words.`,
      });
    }
  }

  if (around.ends) {
    const here = new Set(objects.map((o) => o.id));
    for (const o of objects) {
      if (o.kind !== "arrow") continue;
      const loose = [o.from.id, o.to.id].filter((end) => !here.has(end) && !around.ends!.has(end));
      if (loose.length === 0) continue;
      problems.push({
        kind: "loose-arrow", ids: [o.id],
        say: `Arrow ${named({ id: o.id, text: o.label })} ends on ${loose.join(" and ")}, which ${loose.length > 1 ? "are" : "is"} not on the board.`,
        fix: `Erase it (hive ctl erase ${o.id}) and connect what you meant: hive ctl board connect <from> <to>`,
      });
    }
  }

  if (around.frames) {
    for (const s of shapes) {
      const frame = s.frame ? around.frames.get(s.frame) : undefined;
      if (!frame || inside(s, frame)) continue;
      problems.push({
        kind: "off-frame", ids: [s.id, s.frame!],
        say: `${named(s)} belongs to frame ${s.frame} but sits outside it.`,
        fix: `Move it inside: hive ctl board move ${s.id} --to ${round(Math.min(Math.max(s.x, frame.x + 24), Math.max(frame.x + 24, frame.x + frame.w - s.w - 24)))},${round(Math.min(Math.max(s.y, frame.y + 24), Math.max(frame.y + 24, frame.y + frame.h - s.h - 24)))}`,
      });
    }
  }

  return problems.slice(0, MAX_DRAW_PROBLEMS);
}
