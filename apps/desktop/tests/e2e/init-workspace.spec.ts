// E2E: launch in a folder with NO .hivemind/, click "Initialize workspace",
// verify config.yaml written + New button appears. This is the gap the user
// hit — opening a non-hivemind folder left them unable to create issues.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import os from "node:os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_DIR = path.resolve(__dirname, "../..");

let app: ElectronApplication;
let page: Page;
let workspace: string;

test.beforeAll(async () => {
  // Bare folder — NO .hivemind/. Also no .git (so repoPath falls back to cwd).
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "hivemind-init-"));
  // Isolated userData so localStorage (hivemind:last-project) from other
  // runs doesn't bleed in and auto-reopen a stale workspace.
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), "hivemind-ud-"));
  app = await electron.launch({
    args: [
      path.join(APP_DIR, "out/main/index.js"),
      "--no-sandbox",
      `--user-data-dir=${userData}`,
    ],
    cwd: workspace,
  });
  page = await app.firstWindow();
  page.on("pageerror", (e) => console.log("[r.pageerror]", e.message));
  await page.waitForSelector(".react-flow", { timeout: 10_000 });
  await page.waitForTimeout(400);
});

test.afterAll(async () => {
  await app?.close();
  await fs.rm(workspace, { recursive: true, force: true }).catch(() => {/*ignored*/});
});

test("no workspace: empty-state offers Initialize, no New-issue button", async () => {
  // Canvas-only: no header. The New-issue button is absent without a workspace.
  expect(await page.getByRole("button", { name: /New issue/ }).count()).toBe(0);
  // Empty-state surfaces the init action directly (frame = workspace; the old
  // top-left switcher + ⌘K palette are gone).
  await expect(page.getByRole("button", { name: /Initialize workspace here/ })).toBeVisible();
});

test("Initialize workspace writes config + reveals New button", async () => {
  // Trigger init from the canvas empty-state button (the canonical no-workspace UX).
  await page.getByRole("button", { name: /Initialize workspace here/ }).first().click();

  // Inline prefix modal appears. Set prefix TST and confirm.
  await expect(page.getByRole("heading", { name: "Initialize workspace" })).toBeVisible({ timeout: 3_000 });
  const prefixInput = page.locator('input[placeholder="e.g. PAY"]');
  await prefixInput.fill("TST");
  await page.getByRole("button", { name: /^Initialize$/ }).click();

  // Config file is written synchronously by the IPC handler — assert that
  // first to isolate IPC success from UI re-render.
  await expect.poll(
    async () =>
      fs.readFile(path.join(workspace, ".hivemind", "config.yaml"), "utf8").catch(() => ""),
    { timeout: 8_000 },
  ).toMatch(/prefix:\s*TST/);

  // Then the re-resolve should reveal the New-issue button.
  await expect(page.getByRole("button", { name: /New issue/ })).toBeVisible({ timeout: 10_000 });

  const cfg = await fs.readFile(path.join(workspace, ".hivemind", "config.yaml"), "utf8");
  expect(cfg).toMatch(/next_id:\s*1/);

  // Now the create flow should work end-to-end.
  await page.getByRole("button", { name: /New issue/ }).first().click();
  await expect(page.getByRole("heading", { name: "New issue" })).toBeVisible();
  await page.keyboard.type("First issue after init", { delay: 4 });
  await page.getByRole("button", { name: "Create issue" }).click();
  await page.waitForSelector('[role="dialog"]', { state: "hidden", timeout: 3_000 });

  const md = await fs.readFile(path.join(workspace, ".hivemind", "issues", "TST-1.md"), "utf8");
  expect(md).toMatch(/id:\s*TST-1/);
  expect(md).toMatch(/title:\s*['"]?First issue after init/);
});
