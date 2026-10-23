/**
 * Text a program wrote, made safe to show as one line: a tile's last line, what an agent waits on
 * (docs/design/last-line-2026-10-23.md). The daemon that reads a line, the owner that keeps it
 * (`TileLines` in packages/host) and the row that draws it each pass it through here, and none of
 * them trusts the one before: a line also reaches the owner from a tile's own process (over the
 * control-plane socket) and from a daemon of an older version.
 */

/** The longest line told, in characters. */
export const LINE_MAX = 160;

/** C0 and C1 controls, and the bidi controls that would show a line as something it is not. */
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
/** Tabs and line breaks, which a line shows as a space. */
const BREAKS = /[\t\n\v\f\r\u2028\u2029]+/g;

/** `text` as one line of plain text: tabs and line breaks are spaces, controls go, and it is cut to
 *  `LINE_MAX` characters. Only its first `LINE_MAX * 4` code units are looked at, so a line of a
 *  megabyte costs what one of a few hundred does. */
export function oneLine(text: string): string {
  const head = text.length > LINE_MAX * 4 ? text.slice(0, LINE_MAX * 4) : text;
  const line = head.replace(BREAKS, " ").replace(UNSAFE, "").trim();
  // A string of at most LINE_MAX code units holds at most LINE_MAX characters.
  return line.length <= LINE_MAX ? line : [...line].slice(0, LINE_MAX).join("").trimEnd();
}
