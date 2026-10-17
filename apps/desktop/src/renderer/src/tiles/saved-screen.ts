import * as Headless from "@xterm/headless";
import type { IBufferCell } from "@xterm/headless";
import type { TerminalPalette } from "@hivemind/core/settings-schema";

// Not bundled (node), its CommonJS build names it only on `default`.
const Terminal = Headless.Terminal ?? (Headless as unknown as { default: typeof Headless }).default.Terminal;

/** A stretch of one line of a saved screen, drawn one way. No colour: the tile's own. */
export interface Run {
  text: string;
  color?: string;
  background?: string;
  bold?: true;
  faint?: true;
  italic?: true;
  underline?: true;
}

// Wide enough that no saved line wraps again.
const COLS = 400;
const SCROLLBACK = 5000;

/** What the saved screen `replay` draws, line by line, in the palette's colours: its escapes are
 *  read, never shown, and its text stays text. Trailing blanks and blank lines are left out. */
export function savedScreenLines(replay: string, palette: TerminalPalette): Promise<Run[][]> {
  const term = new Terminal({ cols: COLS, rows: 24, scrollback: SCROLLBACK, allowProposedApi: true });
  return new Promise((resolve) => term.write(replay, () => {
    const buffer = term.buffer.active;
    const cell = buffer.getNullCell();
    const lines: Run[][] = [];
    for (let y = 0; y < buffer.length; y++) {
      const line = buffer.getLine(y);
      const runs: Run[] = [];
      for (let x = 0; line && x < line.length; x++) {
        line.getCell(x, cell);
        // The second half of a wide character.
        if (cell.getWidth() === 0) continue;
        const run: Run = { text: cell.getChars() || " ", ...lookOf(cell, palette) };
        const last = runs.at(-1);
        if (last && sameLook(last, run)) last.text += run.text;
        else runs.push(run);
      }
      lines.push(withoutTrailingBlanks(runs));
    }
    term.dispose();
    while (lines.length && !lines.at(-1)!.length) lines.pop();
    resolve(lines);
  }));
}

function lookOf(cell: IBufferCell, palette: TerminalPalette): Omit<Run, "text"> {
  let color = cell.isFgDefault() ? undefined : colorOf(cell.isFgRGB(), cell.getFgColor(), palette);
  let background = cell.isBgDefault() ? undefined : colorOf(cell.isBgRGB(), cell.getBgColor(), palette);
  if (cell.isInverse()) [color, background] = [background ?? palette.background, color ?? palette.foreground];
  return {
    ...(color ? { color } : {}),
    ...(background ? { background } : {}),
    ...(cell.isBold() ? { bold: true as const } : {}),
    ...(cell.isDim() ? { faint: true as const } : {}),
    ...(cell.isItalic() ? { italic: true as const } : {}),
    ...(cell.isUnderline() ? { underline: true as const } : {}),
  };
}

function colorOf(rgb: boolean, value: number, palette: TerminalPalette): string {
  if (rgb) return `#${value.toString(16).padStart(6, "0")}`;
  if (value < 16) return palette.ansi[value] ?? palette.foreground;
  if (value >= 232) {
    const v = 8 + (value - 232) * 10;
    return hex(v, v, v);
  }
  const i = value - 16;
  const level = (n: number) => (n === 0 ? 0 : 55 + n * 40);
  return hex(level(Math.floor(i / 36)), level(Math.floor(i / 6) % 6), level(i % 6));
}

const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;

const sameLook = (a: Run, b: Run) =>
  a.color === b.color && a.background === b.background && a.bold === b.bold && a.faint === b.faint && a.italic === b.italic && a.underline === b.underline;

/** Spaces at the end of a line drawn with no background are not drawn. */
function withoutTrailingBlanks(runs: Run[]): Run[] {
  while (runs.length) {
    const last = runs.at(-1)!;
    if (last.background || last.underline) break;
    const text = last.text.replace(/ +$/, "");
    if (text) { last.text = text; break; }
    runs.pop();
  }
  return runs;
}
