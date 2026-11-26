/** Plain flowchart text as a drawing: `A[Web app] --> B{Signed in?}: checks`, one statement a line. Pure. */
import type { DrawAsked, DrawnBox, DrawnLink } from "./drawing.js";
import { BOX_FORMS } from "./drawing.js";
import type { ArrowObject, ShapeObject } from "./shapes.js";

type TextLink = DrawnLink & { dash?: "solid" | "dashed" | "dotted" };

const LINK = /\s*(-\.->|-\.-|-->|---|==>)\s*(?:\|([^|]*)\|)?\s*/g;
const NODE = /^([\w.]+(?:-[\w.]+)*)\s*(\(\(.*?\)\)|\[.*?\]|\{.*?\}|\(.*?\))?\s*(?::\s*(.*))?$/;
const NODE_ID = /^[\w.]+(?:-[\w.]+)*$/;
/** `image name <hash>: alt`: a picture kept for the board, as a box. */
const IMAGE_LINE = /^image\s+([\w.]+(?:-[\w.]+)*)\s+([0-9a-f]{64})\s*(?::\s*(.*))?$/;
const DIRECTIONS: Record<string, "down" | "right"> = { down: "down", right: "right", td: "down", tb: "down", lr: "right" };

const refuse = (line: number, why: string): never => { throw new TypeError(`line ${line}: ${why}`); };

function unwrapped(shape: string): { text: string; form: NonNullable<DrawnBox["form"]> } {
  if (shape.startsWith("((")) return { text: shape.slice(2, -2).trim(), form: "ellipse" };
  if (shape.startsWith("{")) return { text: shape.slice(1, -1).trim(), form: "diamond" };
  return { text: shape.slice(1, -1).trim(), form: "rect" };
}

/** Words as written: quotes taken off, `<br>` a new line, `&#NN;` the character it numbers. */
const unquoted = (s: string): string => s.replace(/^"(.*)"$/, "$1").replace(/<br\s*\/?>/g, "\n").replace(/&#(\d{1,6});/g, (_, n: string) => String.fromCodePoint(Number(n)));
const numbered = (c: string): string => `&#${c.codePointAt(0)};`;
/** Words on one line as `unquoted` reads them back: what would read as a link, a comment, the end of a line, a line break or a number is numbered. */
const written = (s: string): string => s
  .replace(/&(?=#\d+;)|<(?=br)|^"(?=.*"$)|;$/g, numbered)
  .replace(/-(?=[-.>])|=(?==)|%(?=%)|\|/g, numbered)
  .replace(/\r?\n/g, "<br>");

/**
 * Flowchart text as what `board.draw` takes. A node is `id`, `id[Box]`, `id((Round))` or
 * `id{Choice}`; a link is `-->`, `---` or dashed `-.->`, labelled `A --> B: label` or
 * `A -->|label| B`; `direction down|right` says which way it runs. `group Name … end` keeps its
 * nodes and draws no box of its own. `image id <hash>: alt` is a picture kept for the board, as a
 * box links can end on. `keep id, id` names what else of a drawing an update leaves
 * as it is. A bare node `onBoard` says is already on the board (`me`, a tile) is where its links
 * end, not a box. What it cannot read is refused with its line (a TypeError).
 */
export function drawFromText(text: string, onBoard: (id: string) => boolean = () => false): DrawAsked {
  const boxes = new Map<string, DrawnBox>();
  const given = new Set<string>();
  const links: TextLink[] = [];
  const keep: string[] = [];
  let direction: DrawAsked["direction"];
  let title: string | undefined;

  const node = (raw: string, line: number): { id: string; label?: string } => {
    const m = NODE.exec(raw.trim());
    if (!m) return refuse(line, `cannot read "${raw.trim()}": a node is id, id[Box], id((Round)) or id{Choice}`);
    const id = m[1]!;
    const shape = m[2] ? unwrapped(m[2]) : undefined;
    if (shape) given.add(id);
    const held = boxes.get(id);
    if (!held) boxes.set(id, { id, text: unquoted(shape?.text ?? id), ...(shape && shape.form !== "rect" ? { form: shape.form } : {}) });
    else if (shape) boxes.set(id, { ...held, text: unquoted(shape.text), ...(shape.form !== "rect" ? { form: shape.form } : {}) });
    return { id, ...(m[3] ? { label: unquoted(m[3].trim()) } : {}) };
  };

  text.split("\n").forEach((rawLine, index) => {
    const n = index + 1;
    const line = rawLine.replace(/%%.*$/, "").replace(/(?<!&#\d{1,6});\s*$/, "").trim();
    if (!line || line.startsWith("#") || line === "end") return;
    const words = line.split(/\s+/);
    const first = words[0]!.toLowerCase();
    if (first === "flowchart" || first === "graph" || first === "direction") {
      const way = DIRECTIONS[(words[1] ?? "").toLowerCase()];
      if (way) direction = way;
      else if (first === "direction") refuse(n, "direction is down or right");
      return;
    }
    if (first === "title") { title = unquoted(line.slice(5).trim()); return; }
    if (first === "group" || first === "subgraph") return;
    const m = first === "image" ? IMAGE_LINE.exec(line) : null;
    if (m) {
      given.add(m[1]!);
      // The hash is checked, and found, where the drawing is read (`readDrawAsked`).
      boxes.set(m[1]!, { id: m[1]!, text: "", image: m[2]!, ...(m[3] ? { alt: unquoted(m[3].trim()) } : {}) } as unknown as DrawnBox);
      return;
    }
    if (first === "keep") {
      for (const id of line.slice(4).split(/[\s,]+/).filter(Boolean)) keep.push(NODE_ID.test(id) ? id : refuse(n, `keep takes ids: ${id}`));
      return;
    }

    const parts: string[] = [];
    const arrows: Array<{ kind: string; label?: string }> = [];
    let from = 0;
    LINK.lastIndex = 0;
    for (let m = LINK.exec(line); m; m = LINK.exec(line)) {
      parts.push(line.slice(from, m.index));
      arrows.push({ kind: m[1]!, ...(m[2] ? { label: m[2].trim() } : {}) });
      from = m.index + m[0].length;
    }
    parts.push(line.slice(from));
    const nodes = parts.map((p) => node(p, n));
    arrows.forEach((arrow, i) => {
      const label = arrow.label ?? nodes[i + 1]!.label;
      links.push({
        from: nodes[i]!.id, to: nodes[i + 1]!.id,
        ...(label ? { label: unquoted(label) } : {}),
        ...(arrow.kind.startsWith("-.") ? { dash: "dashed" as const } : {}),
      });
    });
  });

  for (const id of [...boxes.keys()]) if (!given.has(id) && onBoard(id)) boxes.delete(id);
  if (boxes.size === 0 && links.length === 0 && keep.length === 0) throw new TypeError("nothing to draw: write nodes and links, as in `A[Web app] --> B[API]: login`");
  return { ...(title ? { title } : {}), ...(direction ? { direction } : {}), boxes: [...boxes.values()], links, shapes: [], ...(keep.length ? { keep } : {}) };
}

/** Whether a shape is a drawing's title, as `sketchOf` draws one. */
export const isTitle = (s: ShapeObject): boolean => s.form === "text" && s.size === "large";

/** Whether a shape is a box flowchart text can name. */
export const isBox = (s: ShapeObject): boolean => (BOX_FORMS as readonly string[]).includes(s.form);

const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, " ");

/** Which way a drawing runs, from how its arrows between its own boxes leave them: down when most go out of a box's top or bottom. */
function directionOf(shapes: readonly ShapeObject[], arrows: readonly ArrowObject[]): "down" | null {
  const own = new Set(shapes.map((s) => s.id));
  const between = arrows.filter((a) => own.has(a.from.id) && own.has(a.to.id));
  const upright = between.filter((a) => a.from.side === "top" || a.from.side === "bottom").length;
  return between.length > 0 && upright * 2 > between.length ? "down" : null;
}

/**
 * A drawing's shapes and arrows as the flowchart text `drawFromText` reads: its title, each box by
 * its key (its id when it has none or shares one), each link with what outside the drawing it
 * ends on by id, then `keep` for what text cannot say (a pen stroke, a line). Read back as an
 * update of the drawing, it changes nothing.
 */
export function textOfDrawing(members: ReadonlyArray<ShapeObject | ArrowObject>): string {
  const byZ = [...members].sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
  const shapes = byZ.filter((m): m is ShapeObject => m.kind === "shape");
  const title = shapes.find(isTitle);
  const boxes = shapes.filter((s) => s !== title && (isBox(s) || (s.form === "image" && s.image)));
  const used = new Map<string, number>();
  for (const b of boxes) if (b.key) used.set(b.key, (used.get(b.key) ?? 0) + 1);
  const ids = new Set(members.map((m) => m.id));
  const nameOf = new Map(boxes.map((b) => [b.id, b.key && used.get(b.key) === 1 && NODE_ID.test(b.key) && !ids.has(b.key) ? b.key : b.id]));
  const lines: string[] = [];
  if (title?.text) lines.push(`title ${written(oneLine(title.text))}`);
  const way = directionOf(shapes, byZ.filter((m): m is ArrowObject => m.kind === "arrow"));
  if (way) lines.push(`direction ${way}`);
  for (const b of boxes) {
    if (b.form === "image") {
      lines.push(`image ${nameOf.get(b.id)} ${b.image!.hash}${b.alt ? `: ${written(oneLine(b.alt))}` : ""}`);
      continue;
    }
    const words = written(b.text ?? "");
    lines.push(`${nameOf.get(b.id)}${b.form === "ellipse" ? `((${words}))` : b.form === "diamond" ? `{${words}}` : `[${words}]`}`);
  }
  for (const m of byZ) {
    if (m.kind !== "arrow") continue;
    const end = (id: string): string => nameOf.get(id) ?? id;
    lines.push(`${end(m.from.id)} ${m.dash === "dashed" || m.dash === "dotted" ? "-.->" : "-->"} ${end(m.to.id)}${m.label ? `: ${written(oneLine(m.label))}` : ""}`);
  }
  const kept = shapes.filter((s) => s !== title && !boxes.includes(s)).map((s) => s.id);
  if (kept.length) lines.push(`keep ${kept.join(", ")}`);
  return `${lines.join("\n")}\n`;
}
