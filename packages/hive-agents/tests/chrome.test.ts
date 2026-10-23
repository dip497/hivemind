// What claude's real binary (2.1.309) drew above its input, row by row: its own chrome, which a
// tile's last line passes over, and what it said, which is the line.
import { expect, test } from "bun:test";
import { authoredDefs } from "./authored.js";

const claude = authoredDefs().find((d) => d.id === "claude")!;

test("claude: its effort, its spinner and timer and what a turn's end says are its chrome; its messages are not", () => {
  const rows: Array<[row: string, chrome: boolean]> = [
    [`${" ".repeat(100)}◐ medium · /effort`, true],
    ["✻ Combobulating… ", true],
    ["* Newspapering… (2s · ↓ 2 tokens)", true],
    ["✻ Crunched for 2s · done 6:51 PM", true],
    ["● Hello! What can I help you with today?", false],
    ["● Reading the file… then the tests", false],
    ["  * a list item… in its answer", false],
    ["❯ hello there", false],
  ];
  expect(rows.map(([row]) => [row, claude.chrome!(row)])).toEqual(rows);
});
