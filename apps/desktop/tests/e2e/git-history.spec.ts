// Git history in the app (docs/design/git-history-2026-11-02.md): History in Changes (the log with
// its graph, a commit's message and diff, every branch), a file's history from Files' menu through
// its rename, and blame in the editor, which follows the text being edited and opens a line's
// commit in History. Against a real repository made here.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

let app: ElectronApplication;
let page: Page;
let root: string;
let repo: string;

let n = 0;
function commit(message: string, files: Record<string, string | null>) {
  for (const [f, text] of Object.entries(files)) {
    if (text === null) fs.rmSync(path.join(repo, f));
    else fs.writeFileSync(path.join(repo, f), text);
  }
  execFileSync("git", ["add", "-A"], { cwd: repo });
  const at = `${1_700_000_000 + ++n * 3600} +0000`;
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: repo, env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } });
}
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

test.beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hm-history-")));
  repo = path.join(root, "shop");
  fs.mkdirSync(repo);
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Ada Lovelace");
  git("config", "user.email", "ada@example.com");
  commit("add cart", { "cart.js": "let total = 0;\nfunction add(x) { total += x; }\n" });
  commit("cart: name the sum", { "cart.js": "let sum = 0;\nfunction add(x) { sum += x; }\n" });
  commit("cart in TypeScript", { "cart.js": null, "cart.ts": "let sum = 0;\nfunction add(x) { sum += x; }\n" });
  // A branch merged back: the graph draws it in a lane of its own.
  git("checkout", "-q", "-b", "tax");
  commit("tax: add the rate", { "tax.ts": "export const RATE = 0.2;\n" });
  git("checkout", "-q", "main");
  commit("cart: types", { "cart.ts": "let sum = 0;\nexport function add(x: number) { sum += x; }\n" });
  execFileSync("git", ["merge", "-q", "--no-ff", "-m", "Merge tax", "tax"], { cwd: repo, env: { ...process.env, GIT_AUTHOR_DATE: `${1_700_000_000 + 9 * 3600} +0000`, GIT_COMMITTER_DATE: `${1_700_000_000 + 9 * 3600} +0000` } });
  // A branch not merged: only "all branches" shows it.
  git("checkout", "-q", "-b", "spike");
  commit("spike: try a cache", { "cache.ts": "export {};\n" });
  git("checkout", "-q", "main");

  const env = { ...process.env, XDG_CONFIG_HOME: path.join(root, "config"), HIVEMIND_SHELL_ENV: "0" } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox", `--user-data-dir=${path.join(root, "ud")}`], cwd: repo, env });
  page = await app.firstWindow();
  // A laptop's window: the tiles' menus open in sight.
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

test("History in Changes: the log newest first with its graph, a commit's message and diff, and every branch when asked", async () => {
  await add("changes");
  const changes = page.locator(".react-flow__node-changes");
  await changes.getByRole("button", { name: "history", exact: true }).click();
  const list = changes.getByRole("listbox", { name: "Commits" });
  await expect(list.getByRole("option").first()).toContainText("Merge tax", { timeout: 10_000 });
  await expect(list.getByRole("option")).toHaveCount(6);
  // The merged branch drew a second lane.
  expect(await list.locator("svg").first().getAttribute("width")).toBe("20");
  // The newest is shown until another is picked; picking one shows its message and its diff.
  await list.getByRole("option", { name: /cart: types/ }).click();
  const sha = git("log", "-1", "--format=%H", "--grep=cart: types");
  await expect(changes.locator(`[data-commit-header="${sha}"]`)).toContainText("cart: types");
  await expect(changes.locator(`[data-commit-header="${sha}"]`)).toContainText("Ada Lovelace");
  await expect(changes).toContainText("export function add(x: number)", { timeout: 10_000 });
  // The unmerged branch is on its own, until every branch is asked for.
  await expect(list.getByRole("option", { name: /spike: try a cache/ })).toHaveCount(0);
  await changes.getByRole("button", { name: "all branches" }).click();
  await expect(list.getByRole("option").first()).toContainText("spike: try a cache", { timeout: 10_000 });
});

test("a file's history from Files' menu: its commits through the rename, the rename marked", async () => {
  await add("files");
  const files = page.locator(".react-flow__node-files");
  await show(files);
  await files.getByRole("treeitem", { name: "cart.ts" }).first().click({ button: "right" });
  await page.getByText("Show history", { exact: true }).click();
  const changes = page.locator(".react-flow__node-changes");
  await expect(changes.locator("[data-history-file]")).toHaveText("history of cart.ts", { timeout: 10_000 });
  const list = changes.getByRole("listbox", { name: "History of cart.ts" });
  await expect(list.getByRole("option")).toHaveText([/cart: types/, /cart in TypeScript.*from cart\.js/, /cart: name the sum/, /add cart/], { timeout: 10_000 });
});

test("blame in the editor: who changed each line, an edited line not committed yet, and a click opens that commit in History", async () => {
  // Its own Files, so it holds when it runs on its own: one per frame, so the one there is if any.
  await add("files");
  const files = page.locator(".react-flow__node-files");
  await show(files);
  await files.getByRole("treeitem", { name: "cart.ts" }).first().click();
  const code = page.locator(".react-flow__node-workbench");
  await expect(code.locator(".cm-content")).toContainText("export function add", { timeout: 10_000 });
  await show(code);
  await code.getByRole("button", { name: "toggle blame" }).click();
  const marks = code.locator(".cm-blame .cm-blame-mark");
  await expect(marks).toHaveText([/^Ada · /, /^Ada · /], { timeout: 10_000 });

  // A new line typed: once the text stops changing, it reads as not committed yet.
  await code.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("export const reset = () => { sum = 0; };");
  await expect(marks).toHaveText([/^Ada · /, /^Ada · /, "not committed"], { timeout: 10_000 });

  // The first line's mark: the commit that named the sum, before the rename, in this tile's History.
  const sha = git("log", "-1", "--format=%H", "--grep=cart: name the sum");
  await marks.first().click();
  await expect(code.locator(`[data-commit-header="${sha}"]`)).toContainText("cart: name the sum", { timeout: 10_000 });
});
