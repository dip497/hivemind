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
import { WorkspaceClient } from "@hivemind/workspace-api/client";
import { peerTransport, servePeer } from "@hivemind/workspace-api/peers";
import type { ApiError } from "@hivemind/workspace-api/protocol";
import { workspaceDomains } from "../src/domains.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hm-workspace-api-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
// Review comments of a repo with no workspace go under the config dir: keep them in this test's.
process.env.XDG_CONFIG_HOME = path.join(tmp, "config");
const server = new WorkspaceServer(workspaceDomains(), new Intents(new AuditLog({ file: path.join(tmp, "audit.jsonl") })));
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

test("a service and a guest who may edit write issues, each signed as itself; one who only views is refused, and nothing is written", async () => {
  const root = await makeWorkspace();
  const repo = path.dirname(root);
  const names: Record<string, string> = { ["p".repeat(64)]: "Priya Nair" };
  const named = new WorkspaceServer(workspaceDomains((c) => (c.actor.kind === "peer" ? c.actor.client ?? names[c.actor.person] : undefined)), new Intents(new AuditLog({ file: path.join(tmp, "audit-peers.jsonl") })));
  /** A peer of `repo` at `access`: a tool plugin's service names its program, a guest is a person. */
  const peer = (access: "view" | "edit", client?: string) => {
    const toHost = new Set<(t: string) => void>();
    const toPeer = new Set<(t: string) => void>();
    const closed = new Promise<never>(() => {});
    const end = (mine: Set<(t: string) => void>, theirs: Set<(t: string) => void>) => ({
      send: (t: string) => queueMicrotask(() => { for (const l of theirs) l(t); }),
      on: (l: (t: string) => void) => { mine.add(l); return () => { mine.delete(l); }; },
      closed,
    });
    servePeer(named, end(toHost, toPeer), {
      actor: { kind: "peer", person: client ? "client:g1" : "p".repeat(64), device: "d".repeat(64), access, ...(client ? { client } : {}) },
      workspace: "w", repo, url: repo, holds: () => false,
    });
    return new WorkspaceClient(peerTransport(end(toPeer, toHost)));
  };
  const service = peer("edit", "@acme/jira (service)");
  const made = await service.call("issue.create", root, { title: "from Jira" }) as Issue;
  await service.call("issue.update", root, made.id, { labels: ["jira"] });
  await service.call("issue.setState", root, made.id, "in_progress", "picked up");
  await service.call("issue.comment", root, made.id, "synced");
  await peer("edit").call("issue.comment", root, made.id, "looks right");
  const viewer = peer("view");
  for (const [method, ...params] of [["issue.create", root, { title: "x" }], ["issue.update", root, made.id, { title: "x" }], ["issue.setState", root, made.id, "done"], ["issue.comment", root, made.id, "x"]] as const) {
    assert.equal(await (viewer.call as (m: string, ...p: unknown[]) => Promise<unknown>)(method, ...params).then(() => "answered", (e: ApiError) => e.code), "FORBIDDEN", method);
  }
  const issue = await result<Issue & { sections: { activity: Array<{ who: string; message: string }> } }>("issue.read", root, made.id);
  assert.deepEqual(issue.sections.activity.map((a) => [a.who, a.message]), [
    ["@acme/jira (service)", "created"],
    ["@acme/jira (service)", "labels: [] → [jira]"],
    ["@acme/jira (service)", "state: todo → in_progress"],
    ["@acme/jira (service)", "picked up"],
    ["@acme/jira (service)", "synced"],
    ["Priya Nair", "looks right"],
  ]);
  assert.deepEqual([issue.title, issue.state, issue.labels], ["from Jira", "in_progress", ["jira"]]);
  assert.deepEqual((await result<Issue[]>("issue.list", root)).map((i) => i.id), [made.id]);
});
