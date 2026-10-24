// Finishing an issue through its PR (design jira-sync §15, e2e 4), in a local-only workspace: the
// agent's `hive ctl complete` pushes the branch and opens the PR (through the `gh` shim,
// scripts/gh-shim), the card shows the PR, and once GitHub says it merged the app's PR watcher
// moves the issue to Done. A watched workspace with an open PR is read 10 s after the app opens it,
// so the merge is seen by opening the app again. Then the same with a workflow whose onPrOpened
// is a hive-only PR Created status.
import { test, expect, type Page } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchWindow, type AppWindow } from "./helpers/window";

const REPO_ROOT = path.resolve(process.cwd(), "../..");
const CLI = path.join(REPO_ROOT, "apps/cli/src/index.ts");
const SHIM = path.join(REPO_ROOT, "scripts/gh-shim");
const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hm-issues-pr-")));
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: { ...process.env, ...GIT_ENV }, encoding: "utf8" });

interface Ws { repo: string; wt: string; shim: string }
let n = 0;

/** A repository pushed to a bare origin, its `.hivemind/config.yaml` tracked; TT-1 in progress on
 *  branch TT-1-widgets, with its criteria ticked and one commit in its worktree. */
function workspace(workflow?: string): Ws {
  const base = path.join(tmp, `w${n++}`);
  const repo = path.join(base, "repo");
  const wt = path.join(base, "wt");
  const shim = path.join(base, "shim");
  fs.mkdirSync(path.join(repo, ".hivemind", "issues"), { recursive: true });
  fs.mkdirSync(shim);
  git(base, "init", "-q", "--bare", "origin.git");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "remote", "add", "origin", path.join(base, "origin.git"));
  fs.writeFileSync(path.join(repo, ".hivemind", "config.yaml"), "prefix: TT\nnext_id: 2\nagents: {}\n");
  if (workflow) fs.writeFileSync(path.join(repo, ".hivemind", "workflow.yaml"), workflow);
  fs.writeFileSync(path.join(repo, ".gitignore"), ".hivemind/*\n!.hivemind/config.yaml\n");
  fs.writeFileSync(path.join(repo, "README.md"), "widgets\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "push", "-q", "-u", "origin", "main");
  git(repo, "remote", "set-head", "origin", "main");
  fs.writeFileSync(path.join(repo, ".hivemind", "issues", "TT-1.md"), `---
id: TT-1
title: Add widgets
state: in_progress
parent: null
labels: []
assignee: null
github: null
branch: TT-1-widgets
created: "2026-10-24T00:00:00.000Z"
updated: "2026-10-24T00:00:00.000Z"
---

## Description

Widgets for everyone.

## Acceptance criteria

- [x] widgets render
`);
  git(repo, "worktree", "add", "-q", "-b", "TT-1-widgets", wt);
  fs.writeFileSync(path.join(wt, "widgets.ts"), "export const widgets = 1;\n");
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "-m", "TT-1: widgets");
  return { repo, wt, shim };
}

const shimEnv = (w: Ws) => ({ GH_SHIM: w.shim, PATH: `${SHIM}${path.delimiter}${process.env.PATH}` });
/** `hive …` as the agent in the worktree runs it. */
function hive(w: Ws, ...args: string[]) {
  const r = spawnSync("bun", [CLI, ...args, "--json"], { cwd: w.wt, env: { ...process.env, ...shimEnv(w), HIVE_AGENT_ID: "claude" }, encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
}
/** What GitHub's GraphQL answers for PR #7 from now on. */
const github = (w: Ws, state: string, review: string, checks: string) => fs.writeFileSync(path.join(w.shim, "graphql.json"), JSON.stringify({ data: { r0: { p7: {
  url: "https://github.com/acme/widgets/pull/7", state, isDraft: false, merged: state === "MERGED", reviewDecision: review,
  commits: { nodes: [{ commit: { statusCheckRollup: { state: checks } } }] },
} } } }));
const merged = (w: Ws) => github(w, "MERGED", "APPROVED", "SUCCESS");
const ghCalls = (w: Ws) => fs.readFileSync(path.join(w.shim, "calls"), "utf8").split("\n").map((l) => l.split("\x1f").slice(0, -1));
const onDisk = (w: Ws) => fs.readFileSync(path.join(w.repo, ".hivemind", "issues", "TT-1.md"), "utf8");

let app: AppWindow | null = null;
let page: Page;
/** The app on `w`'s repository, `gh` the shim, with the Issues tile open. */
async function open(w: Ws): Promise<void> {
  await app?.close();
  app = await launchWindow({
    cwd: w.repo,
    env: { ...process.env, ...shimEnv(w), HIVEMIND_SHELL_ENV: "0" },
    args: [`--user-data-dir=${path.join(tmp, `ud-${n++}`)}`],
  });
  page = app.page;
  await page.waitForLoadState("domcontentloaded");
  await page.waitForSelector(".react-flow", { timeout: 15_000 });
  await expect.poll(async () => {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "issues" })));
    return page.locator('[data-tool-plugin="@hivemind/issues"]').count();
  }, { timeout: 15_000 }).toBeGreaterThan(0);
}

test.afterAll(async () => {
  await app?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const tile = () => page.locator('[data-tool-plugin="@hivemind/issues"]');
const column = (name: string) => tile().locator(`[data-column="${name}"]`);
const card = (id: string) => tile().getByRole("button", { name: `Open issue ${id}` });

test("complete opens the PR, the card shows it, and the watcher moves the issue to Done once it merged", async () => {
  test.setTimeout(120_000);
  const w = workspace();
  await open(w);
  await expect(column("In progress").getByRole("button", { name: "Open issue TT-1" })).toBeVisible({ timeout: 10_000 });

  const done = hive(w, "ctl", "complete", "TT-1");
  expect(done.code, done.out).toBe(0);
  expect(git(path.join(w.repo, "..", "origin.git"), "branch", "--format=%(refname:short)")).toContain("TT-1-widgets");
  await expect(column("In review").getByRole("button", { name: "Open issue TT-1" })).toBeVisible({ timeout: 10_000 });
  await expect(card("TT-1").locator('[data-pr-badge="open"]')).toHaveText("#7");
  await card("TT-1").screenshot({ path: test.info().outputPath("card-pr-open.png") });
  await card("TT-1").click();
  await expect(page.locator('[data-pr-row="open"]')).toContainText("acme/widgets#7");
  await page.getByRole("dialog").screenshot({ path: test.info().outputPath("panel-pr-row.png") });
  await page.keyboard.press("Escape");

  // Review asks for changes and checks fail (here seen by `hive pr sync`, the watcher's pass): badges.
  github(w, "OPEN", "CHANGES_REQUESTED", "FAILURE");
  expect(hive(w, "pr", "sync").code).toBe(0);
  await expect(card("TT-1").locator('[data-pr-badge="open"][data-pr-review="changes_requested"][data-pr-checks="failing"]')).toBeVisible({ timeout: 10_000 });
  await expect(column("In review").getByRole("button", { name: "Open issue TT-1" })).toBeVisible();
  await card("TT-1").screenshot({ path: test.info().outputPath("card-pr-review.png") });
  await card("TT-1").click();
  await expect(page.locator("[data-fix-ci]")).toBeVisible();
  await page.getByRole("dialog").screenshot({ path: test.info().outputPath("panel-pr-review.png") });
  fs.writeFileSync(path.join(w.shim, "pr-view.json"), "reviewer: please call them gadgets\n");
  await page.locator("[data-address-review]").click();
  await expect.poll(() => ghCalls(w).some((c) => c.join(" ") === "pr view https://github.com/acme/widgets/pull/7 --comments"), { timeout: 10_000 }).toBe(true);
  await page.keyboard.press("Escape");

  merged(w);
  await open(w);
  await expect(column("Done").getByRole("button", { name: "Open issue TT-1" })).toBeVisible({ timeout: 40_000 });
  await expect(card("TT-1").locator('[data-pr-badge="merged"]')).toBeVisible();
  expect(onDisk(w)).toMatch(/state: done/);
  expect(onDisk(w)).toContain("PR acme/widgets#7 merged");
  expect(onDisk(w)).toContain("hive pr cleanup TT-1");
  await card("TT-1").screenshot({ path: test.info().outputPath("card-pr-merged.png") });
});

test("with a workflow, complete lands in its hive-only PR Created status and the merge in Done", async () => {
  test.setTimeout(90_000);
  const w = workspace([
    "version: 1",
    "statuses:",
    "  - { id: backlog, name: Backlog, category: backlog }",
    "  - { id: todo, name: To Do, category: todo }",
    "  - { id: in_progress, name: In Progress, category: in_progress }",
    "  - { id: code-review, name: Code Review, category: in_review }",
    "  - { id: hive:pr-created, name: PR Created, category: in_review, jira: { follow: code-review } }",
    "  - { id: done, name: Done, category: done }",
    "  - { id: cancelled, name: Cancelled, category: cancelled }",
    "local: { onPrOpened: hive:pr-created, onPrMerged: category:done }",
  ].join("\n"));
  const done = hive(w, "ctl", "complete", "TT-1");
  expect(done.code, done.out).toBe(0);
  expect(onDisk(w)).toMatch(/status: '?hive:pr-created'?/);
  merged(w);
  await open(w);
  await expect(column("Done").getByRole("button", { name: "Open issue TT-1" })).toBeVisible({ timeout: 40_000 });
  expect(onDisk(w)).toMatch(/status: '?done'?/);
});
