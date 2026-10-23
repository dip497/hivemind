// `issue.changed` (issue-watch.ts, design jira-sync §12.1): every write to a workspace's issues is
// told while the workspace is followed, whoever wrote it, `hive` on this machine included (which
// writes the files itself, bypassing the host), with the fields it changed and who signed it; a
// sync's own bookkeeping is not; and nothing is watched once nothing follows.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WORKSPACE_FORMAT, createIssue, deleteIssue, updateIssue, writeConfig } from "@hivemind/core/storage";
import type { IssueChange } from "@hivemind/workspace-api/methods";
import { IssueWatch } from "../src/issue-watch.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hm-issue-watch-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let n = 0;
async function workspace(): Promise<{ repo: string; root: string }> {
  const repo = path.join(tmp, `ws-${n++}`);
  const root = path.join(repo, ".hivemind");
  fs.mkdirSync(path.join(root, "issues"), { recursive: true });
  await writeConfig(root, { prefix: "TT", next_id: 1, agents: {}, format: WORKSPACE_FORMAT });
  return { repo, root };
}

function watching() {
  const heard: Array<[string, IssueChange]> = [];
  const watch = new IssueWatch({ publish: (repo, change) => heard.push([repo, change]) });
  after(() => watch.close());
  /** What has been told once `count` changes arrived (at most 3 s), then a moment more. */
  const told = async (count: number): Promise<Array<[string, IssueChange]>> => {
    const end = Date.now() + 1_500;
    while (heard.length < count && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
    await new Promise((r) => setTimeout(r, 400));
    return heard.splice(0);
  };
  return { watch, told };
}

const settle = () => new Promise((r) => setTimeout(r, 300));

test("a write made through core, as `hive` makes it, is told with the fields it changed and who signed it", async () => {
  const { repo, root } = await workspace();
  const before = await createIssue(root, { title: "old", who: "kraken" });
  const { watch, told } = watching();
  watch.follow(repo, root, new AbortController().signal);
  await settle(); // its issues are read before anything changes

  await updateIssue(root, before.id, { state: "in_progress", labels: ["x"] }, "claude");
  assert.deepEqual(await told(1), [[repo, { id: before.id, root, change: "updated", fields: ["state", "labels", "updated", "activity"], by: "claude" }]]);

  const made = await createIssue(root, { title: "new", who: "kraken" });
  const [[, created]] = (await told(1)) as [[string, IssueChange]];
  assert.deepEqual([created.id, created.change, created.by], [made.id, "created", "kraken"]);
  assert.ok(created.fields.includes("title") && created.fields.includes("activity"), "a new issue's fields are all it has");

  await deleteIssue(root, made.id);
  assert.deepEqual(await told(1), [[repo, { id: made.id, root, change: "deleted", fields: [], by: null }]]);
});

test("a sub-issue's write is told; a file written again unchanged, a sync's bookkeeping and what is not an issue are not", async () => {
  const { repo, root } = await workspace();
  const parent = await createIssue(root, { title: "parent" });
  const { watch, told } = watching();
  watch.follow(repo, root, new AbortController().signal);
  await settle();

  const sub = await createIssue(root, { title: "child", parent: parent.id, who: "codex" });
  assert.deepEqual((await told(1)).map(([, c]) => [c.id, c.change, c.by]), [[sub.id, "created", "codex"]]);

  const file = sub.path;
  fs.writeFileSync(file, fs.readFileSync(file)); // the same bytes: an mtime moved, no field
  fs.mkdirSync(path.join(root, "sync", "jira-acme-PAY"), { recursive: true });
  fs.writeFileSync(path.join(root, "sync", "jira-acme-PAY", "lock"), String(Date.now()));
  fs.writeFileSync(path.join(root, "issues", "notes.txt"), "not an issue");
  assert.deepEqual(await told(1), []);
});

test("issues mirrored into a folder made after following began are told", async () => {
  const { repo, root } = await workspace();
  const { watch, told } = watching();
  watch.follow(repo, root, new AbortController().signal);
  await settle();
  const mirrored = await createIssue(root, { title: "mirrored", who: "@acme/jira (service)" });
  const dir = path.join(root, "mirror", "jira-acme-PAY");
  fs.mkdirSync(dir, { recursive: true });
  fs.renameSync(mirrored.path, path.join(dir, "PAY-318.md"));
  const heard = await told(2);
  const mine = heard.filter(([, c]) => c.change !== "deleted").map(([, c]) => c.id);
  assert.ok(mine.includes(mirrored.id), `the mirrored file is told: ${JSON.stringify(heard)}`);
});

/** The filesystem watches this process holds. */
const watches = () => process.getActiveResourcesInfo().filter((r) => r === "FSEventWrap").length;

test("each workspace following a folder is told once; once the last stops following, nothing is told and nothing is watched", async () => {
  const { repo, root } = await workspace();
  const before = watches();
  const child = path.join(repo, "child");
  const { watch, told } = watching();
  const window = new AbortController();
  const service = new AbortController();
  watch.follow(repo, root, window.signal);
  watch.follow(repo, root, service.signal);
  watch.follow(child, root, service.signal); // a repo inside that keeps its parent's issues
  await settle();
  await createIssue(root, { title: "one" });
  assert.deepEqual((await told(2)).map(([r]) => r).sort(), [child, repo].sort());

  window.abort();
  await createIssue(root, { title: "two" });
  assert.deepEqual((await told(2)).map(([r]) => r).sort(), [child, repo].sort(), "one follower of the repo left: it is still told");

  service.abort();
  await createIssue(root, { title: "three" });
  assert.deepEqual(await told(1), []);
  assert.equal(watches(), before, "its folder is no longer watched");
});
