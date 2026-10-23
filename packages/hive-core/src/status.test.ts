// Status ↔ state through core's write path (design jira-sync §4.3): what lands in the issue file
// when a caller writes a status, a state, or neither, with and without a workflow.yaml.
import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createIssue, listIssues, readIssue, updateIssue, writeConfig } from "./storage.js";
import { filterIssues } from "./query.js";
import { loadWorkflow, transitionTargets, workflowStatuses } from "./workflow.js";

// The PAY Story workflow of packages/jira-fake/fixtures/cloud-scrum-company.site.json, plus the
// hive-only PR Created; Bug (jira:10004) has a shorter list of its own.
const WORKFLOW = `version: 1
statuses:
  - { id: "jira:10000", name: Backlog, category: backlog, source: jira }
  - { id: "jira:10001", name: To Do, category: todo, source: jira }
  - { id: "jira:3", name: In Progress, category: in_progress, source: jira }
  - { id: "jira:10002", name: Blocked, category: in_progress, source: jira }
  - { id: "jira:10003", name: Code Review, category: in_review, source: jira }
  - { id: "jira:10004", name: QA, category: in_review, source: jira }
  - { id: "hive:pr-created", name: PR Created, category: in_review, jira: { follow: "jira:10003" } }
  - { id: "jira:10005", name: Ready for Release, category: in_review, source: jira }
  - { id: "jira:10006", name: Done, category: done, source: jira }
  - { id: "jira:10007", name: Won't Do, category: cancelled, source: jira }
issueTypes:
  "jira:10004":
    statuses: ["jira:10001", "jira:10002", "jira:10004", "jira:10006", "jira:10007"]
    transitions:
      - { id: "21", from: ["jira:10001"], to: "jira:10002" }
      - { id: "81", from: "*", to: "jira:10007" }
`;

async function mkRoot(workflow?: string): Promise<string> {
  const root = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "hive-status-")), ".hivemind");
  await fs.mkdir(path.join(root, "issues"), { recursive: true });
  await writeConfig(root, { prefix: "PAY", next_id: 1, agents: {} });
  if (workflow) await fs.writeFile(path.join(root, "workflow.yaml"), workflow);
  return root;
}
const fileOf = (root: string, id: string) => fs.readFile(path.join(root, "issues", `${id}.md`), "utf8");
const lastActivity = async (root: string, id: string) => (await readIssue(root, id)).sections.activity.at(-1)?.message;

describe("no workflow.yaml: files and activity as before", () => {
  test("a state write writes only `state`, and a status names a category", async () => {
    const root = await mkRoot();
    await createIssue(root, { title: "a" });
    await updateIssue(root, "PAY-1", { state: "in_progress" });
    expect(await fileOf(root, "PAY-1")).not.toContain("status:");
    expect(await lastActivity(root, "PAY-1")).toBe("state: todo → in_progress");
    // The built-in statuses are the categories, by id or by name.
    await updateIssue(root, "PAY-1", { status: "In review" });
    const after = await readIssue(root, "PAY-1");
    expect([after.state, after.status]).toEqual(["in_review", undefined]);
    expect(await fileOf(root, "PAY-1")).not.toContain("status:");
  });
});

describe("with a workflow.yaml", () => {
  test("a new issue gets its state's default status, or the status it names", async () => {
    const root = await mkRoot(WORKFLOW);
    await createIssue(root, { title: "a" });
    await createIssue(root, { title: "b", status: "pr created" });
    expect(await fileOf(root, "PAY-1")).toMatch(/^status: '?jira:10001'?$/m);
    const b = await readIssue(root, "PAY-2");
    expect([b.state, b.status]).toEqual(["in_review", "hive:pr-created"]);
  });

  test("writing a status sets the state to its category, and the activity names the status", async () => {
    const root = await mkRoot(WORKFLOW);
    await createIssue(root, { title: "a" });
    await updateIssue(root, "PAY-1", { status: "code review" });
    const i = await readIssue(root, "PAY-1");
    expect([i.state, i.status]).toEqual(["in_review", "jira:10003"]);
    expect(await lastActivity(root, "PAY-1")).toBe("status: To Do → Code Review (todo → in_review)");
    // Within one category the state stays, and only the status moves.
    await updateIssue(root, "PAY-1", { status: "jira:10004" });
    expect(await lastActivity(root, "PAY-1")).toBe("status: Code Review → QA");
    expect((await readIssue(root, "PAY-1")).state).toBe("in_review");
  });

  test("a state alone lands on the category's default, and the same state keeps the status", async () => {
    const root = await mkRoot(WORKFLOW);
    await createIssue(root, { title: "a", status: "PR Created" });
    await updateIssue(root, "PAY-1", { state: "in_review" });
    expect((await readIssue(root, "PAY-1")).status).toBe("hive:pr-created");
    await updateIssue(root, "PAY-1", { state: "in_progress" });
    expect((await readIssue(root, "PAY-1")).status).toBe("jira:3");
  });

  test("a state alone keeps to the issue type's own statuses", async () => {
    const root = await mkRoot(WORKFLOW);
    await createIssue(root, { title: "bug" });
    const file = path.join(root, "issues", "PAY-1.md");
    const raw = await fs.readFile(file, "utf8");
    await fs.writeFile(file, raw.replace(/^status: .*$/m, '$&\nexternal: { provider: jira, source: "jira:acme/PAY", id: "10423", key: PAY-318, type: { id: "10004", name: Bug } }'));
    await updateIssue(root, "PAY-1", { state: "in_progress" });
    // Bug's list has Blocked but not In Progress.
    expect((await readIssue(root, "PAY-1")).status).toBe("jira:10002");
  });

  test("an unknown status is refused, naming the valid ones, and the file is untouched", async () => {
    const root = await mkRoot(WORKFLOW);
    await createIssue(root, { title: "a" });
    const before = await fileOf(root, "PAY-1");
    const refused = updateIssue(root, "PAY-1", { status: "Shipped" });
    await expect(refused).rejects.toThrow(/unknown status "Shipped".*Code Review \(jira:10003\)/);
    expect(await fileOf(root, "PAY-1")).toBe(before);
    await expect(createIssue(root, { title: "b", status: "Shipped" })).rejects.toThrow(/unknown status/);
  });

  test("an invalid workflow.yaml refuses a status write rather than guessing", async () => {
    const root = await mkRoot(WORKFLOW.replace(/.*Won't Do.*\n/, "").replace(', "jira:10007"]', "]"));
    await fs.writeFile(path.join(root, "issues", "PAY-1.md"), "---\nid: PAY-1\ntitle: a\nstate: todo\ncreated: '2026-10-24T00:00:00.000Z'\nupdated: '2026-10-24T00:00:00.000Z'\n---\n");
    await expect(updateIssue(root, "PAY-1", { state: "done" })).rejects.toThrow(/category cancelled has no status/);
  });
});

describe("filterIssues by status and category", () => {
  test("an issue written before the workflow is in its category's default status", async () => {
    const root = await mkRoot();
    await createIssue(root, { title: "old" }); // no status on disk
    await fs.writeFile(path.join(root, "workflow.yaml"), WORKFLOW);
    await createIssue(root, { title: "new", status: "Blocked" });
    const wf = loadWorkflow(root);
    const all = await listIssues(root);
    const ids = (q: Parameters<typeof filterIssues>[1]) => filterIssues(all, q, wf).map((i) => i.id);
    expect(ids({ status: "jira:10001" })).toEqual(["PAY-1"]);
    expect(ids({ status: "jira:10002" })).toEqual(["PAY-2"]);
    expect(ids({ status: ["jira:3", "jira:10001"] })).toEqual(["PAY-1"]);
    expect(ids({ category: "in_progress" })).toEqual(["PAY-2"]);
  });
});

describe("workflowStatuses", () => {
  test("lists statuses in category order, then the workflow's own", async () => {
    // Done first in the file: it still comes after every earlier category.
    const done = WORKFLOW.match(/.*name: Done,.*\n/)![0];
    const root = await mkRoot(WORKFLOW.replace(done, "").replace("statuses:\n", `statuses:\n${done}`));
    const view = workflowStatuses(root);
    expect(view.statuses.map((s) => s.name)).toEqual([
      "Backlog", "To Do", "In Progress", "Blocked", "Code Review", "QA", "PR Created", "Ready for Release", "Done", "Won't Do",
    ]);
    expect(view.custom).toBe(true);
    expect(workflowStatuses(root)).toBe(view); // per-event callers get the same object
  });

  test("with no file: the six categories, as the board has always labelled them", async () => {
    const view = workflowStatuses(await mkRoot());
    expect(view.custom).toBe(false);
    expect(view.statuses.map((s) => [s.id, s.name])).toEqual([
      ["backlog", "Backlog"], ["todo", "Todo"], ["in_progress", "In progress"], ["in_review", "In review"], ["done", "Done"], ["cancelled", "Cancelled"],
    ]);
  });

  test("transitionTargets: the type's transitions from a status, global ones included", async () => {
    const view = workflowStatuses(await mkRoot(WORKFLOW));
    expect(transitionTargets(view, "jira:10004", "jira:10001")).toEqual(["jira:10002", "jira:10007"]);
    expect(transitionTargets(view, "jira:10004", "jira:10006")).toEqual(["jira:10007"]);
    expect(transitionTargets(view, undefined, "jira:10001")).toBeUndefined();
  });
});
