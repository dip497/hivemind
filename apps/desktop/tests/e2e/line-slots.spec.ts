// A view reserves room for a tile's last line and the host draws it there (protocol 1.17,
// `lineSlots`, docs/design/last-line-2026-10-23.md §4): the line a shell printed shows in the slot
// the view left, drawn by the app over the view's frame, and nothing the view was sent carries it.
import { test, expect, _electron as electron, type ElectronApplication, type Frame, type Page } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, "../../../cli/src/index.ts");
const VIEW = path.join(__dirname, "fixtures", "views", "line-slots");

let app: ElectronApplication;
let page: Page;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-line-slots-"));
const xdg = path.join(root, "config");

test.beforeAll(async () => {
  const env = { ...process.env, XDG_CONFIG_HOME: xdg, HIVEMIND_SHELL_ENV: "0" } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const installed = spawnSync("bun", [CLI, "plugins", "install", VIEW, "--json"], { env, encoding: "utf8" });
  expect(installed.status, installed.stderr).toBe(0);
  execFileSync("git", ["init", "-q", path.join(root, "repo")]);
  app = await electron.launch({ args: [path.resolve(__dirname, "../../out/main/index.js"), "--no-sandbox"], cwd: path.join(root, "repo"), env });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow");
});
test.afterAll(async () => { await app?.close(); fs.rmSync(root, { recursive: true, force: true }); });

test("a shell's last line shows in the slot a view left for it, drawn by the app; the view is told it may ask, and never sent the line", async () => {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  const term = page.locator(".react-flow__node-terminal");
  await expect(term).toHaveCount(1);
  await term.locator(".xterm-screen").click();
  // The Layers row's hover card shows it once the shell ran it: then main has it.
  await expect.poll(async () => {
    await page.keyboard.type("echo $((200+14)) tests passed\n");
    await page.mouse.move(0, 0);
    await page.locator('aside[aria-label="Layers"] [data-layer-tile]').first().hover();
    const line = page.locator("[data-layers-card-line]");
    await line.waitFor({ timeout: 1_500 }).catch(() => {});
    const text = (await line.count()) ? await line.textContent() : null;
    await term.locator(".xterm-screen").click();
    return text;
  }, { timeout: 30_000, intervals: [1_000] }).toBe("214 tests passed");

  await page.locator("[data-view-switch]").click();
  await page.locator('[data-view-choice="line-slots"]').click();
  const view = async (): Promise<Frame> => {
    await expect.poll(() => page.frames().some((f) => f.url().includes("line-slots"))).toBe(true);
    return page.frames().find((f) => f.url().includes("line-slots"))!;
  };
  const slot = page.locator("[data-community-lines] [data-community-line] [data-line-slot]");
  await expect(slot).toHaveText("214 tests passed", { timeout: 20_000 });
  if (process.env.DECIDE_OUT) await page.screenshot({ path: path.join(process.env.DECIDE_OUT, "4-line-slot.png") });
  // Where the view left room: 40px down its box, 16px in.
  const box = (await page.locator("[data-community-view]").boundingBox())!;
  const at = (await page.locator("[data-community-line]").boundingBox())!;
  expect([Math.round(at.x - box.x), Math.round(at.y - box.y), Math.round(at.height)]).toEqual([16, 40, 24]);

  const said = await (await view()).evaluate(() => (window as unknown as { __lineSlots: { supports: boolean; heard: string[] } }).__lineSlots);
  expect(said.supports).toBe(true);
  expect(said.heard.join("\n")).not.toContain("214 tests passed");
  expect(await (await view()).evaluate(() => document.body.innerText)).not.toContain("214 tests passed");
});
