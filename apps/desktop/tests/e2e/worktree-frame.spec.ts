// Nested worktree sub-frames: the frame header's "worktree" control opens the
// Zed-style picker (list existing + create), and creating one spawns a nested
// child frame bound to that branch. Runs against a throwaway git repo fixture
// so worktreeList/worktreeCreate are real + deterministic.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let app: ElectronApplication;
let page: Page;
let repo: string;

const sh = (c: string) => execSync(c, { cwd: repo, stdio: "pipe" });

test.beforeAll(async () => {
  repo = mkdtempSync(path.join(tmpdir(), "hm-wt-"));
  sh("git init -q -b main");
  sh("git config user.email t@t.t");
  sh("git config user.name t");
  writeFileSync(path.join(repo, "readme.md"), "hello\n");
  sh("git add -A");
  sh("git commit -qm init");

  app = await electron.launch({
    args: [
      path.join(process.cwd(), "out/main/index.js"),
      "--no-sandbox",
      `--user-data-dir=/tmp/hm-ud-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    ],
    cwd: repo,
  });
  page = await app.firstWindow();
  page.on("console", (m) => console.log(`[renderer.${m.type()}]`, m.text().slice(0, 160)));
  await page.waitForLoadState("domcontentloaded");
  await page.waitForSelector(".react-flow", { timeout: 15_000 });
  await page.waitForTimeout(400);

  // Materialize a frame (the base workspace frame is repo-bound → worktree
  // controls are enabled).
  await page.keyboard.press("6");
  await page.waitForSelector(".react-flow__node-frame", { timeout: 5_000 });
  await page.waitForTimeout(300);
});

test.afterAll(async () => {
  await app?.close();
  try { execSync(`git worktree prune`, { cwd: repo, stdio: "pipe" }); } catch { /* ignore */ }
  try { execSync(`rm -rf ${repo}`); } catch { /* ignore */ }
});

test("frame 'worktree' control opens the picker (list + create)", async () => {
  const attach = page.locator('[aria-label="attach worktree"]').first();
  await expect(attach).toBeVisible();
  await expect(attach).toBeEnabled();
  await attach.click();

  // Picker portals to body; it offers a Create action and lists the repo's
  // existing (main) worktree.
  await expect(page.getByText("Create new worktree", { exact: false })).toBeVisible({ timeout: 5_000 });
  await page.waitForFunction(
    () => /loading worktrees/i.test(document.body.textContent || "") === false,
    undefined,
    { timeout: 8_000 },
  ).catch(() => {});
  // The main worktree row carries the repo's branch (main).
  await expect(page.getByText("main", { exact: false }).first()).toBeVisible();
});

test("creating a worktree spawns a nested child frame bound to the branch", async () => {
  const beforeFrames = await page.locator(".react-flow__node-frame").count();

  // Open the picker if it closed, then start the create flow.
  if ((await page.getByText("Create new worktree", { exact: false }).count()) === 0) {
    await page.locator('[aria-label="attach worktree"]').first().click();
    await expect(page.getByText("Create new worktree", { exact: false })).toBeVisible({ timeout: 5_000 });
  }
  await page.getByText("Create new worktree", { exact: false }).click();
  const branchInput = page.locator('input[placeholder*="new branch"]');
  await expect(branchInput).toBeVisible({ timeout: 3_000 });
  await branchInput.fill("feature-x");
  await branchInput.press("Enter");

  // A nested child frame appears (frame count grows) carrying the branch pill.
  await expect
    .poll(async () => page.locator(".react-flow__node-frame").count(), { timeout: 15_000 })
    .toBeGreaterThan(beforeFrames);
  await expect(page.locator('[aria-label="detach worktree"]').first()).toBeVisible({ timeout: 5_000 });

  // The worktree actually exists on disk.
  const list = execSync("git worktree list", { cwd: repo }).toString();
  expect(list).toContain("feature-x");
});
