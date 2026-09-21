import { expect, test } from "bun:test";
import { cursorWordActive } from "../src/detect-helpers.js";

test("cursorWordActive reads the first word, ignoring trailing punctuation", () => {
  expect(cursorWordActive("  Thinking… (3s)")).toBe(true);
  expect(cursorWordActive("Reading`s")).toBe(false);
  expect(cursorWordActive("Compacting!!`")).toBe(true);
  expect(cursorWordActive("Done.")).toBe(false);
  expect(cursorWordActive("")).toBe(false);
});

test("cursorWordActive stays linear on a long run of non-letters", () => {
  const t = performance.now();
  expect(cursorWordActive(`ing${"`".repeat(50_000)}x`)).toBe(false);
  expect(cursorWordActive("`".repeat(50_000))).toBe(false);
  expect(performance.now() - t).toBeLessThan(100);
});
