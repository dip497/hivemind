/**
 * The issues a plugin reaches: only `read` follows an id into another of the host's workspaces (a
 * link's other end); every write lands in the workspace the plugin shows, where another
 * workspace's id is not found.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const HERE = "/here/.hivemind";
const OTHER = "/other/.hivemind";
const touched: string[] = [];
const at = (what: string) => (root: string, id: string) => { touched.push(`${what} ${root} ${id}`); return Promise.resolve({ id, path: "p", raw: "r" }); };

(globalThis as unknown as { window: unknown }).window = {
  hive: {
    resolveIssueRoot: (id: string) => Promise.resolve({ root: id.startsWith("OTH-") ? OTHER : HERE }),
    readIssue: at("read"),
    updateIssue: at("update"),
    updateIssueState: at("setState"),
    commentOnIssue: at("comment"),
    deleteIssue: at("delete"),
    linkIssue: at("link"),
    unlinkIssue: at("unlink"),
    moveIssue: at("move"),
    issueWorkflow: () => workflow,
    listIssues: () => Promise.resolve(list),
    onFsChanged: () => () => {},
  },
};
/** What the app answers `issueWorkflow` with: none until a test sets one (a broken workflow.yaml). */
let workflow: Promise<unknown> = Promise.reject(new Error("no workflow"));
let list: unknown[] = [];

const { issueService } = await import("../../src/renderer/src/workspace/issue-service");

test("a plugin reads another workspace's issue but writes only to its own", async () => {
  const issues = issueService(() => HERE);
  const read = await issues.call("read", ["OTH-1"]);
  assert.deepEqual(read, { id: "OTH-1" }, "where the issue is on disk stays in the app");
  await issues.call("update", ["OTH-1", { title: "x" }]);
  await issues.call("setState", ["OTH-1", "done"]);
  await issues.call("comment", ["OTH-1", "hi"]);
  await issues.call("delete", ["OTH-1"]);
  await issues.call("link", ["OTH-1", "HM-1"]);
  await issues.call("unlink", ["OTH-1", "HM-1"]);
  await issues.call("move", ["OTH-1", "HM"]);
  assert.deepEqual(touched, [
    `read ${OTHER} OTH-1`,
    `update ${HERE} OTH-1`, `setState ${HERE} OTH-1`, `comment ${HERE} OTH-1`, `delete ${HERE} OTH-1`,
    `link ${HERE} OTH-1`, `unlink ${HERE} OTH-1`, `move ${HERE} OTH-1`,
  ]);
});

test("each issue a plugin is sent names its status by the workspace's workflow, and the workflow is the app's", async () => {
  const view = {
    custom: true,
    statuses: [
      { id: "jira:1", name: "To Do", category: "todo", source: "jira" },
      { id: "jira:2", name: "Code Review", category: "in_review", source: "jira" },
      { id: "hive:pr", name: "PR Created", category: "in_review", source: "hive" },
    ],
    issueTypes: {},
  };
  workflow = Promise.resolve(view);
  const at = { parent: null, labels: [], assignee: null, created: "2026-10-24T00:00:00.000Z", updated: "2026-10-24T00:00:00.000Z", path: "/here/.hivemind/issues/X.md" };
  // One with its own status; one written before the workflow, in its category's first status.
  list = [{ id: "HM-1", title: "a", state: "in_review", status: "hive:pr", ...at }, { id: "HM-2", title: "b", state: "in_review", ...at }];
  const sent = await new Promise<Array<Record<string, unknown>>>((resolve) => { const off = issueService(() => HERE, () => null).subscribe((l) => { off(); resolve(l as never); }); });
  assert.deepEqual(sent.map((i) => [i.id, i.status, i.statusName, "path" in i]), [["HM-1", "hive:pr", "PR Created", false], ["HM-2", "jira:2", "Code Review", false]]);
  assert.equal(await issueService(() => HERE, () => null).call("workflow", []), view);
});
