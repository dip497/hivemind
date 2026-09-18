// The matcher that replaced regexes in status rules. What is worth pinning here is the
// handful of edges a regex gives you for free and this deliberately does not: where a match
// may start, what a zero-width test does at the end of a line, and that nothing crosses one.
import { describe, expect, test } from "bun:test";
import { evalExpr, validateExpr, type Expr } from "../src/detect-rules.js";

const hit = (seq: Expr, text: string): boolean => evalExpr(seq, text);

describe("seq matches without an engine behind it", () => {
  test("terms run in order, anywhere on a line", () => {
    const e: Expr = { seq: [{ lit: "(" }, { run: "digit", min: 1 }, { lit: "s" }] };
    expect(hit(e, "done (12s) ok")).toBe(true);
    expect(hit(e, "done (s) ok")).toBe(false);   // the run needs at least one
    expect(hit(e, "12s")).toBe(false);           // the literal before it is not there
  });

  test("`at: start` means the start of the line, indentation included", () => {
    const e: Expr = { seq: [{ run: "❯>", min: 1, max: 1 }, { run: "space", min: 1, max: 1 }], at: "start" };
    expect(hit(e, "❯ ready")).toBe(true);
    expect(hit(e, "  ❯ ready")).toBe(false);
    expect(hit(e, "first\n❯ ready")).toBe(true); // every line gets its own try
  });

  test("nothing crosses a line break", () => {
    const e: Expr = { seq: [{ lit: "a" }, { run: "space", min: 1 }, { lit: "b" }] };
    expect(hit(e, "a b")).toBe(true);
    expect(hit(e, "a\nb")).toBe(false);
  });

  test("`notNext` is zero-width, and the end of a line satisfies it", () => {
    const e: Expr = { seq: [{ lit: ">" }, { run: "space", min: 1, max: 1 }, { notNext: "digit" }], at: "start" };
    expect(hit(e, "> x")).toBe(true);
    expect(hit(e, "> ")).toBe(true);   // nothing follows, so nothing forbidden follows
    expect(hit(e, "> 4")).toBe(false);
  });

  test("`upTo` takes everything through the next occurrence, within the line", () => {
    const e: Expr = { seq: [{ lit: "✻" }, { upTo: "…" }] };
    expect(hit(e, "✻ Thinking about it…")).toBe(true);
    expect(hit(e, "✻ Thinking about it")).toBe(false);
    expect(hit(e, "✻ Thinking\nabout it…")).toBe(false);
  });

  test("`any` takes the first alternative that fits, as an alternation would", () => {
    const e: Expr = { seq: [{ lit: "agent" }, { any: ["s", ""] }, { notNext: "word" }] };
    expect(hit(e, "3 agents ")).toBe(true);
    expect(hit(e, "3 agent ")).toBe(true);
    expect(hit(e, "3 agentic ")).toBe(false);
  });

  test("`ci` folds the haystack, so the rule must already be lower case", () => {
    expect(hit({ seq: [{ lit: "yes, allow" }], ci: true }, "2. YES, ALLOW")).toBe(true);
    expect(() => validateExpr({ seq: [{ lit: "Yes" }], ci: true })).toThrow(/must be lower case/);
  });

  test("a negated set is spelled with a leading !", () => {
    const e: Expr = { seq: [{ lit: "·" }, { run: "!space", min: 1 }] };
    expect(hit(e, "· x")).toBe(false);
    expect(hit(e, "·x")).toBe(true);
  });
});

// The shape a corpus of joined fuzz lines cannot produce, and the one that broke the port:
// a regex's `\s` matches the newline at the end of a line, a line-by-line matcher has no
// newline to match. `end` says what was meant instead of relying on that.
test("`end` matches where the line stops, which is where a regex's \\s found a newline", () => {
  const e: Expr = { seq: [{ run: "❯>", min: 1, max: 1 }, { end: true }], at: "start" };
  expect(hit(e, "❯")).toBe(true);
  expect(hit(e, "out\n❯")).toBe(true);
  expect(hit(e, "❯ ")).toBe(false); // a space is a character, not the end
});
