// A terminal resized while a burst of output is still being drawn shows each line once: in the
// window, in the screen the host keeps for the session, and in a second window that opens on it.
// xterm's write buffer, asked by a resize to take in what is queued, took in again the chunks it had
// drawn before it paused, so their lines showed twice (patches/@xterm__*.patch,
// docs/design/xterm-writebuffer-reparse.md).
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { seedAgents } from "./helpers/agents";
import { stopDaemons } from "./helpers/daemons";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-burst-resize-"));
const repo = path.join(root, "repo");
const bin = path.join(root, "bin");
const xdg = path.join(root, "config");
const go = path.join(root, "go");

let app: ElectronApplication;
let page: Page;
let tile: string;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  seedAgents(xdg, ["claude"]);
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  fs.mkdirSync(bin);
  // A Claude that draws a burst each time the test asks (a file appears): the screen cleared, then a
  // line per row, each first erased many thousand times (no trace on a blank row, and slow to take
  // in, so a terminal takes in a part of what is queued and pauses to paint), then "end <round>".
  fs.writeFileSync(path.join(bin, "claude"), `#!/usr/bin/env node
if (process.argv[2] === "--version") { console.log("2.0.0 (Claude Code)"); process.exit(0); }
const fs = require("fs");
process.stdout.write("ready\\r\\n");
setInterval(() => {
  let round;
  try { round = fs.readFileSync(${JSON.stringify(go)}, "utf8").trim(); fs.rmSync(${JSON.stringify(go)}); } catch { return; }
  const filler = "\\x1b[2K".repeat(16000);
  let out = "\\x1b[H\\x1b[2J";
  for (let i = 0; i < process.stdout.rows - 3; i++) out += filler + "\\r" + round + " line " + i + "\\r\\n";
  process.stdout.write(out + "end " + round + "\\r\\n");
}, 50);
`, { mode: 0o755 });
  const env = { ...process.env, XDG_CONFIG_HOME: xdg, HOME: root, HIVEMIND_SHELL_ENV: "0", PATH: `${bin}${path.delimiter}${process.env.PATH}` } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox"], cwd: repo, env });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.waitForSelector(".react-flow", { timeout: 30_000 });
  // In the Windows view the active tile fills the window: resizing its slot resizes the terminal.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: "windows" } })));
  await page.waitForSelector('[data-community-view="windows"][data-community-ready="1"]');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:spawn-agent")));
  const layer = page.locator('aside[aria-label="Layers"] [data-layer-tile^="tile-claude"]').first();
  await layer.click();
  tile = (await layer.getAttribute("data-layer-tile"))!;
  await expect(page.locator("[data-community-slot] .xterm")).toHaveCount(1, { timeout: 15_000 });
  await expect.poll(() => screen(page), { timeout: 20_000 }).toContain("ready");
});
test.afterAll(async () => {
  await app?.close();
  stopDaemons(xdg);
  fs.rmSync(root, { recursive: true, force: true });
});

/** What every terminal in `w` shows. */
const screen = (w: Page) => w.evaluate(() => [...document.querySelectorAll(".xterm")]
  .map((x) => (x.parentElement as (HTMLElement & { __hmScreen?: () => string }) | null)?.__hmScreen?.() ?? "").join("\n"));
/** The lines of `round` in `text`, in order. */
const linesOf = (text: string, round: string) => text.split("\n").map((l) => l.trimEnd()).filter((l) => l.startsWith(`${round} line `));

test("a burst resized while it draws shows each line once, here and in a window that opens on it", async () => {
  test.setTimeout(240_000);
  let rows = 0;
  // Resized at different points of the burst, so one of them lands while the terminal has drawn
  // part of what is queued and paused to paint: in this window, and in the host's screen.
  for (const [n, wait] of [10, 40, 80, 120, 200, 300].entries()) {
    const round = `r${n}`;
    fs.writeFileSync(go, round);
    await page.waitForTimeout(wait);
    await page.evaluate((odd) => {
      const slot = document.querySelector("[data-community-slot]") as HTMLElement;
      slot.style.width = odd ? "900px" : "1000px";
    }, n % 2 === 1);
    await expect.poll(() => screen(page), { timeout: 30_000 }).toContain(`end ${round}`);
    const shown = linesOf(await screen(page), round);
    rows ||= shown.length;
    expect(shown, `round ${round}`).toEqual(Array.from({ length: rows }, (_, i) => `${round} line ${i}`));
    // A window that opens now is sent the screen the host kept.
    const [second] = await Promise.all([app.waitForEvent("window"), page.evaluate(() => window.hive.newWindow())]);
    await second.waitForSelector(".react-flow", { timeout: 15_000 });
    await expect.poll(() => screen(second), { timeout: 20_000 }).toContain(`end ${round}`);
    expect(linesOf(await screen(second), round), `round ${round} in a window that opens on it`).toEqual(shown);
    await second.close();
  }
  expect(rows).toBeGreaterThan(10);
});
