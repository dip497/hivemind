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
