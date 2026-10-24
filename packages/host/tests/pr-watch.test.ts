// The PR watcher (pr-watch.ts, design jira-sync §11.4), fed by a real IssueWatch and answered by
// the `gh` shim (scripts/gh-shim): it runs only while a followed issue has an open PR; one pass is
// one `gh api graphql` call for every followed workspace; merged and closed move the issue by the
// workflow's local rules, closed tells the person, review and checks are only badges.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKSPACE_FORMAT, createIssue, readIssue, updateIssue, writeConfig } from "@hivemind/core/storage";
import type { PrRef } from "@hivemind/core/types";
import { IssueWatch } from "../src/issue-watch.ts";
import { PrWatch } from "../src/pr-watch.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hm-pr-watch-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const shimBin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/gh-shim");
process.env.PATH = `${shimBin}${path.delimiter}${process.env.PATH}`;

let n = 0;
function shim(graphql?: unknown): { calls: () => string[][] } {
  const dir = path.join(tmp, `shim-${n++}`);
  fs.mkdirSync(dir);
  process.env.GH_SHIM = dir;
  if (graphql) fs.writeFileSync(path.join(dir, "graphql.json"), JSON.stringify(graphql));
  return {
    calls: () => (fs.existsSync(path.join(dir, "calls")) ? fs.readFileSync(path.join(dir, "calls"), "utf8").trimEnd().split("\n").map((l) => l.split("\x1f").slice(0, -1)) : []),
  };
}

async function workspace(extra: Record<string, unknown> = {}): Promise<{ repo: string; root: string }> {
  const repo = path.join(tmp, `ws-${n++}`);
  const root = path.join(repo, ".hivemind");
  fs.mkdirSync(path.join(root, "issues"), { recursive: true });
  await writeConfig(root, { prefix: "TT", next_id: 1, agents: {}, format: WORKSPACE_FORMAT, ...extra } as never);
  return { repo, root };
}

const pr = (number: number, state: PrRef["state"] = "open"): PrRef => ({ repo: "acme/widgets", number, url: `https://github.com/acme/widgets/pull/${number}`, state });
const gql = (prs: Record<number, { state: string; merged?: boolean; review?: string; checks?: string }>) => ({
  data: {
    r0: Object.fromEntries(Object.entries(prs).map(([num, p]) => [`p${num}`, {
      url: `https://github.com/acme/widgets/pull/${num}`, state: p.state, isDraft: false, merged: !!p.merged, reviewDecision: p.review ?? null,
      commits: { nodes: [{ commit: { statusCheckRollup: p.checks ? { state: p.checks } : null } }] },
    }])),
  },
});

function watching(o: ConstructorParameters<typeof PrWatch>[0] = {}) {
  const prs = new PrWatch(o);
  const issues = new IssueWatch({ publish: () => {}, watching: prs });
  after(() => { issues.close(); prs.close(); });
  return { prs, issues };
}
const until = (cond: () => boolean, ms = 3000) => new Promise<void>((resolve, reject) => {
  const end = Date.now() + ms;
  const tick = () => (cond() ? resolve() : Date.now() > end ? reject(new Error("timed out")) : setTimeout(tick, 25));
  tick();
});

test("it runs only while a followed issue has an open PR, and stops when none has", async () => {
  shim();
  const { repo, root } = await workspace();
  const issue = await createIssue(root, { title: "No PR yet" });
  const { prs, issues } = watching();
  const follow = new AbortController();
  issues.follow(repo, root, follow.signal);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(prs.running, false, "no open PR: no timer");
  await updateIssue(root, issue.id, { pr: pr(3) });
  await until(() => prs.running);
  await updateIssue(root, issue.id, { pr: pr(3, "closed") });
  await until(() => !prs.running);
  await updateIssue(root, issue.id, { pr: pr(4, "draft") });
  await until(() => prs.running);
  follow.abort();
  assert.equal(prs.running, false, "the last follower gone: no timer");
});

test("one pass reads every followed workspace's PRs in one gh call; merged moves to done, closed to in progress and tells the person", async () => {
  const gh = shim(gql({ 7: { state: "MERGED", merged: true, review: "APPROVED", checks: "SUCCESS" }, 8: { state: "CLOSED" } }));
  const a = await workspace({ cleanup: "ask" });
  const b = await workspace();
  const merged = await createIssue(a.root, { title: "Merged one", state: "in_review" });
  await updateIssue(a.root, merged.id, { pr: pr(7), branch: "TT-1-merged" });
  const closed = await createIssue(b.root, { title: "Closed one", state: "in_review" });
  await updateIssue(b.root, closed.id, { pr: pr(8) });
  const told: string[] = [];
  const { prs, issues } = watching({ notify: (title) => told.push(title) });
  issues.follow(a.repo, a.root, new AbortController().signal);
  issues.follow(b.repo, b.root, new AbortController().signal);
  await until(() => prs.running);

  const changes = await prs.pass();
  assert.deepEqual(changes.map((c) => [c.id, c.event, c.movedTo]).sort(), [[closed.id, "closed", "in_progress"], [merged.id, "merged", "done"]].sort());
  assert.equal(gh.calls().filter((c) => c[0] === "api").length, 1, "one gh call for both workspaces");
  const m = await readIssue(a.root, merged.id);
  assert.deepEqual([m.state, m.pr?.state, m.pr?.review, m.pr?.checks], ["done", "merged", "approved", "passing"]);
  assert.match(m.sections.activity.map((x) => x.message).join("\n"), /hive pr cleanup TT-1/, "cleanup: ask offers the cleanup");
  const c = await readIssue(b.root, closed.id);
  assert.deepEqual([c.state, c.pr?.state], ["in_progress", "closed"]);
  assert.match(c.sections.activity.at(-1)!.message, /closed without merging/);
  assert.deepEqual(told.sort(), [`${closed.id}: PR closed without merging`, `${merged.id}: PR merged`].sort());
  assert.equal(prs.running, false, "nothing open is left to watch");
});

test("a workflow's local rules decide where a merged PR's issue goes", async () => {
  shim(gql({ 9: { state: "MERGED", merged: true } }));
  const { repo, root } = await workspace({ cleanup: "never" });
  fs.writeFileSync(path.join(root, "workflow.yaml"), [
    "version: 1",
    "statuses:",
    ...["backlog", "todo", "in_progress"].map((c) => `  - { id: ${c}, name: ${c}, category: ${c} }`),
    "  - { id: hive:pr-created, name: PR Created, category: in_review }",
    "  - { id: in_review, name: Review, category: in_review }",
    "  - { id: done, name: Done, category: done }",
    "  - { id: shipped, name: Shipped, category: done }",
    "  - { id: cancelled, name: Cancelled, category: cancelled }",
    "local: { onPrOpened: hive:pr-created, onPrMerged: shipped }",
  ].join("\n"));
  const issue = await createIssue(root, { title: "Ships", status: "hive:pr-created" });
  await updateIssue(root, issue.id, { pr: pr(9) });
  const { prs, issues } = watching();
  issues.follow(repo, root, new AbortController().signal);
  await until(() => prs.running);
  await prs.pass();
  const after = await readIssue(root, issue.id);
  assert.deepEqual([after.status, after.state], ["shipped", "done"]);
});

test("changes requested and failing checks are badges: the issue stays where it is and nobody is told", async () => {
  shim(gql({ 5: { state: "OPEN", review: "CHANGES_REQUESTED", checks: "FAILURE" } }));
  const { repo, root } = await workspace();
  const issue = await createIssue(root, { title: "Under review", state: "in_review" });
  await updateIssue(root, issue.id, { pr: pr(5) });
  const told: string[] = [];
  const { prs, issues } = watching({ notify: (t) => told.push(t) });
  issues.follow(repo, root, new AbortController().signal);
  await until(() => prs.running);
  const changes = await prs.pass();
  assert.deepEqual(changes.map((c) => c.event).sort(), ["changes-requested", "checks-failing"]);
  const after = await readIssue(root, issue.id);
  assert.deepEqual([after.state, after.pr?.state, after.pr?.review, after.pr?.checks], ["in_review", "open", "changes_requested", "failing"]);
  assert.deepEqual(told, []);
  assert.equal(prs.running, true, "still open: still watched");
  const file = fs.readFileSync(after.path, "utf8");
  assert.deepEqual(await prs.pass(), [], "the same answer again changes nothing");
  assert.equal(fs.readFileSync(after.path, "utf8"), file, "and writes nothing");
});
