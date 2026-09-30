import { expect, test } from "bun:test";
import { splitAtBoundary } from "../src/vt-boundary.js";

test("a chunk that ends inside a sequence holds that sequence back", () => {
  expect(splitAtBoundary("hi \x1b[38;2;12")).toEqual(["hi ", "\x1b[38;2;12"]);
  expect(splitAtBoundary("hi \x1b[38;2;12;62;190m")).toEqual(["hi \x1b[38;2;12;62;190m", ""]);
  expect(splitAtBoundary("a\x1b")).toEqual(["a", "\x1b"]);
  expect(splitAtBoundary("a\x1b]0;title")).toEqual(["a", "\x1b]0;title"]);
  expect(splitAtBoundary("a\x1b]0;title\x07b")).toEqual(["a\x1b]0;title\x07b", ""]);
  expect(splitAtBoundary("a\x1bPq#0")).toEqual(["a", "\x1bPq#0"]);
  expect(splitAtBoundary("a\x1bPq#0\x1b\\")).toEqual(["a\x1bPq#0\x1b\\", ""]);
  expect(splitAtBoundary("a\x1b(")).toEqual(["a", "\x1b("]);
  expect(splitAtBoundary("a\x1b(B")).toEqual(["a\x1b(B", ""]);
  expect(splitAtBoundary("a\x1b7")).toEqual(["a\x1b7", ""]);
  expect(splitAtBoundary("plain")).toEqual(["plain", ""]);
});

test("any cut of a stream: the parts add back up, and none ends mid-sequence", () => {
  const stream = "x\x1b[1;31mred\x1b[0m\x1b]0;t\x07\x1b(B\x1b[?2004h\r\n\x1b[38;2;10;62;190mtc\x1b7\x1b8\x1bPq\x1b\\end";
  for (let a = 0; a <= stream.length; a++) {
    for (let b = a; b <= stream.length; b++) {
      let held = "";
      const out: string[] = [];
      for (const chunk of [stream.slice(0, a), stream.slice(a, b), stream.slice(b)]) {
        const [ready, rest] = splitAtBoundary(held + chunk);
        held = rest;
        out.push(ready);
      }
      out.push(held);
      expect(out.join("")).toBe(stream);
      for (const part of out.slice(0, -1)) expect(splitAtBoundary(part)[1]).toBe("");
    }
  }
});
