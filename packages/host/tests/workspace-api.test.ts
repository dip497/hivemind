// The workspace API's issues and review comments, as the app's host answers them: what a call asks
// of them is checked before anything is read or written, and one that is malformed is a bad
// request that changes nothing.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WORKSPACE_FORMAT, writeConfig } from "@hivemind/core/storage";
import { Intents } from "@hivemind/workspace-host/intents";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import { WorkspaceServer } from "@hivemind/workspace-api/server";
import { workspaceDomains } from "../src/domains.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hm-workspace-api-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
// Review comments of a repo with no workspace go under the config dir: keep them in this test's.
process.env.XDG_CONFIG_HOME = path.join(tmp, "config");
const server = new WorkspaceServer(workspaceDomains, new Intents(new AuditLog({ file: path.join(tmp, "audit.jsonl") })));
/** The app's window, as a connection: the person at this machine. */
const window = { actor: { kind: "person" } as const, send: () => {}, closed: new AbortController().signal };
const ask = (method: string, ...params: unknown[]) => server.answer(method, params, window);
async function result<T>(method: string, ...params: unknown[]): Promise<T> {
  const answer = await ask(method, ...params);
  if ("error" in answer) throw new Error(`${method}: ${answer.error.code} ${answer.error.message}`);
  return answer.result as T;
}
const codeOf = async (method: string, ...params: unknown[]) => {
  const answer = await ask(method, ...params);
  return "error" in answer ? answer.error.code : "answered";
};
let workspaces = 0;
async function makeWorkspace(): Promise<string> {
  const root = path.join(tmp, `ws-${workspaces++}`, ".hivemind");
  fs.mkdirSync(path.join(root, "issues"), { recursive: true });
  await writeConfig(root, { prefix: "TT", next_id: 1, agents: {}, format: WORKSPACE_FORMAT });
  return root;
}
type Issue = { id: string; title: string; state: string; labels: string[]; github: number | null; sections: { activity: Array<{ who: string }> } };

test("an issue change that is not in the issue's shape is a bad request, and the issue is as it was", async () => {
  const root = await makeWorkspace();
  const { id } = await result<Issue>("issue.create", root, { title: "first", labels: ["a"] });
  const refused = [{ title: "" }, { state: "bogus" }, { labels: "a,b" }, { github: -1 }, { assignee: { type: "robot", id: "x" } }, "not a patch"];
  for (const patch of refused) assert.equal(await codeOf("issue.update", root, id, patch), "BAD_REQUEST", JSON.stringify(patch));
  assert.equal(await codeOf("issue.setState", root, id, "bogus"), "BAD_REQUEST");
  assert.equal(await codeOf("issue.create", root, { title: "second", state: "bogus" }), "BAD_REQUEST");
  const issue = await result<Issue>("issue.read", root, id);
  assert.deepEqual([issue.title, issue.state, issue.labels, issue.github], ["first", "todo", ["a"], null]);
  assert.deepEqual((await result<Issue[]>("issue.list", root)).map((i) => i.id), [id]);
  // What is well formed is written.
  await result("issue.update", root, id, { title: "renamed", state: "in_progress", github: 12 });
  const renamed = await result<Issue>("issue.read", root, id);
  assert.deepEqual([renamed.title, renamed.state, renamed.github], ["renamed", "in_progress", 12]);
});

test("a new issue's activity is signed by the host's window, not by a name the call gives", async () => {
  const root = await makeWorkspace();
  const created = await result<Issue>("issue.create", root, { title: "signed", who: "someone-else" });
  assert.deepEqual(created.sections.activity.map((a) => a.who), ["ui"]);
});

test("saving a repo's review comments with what is not a list is a bad request, and the comments stay", async () => {
  const repo = path.join(tmp, "plain-repo");
  fs.mkdirSync(repo);
  const comment = { id: "c1", file: "a.ts", startLine: 1, endLine: 1, side: "additions", body: "why?", author: "me", at: "2026-09-30T00:00:00.000Z" };
  await result("review.save", repo, [comment]);
  for (const comments of [null, { c1: comment }, "[]"]) assert.equal(await codeOf("review.save", repo, comments), "BAD_REQUEST", JSON.stringify(comments));
  assert.deepEqual((await result<Array<{ id: string }>>("review.list", repo)).map((c) => c.id), ["c1"]);
});
