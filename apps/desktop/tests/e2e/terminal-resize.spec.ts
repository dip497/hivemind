// A terminal resized in a burst (a window being dragged larger, a panel resized, a project switched
// to) takes the first size at once and then only the one the burst ends at, grid and program in the
// same step: the grid it draws into is always the size it was told. An agent redrawing at a width the grid no longer has wraps its lines, and what
// it meant to erase stays on screen, interleaved with what comes next.
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
  // A Claude that writes down each size it is told, and redraws its two bottom lines, full width,
  // every 150 ms, erasing the last ones as Ink does: up two lines, clear to the end.
  fs.writeFileSync(path.join(bin, "claude"), `#!/usr/bin/env node
if (process.argv[2] === "--version") { console.log("2.0.0 (Claude Code)"); process.exit(0); }
const fs = require("fs");
process.stdout.on("resize", () => fs.appendFileSync(${JSON.stringify(log)}, process.stdout.rows + " " + process.stdout.columns + "\\n"));
process.stdout.write("ready\\n\\n\\n");
setInterval(() => { const w = process.stdout.columns; process.stdout.write("\\x1b[2A\\r\\x1b[J" + "=".repeat(w) + "\\n" + "#".repeat(w) + "\\n"); }, 150);
`, { mode: 0o755 });
  const env = { ...process.env, XDG_CONFIG_HOME: xdg, HOME: root, HIVEMIND_SHELL_ENV: "0", PATH: `${bin}${path.delimiter}${process.env.PATH}` } as Record<string, string>;
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
    .some((x) => ((x.parentElement as unknown as { __hmScreen?: () => string }).__hmScreen?.() ?? "").includes("###"))), { timeout: 20_000 }).toBe(true);
});
test.afterAll(async () => { await app?.close(); fs.rmSync(root, { recursive: true, force: true }); });

const heard = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);

test("a burst of resizes reaches the program twice at most: at its start, and at the size it ends at", async () => {
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
      await new Promise((r) => setTimeout(r, 30));
    }
    return out;
  });
  expect(widths).toHaveLength(10);
  await expect.poll(() => heard().length, { timeout: 10_000 }).toBeGreaterThan(before);
  await page.waitForTimeout(600); // long enough that a second resize would have come
  const burst = heard().slice(before);
  expect(burst.length).toBeGreaterThanOrEqual(1);
  expect(burst.length).toBeLessThanOrEqual(2);
  // The size the burst ended at: what the terminal shows now.
  const shown = await page.evaluate(() => (document.querySelector("[data-community-slot] .xterm-screen") as HTMLElement).getBoundingClientRect().width);
  const cols = Number(burst.at(-1)!.split(" ")[1]);
  expect(cols).toBeGreaterThan(0);
  expect(shown / cols).toBeGreaterThan(6); // a cell is several pixels wide: the grid the screen shows
});

test("shrunk while it draws, the program ends at the grid's size: its last line fills one row, unwrapped", async () => {
  await page.waitForTimeout(600);
  const before = heard().length;
  await page.evaluate(async () => {
    const slot = document.querySelector("[data-community-slot]") as HTMLElement;
    const start = slot.getBoundingClientRect().width;
    for (let i = 1; i <= 12; i++) {
      slot.style.width = `${start - i * 40}px`;
      await new Promise((r) => setTimeout(r, 30));
    }
  });
  await expect.poll(() => heard().length, { timeout: 10_000 }).toBeGreaterThan(before);
  await page.waitForTimeout(800);
  const sizes = heard().slice(before);
  expect(sizes.length).toBeLessThanOrEqual(2);
  const cols = Number(sizes.at(-1)!.split(" ")[1]);
  const screen = await page.evaluate(() => ((document.querySelector("[data-community-slot] .xterm")!.parentElement as unknown as { __hmScreen: () => string }).__hmScreen()));
  // Its live line is drawn at the width it was told; on a grid of another width it would wrap.
  const last = screen.split("\n").filter((l) => l.trim()).at(-1)!;
  expect(last).toBe("#".repeat(cols));
});
