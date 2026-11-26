import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { CodeSymbol, LanguageId } from "../src/contract.js";
import { nodeSyntax } from "../src/syntax-node.js";

const fixture = fs.readFileSync(path.join(import.meta.dir, "fixtures", "server-pool.ts.txt"), "utf8");
const brief = (symbols: CodeSymbol[]): unknown[] => symbols.map((s) => s.children.length ? [s.kind, s.name, brief(s.children)] : [s.kind, s.name]);

describe("the syntax provider", () => {
  test("outlines a real TypeScript file, members under their class or interface", async () => {
    const { outline } = await nodeSyntax().read("typescript", fixture);
    expect(brief(outline)).toEqual([
      ["interface", "Stoppable", [["method", "stop"]]],
      ["interface", "Live", [["property", "server"], ["property", "usedAt"], ["property", "idle"]]],
      ["interface", "PoolOptions", [["property", "cap"], ["property", "idleMs"], ["method", "onStop"]]],
      ["class", "ServerPool", [
        ["field", "live"], ["field", "cap"], ["field", "idleMs"], ["field", "tick"], ["constructor", "constructor"],
        ["method", "use"], ["method", "keys"], ["method", "servers"], ["method", "close"],
        ["method", "idleTimer"], ["method", "leastLately"], ["method", "stop"],
      ]],
    ]);
    const pool = outline[3]!;
    expect(pool.span.start.line).toBe(18);
    expect(pool.span.end.line).toBe(78);
    expect(pool.nameAt).toEqual({ line: 18, col: 13 });
  });

  test("folds the class from its first line to its last", async () => {
    const { folding } = await nodeSyntax().read("typescript", fixture);
    expect(folding).toContainEqual({ startLine: 18, endLine: 78 });
    expect(folding.every((f) => f.endLine > f.startLine)).toBe(true);
  });

  test.each([
    ["python", "class A:\n    def m(self):\n        pass\n\ndef f():\n    pass\n", [["class", "A", [["method", "m"]]], ["function", "f"]]],
    ["rust", "struct S { a: i32 }\nimpl S {\n    fn new() -> S { S { a: 1 } }\n}\n", [["class", "S", [["field", "a"]]], ["class", "impl S", [["method", "new"]]]]],
    ["go", "package p\ntype S struct {\n\tA int\n}\nfunc (s S) M() {}\n", [["class", "S", [["field", "A"]]], ["method", "M"]]],
    ["java", "class A {\n  A() {}\n  void m() {}\n}\n", [["class", "A", [["constructor", "A"], ["method", "m"]]]]],
    ["tsx", "export const App = () => <div>hi</div>;\n", [["function", "App"]]],
  ] as [LanguageId, string, unknown[]][])("outlines %s", async (language, text, expected) => {
    expect(brief((await nodeSyntax().read(language, text)).outline)).toEqual(expected);
  });
});
