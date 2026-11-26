/** What a drawing is called, wherever it is listed: Layers and `hive ctl board`. Pure. */
import type { BoardObject, ShapeForm, ShapeTextSize } from "./shapes.js";

const FORM_NAMES: Record<ShapeForm, string> = {
  rect: "Box", ellipse: "Ellipse", diamond: "Diamond", text: "Text", line: "Line", pen: "Pen stroke", triangle: "Triangle",
  hexagon: "Hexagon", cylinder: "Cylinder", cloud: "Cloud", star: "Star", parallelogram: "Parallelogram", image: "Image",
};

/** What one object is, in a word. */
export function objectKindName(o: BoardObject): string {
  if (o.kind !== "shape") return o.kind === "arrow" ? "Arrow" : "Widget";
  if (o.form === "line" && o.head) return "Arrow";
  if (o.form === "pen" && o.marker) return "Highlight";
  return FORM_NAMES[o.form] ?? "Shape";
}

export const TEXT_SIZE_RANK: Record<ShapeTextSize, number> = { small: 0, medium: 1, large: 2 };

export const firstLineOf = (text: string): string => text.split("\n", 1)[0]!.trim().slice(0, 80);

/** What an arrow's end is called: a shape's first line of text, else a tile's name. */
export function endNamer(objects: readonly BoardObject[], tiles: Iterable<{ id: string; name: string }> = []): (id: string) => string | undefined {
  const names = new Map<string, string>();
  for (const t of tiles) if (t.name.trim()) names.set(t.id, firstLineOf(t.name));
  for (const o of objects) {
    const words = o.kind === "shape" ? (o.text?.trim() || o.alt?.trim()) : undefined;
    if (words) names.set(o.id, firstLineOf(words));
  }
  return (id) => names.get(id);
}

/** A drawing's name: the first line of its largest text (the first of the largest); a lone arrow by what it joins
 *  ("API → Database"), else by its label; else what it is ("Arrow", "Box", "3 shapes"). */
export function drawingName(members: readonly BoardObject[], nameOf?: (id: string) => string | undefined): string {
  let title = "";
  let rank = -1;
  for (const o of members) {
    if (o.kind !== "shape" || !o.text?.trim()) continue;
    const r = TEXT_SIZE_RANK[o.size ?? "medium"] ?? 1;
    if (r > rank) { title = firstLineOf(o.text.trim()); rank = r; }
  }
  if (title) return title;
  const only = members.length === 1 ? members[0]! : undefined;
  if (only?.kind === "arrow") {
    const from = nameOf?.(only.from.id);
    const to = nameOf?.(only.to.id);
    if (from || to) return `${from ?? "?"} → ${to ?? "?"}`;
    if (only.label.trim()) return firstLineOf(only.label.trim());
  }
  return members.length === 1 ? objectKindName(members[0]!) : `${members.length} shapes`;
}
