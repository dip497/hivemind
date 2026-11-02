// The Code plugin's pieces as tools of their own (docs/design/code-tools-2026-11-02.md §3.1): Files and
// Changes open from Add on their own, a file picked in either opens in the frame's editor (started
// when there is none, reused after), Changes shows the working tree's change, and each is its
// frame's: the files of the frame's own folder, its picks opened in that frame's editor.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fsSync from "node:fs";
import path from "node:path";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";

let app: ElectronApplication;
let page: Page;
let root: string;
let repo: string;
/** A second project, its own repository, added as a frame of its own. */
let other: string;

const seed = (dir: string, files: Record<string, string>) => {
  fsSync.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) fsSync.writeFileSync(path.join(dir, name), text);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e2e@test.dev");
  git("config", "user.name", "e2e");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
};

test.beforeAll(async () => {
  root = fsSync.realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), "hm-code-tools-")));
  repo = path.join(root, "shop");
  other = path.join(root, "billing");
  seed(repo, { "cart.ts": "export const total = (xs: number[]) => xs.length;\n", "notes.md": "# NOTES_MARKER\n" });
  seed(other, { "invoice.ts": "export const INVOICE_MARKER = 1;\n" });
  // An agent's edit, not committed: what Changes is for.
  await fs.writeFile(path.join(repo, "cart.ts"), "export const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);\n", "utf8");

  const env = { ...process.env, XDG_CONFIG_HOME: path.join(root, "config"), HIVEMIND_SHELL_ENV: "0" } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox", `--user-data-dir=${path.join(root, "ud")}`], cwd: repo, env });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 30_000 });
});

test.afterAll(async () => {
  await app?.close();
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
});

/** Add ▸ a tool, as a person does, answering the frame picker with `where` if the app asks. */
async function add(kind: string, where?: string) {
  await page.locator(".react-flow__pane").click({ position: { x: 5, y: 5 } });
  await page.locator('[data-toolbar-action="board"]').click();
  await page.locator(`[data-add-menu] [data-board-choice="tile:${kind}"]`).click();
  const picker = page.getByRole("dialog").filter({ hasText: /Start .* in/ });
  if (await picker.isVisible({ timeout: 1500 }).catch(() => false)) {
    await (where ? picker.getByText(where, { exact: true }) : picker.getByRole("button").first()).click();
  }
}
/** Bring a tile into view, as picking it in Layers does: opening a file moves the camera to the editor. */
const show = (tile: import("@playwright/test").Locator) => tile.getAttribute("data-id").then((id) =>
  page.evaluate((d) => window.dispatchEvent(new CustomEvent("hivemind:focus-tile", { detail: d })), id));

test("Files opens on its own, and a file picked in it opens in the frame's editor, started once and reused", async () => {
  await add("files");
  const files = page.locator(".react-flow__node-files");
  await expect(files).toHaveCount(1);
  // On its own it has no editor beside it: the Code tile is not opened with it.
  await expect(page.locator(".react-flow__node-workbench")).toHaveCount(0);

  await files.getByRole("treeitem", { name: "notes.md" }).first().click();
  const editor = page.locator(".react-flow__node-workbench");
  await expect(editor).toHaveCount(1, { timeout: 8_000 });
  await expect.poll(() => editor.locator(".cm-content").textContent(), { timeout: 8_000 }).toContain("NOTES_MARKER");

  // A second file: the same editor, a second tab, not a second editor.
  await show(files);
  await files.getByRole("treeitem", { name: "cart.ts" }).first().click();
  await expect.poll(() => editor.locator(".cm-content").textContent(), { timeout: 8_000 }).toContain("reduce");
  await expect(editor).toHaveCount(1);
});

test("Changes opens on its own and shows the working tree's change", async () => {
  await add("changes");
  const changes = page.locator(".react-flow__node-changes");
  await expect(changes).toHaveCount(1);
  await expect(changes).toContainText("cart.ts", { timeout: 10_000 });
  // Only the changed file: the one untouched is not listed.
  await expect(changes).not.toContainText("notes.md");
});

test("each is one per frame: adding Files again shows the one there is", async () => {
  // Twice here, so this holds when it runs on its own too.
  await add("files");
  await add("files");
  await expect(page.locator(".react-flow__node-files")).toHaveCount(1);
});

test("each is its frame's: a frame of another project lists that project's files, and opens them in its own editor", async () => {
  await app.evaluate(({ dialog }, picked) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog; }, other);
  await page.locator('aside[aria-label="Layers"] [data-layers-action="project"]').click();
  await expect(page.locator('[data-layers-project="billing"]')).toHaveCount(1);

  await add("files", "billing");
  const all = page.locator(".react-flow__node-files");
  await expect(all).toHaveCount(2);
  const billing = all.filter({ has: page.getByRole("treeitem", { name: "invoice.ts" }) });
  await expect(billing).toHaveCount(1);
  // Its own folder only: the first project's files are not in it.
  await expect(billing.getByRole("treeitem", { name: "cart.ts" })).toHaveCount(0);

  await show(billing);
  await billing.getByRole("treeitem", { name: "invoice.ts" }).first().click();
  const editors = page.locator(".react-flow__node-workbench");
  await expect(editors).toHaveCount(2, { timeout: 8_000 });
  await expect(editors.filter({ hasText: "INVOICE_MARKER" })).toHaveCount(1, { timeout: 8_000 });
  // The first project's editor did not take it.
  await expect(editors.filter({ hasText: "NOTES_MARKER" }).filter({ hasText: "INVOICE_MARKER" })).toHaveCount(0);
});
