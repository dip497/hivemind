import { afterAll, describe, expect, test } from "bun:test";
import path from "node:path";
import { SidecarClient } from "../src/sidecar-client.js";

const root = path.join(import.meta.dir, "fixtures", "project");
const square = path.join(root, "square.ts");
const sidecar = new SidecarClient();
afterAll(() => sidecar.close());

describe("the sidecar, as its own process", () => {
  test("outlines a file from disk at syntax accuracy", async () => {
    const r = await sidecar.ask({ question: "documentSymbol", root, file: square, language: "typescript" });
    expect(r).toMatchObject({ accuracy: "syntax", by: "tree-sitter" });
    const names = ("answer" in r ? r.answer as { name: string }[] : []).map((s) => s.name);
    expect(names).toEqual(["Square", "total"]);
  });

  // square.ts line 10: `export const total = areaOf(new Square(2)) + …`; `areaOf` starts at column 21.
  test("goes to a definition in another file through the workspace's own TypeScript", async () => {
    const r = await sidecar.ask({ question: "definition", root, file: square, language: "typescript", at: { line: 10, col: 22 } });
    expect(r).toMatchObject({ accuracy: "compiler" });
    expect("answer" in r ? r.answer : r).toEqual([
      { file: "shapes.ts", span: { start: { line: 5, col: 16 }, end: { line: 5, col: 22 } }, text: "export function areaOf(shape: Shape): number {" },
    ]);
  }, 60_000);

  test("finds every usage, and hovers with the type", async () => {
    const refs = await sidecar.ask({ question: "references", root, file: square, language: "typescript", at: { line: 10, col: 22 } });
    const where = ("answer" in refs ? refs.answer as { file: string; span: { start: { line: number } } }[] : []).map((l) => `${l.file}:${l.span.start.line}`).sort();
    expect(where).toEqual(["shapes.ts:5", "square.ts:1", "square.ts:10", "square.ts:10"]);
    const hover = await sidecar.ask({ question: "hover", root, file: square, language: "typescript", at: { line: 10, col: 22 } });
    expect("answer" in hover && (hover.answer as { text: string }).text).toContain("areaOf(shape: Shape): number");
  }, 60_000);

  test("a language server that dies is started again on the next question", async () => {
    const before = await sidecar.ask({ question: "servers" });
    const pid = ("servers" in before ? before.servers : [])[0]?.pid;
    expect(pid).toBeGreaterThan(0);
    process.kill(pid!, "SIGKILL");
    await Bun.sleep(300);
    const again = await sidecar.ask({ question: "definition", root, file: square, language: "typescript", at: { line: 10, col: 22 } });
    expect(again).toMatchObject({ accuracy: "compiler", answer: [{ file: "shapes.ts" }] });
    const after = await sidecar.ask({ question: "servers" });
    expect(("servers" in after ? after.servers : []).map((s) => s.pid)).not.toContain(pid);
  }, 60_000);

  test("usages reach every TypeScript project of the workspace, and say so until they are loaded", async () => {
    const mono = path.join(import.meta.dir, "fixtures", "mono");
    const ask = () => sidecar.ask({ question: "references", root: mono, file: path.join(mono, "lib", "price.ts"), language: "typescript", at: { line: 1, col: 17 } });
    let r = await ask();
    for (let i = 0; i < 50 && "partial" in r && r.partial; i++) { await Bun.sleep(200); r = await ask(); }
    expect("partial" in r ? r.partial : undefined).toBeUndefined();
    const where = ("answer" in r ? r.answer as { file: string; span: { start: { line: number } } }[] : []).map((l) => `${l.file}:${l.span.start.line}`).sort();
    expect(where).toEqual(["app/total.ts:1", "app/total.ts:3", "lib/price.ts:1"]);
  }, 60_000);
});

