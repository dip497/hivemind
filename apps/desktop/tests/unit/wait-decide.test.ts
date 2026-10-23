// When an agent's wait may be allowed or denied with one click from its row or toast
// (wait-decide.tsx, docs/design/last-line-2026-10-23.md §2): only a permission its agent says the
// keys of, for a tool whose input is known, so the person always has the input to read first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decidable } from "../../src/renderer/src/wait-decide.tsx";
import type { AgentWait } from "../../src/renderer/src/agent-waits.ts";

const wait = (w: Omit<AgentWait, "since">): AgentWait => ({ since: 1, ...w });

test("Allow and Deny are offered only for a permission its agent decides, of a tool whose input is known", () => {
  const rows: Array<[string, AgentWait | undefined, boolean]> = [
    ["a permission decided from here, its command known", wait({ kind: "permission", decide: true, tool: { name: "Bash", about: "npm test" } }), true],
    ["its agent says no keys that decide it", wait({ kind: "permission", tool: { name: "Bash", about: "npm test" } }), false],
    ["no tool known: nothing to read before allowing", wait({ kind: "permission", decide: true }), false],
    ["a tool whose input is not known", wait({ kind: "permission", decide: true, tool: { name: "Bash" } }), false],
    ["an input of blanks", wait({ kind: "permission", decide: true, tool: { name: "Bash", about: "  \n " } }), false],
    ["a question is answered, not allowed", wait({ kind: "question", decide: true, tool: { name: "AskUserQuestion", about: "Which?" } }), false],
    ["a supervised approval is its lead's", wait({ kind: "approval", decide: true, tool: { name: "Bash", about: "npm test" } }), false],
    ["no wait", undefined, false],
  ];
  for (const [what, waiting, offered] of rows) assert.equal(decidable(waiting), offered, what);
});
