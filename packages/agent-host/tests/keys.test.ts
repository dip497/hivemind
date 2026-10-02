// Typing key tokens into an agent's screen (keys.ts): each token as the bytes a terminal sends for
// it, the first at once and the rest a gap apart, so a TUI takes each one; nothing past a first
// key that found no terminal.
import { expect, test } from "bun:test";
import { KEY_GAP_MS, typeKeys } from "../src/keys.js";

test("the first key is typed at once and each next one after a gap, as the bytes its token names", async () => {
  const typed: string[] = [];
  expect(typeKeys((bytes) => { typed.push(bytes); return true; }, ["Down", "2", "Enter"])).toBe(true);
  expect(typed).toEqual(["\x1b[B"]);
  await Bun.sleep(KEY_GAP_MS * 3 + 100);
  expect(typed).toEqual(["\x1b[B", "2", "\r"]);
});

test("keys for a terminal that is not there are not typed, and say so", async () => {
  const typed: string[] = [];
  expect(typeKeys((bytes) => { typed.push(bytes); return false; }, ["1", "Enter"])).toBe(false);
  await Bun.sleep(KEY_GAP_MS * 2 + 100);
  expect(typed).toEqual(["1"]);
  expect(typeKeys(() => true, [])).toBe(false);
});
