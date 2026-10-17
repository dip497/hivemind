// A sleeping agent's saved screen (tiles/saved-screen.ts) is drawn at the size its terminal last had:
// an agent that draws the whole screen, as Claude does, keeps every row of it, and its lines end
// where they did, whatever size the terminal drawing it had before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { drawSaved } from "../../src/renderer/src/tiles/saved-screen.ts";

// A CommonJS package, which names nothing for an import.
const { Terminal } = createRequire(import.meta.url)("@xterm/headless") as typeof import("@xterm/headless");

test("a full-screen agent's saved screen shows every row, each as wide as it was", async () => {
  const cols = 120, rows = 36;
  const screen = [...Array.from({ length: rows - 2 }, (_, i) => `row ${i + 1}`), "─".repeat(cols), "❯"];
  // What it printed before taking the whole screen, then the screen it drew there.
  const replay = `before it took the screen\r\n\x1b[?1049h\x1b[H${screen.join("\r\n")}`;
  const term = new Terminal({ cols: 400, rows: 24, allowProposedApi: true });
  await drawSaved(term, { replay, cols, rows });
  const buffer = term.buffer.active;
  const shown = Array.from({ length: term.rows }, (_, y) => buffer.getLine(buffer.viewportY + y)?.translateToString(true));
  assert.deepEqual(shown, screen);
  term.dispose();
});
