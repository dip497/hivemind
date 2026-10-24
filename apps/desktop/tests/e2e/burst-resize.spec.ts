// A terminal resized while a burst of output is still being drawn shows each line once: in the
// window (the renderer's xterm) and in a second window that opens on it, which is sent the screen the
// host keeps (the screen worker's headless xterm). xterm's write buffer, asked by a resize to take in
// what is queued, took in again the writes it had drawn before it paused, so their lines showed twice
// (patches/@xterm__*.patch, docs/design/xterm-writebuffer-reparse.md).
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
/** Lines in a burst: fewer than the rows, so the screen shows them all, and than the 50 writes after
 *  which xterm drops what it has taken in. */
const LINES = 15;

let app: ElectronApplication;
let page: Page;
let tile: string;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  seedAgents(xdg, ["claude"]);
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  fs.mkdirSync(bin);
  // A Claude that draws a burst each time the test asks (a file appears): the screen cleared and
  // "<round> start" in a write of its own, then a line every 15 ms, each behind a few thousand
  // erase-belows. Those leave no trace (the rows below are blank) but take ~60 ms to take in, so
  // every terminal on the way falls behind from the first line to the last: the lines reach it as
  // separate writes (15 ms is past the host's and main's coalescing), it takes in one and pauses to
  // paint with the rest queued. The lines start 300 ms after the clear, which every terminal has
  // taken in and let go of by then, so a line taken in twice shows twice (a clear taken in again
  // would draw the same screen once more).
  fs.writeFileSync(path.join(bin, "claude"), `#!/usr/bin/env node
if (process.argv[2] === "--version") { console.log("2.0.0 (Claude Code)"); process.exit(0); }
const fs = require("fs");
process.stdout.write("ready\\r\\n");
const filler = "\\x1b[J".repeat(4000);
setInterval(() => {
  let round;
  try { round = fs.readFileSync(${JSON.stringify(go)}, "utf8").trim(); fs.rmSync(${JSON.stringify(go)}); } catch { return; }
  process.stdout.write("\\x1b[H\\x1b[2J" + round + " start\\r\\n");
  let i = 0;
  setTimeout(() => {
    const line = setInterval(() => {
      if (i === ${LINES}) { clearInterval(line); process.stdout.write("end " + round + "\\r\\n"); return; }
      process.stdout.write(filler + round + " line " + i++ + "\\r\\n");
    }, 15);
  }, 300);
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
  const expected = (round: string) => Array.from({ length: LINES }, (_, i) => `${round} line ${i}`);
  for (const n of [0, 1, 2, 3]) {
    const round = `r${n}`;
    fs.writeFileSync(go, round);
    // Resized once the terminal has taken in a few lines of the burst and before its end: while it
    // is behind, in a pause between the writes it takes in. The screen it showed then says so.
    const before = await page.evaluate(async ([round, odd]) => {
      const read = () => [...document.querySelectorAll(".xterm")]
        .map((x) => (x.parentElement as (HTMLElement & { __hmScreen?: () => string }) | null)?.__hmScreen?.() ?? "").join("\n");
      for (let s = read(); ; s = read()) {
        if (s.includes(`${round} line 2`)) {
          (document.querySelector("[data-community-slot]") as HTMLElement).style.width = odd ? "900px" : "1000px";
          return s;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
    }, [round, n % 2 === 1] as const);
    expect(before, `round ${round} resized mid-burst`).not.toContain(`end ${round}`);
    await expect.poll(() => screen(page), { timeout: 30_000 }).toContain(`end ${round}`);
    expect(linesOf(await screen(page), round), `round ${round} in this window`).toEqual(expected(round));
    // A window that opens now is sent the screen the host kept.
    const [second] = await Promise.all([app.waitForEvent("window"), page.evaluate(() => window.hive.newWindow())]);
    await second.waitForSelector(".react-flow", { timeout: 15_000 });
    await expect.poll(() => screen(second), { timeout: 20_000 }).toContain(`end ${round}`);
    expect(linesOf(await screen(second), round), `round ${round} in a window that opens on it`).toEqual(expected(round));
    await second.close();
    // Back to the front: a window behind another gets no frames, so it would neither resize nor
    // be read until the burst is over.
    await page.bringToFront();
  }
});
