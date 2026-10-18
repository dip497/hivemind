// A notification that an agent needs you is drawn over a widget card in the same spot, and the
// card over the canvas: a notification is never hidden behind a widget.
import { test, expect, type ElectronApplication } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { person } from "./helpers/multiplayer";
import { chooserAgent } from "./helpers/chooser";
import { stopDaemons } from "./helpers/daemons";

// A tall card that parks itself in the bottom-right corner, where notifications show.
const TALL = `
hive.on("start", () => {
  hive.render({ type: "stack", children: Array.from({ length: 8 }, (_, i) => ({ type: "text", text: "line " + i })) });
  hive.moveTo({ x: 1, y: 1 }, { over: 0 });
});
`;

let root: string;
const apps: ElectronApplication[] = [];
test.beforeEach(() => { root = fs.mkdtempSync("/tmp/hm-notify-over-"); });
test.afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  stopDaemons(root);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test("an agent's notification draws over a widget card in the same spot", async () => {
  test.setTimeout(120_000);
  const repo = path.join(root, "api");
  fs.mkdirSync(repo);
  execSync("git init -q", { cwd: repo });
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const env = chooserAgent(root);
  const widget = path.join(root, "desktop", "hivemind", "widgets", "tall");
  fs.mkdirSync(widget, { recursive: true });
  fs.writeFileSync(path.join(widget, "widget.json"), JSON.stringify({ name: "Tall" }));
  fs.writeFileSync(path.join(widget, "widget.js"), TALL);
  const page = await person(root, "desktop", repo, apps, { ...env, HIVEMIND_SHELL_ENV: "0", HOME: home });

  await page.evaluate(() => window.hive.settingsSet("agents.defaultAgent", "chooser"));
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:shortcut", { detail: "agent" })));
  const terminal = page.locator(".react-flow__node-terminal");
  await expect(terminal).toHaveCount(1, { timeout: 20_000 });
  const tile = (await terminal.getAttribute("data-id"))!;
  const state = async () => (await page.evaluate((r) => window.hive.agentList(r), repo)).agents.find((a) => a.tile === tile)?.state;
  await expect.poll(state, { timeout: 30_000 }).toBe("idle");

  await page.locator('[data-toolbar-action="board"]').first().click();
  await page.locator('[data-board-choice="widget:tall"]').click();
  const card = page.locator('[data-widget-layer] [data-widget="tall"]');
  await expect(card).toContainText("line 7", { timeout: 15_000 });

  // Looking elsewhere, so the agent's ask comes as a notification.
  await page.locator(".react-flow__pane").click({ position: { x: 5, y: 5 } });
  await page.evaluate((t) => window.hive.ptyWrite(`hm:${t}`, "perm\r"), tile);
  const notice = page.locator(".hm-toast").filter({ hasText: "needs your input" });
  await expect(notice).toBeVisible({ timeout: 20_000 });

  // The card has settled in the corner when it covers the notification's spot.
  let overlap = { x: 0, y: 0 };
  await expect.poll(async () => {
    const a = (await notice.boundingBox())!;
    const b = (await card.boundingBox())!;
    const left = Math.max(a.x, b.x), right = Math.min(a.x + a.width, b.x + b.width);
    const top = Math.max(a.y, b.y), bottom = Math.min(a.y + a.height, b.y + b.height);
    overlap = { x: (left + right) / 2, y: (top + bottom) / 2 };
    return right - left > 20 && bottom - top > 20;
  }, { timeout: 10_000 }).toBe(true);

  const topmost = (x: number, y: number) => page.evaluate(([px, py]) => {
    const hit = document.elementFromPoint(px, py);
    return hit?.closest(".hm-toast") ? "notification" : hit?.closest("[data-widget]") ? "widget" : hit?.closest(".react-flow") ? "canvas" : "other";
  }, [x, y] as const);
  expect(await topmost(overlap.x, overlap.y)).toBe("notification");
  // The card's top, above the notification: there the card draws over the canvas.
  const b = (await card.boundingBox())!;
  expect(await topmost(b.x + b.width / 2, b.y + 12)).toBe("widget");
});
