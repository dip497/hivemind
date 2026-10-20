// A plugin tile's console is read by an agent only when it asks (`tile look`), so the ring must
// hold the newest lines, oldest first, no more than CONSOLE_LINES of them, each cut to a size, and
// each tile's apart from another's.
import { expect, test } from "bun:test";
import { CONSOLE_LINES } from "@hivemind/workspace-api/plugins";
import { CONSOLE_LINE_CHARS, ConsoleRings } from "../src/console-ring";

test("it keeps the newest lines of each tile, oldest first, and drops the oldest past the limit", () => {
  const r = new ConsoleRings();
  for (let i = 0; i < CONSOLE_LINES + 5; i++) r.push("t1", "log", `line ${i}`, i);
  r.push("t2", "error", "other tile", 0);
  const lines = r.read("t1");
  expect(lines.length).toBe(CONSOLE_LINES);
  expect(lines[0]!.text).toBe("line 5");
  expect(lines.at(-1)!.text).toBe(`line ${CONSOLE_LINES + 4}`);
  expect(r.read("t2")).toEqual([{ level: "error", text: "other tile", at: 0 }]);
});

test("a huge line is cut, and a tile forgotten has none", () => {
  const r = new ConsoleRings();
  r.push("t1", "warn", "x".repeat(CONSOLE_LINE_CHARS * 3));
  expect(r.read("t1")[0]!.text.length).toBe(CONSOLE_LINE_CHARS + 1);
  r.forget("t1");
  expect(r.read("t1")).toEqual([]);
});
