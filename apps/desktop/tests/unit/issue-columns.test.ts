/**
 * The Issues board's status columns (design jira-sync §4.3): a workspace's board columns when its
 * workflow has them, every status no column holds placed by its state; one column per status
 * otherwise; cancelled ones only when asked for. With no workflow of its own the columns are the
 * six states, keyed by state, as the board has always drawn them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { statusColumns } from "../../tools/issues/src/grouping";
import { STATES_ONLY, type IssueSummary, type Workflow } from "../../tools/issues/src/data";

const at = { parent: null, labels: [], assignee: null, created: "2026-10-24T00:00:00.000Z", updated: "2026-10-24T00:00:00.000Z" };
const issue = (id: string, state: IssueSummary["state"], status?: string): IssueSummary => ({ id, title: id, state, ...(status ? { status } : {}), ...at });
const columns = (issues: IssueSummary[], wf: Workflow, showCancelled = false) =>
  statusColumns(issues, wf, showCancelled).map((g) => [g.label, g.dropStatuses!.map((s) => s.id), g.items.map((i) => i.id)]);

const WF: Workflow = {
  custom: true,
  statuses: [
    { id: "j:backlog", name: "Backlog", category: "backlog", source: "jira" },
    { id: "j:todo", name: "To Do", category: "todo", source: "jira" },
    { id: "j:prog", name: "In Progress", category: "in_progress", source: "jira" },
    { id: "j:review", name: "Code Review", category: "in_review", source: "jira" },
    { id: "j:qa", name: "QA", category: "in_review", source: "jira" },
    { id: "hive:pr", name: "PR Created", category: "in_review", source: "hive" },
    { id: "j:done", name: "Done", category: "done", source: "jira" },
    { id: "j:wont", name: "Won't Do", category: "cancelled", source: "jira" },
    { id: "j:old", name: "Old", category: "todo", source: "jira", retired: true },
  ],
  board: { columns: [
    { name: "To Do", statuses: ["j:todo"] },
    { name: "Doing", statuses: ["j:prog"] },
    { name: "Review", statuses: ["j:review", "j:qa"] },
    { name: "Done", statuses: ["j:done", "j:wont"] },
  ] },
  issueTypes: {},
};

test("no workflow of its own: the six states, cancelled only when asked, keyed by state", () => {
  const list = [issue("A-1", "todo"), issue("A-2", "cancelled")];
  assert.deepEqual(statusColumns(list, STATES_ONLY, false).map((g) => [g.key, g.label]), [
    ["backlog", "Backlog"], ["todo", "Todo"], ["in_progress", "In progress"], ["in_review", "In review"], ["done", "Done"],
  ]);
  assert.deepEqual(columns(list, STATES_ONLY, true).at(-1), ["Cancelled", ["cancelled"], ["A-2"]]);
});

test("board columns in order, a status no column holds placed by its state, retired only while used", () => {
  const list = [issue("A-1", "in_review", "hive:pr"), issue("A-2", "in_review", "j:qa"), issue("A-3", "backlog", "j:backlog"), issue("A-4", "cancelled", "j:wont")];
  assert.deepEqual(columns(list, WF), [
    ["Backlog", ["j:backlog"], ["A-3"]],
    ["To Do", ["j:todo"], []],
    ["Doing", ["j:prog"], []],
    ["Review", ["j:review", "j:qa"], ["A-2"]],
    ["PR Created", ["hive:pr"], ["A-1"]],
    // A cancelled status in a mixed column is dropped from it until asked for, its issues with it.
    ["Done", ["j:done"], []],
  ]);
  assert.deepEqual(columns(list, WF, true).at(-1), ["Done", ["j:done", "j:wont"], ["A-4"]]);
  assert.deepEqual(columns([issue("A-5", "todo", "j:old")], WF)[2], ["Old", ["j:old"], ["A-5"]]);
});

test("without board columns, one column per status in the workflow's order", () => {
  const { board: _, ...noBoard } = WF;
  assert.deepEqual(columns([], noBoard).map((c) => c[0]), ["Backlog", "To Do", "In Progress", "Code Review", "QA", "PR Created", "Done"]);
});

test("the board's own order is kept when a later column holds an earlier state; a status no column holds goes before the first column of a later state", () => {
  // cloud-scrum-company's PAY board: Ready (an in-progress "Ready for Release") comes after Review.
  const wf: Workflow = {
    ...WF,
    statuses: [...WF.statuses, { id: "j:ready", name: "Ready for Release", category: "in_progress", source: "jira" }, { id: "j:blocked", name: "Blocked", category: "in_progress", source: "jira" }],
    board: { columns: [
      { name: "To Do", statuses: ["j:todo"] },
      { name: "In Progress", statuses: ["j:prog"] },
      { name: "Review", statuses: ["j:review", "j:qa", "hive:pr"] },
      { name: "Ready", statuses: ["j:ready"] },
      { name: "Done", statuses: ["j:done", "j:wont"] },
    ] },
  };
  assert.deepEqual(columns([issue("A-1", "in_progress", "j:ready")], wf).map((c) => c[0]), ["Backlog", "To Do", "In Progress", "Blocked", "Review", "Ready", "Done"]);
  assert.deepEqual(columns([issue("A-1", "in_progress", "j:ready")], wf)[5], ["Ready", ["j:ready"], ["A-1"]]);
});
