/** Render a plugin's icon from the manifest's closed shape vocabulary — the same set the
 *  app validates against, so this is a translation and not a trust decision. */
type Shape = Record<string, Record<string, string>>;
export type Icon = { viewBox: string; attrs?: Record<string, string>; shapes?: Shape[] };

const SHAPES = ["path", "rect", "circle", "ellipse"];
const ATTRS = ["d", "x", "y", "width", "height", "rx", "ry", "cx", "cy", "r", "fill", "stroke",
  "stroke-width", "stroke-linecap", "stroke-linejoin", "fill-rule", "clip-rule", "opacity", "transform"];
const ROOT = ["fill", "stroke", "opacity", "fill-rule", "clip-rule"];
const esc = (v: string) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
// Manifests are YAML written by people, so `fillRule` and `fill-rule` both occur; SVG wants the
// second, and dropping it turns an icon's cut-out into a filled blob.
const kebab = (k: string) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const attrsOf = (o: Record<string, string>, allowed: string[]) =>
  Object.entries(o).map(([k, v]) => [kebab(k), v] as const).filter(([k]) => allowed.includes(k))
    .map(([k, v]) => `${k}="${esc(v)}"`).join(" ");

export function mark(icon: Icon | undefined, size = 22): string | null {
  if (!icon?.viewBox || !icon.shapes?.length) return null;
  const body = icon.shapes.map((shape) => {
    const kind = SHAPES.find((k) => shape[k]);
    return kind ? `<${kind} ${attrsOf(shape[kind]!, ATTRS)} />` : "";
  }).join("");
  return `<svg width="${size}" height="${size}" viewBox="${esc(icon.viewBox)}" ${attrsOf(icon.attrs ?? {}, ROOT)} aria-hidden="true">${body}</svg>`;
}
