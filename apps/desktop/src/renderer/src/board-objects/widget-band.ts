/**
 * The band of widget cards the window stacks down one edge of the screen. The widget layer lays
 * them out and sets it here, once per change; what must keep clear of the cards follows it: the
 * active view (protocol `widgetBand`, in its own pixels), the canvas framing a tile it flies to
 * (`FocusOnTile`), and the app's own corners through `--widgets-right-inset` on <html>, the width
 * of a column along the window's right edge (the toasts move left by it, as far as the window has
 * room: `--toasts-right-inset` in styles.css).
 */
import type { ViewWidgetBand } from "@hivemind/view-sdk/protocol";

/** `width` CSS px in from the window's `edge` to the far side of the cards, the gap included; 0
 *  when none is stacked there. */
export type WidgetBand = ViewWidgetBand;

const RIGHT_INSET = "--widgets-right-inset";
const NONE: WidgetBand = { edge: "right", width: 0 };
let band: WidgetBand | null = null;
const followers = new Set<(band: WidgetBand) => void>();

/** The band now. */
export function widgetBand(): WidgetBand {
  return band ?? NONE;
}

/** The cards were laid out again: tell whoever follows the band, when it moved. */
export function setWidgetBand(next: WidgetBand): void {
  if (band && band.edge === next.edge && band.width === next.width) return;
  band = { edge: next.edge, width: next.width };
  document.documentElement.style.setProperty(RIGHT_INSET, `${band.edge === "right" ? band.width : 0}px`);
  for (const cb of followers) cb(band);
}

/** `cb` with the band now, then on each change, until the returned function is called. */
export function followWidgetBand(cb: (band: WidgetBand) => void): () => void {
  followers.add(cb);
  cb(widgetBand());
  return () => { followers.delete(cb); };
}

/** The band as a view in `box` (its rect in the window) has it: the part of it over the view,
 *  from the view's own edge. */
export function bandOver(band: WidgetBand, box: { left: number; right: number }, windowW: number): WidgetBand {
  const inside = band.edge === "right" ? band.width - (windowW - box.right) : band.width - box.left;
  return { edge: band.edge, width: band.width > 0 ? Math.round(Math.min(Math.max(inside, 0), box.right - box.left)) : 0 };
}
