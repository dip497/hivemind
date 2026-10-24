// A permission is answered where it shows (docs/design/last-line-2026-10-23.md §2, §3): an agent
// that waits on the person's permission to run a command says it on its Layers row, in amber, with
// Deny and Allow under it, or Review when the row cuts it short; and, seen from elsewhere, its toast
// says it too and offers the same. Each answers `agent.answer` with the wait's `since`, and the hook that holds the wait
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
/** Where screenshots go when someone asks for them. */
const OUT = process.env.DECIDE_OUT;
const shot = async (page: Page, name: string) => { if (OUT) await page.screenshot({ path: path.join(OUT, name) }); };
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
  const env = chooserAgent(root, { held: true, about: true });
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

test("a permission says what it runs on the agent's row in amber; cut short there, the row offers Review, which shows it whole with the keyboard on Deny, and Allow answers its hook", async () => {
  test.setTimeout(120_000);
  const { desktop, log, ask } = await started();
  await ask();
  const row = desktop.locator('aside[aria-label="Layers"] [data-layer-tile]');
  await expect(row.locator('[data-layer-line="waiting"]')).toHaveText("Bash: rm -rf build", { timeout: 20_000 });
  // The panel's row is narrower than the line beside its needs-you chip: none of it may be allowed
  // unseen.
  const band = row.locator("[data-layer-decide]");
  await expect(band.locator("[data-decide]")).toHaveText(["Review"]);
  await expect(row).toHaveCSS("height", "80px");
  await shot(desktop, "1-row-review.png");

  await band.locator('[data-decide="review"]').click();
  const review = desktop.locator("[data-wait-review]");
  await expect(review.locator("pre")).toHaveText("rm -rf build");
  await shot(desktop, "2-review.png");
  await expect(review.locator("[data-decide]")).toHaveText(["Deny", "Allow"]);
  expect(await desktop.evaluate(() => document.activeElement?.getAttribute("data-decide") ?? null)).toBe("deny");
  await review.locator('[data-decide="allow"]').click();
  await expect.poll(log, { timeout: 20_000 }).toContain("hook said");
  expect(log()).toMatch(/hook said .*allow/);
  await expect(band).toHaveCount(0, { timeout: 20_000 });
});

test("seen from elsewhere, the agent's toast says what it waits on and offers Deny and Allow, filled in place; Deny answers its hook and the toast stops asking", async () => {
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
  await shot(desktop, "3-toast.png");
  await deny.click();
  await expect.poll(log, { timeout: 20_000 }).toContain("hook said");
  expect(log()).toMatch(/hook said .*deny/);
  // Its wait ended: the needs-you toast goes (the turn the denial ends may tell it finished, in
  // its place).
  await expect(card.locator("[data-decide]")).toHaveCount(0, { timeout: 20_000 });
  await expect(card).not.toContainText("needs your input");
});
