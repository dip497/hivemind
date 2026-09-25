// A terminal no view shows gets no bytes; shown again it opens on the screen the host kept.
// Runs the real daemon: only a host that keeps each session's screen can show it again.
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
const XDG = fs.mkdtempSync(path.join(os.tmpdir(), "hm-interest-xdg-"));
const ENV = { ...process.env, XDG_CONFIG_HOME: XDG, HIVEMIND_PTY_DAEMON: "1" } as Record<string, string>;
const VIEW = fs.mkdtempSync(path.join(os.tmpdir(), "hm-interest-view-"));

/** What the renderer's copy of each terminal shows. */
const screens = () => page.evaluate(() => [...document.querySelectorAll(".xterm")]
  .map((x) => (x.parentElement as (HTMLElement & { __hmScreen?: () => string }) | null)?.__hmScreen?.() ?? "").join("\n"));

test.beforeAll(async () => {
  repo = await fs.promises.mkdtemp(path.join(os.tmpdir(), "hm-interest-"));
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
  // Reap only the daemon this spec started (its socket is under this spec's XDG), before
  // closing the app: close() waits on child processes.
  try { execFileSync("pkill", ["-f", `out/main/pty-daemon.js ${XDG}/`], { stdio: "ignore" }); } catch { /* none */ }
  await Promise.race([app?.close(), new Promise((r) => setTimeout(r, 10_000))]);
  for (const d of [repo, XDG, VIEW]) await fs.promises.rm(d, { recursive: true, force: true }).catch(() => {});
});

test("a parked terminal receives nothing, and shows what it missed when it comes back", async () => {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  const term = page.locator(".react-flow__node-terminal .xterm");
  await expect(term).toHaveCount(1, { timeout: 15_000 });
  await expect.poll(screens, { timeout: 15_000 }).toMatch(/[$#] *$/m); // the shell is at its prompt
  await term.click();
  // Quotes split each marker in the command line, so only the output carries it whole.
  await page.keyboard.type(`echo READY""-MARK; sleep 3; echo HIDDEN""-MARK`);
  await page.keyboard.press("Enter");
  await expect.poll(screens, { timeout: 10_000 }).toContain("READY-MARK");

  // Park it: a view that shows no tiles. Past the grace, main stops sending its bytes.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: "blank" } })));
  await page.waitForSelector('[data-community-view="blank"][data-community-ready="1"]', { timeout: 20_000 });
  await expect(page.locator("#hm-tile-park [data-surface] .xterm")).toHaveCount(1, { timeout: 10_000 });
  await page.waitForTimeout(5_000); // the shell has printed HIDDEN-MARK by now
  expect(await screens(), "the parked copy was sent nothing").not.toContain("HIDDEN-MARK");

  // Shown again: the host's screen, which has it.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: "canvas" } })));
  await expect(page.locator(".react-flow__node-terminal .xterm")).toHaveCount(1, { timeout: 10_000 });
  await expect.poll(screens, { timeout: 10_000 }).toContain("HIDDEN-MARK");
  expect(await screens()).toContain("READY-MARK");

  // And it is live again.
  await page.locator(".react-flow__node-terminal .xterm").click();
  await page.keyboard.type(`echo AFTER""-MARK`);
  await page.keyboard.press("Enter");
  await expect.poll(screens, { timeout: 10_000 }).toContain("AFTER-MARK");
});
