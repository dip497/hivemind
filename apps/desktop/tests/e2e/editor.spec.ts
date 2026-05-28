// E2E for the IDE-style Workbench tile (file explorer + tabbed editor attached
// in one tile). Seeds a real git repo with one file, opens the canvas, toggles
// the Explorer (which mounts the workbench), clicks the file in the embedded
// tree, and asserts the embedded editor renders the file's content. Then types
// and asserts dirty. Saving-to-disk is verified as a bonus after ⌘S.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";

let app: ElectronApplication;
let page: Page;
let repo: string;
const FILE = "hello.ts";
const ORIGINAL = "export const greeting = 'hello world';\n";

test.beforeAll(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), "hm-editor-"));
  await fs.writeFile(path.join(repo, FILE), ORIGINAL, "utf8");
  // The file tree is fed by `git ls-files`, so the file must be tracked.
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q");
  git("config", "user.email", "e2e@test.dev");
  git("config", "user.name", "e2e");
  git("add", FILE);
  git("commit", "-q", "-m", "seed");

  app = await electron.launch({
    args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox", `--user-data-dir=/tmp/hm-editor-ud-${Date.now()}`],
    cwd: repo,
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForSelector(".react-flow", { timeout: 15_000 });
  await page.waitForTimeout(400);
  // Open the workbench tile (Explorer toggle mounts tree + editor attached).
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "tree" })));
  await page.waitForSelector(".react-flow__node-workbench", { timeout: 8_000 });
  await page.waitForTimeout(600);
});

test.afterAll(async () => {
  await app?.close();
  await fs.rm(repo, { recursive: true, force: true }).catch(() => {});
});

test("clicking a tree file opens it as a tab in the embedded editor", async () => {
  // The Pierre file tree renders rows inside a virtualized web component
  // (shadow DOM); each file is a `button[role="treeitem"]`. Click the row for
  // our seeded file (only one exists in this repo). Playwright pierces shadow
  // DOM, so the role locator resolves the row even though it's in shadow. The
  // tree + editor both live inside the single workbench node.
  const workbench = page.locator(".react-flow__node-workbench");
  const row = workbench.locator("button[role='treeitem']").first();
  await row.waitFor({ state: "visible", timeout: 8_000 });
  await row.click();
  // The embedded editor (inside the workbench) shows the tab + content.
  const editor = workbench;
  // Tab labelled with the file name.
  await expect(editor.getByRole("tab")).toContainText(FILE.split("/").pop()!, { timeout: 5_000 });
  // CodeMirror renders the file content.
  await expect.poll(async () => editor.locator(".cm-content").textContent(), { timeout: 6_000, intervals: [300] })
    .toContain("greeting");
});

test("typing marks the tab dirty", async () => {
  const editor = page.locator(".react-flow__node-workbench");
  const content = editor.locator(".cm-content");
  await content.click();
  await page.keyboard.type("// edited\n");
  // The active tab shows an unsaved dot once dirty (embedded editor has no
  // header; the dirty indicator lives on the tab itself).
  await expect(editor.getByRole("tab")).toHaveAttribute("title", FILE, { timeout: 4_000 });
  await expect(editor.locator(".cm-content")).toContainText("// edited", { timeout: 4_000 });
});

test("Ctrl+S saves edits to disk", async () => {
  const editor = page.locator(".react-flow__node-workbench");
  await editor.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+s");
  // File on disk now contains the typed text; dirty dot clears.
  await expect.poll(async () => fs.readFile(path.join(repo, FILE), "utf8"), { timeout: 6_000, intervals: [300] })
    .toContain("// edited");
});

test("Ctrl+F opens the CodeMirror search panel", async () => {
  const editor = page.locator(".react-flow__node-workbench");
  await editor.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+f");
  // @codemirror/search renders a docked panel with a 'search…' input.
  await expect(editor.locator(".cm-panel.cm-search input[name='search']"))
    .toBeVisible({ timeout: 4_000 });
  await page.keyboard.press("Escape");
});
