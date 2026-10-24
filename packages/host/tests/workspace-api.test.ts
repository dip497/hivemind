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
import { mayCall } from "@hivemind/workspace-api/roles";

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
  // What is well formed is written, and what the file holds that the patch doesn't name stays.
  fs.writeFileSync(issue.path, fs.readFileSync(issue.path, "utf8").replace("\nupdated:", "\nx_note: keep\nupdated:"));
  await result("issue.update", root, id, { title: "renamed", state: "in_progress", github: 12, branch: "X-1-renamed", aliases: ["OLD-1"] });
  const renamed = await result<Issue>("issue.read", root, id);
  assert.deepEqual(
    [renamed.title, renamed.state, renamed.github, renamed.branch, renamed.aliases, renamed.x_note],
    ["renamed", "in_progress", 12, "X-1-renamed", ["OLD-1"], "keep"],
  );
  assert.equal((await result<Issue>("issue.create", root, { title: "branched", branch: "X-2-branched" })).branch, "X-2-branched");
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

test("a sync service at edit role mirrors a tracker's issues with issue.ingest; view is refused, and a malformed record writes nothing", async () => {
  const root = await makeWorkspace();
  const peer = (access: "view" | "edit") => ({ actor: { kind: "peer", person: "b".repeat(64), device: "d".repeat(64), access } as const, send: () => {}, closed: new AbortController().signal });
  const record = { external: { id: "10423", key: "PAY-318", remoteUpdated: "2026-10-22T09:14:00.000+0000" }, title: "Retry failed webhooks", status: { id: "jira:10001", name: "To Do", category: "todo" } };
  // a peer's role is checked by the peer layer, against the role table
  assert.equal(mayCall({ access: "view" }, "issue.ingest"), false);
  assert.equal(mayCall({ access: "edit" }, "issue.ingest"), true);
  const bad = await server.answer("issue.ingest", [root, "jira:acme/PAY", [record, { external: { id: "1", key: "PAY-1" } }]], peer("edit"));
  assert.equal("error" in bad && bad.error.code, "BAD_REQUEST");
  assert.equal(fs.existsSync(path.join(root, "mirror")), false);
  const ok = await server.answer("issue.ingest", [root, "jira:acme/PAY", [record]], peer("edit"));
  assert.ok("result" in ok, JSON.stringify(ok));
  assert.deepEqual((ok.result as { created: string[] }).created, ["PAY-318"]);
  assert.equal((await result<Issue>("issue.read", root, "PAY-318")).title, "Retry failed webhooks");
});

test("a status reaches core through the API, sets the state, and the workflow is read as the window lists it", async () => {
  const root = await makeWorkspace();
  fs.writeFileSync(path.join(root, "workflow.yaml"), [
    "version: 1",
    "statuses:",
    ...["backlog", "todo", "in_progress", "done", "cancelled"].map((c) => `  - { id: "s:${c}", name: ${c}, category: ${c} }`),
    '  - { id: "jira:10004", name: QA, category: in_review, source: jira }',
  ].join("\n"));
  const { id, state } = await result<Issue>("issue.create", root, { title: "x", status: "qa" });
  assert.equal(state, "in_review");
  await result("issue.update", root, id, { status: "s:done" });
  const issue = await result<Issue & { status?: string }>("issue.read", root, id);
  assert.deepEqual([issue.state, issue.status], ["done", "s:done"]);
  // Refused by core, as every core refusal is: FAILED, naming the statuses there are.
  const refused = await ask("issue.update", root, id, { status: "Shipped" });
  assert.match("error" in refused ? refused.error.message : "", /unknown status "Shipped".*QA \(jira:10004\)/);
  const wf = await result<{ custom: boolean; statuses: Array<{ id: string }> }>("issue.workflow", root);
  assert.equal(wf.custom, true);
  assert.deepEqual(wf.statuses.map((s) => s.id), ["s:backlog", "s:todo", "s:in_progress", "jira:10004", "s:done", "s:cancelled"]);
});
