// What claude and pi show before the cursor at their prompt, as their real binaries drew it
// (claude 2.1.309, pi 1.3.0): a message waits only while the person has words there.
import { expect, test } from "bun:test";
import { authoredDefs } from "./authored.js";

const agent = (id: string) => authoredDefs().find((d) => d.id === id)!;
const rule = "─".repeat(100);

test("claude: its prompt with only its suggestion after the cursor reads empty; with words, not", () => {
  const above = ["  ◐ medium · /effort", rule].join("\n");
  expect(agent("claude").emptyPrompt!(`${above}\n❯ `)).toBe(true);
  expect(agent("claude").emptyPrompt!(`${above}\n❯ fix the nav`)).toBe(false);
  expect(agent("claude").emptyPrompt!(`${above}\n❯ fix the nav\n  and the footer`)).toBe(false);
});

test("pi: the line under its editor's rule with the cursor at its start reads empty; with words, not", () => {
  const above = [" Changelog: https://pi.dev/changelog", rule].join("\n");
  expect(agent("pi").emptyPrompt!(`${above}\n`)).toBe(true);
  expect(agent("pi").emptyPrompt!(`${above}\nfix the nav`)).toBe(false);
  expect(agent("pi").emptyPrompt!(`${above}\nfix the nav\n`)).toBe(false);
});
