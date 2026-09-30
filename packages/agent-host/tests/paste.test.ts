// A prompt is handed to a TUI the way a human pastes one — or, where that is not on, as a
// single line. What must never happen is a newline submitting half of it.
import { test, expect } from "bun:test";
import { pasteText } from "../src/paste.ts";

test("bracketed paste carries the whole text, newlines and all", () => {
  expect(pasteText("one\ntwo", true)).toBe("\x1b[200~one\ntwo\x1b[201~");
  // Text that ends the paste itself would leave its tail as keystrokes.
  expect(pasteText("one\x1b[201~rm -rf /", true)).toBe("\x1b[200~onerm -rf /\x1b[201~");
});

test("without bracketed paste the text goes in as one line", () => {
  expect(pasteText("one\ntwo\r\nthree\rfour", false)).toBe("one two three four");
  expect(pasteText("plain", false)).toBe("plain");
});
