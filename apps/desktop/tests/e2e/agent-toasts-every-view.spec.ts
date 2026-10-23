// An agent that needs you while you look at another tile pings you in whichever view is
// open, not only on the canvas: a stack drawn by the canvas alone held every toast raised
// in another view and showed them all at once when the canvas came back.
import { test, expect, type ElectronApplication } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { person } from "./helpers/multiplayer";
import { chooserAgent } from "./helpers/chooser";
import { stopDaemons } from "./helpers/daemons";

let root: string;
const apps: ElectronApplication[] = [];
test.beforeEach(() => { root = fs.mkdtempSync("/tmp/hm-toasts-views-"); });
test.afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  stopDaemons(root);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test("an agent's notification shows in the Windows view and opens its tab", async () => {
  test.setTimeout(120_000);
  const repo = path.join(root, "api");
  fs.mkdirSync(repo);
  execSync("git init -q", { cwd: repo });
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const page = await person(root, "desktop", repo, apps, { ...chooserAgent(root), HIVEMIND_SHELL_ENV: "0", HOME: home });

  await page.evaluate(() => window.hive.settingsSet("agents.defaultAgent", "chooser"));
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:shortcut", { detail: "agent" })));
  const agent = page.locator(".react-flow__node-terminal");
  await expect(agent).toHaveCount(1, { timeout: 20_000 });
  const tile = (await agent.getAttribute("data-id"))!;
  const state = async () => (await page.evaluate((r) => window.hive.agentList(r), repo)).agents.find((a) => a.tile === tile)?.state;
  await expect.poll(state, { timeout: 30_000 }).toBe("idle");
  // A shell opened after it is the selected tile, so the agent's ask comes as a notification.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await expect(page.locator(".react-flow__node-terminal")).toHaveCount(2, { timeout: 10_000 });

  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: "windows" } })));
  await page.waitForSelector('[data-community-view="windows"][data-community-ready="1"]');
  const agentTab = page.frameLocator('iframe[name="hm-view:windows"]').locator(`[role="tab"][data-tile-id=${JSON.stringify(tile)}]`);
  await expect(agentTab).toHaveAttribute("aria-selected", "false");

  await page.evaluate((t) => window.hive.ptyWrite(`hm:${t}`, "perm\r"), tile);
  const notice = page.locator(".hm-toast").filter({ hasText: "needs your input" });
  await expect(notice).toBeVisible({ timeout: 20_000 });
  await notice.click();
  await expect(agentTab).toHaveAttribute("aria-selected", "true");
  await expect(notice).toHaveCount(0);
});
