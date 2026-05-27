// Regression: the Issues tile on the canvas (board-lite). Seeds a real
// .hivemind workspace + one issue, opens the tile, and verifies the card,
// per-card state dropdown, "work" button, and click→peek all render.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";

let app: ElectronApplication;
let page: Page;
let workspace: string;

test.beforeAll(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "hm-issues-"));
  await fs.mkdir(path.join(workspace, ".hivemind", "issues"), { recursive: true });
  await fs.writeFile(path.join(workspace, ".hivemind", "config.yaml"), "prefix: XX\nnext_id: 2\nagents: {}\n", "utf8");
  await fs.writeFile(
    path.join(workspace, ".hivemind", "issues", "XX-1.md"),
    `---
id: XX-1
title: Wire up the flux capacitor
state: todo
parent: null
labels: []
assignee: null
github: null
created: "2026-05-21T00:00:00.000Z"
updated: "2026-05-21T00:00:00.000Z"
---

## Description

Make it go.

## Acceptance Criteria

- [ ] it goes
`,
    "utf8",
  );

  app = await electron.launch({
    args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox", `--user-data-dir=/tmp/hm-issues-ud-${Date.now()}`],
    cwd: workspace,
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForSelector(".react-flow", { timeout: 15_000 });
  await page.waitForTimeout(400);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "issues" })));
  await page.waitForSelector(".react-flow__node-issues", { timeout: 6_000 });
  await page.waitForTimeout(800);
});

test.afterAll(async () => {
  await app?.close();
  await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
});

test("renders the issue card with id + title", async () => {
  const txt = await page.evaluate(() => document.querySelector(".react-flow__node-issues")?.textContent || "");
  expect(txt).toContain("XX-1");
  expect(txt).toContain("Wire up the flux capacitor");
});

test("card has a state dropdown and a work button", async () => {
  const node = page.locator(".react-flow__node-issues");
  expect(await node.locator("select").count()).toBeGreaterThan(0);
  // work button is opacity-0 until hover but present in the DOM
  expect(await node.locator('button', { hasText: /work/ }).count()).toBeGreaterThan(0);
});

test("clicking a card opens the issue peek", async () => {
  await page.locator(".react-flow__node-issues").getByText("Wire up the flux capacitor").click();
  // The peek slide-over has a distinctive "Work on this" button (the tile card's
  // is just "work"). Poll until it appears — readIssue is async.
  await expect(page.getByRole("button", { name: /Work on this/i })).toBeVisible({ timeout: 5_000 });
});

test("card state dropdown changes the issue state (manual override)", async () => {
  // The dropdown is the manual path; the agent owns automatic transitions via
  // the hive-work skill (set_state over MCP), which needs a live claude — not
  // exercised here. This verifies the manual write path works.
  const node = page.locator(".react-flow__node-issues");
  const select = node.locator("select").first();
  await select.selectOption("in_progress");
  await expect.poll(async () => node.locator("select").first().inputValue(), { timeout: 6_000, intervals: [400] }).toBe("in_progress");
});
