/**
 * What a reattach's replay loses about the mouse.
 *
 * `SerializeAddon` writes the tracking mode an app turned on (`?1003h`) but not how it asked
 * for the coordinates to be encoded. An app that asked for SGR (`?1006h`) is then answered in
 * the original 1978 encoding, which it does not parse: its screen keeps updating and its
 * keyboard works, and nothing happens when you click or scroll — until a resize makes it ask
 * again. Re-emitted after the replay so the client's terminal reports the way the app expects.
 */
export function mouseEncodingSeq(term: unknown): string {
  const t = term as {
    modes?: { mouseTrackingMode?: string };
    _core?: { coreMouseService?: { activeEncoding?: string } };
  } | null;
  if (!t?.modes || !t.modes.mouseTrackingMode || t.modes.mouseTrackingMode === "none") return "";
  switch (t._core?.coreMouseService?.activeEncoding) {
    case "SGR": return "\x1b[?1006h";
    case "SGR_PIXELS": return "\x1b[?1016h";
    default: return "";
  }
}
