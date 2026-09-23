// A terminal no view shows still runs: with a community view active that places no
// surfaces, a new shell tile is never adopted by a slot, yet after the grace its body
// mounts in the park and its session starts.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

test.use({ trace: "off" });

let app: ElectronApplication;
let page: Page;
let repo: string;
const APP_DIR = process.cwd();
const CLI = path.resolve(APP_DIR, "../cli/src/index.ts");
const XDG = fs.mkdtempSync(path.join(os.tmpdir(), "hm-unseen-xdg-"));
const ENV = { ...process.env, XDG_CONFIG_HOME: XDG } as Record<string, string>;
const VIEW = fs.mkdtempSync(path.join(os.tmpdir(), "hm-unseen-view-"));

test.beforeAll(async () => {
  repo = await fs.promises.mkdtemp(path.join(os.tmpdir(), "hm-unseen-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  fs.writeFileSync(path.join(VIEW, "hivemind-view.json"), JSON.stringify({ id: "blank", name: "Blank", version: "0.1.0", entry: "main.js", protocol: 1, permissions: [] }));
  fs.writeFileSync(path.join(VIEW, "main.js"), `import { connect } from "@hivemind/view-sdk"; await connect(); document.body.textContent = "blank";`);
  const r = spawnSync("bun", [CLI, "views", "install", VIEW, "--json"], { cwd: repo, encoding: "utf8", env: ENV });
  expect(r.status, r.stdout + r.stderr).toBe(0);
  app = await electron.launch({ args: [path.join(APP_DIR, "out/main/index.js"), "--no-sandbox"], cwd: repo, env: ENV });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 15_000 });
});

test.afterAll(async () => {
  await app?.close();
  for (const d of [repo, XDG, VIEW]) await fs.promises.rm(d, { recursive: true, force: true }).catch(() => {});
});

test("a terminal created while a view shows none of its tiles still starts, unseen", async () => {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: "blank" } })));
  await page.waitForSelector('[data-community-view="blank"][data-community-ready="1"]', { timeout: 20_000 });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  // Nothing claims it, so it mounts in the park after the grace, at a real size.
  const parked = page.locator("#hm-tile-park [data-surface] .xterm");
  await expect(parked).toHaveCount(1, { timeout: 10_000 });
  const box = await page.locator("#hm-tile-park [data-surface]").first().evaluate((el) => ({ w: (el as HTMLElement).offsetWidth, h: (el as HTMLElement).offsetHeight }));
  expect(box.w).toBeGreaterThan(100);
  expect(box.h).toBeGreaterThan(100);
  // Showing it later adopts the same live terminal; it does not start a second one.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: "canvas" } })));
  await expect(page.locator(".react-flow__node-terminal .xterm")).toHaveCount(1, { timeout: 10_000 });
  await expect(page.locator("#hm-tile-park [data-surface] .xterm")).toHaveCount(0);
});
