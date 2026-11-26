// Questions to the workspace's host about code (code/code-intel.ts): a file outside the workspace,
// or in a workspace on another machine, is never asked about; the question fails with what to do.
import { test } from "node:test";
import assert from "node:assert/strict";

const calls: string[] = [];
const answer = { value: [], accuracy: "syntax", version: 0 };
(globalThis as { window?: unknown }).window = {
  hive: {
    codeDefinition: async (_repo: string, file: string) => { calls.push(file); return answer; },
    codeUsages: async (_repo: string, file: string) => { calls.push(file); return answer; },
    codeHover: async (_repo: string, file: string) => { calls.push(file); return answer; },
    codeCancel: () => {},
    onCodeAnswered: () => () => {},
  },
};
const { codeIntel } = await import("../../src/renderer/src/code/code-intel");
const at = { line: 1, col: 0 };

test("a file outside the workspace or on another machine is not asked about, and says why", async () => {
  for (const [repo, file] of [["/work/app", "/home/me/notes/tool.ts"], ["ssh://box/work/app", "src/a.ts"]]) {
    await assert.rejects(codeIntel.definition({ repo, file, text: "", version: 1 }, at).answer, /Code questions work inside the workspace/);
    await assert.rejects(codeIntel.usages({ repo, file, text: "", version: 1 }, at).answer, /Code questions work inside the workspace/);
  }
  assert.deepEqual(calls, []);
  await codeIntel.definition({ repo: "/work/app", file: "src/a.ts", text: "", version: 1 }, at).answer;
  assert.deepEqual(calls, ["src/a.ts"]);
});
