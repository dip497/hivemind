import { describe, expect, test } from "bun:test";
import { CodeAnswers } from "../src/answers.js";
import type { Accuracy, Answer, CodeDocument, CodeIntelProvider, Question } from "../src/contract.js";

const doc = (version: number): CodeDocument => ({ file: "/w/a.ts", language: "typescript", version });
const later = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A provider that answers `value` after `ms`. */
function provider(id: string, accuracy: Accuracy, ms: number, value: unknown, answers: Question[] = ["references", "rename"], partial?: string): CodeIntelProvider {
  return {
    id, accuracy, answers, languages: ["typescript"], runs: "sidecar",
    ask: async () => { await later(ms); return { value: value as never, ...(partial ? { partial } : {}) }; },
  };
}
const loc = (line: number) => [{ file: "a.ts", span: { start: { line, col: 0 }, end: { line, col: 1 } } }];

describe("the order answers are taken in", () => {
  test("the fastest answer comes first and a more accurate one replaces it", async () => {
    const seen: Answer[] = [];
    const answers = new CodeAnswers(() => [provider("words", "syntax", 5, loc(1)), provider("server", "compiler", 40, loc(2))]);
    const best = await answers.ask("references", doc(1), { line: 1, col: 0 }, { onAnswer: (a) => seen.push(a) });
    expect(seen.map((a) => [a.by, a.accuracy])).toEqual([["words", "syntax"], ["server", "compiler"]]);
    expect(best).toMatchObject({ by: "server", accuracy: "compiler", version: 1, value: loc(2) });
  });

  test("a less accurate answer that comes later does not replace a more accurate one", async () => {
    const answers = new CodeAnswers(() => [provider("index", "index", 5, loc(2)), provider("words", "syntax", 30, loc(1)), provider("server", "compiler", 400, loc(3))]);
    const seen: string[] = [];
    const best = await answers.ask("references", doc(1), { line: 1, col: 0 }, { onAnswer: (a) => seen.push(a.by), within: 100 });
    expect(seen).toEqual(["index"]);
    expect(best?.by).toBe("index");
  });

  test("an answer for a version the file has moved on from is dropped", async () => {
    const answers = new CodeAnswers(() => [provider("server", "compiler", 30, loc(2))]);
    const seen: string[] = [];
    const asked = answers.ask("references", doc(1), { line: 1, col: 0 }, { onAnswer: (a) => seen.push(a.by) });
    answers.edited("/w/a.ts", 2);
    expect(await asked).toBeNull();
    expect(seen).toEqual([]);
  });

  test("finding nothing does not replace something found", async () => {
    const answers = new CodeAnswers(() => [provider("words", "syntax", 5, loc(1)), provider("server", "compiler", 20, [])]);
    expect((await answers.ask("references", doc(1), { line: 1, col: 0 }))?.by).toBe("words");
  });

  test("rename is asked only of a compiler-accurate provider", async () => {
    const answers = new CodeAnswers(() => [provider("words", "syntax", 1, [{ file: "a.ts", edits: [] }])]);
    expect(await answers.ask("rename", doc(1), { line: 1, col: 0 })).toBeNull();
  });

  test("the best answer so far is given when time runs out", async () => {
    const answers = new CodeAnswers(() => [provider("words", "syntax", 5, loc(1)), provider("server", "compiler", 500, loc(2))]);
    const started = Date.now();
    expect((await answers.ask("references", doc(1), { line: 1, col: 0 }, { within: 60 }))?.by).toBe("words");
    expect(Date.now() - started).toBeLessThan(400);
  });

  test("a compiler answer that covers part of the workspace keeps the text's other places beside it, whichever comes first", async () => {
    const both = [...loc(1), ...loc(2)];
    for (const [words, server] of [[5, 30], [30, 5]]) {
      const answers = new CodeAnswers(() => [provider("words", "syntax", words, both), provider("server", "compiler", server, loc(2), ["references"], "packages/host")]);
      const best = await answers.ask("references", doc(1), { line: 1, col: 0 }, { within: 200 });
      expect(best).toMatchObject({ by: "server", partial: "packages/host", value: loc(2), also: { accuracy: "syntax", by: "words", value: loc(1) } });
    }
  });

  test("a question taken back answers null and tells nothing more", async () => {
    const answers = new CodeAnswers(() => [provider("server", "compiler", 40, loc(2))]);
    const seen: string[] = [];
    const taken = new AbortController();
    const asked = answers.ask("references", doc(1), { line: 1, col: 0 }, { onAnswer: (a) => seen.push(a.by), signal: taken.signal });
    taken.abort();
    expect(await asked).toBeNull();
    await later(60);
    expect(seen).toEqual([]);
  });
});
