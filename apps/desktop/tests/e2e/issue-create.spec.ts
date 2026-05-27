// Full E2E for issue creation:
//   1. Set up a temp hivemind workspace on disk (`.hivemind/config.yaml`,
//      empty `issues/` dir).
//   2. Launch Electron with cwd = that temp dir → resolveProject() finds the
//      .hivemind root and seeds the renderer.
//   3. Open the New-Issue modal via the header "+ New" button (the modal
//      requires `root`; with no `.hivemind/` the button is hidden).
//   4. Fill title + description, submit.
//   5. Assert the markdown file appears on disk at `.hivemind/issues/XX-1.md`
//      with the expected frontmatter (id, title, state, etc).
//   6. Assert the issue shows up in the renderer (Board view card).
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
  // Seed an isolated workspace so this test is hermetic.
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "hivemind-e2e-"));
  await fs.mkdir(path.join(workspace, ".hivemind", "issues"), { recursive: true });
  // ConfigZ expects: prefix, next_id, agents{}
  await fs.writeFile(
    path.join(workspace, ".hivemind", "config.yaml"),
    "prefix: XX\nnext_id: 1\nagents: {}\n",
    "utf8",
  );

  app = await electron.launch({
    args: [
      path.join(APP_DIR, "out/main/index.js"),
      "--no-sandbox",
      `--user-data-dir=/tmp/hivemind-ud-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    ],
    cwd: workspace,
  });
  page = await app.firstWindow();
  page.on("console", (m) => console.log(`[r.${m.type()}]`, m.text()));
  page.on("pageerror", (e) => console.log("[r.pageerror]", e.message));
  await page.waitForLoadState("domcontentloaded");
  // Wait for the project to resolve — the "+ New" button only shows once
  // App.tsx has a `root`.
  await page.waitForSelector(".react-flow", { timeout: 10_000 });
  await page.waitForTimeout(500);
});

test.afterAll(async () => {
  await app?.close();
  await fs.rm(workspace, { recursive: true, force: true }).catch(() => {/*ignored*/});
});

test("project resolves: the floating New-issue button is visible", async () => {
  // Canvas-only: New lives in the floating top-right chrome, not a header bar.
  await expect(page.getByRole("button", { name: /New issue/ })).toBeVisible();
});

test("creates an issue via the modal and persists it to disk", async () => {
  await page.getByRole("button", { name: /New issue/ }).first().click();
  await page.waitForSelector('[role="dialog"]', { timeout: 3_000 });
  // The dialog should contain the heading "New issue" — disambiguates from
  // the ⌘K palette which also opens dialogs.
  await expect(page.getByRole("heading", { name: "New issue" })).toBeVisible();

  // Title is autofocused; just type.
  const title = "Playwright created issue";
  await page.keyboard.type(title, { delay: 5 });

  // Description (find by its label).
  const desc = page.locator("textarea").first();
  await desc.fill("acceptance: visible in Board view after submit");

  // Submit. The submit button reads "Create issue".
  await page.getByRole("button", { name: "Create issue" }).click();

  // Dialog closes on submit. (Canvas-only: there's no board view to render the
  // card into — the issue lives on disk + in the IssuesTile when opened. The
  // on-disk assertions below are the source of truth.)
  await page.waitForSelector('[role="dialog"]', { state: "hidden", timeout: 3_000 });

  // Assert the on-disk file. Prefix XX, next_id starts at 1 → first id is XX-1.
  const issuePath = path.join(workspace, ".hivemind", "issues", "XX-1.md");
  const md = await fs.readFile(issuePath, "utf8");
  console.log("issue md:", md.slice(0, 400));
  expect(md).toMatch(/^---/m);
  expect(md).toMatch(/id:\s*XX-1/m);
  expect(md).toMatch(new RegExp(`title:\\s*['"]?${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  expect(md).toMatch(/state:\s*todo/m);
  expect(md).not.toMatch(/^cycle:/m);

  // The config's next_id should now be 2.
  const cfg = await fs.readFile(path.join(workspace, ".hivemind", "config.yaml"), "utf8");
  expect(cfg).toMatch(/next_id:\s*2/);
});

test("Ctrl+N opens the same modal", async () => {
  await page.keyboard.press("Control+n");
  await expect(page.getByRole("heading", { name: "New issue" })).toBeVisible({ timeout: 2_000 });
  await page.keyboard.press("Escape");
});
