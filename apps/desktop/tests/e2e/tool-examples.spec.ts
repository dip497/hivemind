// The CI runs and Worktrees example tools, loaded into the real app. CI runs drives a `gh` on PATH
// that answers from files, so its list, a failed job's log and its rerun are checked without the
// network. Worktrees reads a repository with three worktrees and removes the one that loses nothing.
import { test, expect, _electron as electron, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { seedAgents } from "./helpers/agents";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-tool-examples-"));
const xdg = path.join(root, "config");
seedAgents(xdg);
const repo = path.join(root, "repo");
const fakeGh = path.join(root, "gh");
const env = { ...process.env, XDG_CONFIG_HOME: xdg, HIVEMIND_PTY_DAEMON: "0", HIVEMIND_SHELL_ENV: "0", PATH: `${fakeGh}${path.delimiter}${process.env.PATH}` } as Record<string, string>;
delete env.ELECTRON_RUN_AS_NODE;
const cli = path.resolve(process.cwd(), "../cli/src/index.ts");
const examples = path.resolve(process.cwd(), "../../examples/tools");
let hcp: Record<string, string> = {};
const hive = (...args: string[]) => {
  const result = spawnSync("bun", [cli, ...args, "--json"], { cwd: repo, env: { ...env, ...hcp }, encoding: "utf8" });
  if (!result.stdout.trim()) throw new Error(result.stderr);
  return { status: result.status, data: JSON.parse(result.stdout) };
};
const git = (cmd: string, cwd = repo) => execSync(`git -c user.email=t@t -c user.name=t ${cmd}`, { cwd, encoding: "utf8" });

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  fs.mkdirSync(repo, { recursive: true });
  execSync("git init -q -b main", { cwd: repo });
  fs.writeFileSync(path.join(repo, "a.ts"), "export const a = 1;\n");
  git("add -A");
  git("commit -q -m 'first change'");
  git(`worktree add -q -b done ${path.join(root, "wt-merged")}`);
  git(`worktree add -q -b feat ${path.join(root, "wt-work")}`);
  const work = path.join(root, "wt-work");
  fs.appendFileSync(path.join(work, "a.ts"), "export const committed = 2;\n");
  git("commit -q -am 'feat: committed'", work);
  fs.appendFileSync(path.join(work, "a.ts"), "export const uncommitted = 3;\n");

  fs.mkdirSync(fakeGh);
  fs.writeFileSync(path.join(fakeGh, "runs.json"), JSON.stringify([
    { databaseId: 101, displayTitle: "fix: the build", headBranch: "main", status: "completed", conclusion: "failure", workflowName: "CI", createdAt: new Date().toISOString(), event: "push", url: "https://example.test/runs/101" },
    { databaseId: 100, displayTitle: "docs: a typo", headBranch: "main", status: "completed", conclusion: "success", workflowName: "CI", createdAt: new Date().toISOString(), event: "push", url: "https://example.test/runs/100" },
  ]));
  fs.writeFileSync(path.join(fakeGh, "jobs.json"), JSON.stringify({ jobs: [
    { databaseId: 7, name: "lint", status: "completed", conclusion: "success", steps: [{ number: 1, name: "Lint", status: "completed", conclusion: "success" }] },
    { databaseId: 8, name: "typecheck", status: "completed", conclusion: "failure", steps: [{ number: 1, name: "Typecheck", status: "completed", conclusion: "failure" }] },
  ] }));
  fs.writeFileSync(path.join(fakeGh, "log.txt"), "typecheck\tTypecheck\t2026-10-07T10:00:00.0000000Z src/a.ts(1,1): error TS2345: boom\n");
  fs.writeFileSync(path.join(fakeGh, "gh"), [
    "#!/bin/sh",
    `d='${fakeGh}'`,
    'case "$1 $2" in',
    '  "run list") cat "$d/runs.json" ;;',
    '  "run view") if [ "$3" = "--job" ]; then cat "$d/log.txt"; else cat "$d/jobs.json"; fi ;;',
    '  "run rerun"|"run cancel") echo "$@" >> "$d/calls" ;;',
    '  *) echo "unexpected: $*" >&2; exit 1 ;;',
    "esac",
  ].join("\n"), { mode: 0o755 });

  for (const name of ["ci-runs", "worktrees"]) {
    expect(hive("tools", "install", path.join(examples, name)).status).toBe(0);
    expect(hive("plugins", "enable", `tool:dip497/${name}`).status).toBe(0);
  }
  app = await electron.launch({ args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox"], cwd: repo, env });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 30_000 });
  const userData = path.join(xdg, "hivemind-dev");
  await expect.poll(() => fs.existsSync(path.join(userData, "hcp.token"))).toBe(true);
  hcp = { HIVE_HCP_SOCK: path.join(userData, "hcp.sock"), HCP_TOKEN: fs.readFileSync(path.join(userData, "hcp.token"), "utf8").trim() };
});
test.afterAll(async () => { await app?.close(); fs.rmSync(root, { recursive: true, force: true }); });

const tile = (id: string) => page.locator(`[data-tool-plugin="${id}"]`);
// The diff view draws inside shadow roots: read the text through them.
const deepText = (el: Locator) => () => el.evaluate((n) => {
  const walk = (x: Element | ShadowRoot): string => [...x.children].map((c) => (c.shadowRoot ? walk(c.shadowRoot) : "") + (c.children.length ? walk(c) : c.textContent ?? "")).join(" ");
  return walk(n);
});

test("CI runs lists the runs, shows a failed job's lines, and reruns the failed jobs", async () => {
  expect(hive("ctl", "open-tool", "dip497/ci-runs/runs").status).toBe(0);
  const ci = tile("dip497/ci-runs");
  await expect(ci).toContainText("fix: the build", { timeout: 20_000 });
  await expect(ci).toContainText("docs: a typo");
  await ci.locator('[data-run="101"]').click();
  // The failed job is the one chosen, and its failed lines are shown under its step.
  await expect(ci.locator("[data-log]")).toContainText("error TS2345: boom");
  await expect(ci.locator("[data-log]")).toContainText("── Typecheck");
  await expect(ci).toContainText("Failed at: Typecheck");
  await expect(ci.getByRole("button", { name: "Ask an agent to fix" })).toBeVisible();
  await ci.getByRole("button", { name: "Rerun failed" }).click();
  await expect.poll(() => fs.readFileSync(path.join(fakeGh, "calls"), "utf8").trim()).toBe("run rerun 101 --failed");
  // A job that passed shows its steps, and offers no fix.
  await ci.locator('[data-job="lint"]').click();
  await expect(ci).toContainText("passed · 1 steps");
  await expect(ci.getByRole("button", { name: "Ask an agent to fix" })).toHaveCount(0);
});

test("Worktrees shows each worktree's state, its diffs, and removes only one that loses nothing", async () => {
  expect(hive("ctl", "open-tool", "dip497/worktrees/worktrees").status).toBe(0);
  const wt = tile("dip497/worktrees");
  const row = (name: string) => wt.locator(`[data-worktree="${name}"]`);
  await expect(row("wt-work")).toContainText("1 uncommitted", { timeout: 20_000 });
  await expect(row("wt-work")).toContainText("↑1");
  await expect(row("wt-work")).not.toContainText("merged");
  await expect(row("wt-merged")).toContainText("merged");
  await expect(row("repo")).toContainText("main worktree");

  await row("wt-work").click();
  await expect.poll(deepText(wt), { timeout: 15_000 }).toContain("uncommitted = 3");
  await wt.getByRole("button", { name: /^Branch vs main/ }).click();
  await expect.poll(deepText(wt), { timeout: 15_000 }).toContain("committed = 2");
  await expect(wt.getByRole("button", { name: "Remove" })).toHaveCount(0);

  await wt.getByRole("button", { name: /^Merged/ }).click();
  await expect(wt.locator("[data-worktree]")).toHaveCount(1);
  await row("wt-merged").click();
  await wt.getByRole("button", { name: "Remove" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove" }).click();
  await expect.poll(() => fs.existsSync(path.join(root, "wt-merged"))).toBe(false);
  await expect.poll(() => git("branch --list done").trim()).toBe("");
  await expect(wt.locator("[data-worktree]")).toHaveCount(0);
  expect(fs.existsSync(path.join(root, "wt-work"))).toBe(true);
});
