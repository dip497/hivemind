// A permission is answered where it shows (docs/design/last-line-2026-10-23.md §2, §3): an agent
// that waits on the person's permission to run a one-line command says it on its Layers row, in
// amber, with Deny and Allow under it; and, seen from elsewhere, its toast says it too and offers
// the same. Each answers `agent.answer` with the wait's `since`, and the hook that holds the wait
// prints that answer. A stand-in agent asks as Claude Code does (helpers/chooser.ts, `held`).
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { person } from "./helpers/multiplayer";
import { chooserAgent } from "./helpers/chooser";
import { stopDaemons } from "./helpers/daemons";

let root: string;
const apps: ElectronApplication[] = [];
test.beforeEach(() => { root = fs.mkdtempSync("/tmp/hm-decide-"); });
test.afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  stopDaemons(root);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** The desktop with the stand-in started, idle, and the way to make it ask. */
async function started(): Promise<{ desktop: Page; tile: string; log: () => string; ask: () => Promise<void> }> {
  const repo = path.join(root, "api");
  fs.mkdirSync(repo);
  execSync("git init -q", { cwd: repo });
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const env = chooserAgent(root, { held: true });
  const desktop = await person(root, "desktop", repo, apps, { ...env, CHOOSER_LATE: "1", HIVEMIND_SHELL_ENV: "0", HOME: home });
  await desktop.evaluate(() => window.hive.settingsSet("agents.defaultAgent", "chooser"));
  await desktop.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:shortcut", { detail: "agent" })));
  await expect(desktop.locator(".react-flow__node-terminal")).toHaveCount(1, { timeout: 20_000 });
  const tile = (await desktop.locator(".react-flow__node-terminal").getAttribute("data-id"))!;
  const state = async () => (await desktop.evaluate((r) => window.hive.agentList(r), repo)).agents.find((a) => a.tile === tile)?.state;
  await expect.poll(state, { timeout: 30_000 }).toBe("idle");
  const log = () => (fs.existsSync(env.CHOOSER_LOG) ? fs.readFileSync(env.CHOOSER_LOG, "utf8") : "");
  return { desktop, tile, log, ask: () => desktop.evaluate((t) => window.hive.ptyWrite(`hm:${t}`, "perm\r"), tile) };
}

test("a permission to run one line says it on the agent's row in amber with Deny and Allow, the keyboard not on Allow; Allow answers its hook and the band goes", async () => {
  test.setTimeout(120_000);
  const { desktop, log, ask } = await started();
  await ask();
  const row = desktop.locator('aside[aria-label="Layers"] [data-layer-tile]');
  await expect(row.locator('[data-layer-line="waiting"]')).toHaveText("Bash: rm -rf build", { timeout: 20_000 });
  const band = row.locator("[data-layer-decide]");
  await expect(band.locator("[data-decide]")).toHaveText(["Deny", "Allow"]);
  await expect(row).toHaveCSS("height", "80px");
  expect(await desktop.evaluate(() => document.activeElement?.getAttribute("data-decide") ?? null)).not.toBe("allow");

  await band.locator('[data-decide="allow"]').click();
  await expect.poll(log, { timeout: 20_000 }).toContain("hook said");
  expect(log()).toMatch(/hook said .*allow/);
  await expect(band).toHaveCount(0, { timeout: 20_000 });
});

test("seen from elsewhere, the agent's toast says what it waits on and offers Deny and Allow, filled in place; Deny answers its hook and the toast goes", async () => {
  test.setTimeout(120_000);
  const { desktop, log, ask } = await started();
  // Nothing selected: the toast is for a tile the person is not looking at.
  await desktop.locator(".react-flow__pane").click({ position: { x: 5, y: 5 } });
  await ask();
  const card = desktop.locator("[data-notifications] .hm-toast");
  await expect(card).toHaveCount(1, { timeout: 20_000 });
  await expect(card).toContainText("Bash: rm -rf build", { timeout: 20_000 });
  const deny = card.locator('[data-decide="deny"]');
  await expect(card.locator("[data-decide]")).toHaveText(["Deny", "Allow"]);
  await deny.click();
  await expect.poll(log, { timeout: 20_000 }).toContain("hook said");
  expect(log()).toMatch(/hook said .*deny/);
  await expect(card).toHaveCount(0, { timeout: 20_000 });
});
