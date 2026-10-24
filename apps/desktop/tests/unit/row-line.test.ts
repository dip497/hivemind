// What a terminal's Layers row says under its name (row-line.tsx, docs/design/last-line-2026-10-23.md
// §2): what its agent waits on, in place of its screen's last line, else that line. Both are text
// the agent or a process in the tile wrote, so neither may carry a control that reorders it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { lineFor } from "../../src/shared/line-for.ts";
import type { AgentWait } from "../../src/renderer/src/agent-waits.ts";

const wait = (w: Omit<AgentWait, "since">): AgentWait => ({ since: 1, ...w });

test("a row says what its agent waits on, in place of its last line, else its last line", () => {
  const rows: Array<[string, AgentWait | undefined, string | undefined, string]> = [
    ["a tool, by the first line of what it is about", wait({ kind: "permission", tool: { name: "Bash", about: "npm test\nnpm run lint" } }), "214 tests passed", "Bash: npm test"],
    ["a question", wait({ kind: "question", asks: [{ question: "Which branch?", options: ["main", "dev"] }] }), undefined, "Asks: Which branch?"],
    ["a plan", wait({ kind: "plan", plan: "1. Read\n2. Write" }), undefined, "Plan ready for review"],
    ["a wait that says no more, by its kind", wait({ kind: "permission" }), "214 tests passed", "Permission"],
    ["no wait: the last line", undefined, "214 tests passed", "214 tests passed"],
    ["nothing to say", undefined, undefined, ""],
    ["bidi controls out of the line", undefined, "\u202Etxt.exe\u202C passed \u2066ok\u2069", "txt.exe passed ok"],
    ["bidi controls out of what a tool is about", wait({ kind: "permission", tool: { name: "Bash", about: "rm -rf \u202Ebuild\u202C" } }), undefined, "Bash: rm -rf build"],
  ];
  for (const [what, waiting, line, says] of rows) assert.equal(lineFor(waiting, line), says, what);
});
