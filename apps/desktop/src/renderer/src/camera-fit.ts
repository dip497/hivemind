/**
 * The zoom that frames a `w`×`h` rect in the pane, the way xyflow's fitView
 * would (numeric padding: the usable pane is `pane / (1 + padding)`).
 *
 * Focus uses this instead of reading the live zoom. A long pan animates by
 * zooming out mid-flight, so a zoom read while one flight is still running —
 * a new frame, then the shell spawned into it — is that dip, and taking it as
 * the next target ratcheted the canvas down to a fraction of 100%.
 */
export function focusZoom(w: number, h: number, paneW: number, paneH: number, padding = 0.18, maxZoom = 1): number {
  if (!(w > 0 && h > 0 && paneW > 0 && paneH > 0)) return maxZoom;
  return Math.min(maxZoom, paneW / (1 + padding) / w, paneH / (1 + padding) / h);
}

/**
 * How much of a pane `paneW` wide a tile is framed in while a column of widget cards floats along
 * the window's right edge: the cards reach `inset` px in from that edge, and the pane ends `paneGap`
 * px short of it. The rest is under the cards. Cards that would leave less than half the pane are
 * framed past, as if not there: a tile squeezed into a sliver of it helps no one.
 */
export function roomLeftOfCards(paneW: number, inset: number, paneGap: number): number {
  const room = paneW - Math.min(Math.max(inset - paneGap, 0), paneW);
  return room >= paneW / 2 ? room : paneW;
}

/** The pane a camera move frames into: its size, the width left of any widget cards, and the
 *  heights at its top and bottom that the tool island covers. */
export interface Room { paneW: number; paneH: number; roomW: number; top: number; bottom: number }

/**
 * Where the camera centre goes and at what zoom to show `box` whole and in the middle of the room
 * left free. `exact` holds 100% (text is sharp only there): a box too big for the room shows from
 * its left or top edge instead of its middle. Both land on whole screen pixels.
 */
export function cameraFor(box: { x: number; y: number; w: number; h: number }, room: Room, exact: boolean): { x: number; y: number; zoom: number } {
  const { paneW, paneH, roomW, top, bottom } = room;
  const covered = top + bottom;
  const roomH = Math.max(paneH - covered, paneH / 2);
  const zoom = exact ? 1 : focusZoom(box.w, box.h, roomW, roomH);
  // How far the camera centre sits from the room's, in screen px: right of the cards, off the island.
  const shiftX = (paneW - roomW) / 2;
  const shiftY = covered > 0 ? -((paneH - roomH) * (top - bottom)) / covered / 2 : 0;
  let x = box.x + box.w / 2 + shiftX / zoom;
  let y = box.y + box.h / 2 + shiftY / zoom;
  const PAD = 24;
  if (exact && paneW > 0 && box.w > roomW - 2 * PAD) x = box.x + paneW / 2 - PAD;
  if (exact && paneH > 0 && box.h > roomH - 2 * PAD) y = box.y + paneH / 2 - top - PAD;
  if (paneW > 0) x = (paneW / 2 - Math.round(paneW / 2 - x * zoom)) / zoom;
  if (paneH > 0) y = (paneH / 2 - Math.round(paneH / 2 - y * zoom)) / zoom;
  return { x, y, zoom };
}
