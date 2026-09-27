/**
 * Output is cut into chunks wherever the PTY read happened to end, which can be the middle of an
 * escape sequence. A terminal that is sent the screen between two such chunks and then the rest
 * of the stream would print the sequence's second half as text. Cutting only where a sequence
 * ends keeps every chunk boundary a place a screen can be taken.
 */

/** A sequence that never ends (a runaway string) is let through past this size. */
const HOLD_MAX = 1 << 20;

const isFinal = (c: number) => c >= 0x40 && c <= 0x7e;

/** Where the sequence starting at `i` (an ESC) ends, or -1 when `text` stops before it does. */
function sequenceEnd(text: string, i: number): number {
  if (i + 1 >= text.length) return -1;
  const c = text.charCodeAt(i + 1);
  if (c === 0x5b) { // CSI: parameters and intermediates, then a final byte
    for (let j = i + 2; j < text.length; j++) {
      const k = text.charCodeAt(j);
      if (isFinal(k)) return j + 1;
      if (k < 0x20 || k > 0x3f) return j; // not a CSI after all: nothing to hold
    }
    return -1;
  }
  // OSC, DCS, APC, PM, SOS: a string, ended by ST (ESC \) or, for OSC, BEL.
  if (c === 0x5d || c === 0x50 || c === 0x5f || c === 0x5e || c === 0x58) {
    for (let j = i + 2; j < text.length; j++) {
      const k = text.charCodeAt(j);
      if (k === 0x07 && c === 0x5d) return j + 1;
      if (k === 0x1b) return j + 1 < text.length ? j + 2 : -1;
    }
    return -1;
  }
  if (c >= 0x20 && c <= 0x2f) return i + 2 < text.length ? i + 3 : -1; // ESC ( B and the like
  return i + 2;
}

/** The part of `text` that ends on a sequence boundary, and what to hold for the next chunk. */
export function splitAtBoundary(text: string): [ready: string, held: string] {
  for (let i = text.indexOf("\x1b"); i >= 0; ) {
    const end = sequenceEnd(text, i);
    if (end < 0) return text.length - i > HOLD_MAX ? [text, ""] : [text.slice(0, i), text.slice(i)];
    i = text.indexOf("\x1b", end);
  }
  return [text, ""];
}
