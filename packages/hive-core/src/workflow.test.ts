import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BUILTIN_WORKFLOW, categoryOf, defaultStatus, loadWorkflow } from "./workflow.js";

function root(): string {
  return mkdtempSync(path.join(tmpdir(), "hive-wf-"));
}

const NINE = `version: 1
statuses:
  - { id: "jira:10000", name: Backlog, category: backlog, source: jira }
  - { id: "jira:10001", name: To Do, category: todo, source: jira }
  - { id: "jira:3", name: In Progress, category: in_progress, source: jira }
  - { id: "jira:10003", name: Code Review, category: in_review, source: jira }
  - { id: "hive:pr-created", name: PR Created, category: in_review, jira: { follow: "jira:10003" } }
  - { id: "jira:10006", name: Done, category: done, source: jira }
  - { id: "jira:10007", name: Won't Do, category: cancelled, source: jira }
issueTypes:
  "jira:10004": { statuses: ["jira:10001", "jira:3", "jira:10003", "jira:10006", "jira:10007"] }
`;

describe("loadWorkflow", () => {
  // The backward-compatibility contract: a workspace without workflow.yaml has exactly the six
  // categories as statuses, so every existing reader of `state` sees no change.
  test("no file gives one built-in status per category, id = category", () => {
    const wf = loadWorkflow(root());
    expect(wf).toBe(BUILTIN_WORKFLOW);
    expect(wf.statuses.map((s) => [s.id, s.category])).toEqual(
      ["backlog", "todo", "in_progress", "in_review", "done", "cancelled"].map((c) => [c, c]),
    );
  });

  test("a file is read, and re-read when it changes", () => {
    const r = root();
    writeFileSync(path.join(r, "workflow.yaml"), NINE);
    const wf = loadWorkflow(r);
    expect(categoryOf(wf, "hive:pr-created")).toBe("in_review");
    writeFileSync(path.join(r, "workflow.yaml"), NINE.replace("name: PR Created", "name: PR Open!"));
    expect(loadWorkflow(r).statuses.find((s) => s.id === "hive:pr-created")?.name).toBe("PR Open!");
    rmSync(path.join(r, "workflow.yaml"));
    expect(loadWorkflow(r)).toBe(BUILTIN_WORKFLOW);
  });

  // A half-valid workflow would put issues in statuses no column shows; refuse it whole.
  test.each([
    ["a category with no status", NINE.replace(/.*Won't Do.*\n/, "").replace(', "jira:10007"]', "]")],
    ["a duplicate id", NINE.replace('id: "jira:10000"', 'id: "hive:pr-created"')],
    ["a follow to an unknown status", NINE.replace('follow: "jira:10003"', 'follow: "jira:999"')],
    ["an issue type naming an unknown status", NINE.replace('"jira:10007"] }', '"jira:404"] }')],
  ])("refuses %s", (_label, yaml) => {
    const r = root();
    writeFileSync(path.join(r, "workflow.yaml"), yaml);
    expect(() => loadWorkflow(r)).toThrow();
  });
});

describe("defaultStatus", () => {
  test("picks the first status of the category, within the issue type's own list", () => {
    const r = root();
    writeFileSync(path.join(r, "workflow.yaml"), NINE);
    const wf = loadWorkflow(r);
    expect(defaultStatus(wf, "in_review")?.id).toBe("jira:10003");
    expect(defaultStatus(wf, "backlog", "jira:10004")).toBeUndefined();
    expect(defaultStatus(wf, "todo", "jira:10004")?.id).toBe("jira:10001");
  });
});
