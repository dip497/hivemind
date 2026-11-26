// E2E for the IDE-style Workbench tile (file explorer + tabbed editor attached
// in one tile). Seeds a real git repo with one file, opens the canvas, toggles
// the Explorer (which mounts the workbench), clicks the file in the embedded
// tree, and asserts the embedded editor renders the file's content. Then types
// and asserts dirty. Saving-to-disk is verified as a bonus after ⌘S.
import { test, expect, type Page } from "@playwright/test";
import { launchWindow, type AppWindow } from "./helpers/window";
import path from "node:path";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { createRequire } from "node:module";
import { contrastRatio } from "@hivemind/core/css-color";

let app: AppWindow;
let page: Page;
let repo: string;
const FILE = "hello.ts";
const ORIGINAL = "export const greeting = 'hello world';\n";
// Two extra files for the tab-switching test (distinct unique markers so the
// assertion can tell which buffer is active). Kept separate from FILE so the
// edit/save tests above don't perturb them.
const FILE_A = "tabs-a.ts";
const FILE_B = "tabs-b.ts";
const MARK_A = "ALPHA_TAB_MARKER";
const MARK_B = "BETA_TAB_MARKER";
// Named to sort after the files above, so the tree's first row stays FILE.
const FILE_CRLF = "win-lines.txt";
const FILE_PNG = "wpic.png";
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const FILE_WATCHED = "watched.ts";
// A name used in one file and defined in another, sorted after the files above.
const FILE_DEFINES = "zdef-price.ts";
const FILE_USES = "zdef-total.ts";

test.beforeAll(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), "hm-editor-"));
  await fs.writeFile(path.join(repo, FILE), ORIGINAL, "utf8");
  await fs.writeFile(path.join(repo, FILE_A), `export const a = '${MARK_A}';\n`, "utf8");
  await fs.writeFile(path.join(repo, FILE_B), `export const b = '${MARK_B}';\n`, "utf8");
  await fs.writeFile(path.join(repo, FILE_CRLF), "one\r\ntwo\r\n", "utf8");
  await fs.writeFile(path.join(repo, FILE_PNG), PNG_BYTES);
  await fs.writeFile(path.join(repo, FILE_WATCHED), "const first = 1;\nconst second = 2;\nconst third = 3;\n", "utf8");
  await fs.writeFile(path.join(repo, FILE_DEFINES), "// prices\n\nexport function priceOf(n: number): number {\n  return n * 2;\n}\n", "utf8");
  await fs.writeFile(path.join(repo, FILE_USES), `import { priceOf } from "./zdef-price";\n\nexport const total = priceOf(3);\n`, "utf8");
  // The file tree is fed by `git ls-files`, so the files must be tracked.
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q");
  git("config", "user.email", "e2e@test.dev");
  git("config", "user.name", "e2e");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  // The workspace's own TypeScript answers definitions: this app's TypeScript 7, linked in untracked.
  await fs.mkdir(path.join(repo, "node_modules"));
  await fs.symlink(path.dirname(createRequire(import.meta.url).resolve("typescript/package.json")), path.join(repo, "node_modules", "typescript"));

  app = await launchWindow({ cwd: repo, args: [`--user-data-dir=/tmp/hm-editor-ud-${Date.now()}`] });
  page = app.page;
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
  // The file tree is a web component (shadow DOM) whose rows are `treeitem`s; Playwright pierces it.
  // By name: the repo holds other files and a node_modules folder, which sorts first.
  const workbench = page.locator(".react-flow__node-workbench");
  const row = workbench.getByRole("treeitem", { name: FILE.split("/").pop()! }).first();
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
  // The dot is named for a screen reader and neutral: an unsaved file does not wait on the person,
  // so it is not the amber of "needs you" (DESIGN.md), and it reads 3:1 on its tab as a mark.
  const dot = editor.getByRole("img", { name: "unsaved changes" });
  await expect(dot).toBeVisible({ timeout: 4_000 });
  const { fill, warn, tab } = await dot.evaluate((el) => {
    const px = (css: string) => {
      const c = document.createElement("canvas").getContext("2d")!;
      c.fillStyle = css;
      c.fillRect(0, 0, 1, 1);
      return `rgb(${[...c.getImageData(0, 0, 1, 1).data.slice(0, 3)].join(" ")})`;
    };
    let under: Element | null = el.parentElement;
    while (under && getComputedStyle(under).backgroundColor === "rgba(0, 0, 0, 0)") under = under.parentElement;
    return { fill: px(getComputedStyle(el).backgroundColor), warn: px(getComputedStyle(el).getPropertyValue("--color-warn")), tab: px(getComputedStyle(under!).backgroundColor) };
  });
  expect(fill).not.toBe(warn);
  expect(contrastRatio(fill, tab)).toBeGreaterThanOrEqual(3);
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

test("re-clicking an already-open file switches back to its tab", async () => {
  // Regression: open A, open B (B becomes active), then click A again. The tab
  // list dedupes, so re-clicking an open file produced no state change and the
  // editor stayed on B. Selecting a file must always activate it.
  const wb = page.locator(".react-flow__node-workbench");
  // Rows render the name split around an ellipsis-truncation span (visually
  // "tabs-a.ts", textually "tabs-a.tabs-a.……tsts"), so text matching can never
  // hit — the accessible name is the exact file name.
  const treeFile = (name: string) => wb.getByRole("treeitem", { name }).first();
  const showsContent = (marker: string) =>
    expect
      .poll(async () => wb.locator(".cm-content").textContent(), { timeout: 6_000, intervals: [300] })
      .toContain(marker);

  // Open A → its content shows.
  await treeFile(FILE_A).click();
  await showsContent(MARK_A);
  // Open B → B becomes the active tab.
  await treeFile(FILE_B).click();
  await showsContent(MARK_B);
  // Re-click A → MUST switch back to A's buffer (the bug: it stayed on B).
  await treeFile(FILE_A).click();
  await showsContent(MARK_A);
});

// ── safety: nothing the person typed or has on disk is lost ──────────────────
const wb = () => page.locator(".react-flow__node-workbench");
const openFile = async (name: string) => { await wb().getByRole("treeitem", { name }).first().click(); };
const tabOf = (name: string) => wb().locator(`[role="tab"][title="${name}"]`);
const contentHas = (text: string) =>
  expect.poll(async () => wb().locator(".cm-content").textContent(), { timeout: 6_000, intervals: [300] }).toContain(text);

test("switching to another tab and back keeps the edit, and undo takes it back", async () => {
  await openFile(FILE_A);
  await contentHas(MARK_A);
  await wb().locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("// undo me");
  await openFile(FILE_B);
  await contentHas(MARK_B);
  await openFile(FILE_A);
  await contentHas("undo me");
  await wb().locator(".cm-content").focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => wb().locator(".cm-content").textContent(), { timeout: 4_000 }).not.toContain("undo me");
  await expect(tabOf(FILE_A).locator("[data-unsaved]")).toHaveCount(0);
});

test("closing a tab with unsaved edits asks: Cancel keeps it, Don't save closes it and leaves the file as it was", async () => {
  await openFile(FILE_A);
  await contentHas(MARK_A);
  await wb().locator(".cm-content").click();
  await page.keyboard.type("UNSAVED_TEXT");
  const close = async () => { await tabOf(FILE_A).hover(); await tabOf(FILE_A).getByRole("button", { name: `close ${FILE_A}` }).click(); };
  await close();
  const ask = page.locator("[data-unsaved-close]");
  await expect(ask).toBeVisible({ timeout: 4_000 });
  await ask.getByRole("button", { name: "Cancel" }).click();
  await expect(tabOf(FILE_A)).toHaveCount(1);
  await contentHas("UNSAVED_TEXT");
  await close();
  await ask.getByRole("button", { name: "Don't save" }).click();
  await expect(tabOf(FILE_A)).toHaveCount(0);
  expect(await fs.readFile(path.join(repo, FILE_A), "utf8")).toBe(`export const a = '${MARK_A}';\n`);
});

test("a CRLF file opens as saved, and saving keeps CRLF on every line", async () => {
  await openFile(FILE_CRLF);
  await contentHas("two");
  await expect(tabOf(FILE_CRLF).locator("[data-unsaved]")).toHaveCount(0);
  await wb().locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.press("End");
  await page.keyboard.type("!");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => fs.readFile(path.join(repo, FILE_CRLF), "utf8"), { timeout: 6_000, intervals: [300] }).toBe("one!\r\ntwo\r\n");
  await expect(tabOf(FILE_CRLF).locator("[data-unsaved]")).toHaveCount(0);
});

test("a binary file is said to be binary, not shown as text, and Ctrl+S leaves it as it was", async () => {
  await openFile(FILE_PNG);
  await expect(wb().locator("[data-not-text]")).toContainText("This file is binary", { timeout: 6_000 });
  await expect(wb().locator("[data-not-text]").getByRole("button", { name: "Open with your system app" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+s");
  await page.waitForTimeout(500);
  expect(Buffer.compare(await fs.readFile(path.join(repo, FILE_PNG)), PNG_BYTES)).toBe(0);
});

test("an agent's write to an open, saved file shows in place: the cursor stays on its line", async () => {
  await openFile(FILE_WATCHED);
  await contentHas("third");
  await wb().locator(".cm-line", { hasText: "third" }).click();
  await fs.writeFile(path.join(repo, FILE_WATCHED), "const first = 1;\nconst second = 'two';\nconst third = 3;\n", "utf8");
  await contentHas("'two'");
  await expect(wb().locator(".cm-activeLine")).toContainText("third");
  await expect(tabOf(FILE_WATCHED).locator("[data-unsaved]")).toHaveCount(0);
});

test("a comment on selected lines shows a mark beside them, opens its thread, and moves down when lines are added above on disk", async () => {
  await openFile(FILE_WATCHED);
  await contentHas("third");
  const second = wb().locator(".cm-line", { hasText: "second" });
  await second.click({ clickCount: 3 });
  const bar = wb().locator("[data-code-selection-bar]");
  await expect(bar).toBeVisible({ timeout: 4_000 });
  await bar.getByRole("button", { name: "Comment" }).click();
  await wb().locator("[data-code-compose='comment'] textarea").fill("why a string here?");
  await wb().locator("[data-code-compose='comment']").getByRole("button", { name: "Add comment" }).click();
  await expect(wb().locator("[data-code-comments-waiting]")).toContainText("1 comment not sent");
  const mark = wb().locator("[data-code-comment-mark]");
  await expect(mark).toHaveCount(1, { timeout: 4_000 });
  await mark.click();
  await expect(wb().locator("[data-code-thread]")).toContainText("why a string here?");
  await expect(wb().locator("[data-code-thread]")).toContainText(`@${FILE_WATCHED}#L2`);
  await page.keyboard.press("Escape");
  await fs.writeFile(path.join(repo, FILE_WATCHED), "// added above\nconst first = 1;\nconst second = 'two';\nconst third = 3;\n", "utf8");
  await contentHas("added above");
  const lineOfMark = async () => mark.evaluate((el) => {
    const gutter = el.closest(".cm-gutterElement") as HTMLElement;
    const row = [...document.querySelectorAll(".react-flow__node-workbench .cm-lineNumbers .cm-gutterElement")].find((g) => Math.abs((g as HTMLElement).getBoundingClientRect().top - gutter.getBoundingClientRect().top) < 2);
    return row?.textContent;
  });
  await expect.poll(lineOfMark, { timeout: 4_000 }).toBe("3");
});

test("Ctrl+click on a name, or F12 on it, opens its definition in another file at its line", async () => {
  await openFile(FILE_USES);
  await contentHas("priceOf(3)");
  const call = wb().locator(".cm-line", { hasText: "total = priceOf" }).locator("span", { hasText: /^priceOf$/ }).first();
  await call.click({ modifiers: ["ControlOrMeta"] });
  await expect(tabOf(FILE_DEFINES)).toHaveAttribute("aria-selected", "true", { timeout: 20_000 });
  await expect(wb().locator(".cm-activeLine")).toContainText("export function priceOf", { timeout: 5_000 });

  await openFile(FILE_USES);
  await contentHas("priceOf(3)");
  await call.click();
  await page.keyboard.press("F12");
  await expect(tabOf(FILE_DEFINES)).toHaveAttribute("aria-selected", "true", { timeout: 20_000 });
});

// Last: it closes the Code tile the tests above share.
test("closing the Code tile with an unsaved file asks: Cancel keeps it, Save all saves and closes", async () => {
  await openFile(FILE_B);
  await contentHas(MARK_B);
  await wb().locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("// kept");
  // At 100% the tile is wider than the canvas and shown from its left edge: fit everything to reach its close.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Escape");
  const close = wb().getByRole("button", { name: "close tile" });
  await expect.poll(async () => { const b = await close.boundingBox(); return !!b && b.x + b.width <= (await page.evaluate(() => innerWidth)); }).toBe(true);
  await close.click();
  const ask = page.locator("[data-unsaved-tile-close]");
  await expect(ask).toBeVisible({ timeout: 4_000 });
  await ask.getByRole("button", { name: "Cancel" }).click();
  await expect(wb()).toHaveCount(1);
  await close.click();
  await ask.getByRole("button", { name: "Save", exact: true }).click();
  await expect(wb()).toHaveCount(0, { timeout: 4_000 });
  expect(await fs.readFile(path.join(repo, FILE_B), "utf8")).toContain("// kept");
});
