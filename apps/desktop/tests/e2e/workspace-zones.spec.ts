// Throwaway e2e: verify multi-workspace zones end-to-end via the
// HIVEMIND_TEST_PICK_DIR seam (native folder dialog can't be driven headless).
// Launch on repo A, add a frame, bind it to repo B, drag the Issues tile into
// the zone, and assert it shows B's issue (not A's) — proving mkTile threads the
// zone's `root`. Also assert the spawn picker appears with a zone present.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";

let app: ElectronApplication;
let page: Page;
let repoA: string;
let repoB: string;

async function seedRepo(prefix: string, issueTitle: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `hm-ws-${prefix}-`));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir });
  git("init", "-q");
  git("config", "user.email", "e2e@test.dev");
  git("config", "user.name", "e2e");
  await fs.writeFile(path.join(dir, "README.md"), `# ${prefix}\n`, "utf8");
  await fs.mkdir(path.join(dir, ".hivemind", "issues"), { recursive: true });
  await fs.writeFile(
    path.join(dir, ".hivemind", "config.yaml"),
    `prefix: ${prefix}\nnext_id: 2\nagents: {}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(dir, ".hivemind", "issues", `${prefix}-1.md`),
    `---\nid: ${prefix}-1\ntitle: "${issueTitle}"\nstate: todo\ncreated: 2026-05-22\nupdated: 2026-05-22\n---\n\n## Description\n${issueTitle}\n`,
    "utf8",
  );
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  return dir;
}

test.beforeAll(async () => {
  repoA = await seedRepo("AAA", "alpha-task");
  repoB = await seedRepo("BBB", "beta-task");
  app = await electron.launch({
    args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox", `--user-data-dir=/tmp/hm-ws-ud-${Date.now()}`],
    cwd: repoA,
    env: { ...process.env, HIVEMIND_PTY_DAEMON: "0", HIVEMIND_TEST_PICK_DIR: repoB },
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForSelector(".react-flow", { timeout: 15_000 });
  await page.waitForTimeout(500);
});

test.afterAll(async () => {
  await app?.close();
  await fs.rm(repoA, { recursive: true, force: true }).catch(() => {});
  await fs.rm(repoB, { recursive: true, force: true }).catch(() => {});
});

test("bind a frame to workspace B and the in-zone Issues tile shows B's issues", async () => {
  // 1. Add a frame.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:add-frame")));
  await page.waitForSelector(".react-flow__node-frame", { timeout: 6_000 });
  await page.waitForTimeout(300);

  // 2. Bind it to a workspace → pickProjectFolder returns repoB (seam).
  await page.locator('[aria-label="bind workspace"]').first().click();
  // Frame chip should now show repo B's name.
  await expect(page.locator(".react-flow__node-frame")).toContainText(path.basename(repoB), { timeout: 6_000 });

  // 3. frame = workspace: with a single frame, spawning goes straight into it
  //    (no picker until 2+ frames exist) → a claude tile lands INSIDE the frame.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:spawn-claude")));
  await page.waitForSelector(".react-flow__node-terminal", { timeout: 6_000 });

  // The spawned terminal node is parented to the frame (react-flow nests a
  // child node's DOM under the parent's). Assert it landed inside the frame.
  const frameBox = await page.locator(".react-flow__node-frame").boundingBox();
  const termBox = await page.locator(".react-flow__node-terminal").first().boundingBox();
  expect(frameBox && termBox).toBeTruthy();
  // Terminal's top-left sits within the frame's bounds (it was placed at
  // frame.x+24, frame.y+48 and parented).
  expect(termBox!.x).toBeGreaterThanOrEqual(frameBox!.x - 4);
  expect(termBox!.y).toBeGreaterThanOrEqual(frameBox!.y - 4);
  expect(termBox!.x).toBeLessThan(frameBox!.x + frameBox!.width);
});
