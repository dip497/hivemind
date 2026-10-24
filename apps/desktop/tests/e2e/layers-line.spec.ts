// A terminal's Layers row says what its screen last showed, under its name
// (docs/design/last-line-2026-10-23.md): the line its pty daemon read, kept by main and sent to the
// window that watches that tile. Hidden, the panel watches nothing; shown again, it is answered the
// line as it is, with nothing new printed.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-layers-line-"));
const repo = path.join(root, "repo");
const env = { ...process.env, XDG_CONFIG_HOME: path.join(root, "config"), HIVEMIND_SHELL_ENV: "0" } as Record<string, string>;
delete env.ELECTRON_RUN_AS_NODE;
let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  app = await electron.launch({ args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox", `--user-data-dir=${path.join(root, "user-data")}`], cwd: repo, env });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 30_000 });
});
test.afterAll(async () => { await app?.close(); fs.rmSync(root, { recursive: true, force: true }); });

const panel = () => page.locator('aside[aria-label="Layers"]');

test("a shell's row shows the line it printed last; hidden and shown again, the panel shows it with no new output", async () => {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  const term = page.locator(".react-flow__node-terminal");
  await expect(term).toHaveCount(1);
  await term.locator(".xterm-screen").click();
  const row = panel().locator("[data-layer-tile]");
  await expect(row).toHaveCount(1);
  const line = row.locator("[data-layer-line]");
  // Worked out by the shell, so the line is what it printed, not the keys typed. Typed again until
  // the shell is up to run it: running it twice changes nothing.
  await expect.poll(async () => {
    await page.keyboard.type("echo $((200+14)) tests passed\n");
    return (await line.count()) ? line.textContent() : null;
  }, { timeout: 30_000, intervals: [2_500] }).toBe("214 tests passed");
  // The row is two lines high while it has one.
  await expect(row).toHaveCSS("height", "44px");

  await panel().locator("[data-layers-close]").click();
  await expect(panel()).toHaveCount(0);
  await page.getByRole("button", { name: "show layers" }).click();
  await expect(panel().locator("[data-layer-tile] [data-layer-line]")).toHaveText("214 tests passed");
});

// Hidden is kept for every window (localStorage): one that reloads into a hidden panel has no row
// to say it watches nothing, while main still holds the watch its connection had before.
test("a window that reloads with the panel hidden is sent no lines", async () => {
  await expect(panel().locator("[data-layer-tile] [data-layer-line]")).toHaveText("214 tests passed");
  await page.evaluate(() => localStorage.setItem("hivemind:layers-hidden", "1"));
  await page.reload();
  await page.waitForSelector(".react-flow", { timeout: 30_000 });
  await expect(panel()).toHaveCount(0);
  await page.evaluate(() => {
    const w = window as unknown as { sent: number };
    w.sent = 0;
    window.hive.onTileLines(() => { w.sent++; });
  });
  const term = page.locator(".react-flow__node-terminal");
  // Reloaded, no tile is selected: its header selects it, and then its screen takes the keys.
  await term.locator(".tile-drag-handle").first().click();
  await term.locator(".xterm-screen").click();
  await page.keyboard.type("echo $((300+1)) after reload\n");
  // The terminal draws on a canvas: its screen is read through the hook the app leaves on it.
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll(".xterm")]
    .map((x) => (x.parentElement as (HTMLElement & { __hmScreen?: () => string }) | null)?.__hmScreen?.() ?? "").join("\n")))
    .toContain("301 after reload");
  // Past the daemon's next read (1.2 s) and main's next send (250 ms).
  await page.waitForTimeout(3_000);
  expect(await page.evaluate(() => (window as unknown as { sent: number }).sent)).toBe(0);
  // Main had the line all along: shown, the panel is answered it.
  await page.getByRole("button", { name: "show layers" }).click();
  await expect(panel().locator("[data-layer-tile] [data-layer-line]")).toHaveText("301 after reload");
});
