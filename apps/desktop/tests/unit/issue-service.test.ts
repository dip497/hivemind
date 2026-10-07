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
  },
};

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
