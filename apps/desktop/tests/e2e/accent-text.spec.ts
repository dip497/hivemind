// The accent colours marks, never words: it is held to 3:1 as a mark (theme-format.ts
// ACCENT_SURFACES), not to 4.5:1 as text, and the person may pick any colour. With a picked
// accent, no visible text on the real pages that once drew words in it (Layers' "filtered", a
// markdown link, a renamed file in the tree) is drawn in `--color-brand`, `--color-accent` or
// `--color-info`. Nor is any in amber where nothing waits on the person: a modified file in the tree
// once was (The One Voice Rule).
import { test, expect, type Page } from "@playwright/test";
import { launchWindow, type AppWindow } from "./helpers/window";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let app: AppWindow;
let page: Page;
let repo: string;
/** A violet that reads 3:1 on Signal's page and panels, as a mark must, and under 4.5:1. */
const ACCENT = { brand: "#7c6aa8", accent: "#a493cf" };

test.beforeAll(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), "hm-accent-text-"));
  await fs.writeFile(path.join(repo, "notes.md"), "# Notes\n\nSee [the guide](https://example.com/guide).\n", "utf8");
  await fs.writeFile(path.join(repo, "old.ts"), "export const x = 1;\n", "utf8");
  await fs.writeFile(path.join(repo, "edited.ts"), "export const y = 1;\n", "utf8");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q");
  git("config", "user.email", "e2e@test.dev");
  git("config", "user.name", "e2e");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  git("mv", "old.ts", "renamed.ts");
  await fs.writeFile(path.join(repo, "edited.ts"), "export const y = 2;\n", "utf8");
  app = await launchWindow({ cwd: repo, args: [`--user-data-dir=/tmp/hm-accent-text-ud-${Date.now()}`] });
  page = app.page;
  await page.waitForSelector(".react-flow", { timeout: 15_000 });
  await page.evaluate((a) => window.hive.settingsSet("appearanceExtra.accent", a), ACCENT);
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--color-brand").trim())).toBe(ACCENT.brand);
});

test.afterAll(async () => {
  await app?.close();
  await fs.rm(repo, { recursive: true, force: true }).catch(() => {});
});

/** Visible text, shadow roots included, drawn in one of `tokens`, with the words it says. */
const textIn = (tokens: string[]) => page.evaluate((tokens) => {
  const c = document.createElement("canvas").getContext("2d")!;
  const px = (css: string) => { c.clearRect(0, 0, 1, 1); c.fillStyle = css; c.fillRect(0, 0, 1, 1); return [...c.getImageData(0, 0, 1, 1).data].join(","); };
  const root = getComputedStyle(document.documentElement);
  const accents = new Set(tokens.map((v) => px(root.getPropertyValue(v))));
  const found: string[] = [];
  const walk = (node: ParentNode) => {
    for (const el of node.querySelectorAll("*")) {
      if (el.shadowRoot) walk(el.shadowRoot);
      const words = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent ?? "").join("").trim();
      if (!words || !el.getClientRects().length) continue;
      const s = getComputedStyle(el);
      if (s.visibility === "hidden" || s.opacity === "0") continue;
      if (accents.has(px(s.color))) found.push(words);
    }
  };
  walk(document);
  return found;
}, tokens);
const accentText = () => textIn(["--color-brand", "--color-accent", "--color-info"]);
const amberText = () => textIn(["--color-warn", "--color-status-attention", "--color-status-attention-text"]);

test("Layers filtered: its heading says so in a text colour", async () => {
  const panel = page.locator('aside[aria-label="Layers"]');
  await panel.locator("[data-layers-view-menu]").click();
  await page.locator('[data-layers-view="status"]').click();
  await page.locator('[data-layers-choice="status:working"]').click();
  await page.keyboard.press("Escape");
  await expect(panel.getByText("· filtered")).toBeVisible();
  expect(await accentText()).toEqual([]);
});

test("a markdown link, a renamed and a modified file in the tree are words in a text colour, none amber", async () => {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "tree" })));
  const workbench = page.locator(".react-flow__node-workbench");
  await workbench.getByRole("treeitem", { name: "renamed.ts" }).waitFor({ timeout: 10_000 });
  await workbench.getByRole("treeitem", { name: "notes.md" }).click();
  await workbench.getByRole("button", { name: "toggle markdown preview" }).click();
  await expect(workbench.locator(".md-preview a", { hasText: "the guide" })).toBeVisible({ timeout: 6_000 });
  await page.screenshot({ path: test.info().outputPath("accent-text.png") });
  expect(await accentText()).toEqual([]);
  expect(await amberText()).toEqual([]);
});
