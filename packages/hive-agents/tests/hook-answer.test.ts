import { expect, test } from "bun:test";
import path from "node:path";
import { readAgentManifest } from "../src/load.js";
import { hookAnswerOf, hookAsks, printedAnswer } from "../src/hook-answer.js";

const claude = async () => {
  const def = (await readAgentManifest(path.join(import.meta.dir, "fixtures/published-agents/claude/agent.yaml"), { source: "user", requireDirMatch: true })).def!;
  return hookAnswerOf(def, "PermissionRequest")!;
};

// Claude's AskUserQuestion with two questions, the second several may be chosen of.
const TWO = { questions: [
  { question: "Which fruit?", header: "Fruit", multiSelect: false, options: [{ label: "Apple", description: "" }, { label: "Banana", description: "" }, { label: "Mango", description: "" }] },
  { question: "Which colours?", header: "Colour", multiSelect: true, options: [{ label: "Red", description: "" }, { label: "Green", description: "" }, { label: "Blue", description: "" }] },
] };

test("each question's answer goes under its own text, several chosen joined as Claude Code joins them, a typed one as typed", async () => {
  const answer = await claude();
  expect(hookAsks(answer, TWO)?.map((q) => [q.question, q.many ?? false])).toEqual([["Which fruit?", false], ["Which colours?", true]]);
  const printed = (answers: Parameters<typeof printedAnswer>[2]) => JSON.parse(printedAnswer(answer, TWO, answers)!).hookSpecificOutput.decision;
  expect(printed({ answers: [{ chosen: [2] }, { chosen: [0, 2] }] })).toEqual({ behavior: "allow", updatedInput: { ...TWO, answers: { "Which fruit?": "Mango", "Which colours?": "Red, Blue" } } });
  expect(printed({ answers: [{ text: "Durian" }, { chosen: [1] }] }).updatedInput.answers).toEqual({ "Which fruit?": "Durian", "Which colours?": "Green" });
});

test("an answer that leaves a question out, names an option it does not list, or several of a question that takes one, prints nothing", async () => {
  const answer = await claude();
  expect(printedAnswer(answer, TWO, { answers: [{ chosen: [0] }, { chosen: [1] }] })).toBeDefined();
  for (const answers of [[{ chosen: [0] }], [{ chosen: [3] }, { chosen: [0] }], [{ chosen: [] }, { chosen: [0] }], [{ chosen: [0, 1] }, { chosen: [0] }]]) {
    expect(printedAnswer(answer, TWO, { answers })).toBeUndefined();
  }
});
