// Finding in the app (docs/design/code-tools-2026-11-02.md §3.2): the Search tile finds a line and
// opens the frame's editor at it; Ctrl+P in the Code tile goes to a file by a typo'd name; and the
// editor closes a bracket and offers the file's own words as they are typed.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

let app: ElectronApplication;
let page: Page;
let root: string;
let repo: string;

const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
function write(f: string, text: string) {
  fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
  fs.writeFileSync(path.join(repo, f), text);
}

test.beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hm-search-")));
  repo = path.join(root, "shop");
  fs.mkdirSync(repo);
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Ada");
  git("config", "user.email", "ada@example.com");
  write("src/checkout/cart.ts", "export const items: string[] = [];\nexport function addItem(name: string) { items.push(name); }\n");
  // The line to find sits far enough down that opening at it has to scroll.
  write("src/checkout/tax.ts", `${Array.from({ length: 120 }, (_, i) => `// filler ${i}`).join("\n")}\nexport const TAX_RATE_MARKER = 0.2;\n`);
  write("README.md", "# shop\n");
  git("add", "-A");
  git("commit", "-q", "-m", "shop");

  const env = { ...process.env, XDG_CONFIG_HOME: path.join(root, "config"), HIVEMIND_SHELL_ENV: "0" } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox", `--user-data-dir=${path.join(root, "ud")}`], cwd: repo, env });
  page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]!; w.unmaximize(); w.setContentSize(1600, 1000); });
  await page.waitForSelector(".react-flow", { timeout: 30_000 });
});

test.afterAll(async () => {
  await app?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

async function add(kind: string) {
  await page.locator(".react-flow__pane").click({ position: { x: 5, y: 5 } });
  await page.locator('[data-toolbar-action="board"]').click();
  await page.locator(`[data-add-menu] [data-board-choice="tile:${kind}"]`).click();
  const picker = page.getByRole("dialog").filter({ hasText: /Start .* in/ });
  if (await picker.isVisible({ timeout: 1500 }).catch(() => false)) await picker.getByRole("button").first().click();
}
const show = (tile: import("@playwright/test").Locator) => tile.getAttribute("data-id").then((id) =>
  page.evaluate((d) => window.dispatchEvent(new CustomEvent("hivemind:focus-tile", { detail: d })), id));

test("the Search tile finds a line, and a result opens the frame's editor with the cursor on that line", async () => {
  await add("search");
  const search = page.locator(".react-flow__node-search");
  await show(search);
  await search.getByRole("textbox", { name: "Find in files" }).fill("TAX_RATE_MARKER");
  const hit = search.locator('[data-find-line="src/checkout/tax.ts:121"]');
  await expect(hit).toContainText("TAX_RATE_MARKER", { timeout: 10_000 });
  await expect(search.locator("[data-find-summary]")).toContainText("1 result in 1 file");
  await hit.click();
  const code = page.locator(".react-flow__node-workbench");
  await expect(code.locator(".cm-activeLine")).toContainText("export const TAX_RATE_MARKER", { timeout: 10_000 });
});

test("Ctrl+P in the Code tile goes to a file by a typo'd name", async () => {
  await add("editor");
  const code = page.locator(".react-flow__node-workbench");
  await show(code);
  await code.getByRole("button", { name: "Explorer (files)" }).focus();
  await page.keyboard.press("Control+p");
  const dialog = page.locator("[data-quick-open]");
  await dialog.getByPlaceholder("Go to file…").fill("chkcart");
  await expect(dialog.locator("[data-quick-open-file]").first()).toHaveAttribute("data-quick-open-file", "src/checkout/cart.ts", { timeout: 10_000 });
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(code.locator(".cm-content")).toContainText("export function addItem", { timeout: 10_000 });
});

test("the editor closes a bracket as it is opened, and offers the file's own words", async () => {
  const code = page.locator(".react-flow__node-workbench");
  await show(code);
  await code.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("\nconsole.log(");
  await expect(code.locator(".cm-activeLine")).toHaveText("console.log()");
  await page.keyboard.type("addI");
  await expect(page.locator(".cm-tooltip-autocomplete")).toContainText("addItem", { timeout: 5_000 });
  // CodeMirror ignores Enter for 75 ms after the list opens (`interactionDelay`), so a key meant
  // for the line is not taken as a pick; a person never types that fast after reading it.
  await page.waitForTimeout(150);
  await page.keyboard.press("Enter");
  await expect(code.locator(".cm-activeLine")).toHaveText("console.log(addItem)");
});
