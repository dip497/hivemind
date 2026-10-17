// A sleeping agent's saved screen, drawn as lines of runs (tiles/saved-screen.ts): its escapes are
// read and never shown, its text stays text, colours come from the palette (the 256 and the RGB
// ones too), an inverse run swaps them, a wide character is one, and trailing blanks go.
import { test } from "node:test";
import assert from "node:assert/strict";
import { savedScreenLines } from "../../src/renderer/src/tiles/saved-screen.ts";

const palette = {
  background: "#000001", foreground: "#fffffe", cursor: "#fff", selection: "#333",
  ansi: ["#a00000", "#a00001", "#a00002", "#a00003", "#a00004", "#a00005", "#a00006", "#a00007", "#a00008", "#a00009", "#a0000a", "#a0000b", "#a0000c", "#a0000d", "#a0000e", "#a0000f"],
};

test("its escapes are read, not shown; its text stays text; colours are the palette's", async () => {
  const lines = await savedScreenLines("\x1b[31mred\x1b[0m <b>&amp;\r\n\x1b[1mbold\x1b[22m abc\x1b[2Dz", palette);
  assert.deepEqual(lines, [
    [{ text: "red", color: "#a00001" }, { text: " <b>&amp;" }],
    [{ text: "bold", bold: true }, { text: " azc" }],
  ]);
});

test("the 256 colours and RGB ones are drawn as they were; inverse swaps a run's colours", async () => {
  const lines = await savedScreenLines("\x1b[38;5;196mX\x1b[38;5;244mY\x1b[38;2;1;2;3mZ\x1b[0m\r\n\x1b[7mI\x1b[0m", palette);
  assert.deepEqual(lines, [
    [{ text: "X", color: "#ff0000" }, { text: "Y", color: "#808080" }, { text: "Z", color: "#010203" }],
    [{ text: "I", color: "#000001", background: "#fffffe" }],
  ]);
});

test("a wide character is drawn once; blanks at a line's end and blank lines at the end go, a coloured blank stays", async () => {
  const lines = await savedScreenLines("日本 ok   \r\n\x1b[41m  \x1b[0m\r\n\r\n\r\n", palette);
  assert.deepEqual(lines, [
    [{ text: "日本 ok" }],
    [{ text: "  ", background: "#a00001" }],
  ]);
});
