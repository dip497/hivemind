// Terminals drawn on WebGL share one glyph atlas. Coming back to the window rebuilds the atlas
// from the terminal in view; a terminal in another tab must still draw its own text when it is
// shown again, not the glyphs the atlas holds now at the places it remembered.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test.use({ trace: "off" });

let app: ElectronApplication;
let page: Page;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-atlas-"));
const repo = path.join(root, "repo");

test.beforeAll(async () => {
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const env: Record<string, string> = { ...process.env, HIVEMIND_SHELL_ENV: "0" } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox", `--user-data-dir=${path.join(root, "ud")}`],
    cwd: repo,
    env,
  });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 15_000 });
  for (const n of [1, 2]) {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
    await expect(page.locator(".react-flow__node-terminal")).toHaveCount(n, { timeout: 10_000 });
  }
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: "windows" } })));
  await page.waitForSelector('[data-community-view="windows"][data-community-ready="1"]', { timeout: 20_000 });
});

test.afterAll(async () => {
  await page?.evaluate(async () => {
    window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: "canvas" } }));
    await window.hive.settingsSet("views.defaultView", "canvas");
  }).catch(() => {});
  await app?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/** The terminal the active tab shows: its screen box, its row height, whether WebGL draws it, its text. */
const shown = () => page.evaluate(() => {
  const term = [...document.querySelectorAll<HTMLElement>(".xterm")].find((x) => x.checkVisibility({ visibilityProperty: true }));
  const screen = term?.querySelector<HTMLElement>(".xterm-screen");
  if (!term || !screen) return null;
  let host: Element | null = term;
  while (host && !("__hmScreen" in host)) host = host.parentElement;
  const r = screen.getBoundingClientRect();
  // Its screen has a line per row (WebGL draws no row elements to count).
  const text = (host as (Element & { __hmScreen(): string }) | null)?.__hmScreen() ?? "";
  const rows = text.split("\n").length;
  return { tile: term.closest<HTMLElement>("[data-surface]")?.dataset.surface, x: r.x, y: r.y, width: r.width, rowHeight: r.height / rows, webgl: !!screen.querySelector("canvas"), text };
});

/** Show tile `i` from the Layers rail: the page's own control, so the window's focus does not move. */
async function show(i: number) {
  const row = page.locator("[data-layer-tile]").nth(i);
  const tile = await row.getAttribute("data-layer-tile");
  await row.click();
  await expect.poll(async () => { const s = await shown(); return s?.tile === tile && s.webgl; }, { timeout: 10_000 }).toBe(true);
}

async function typeInto(i: number, line: string, until: string) {
  await show(i);
  const s = (await shown())!;
  await page.mouse.click(s.x + s.width / 2, s.y + s.rowHeight * 2);
  await page.keyboard.type(line + "\n");
  await expect.poll(async () => (await shown())?.text ?? "", { timeout: 10_000 }).toContain(until);
}

/** The top rows of the terminal the active tab shows, as pixels: the command and what it printed. */
async function topRows(): Promise<Buffer> {
  const s = (await shown())!;
  await page.waitForTimeout(400);
  return page.screenshot({ clip: { x: s.x, y: s.y, width: s.width, height: Math.round(s.rowHeight * 4) } });
}

test("a terminal in another tab draws its own text after the window comes back and the atlas is rebuilt", async () => {
  await typeInto(1, "printf '%s\\n' quick-brown-fox jumps-over-the lazy-dog", "lazy-dog\n");
  const before = await topRows();

  await show(0);
  // Back to the window: the terminal in view rebuilds the atlas, then draws new glyphs into it.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await typeInto(0, "echo 'ZYXWVUTSRQPONM-9876543210-[]{}<>=+*&^%#@~'", "\nZYXWVUTSRQPONM-9876543210");

  // Shown again, it draws a new frame, as an agent's status line does: its top rows did not change.
  await typeInto(1, "echo next", "next\n");
  expect((await topRows()).equals(before)).toBe(true);
});
