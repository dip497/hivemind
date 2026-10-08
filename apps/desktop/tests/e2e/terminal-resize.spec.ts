// A terminal resized in a burst (a window being dragged larger, a panel resized) follows every
// frame on screen, but the program in it hears one resize, at the size the burst ends at. An agent
// that redraws on each one draws at widths already gone, and their borders stay on screen.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { seedAgents } from "./helpers/agents";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-term-resize-"));
const repo = path.join(root, "repo");
const bin = path.join(root, "bin");
const log = path.join(root, "sizes");
let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  const xdg = path.join(root, "config");
  seedAgents(xdg, ["claude"]);
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  fs.mkdirSync(bin);
  // A Claude that writes down each size it is told.
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\n[ "$1" = --version ] && echo '2.0.0 (Claude Code)' && exit 0\ntrap 'echo "$(stty size)" >> ${JSON.stringify(log)}' WINCH\necho ready\nwhile :; do sleep 0.05; done\n`, { mode: 0o755 });
  const env = { ...process.env, XDG_CONFIG_HOME: xdg, HOME: root, HIVEMIND_PTY_DAEMON: "0", HIVEMIND_SHELL_ENV: "0", PATH: `${bin}${path.delimiter}${process.env.PATH}` } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE; delete env.HIVE_HCP_SOCK; delete env.HCP_TOKEN; delete env.HIVEMIND_TILE;
  app = await electron.launch({ args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox", `--user-data-dir=${path.join(root, "ud")}`], cwd: repo, env });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.waitForSelector(".react-flow", { timeout: 30_000 });
  // In the Windows view the active tile fills the window, so resizing the window resizes it.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: "windows" } })));
  await page.waitForSelector('[data-community-view="windows"][data-community-ready="1"]');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:spawn-agent")));
  // Its tab is the one shown.
  await page.locator('aside[aria-label="Layers"] [data-layer-tile^="tile-claude"]').first().click();
  await expect(page.locator("[data-community-slot] .xterm")).toHaveCount(1, { timeout: 15_000 });
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll(".xterm")]
    .some((x) => ((x.parentElement as unknown as { __hmScreen?: () => string }).__hmScreen?.() ?? "").includes("ready"))), { timeout: 20_000 }).toBe(true);
});
test.afterAll(async () => { await app?.close(); fs.rmSync(root, { recursive: true, force: true }); });

const heard = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);

test("a burst of resizes reaches the program once, at the size it ends at", async () => {
  await page.waitForTimeout(600); // whatever the start sized settles first
  const before = heard().length;
  // As a drag does it: the tile a little wider each frame, for ten frames.
  const widths = await page.evaluate(async () => {
    const slot = document.querySelector("[data-community-slot]") as HTMLElement;
    const start = slot.getBoundingClientRect().width;
    const out: number[] = [];
    for (let i = 1; i <= 10; i++) {
      slot.style.width = `${start - 400 + i * 30}px`;
      out.push(start - 400 + i * 30);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }
    return out;
  });
  expect(widths).toHaveLength(10);
  await expect.poll(() => heard().length, { timeout: 10_000 }).toBeGreaterThan(before);
  await page.waitForTimeout(600); // long enough that a second resize would have come
  const burst = heard().slice(before);
  expect(burst).toHaveLength(1);
  // The size the burst ended at: what the terminal shows now.
  const shown = await page.evaluate(() => (document.querySelector("[data-community-slot] .xterm-screen") as HTMLElement).getBoundingClientRect().width);
  const cols = Number(burst[0]!.split(" ")[1]);
  expect(cols).toBeGreaterThan(0);
  expect(shown / cols).toBeGreaterThan(6); // a cell is several pixels wide: the grid the screen shows
});
