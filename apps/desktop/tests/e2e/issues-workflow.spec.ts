// The Issues board with a workspace workflow (design jira-sync §4.3): the PAY Story workflow of
// packages/jira-fake/fixtures/cloud-scrum-company.site.json, its scrum board's columns, and a
// hive-only PR Created in the Review column. Checks the columns come in the board's order and that a
// card dragged between columns ends in the right status on disk, through the status picker when
// the column holds several.
import { test, expect, type Page } from "@playwright/test";
import { launchWindow, type AppWindow } from "./helpers/window";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";

let app: AppWindow;
let page: Page;
let workspace: string;

const WORKFLOW = `version: 1
statuses:
  - { id: "jira:10000", name: Backlog, category: backlog, source: jira }
  - { id: "jira:10001", name: To Do, category: todo, source: jira }
  - { id: "jira:3", name: In Progress, category: in_progress, source: jira }
  - { id: "jira:10002", name: Blocked, category: in_progress, source: jira }
  - { id: "jira:10003", name: Code Review, category: in_review, source: jira }
  - { id: "jira:10004", name: QA, category: in_review, source: jira }
  - { id: "jira:10005", name: Ready for Release, category: in_review, source: jira }
  - { id: "hive:pr-created", name: PR Created, category: in_review, source: hive, jira: { follow: "jira:10003" } }
  - { id: "jira:10006", name: Done, category: done, source: jira }
  - { id: "jira:10007", name: Won't Do, category: cancelled, source: jira }
board:
  id: 12
  type: scrum
  columns:
    - { name: To Do, statuses: ["jira:10001"] }
    - { name: In Progress, statuses: ["jira:3", "jira:10002"] }
    - { name: Review, statuses: ["jira:10003", "jira:10004", "hive:pr-created"] }
    - { name: Ready, statuses: ["jira:10005"] }
    - { name: Done, statuses: ["jira:10006", "jira:10007"] }
`;

const issueFile = (id: string, title: string, status: string, state: string) => `---
id: ${id}
title: ${title}
state: ${state}
parent: null
labels: []
assignee: null
github: null
status: "${status}"
created: "2026-10-24T00:00:00.000Z"
updated: "2026-10-24T00:00:00.000Z"
---

## Description

${title}.
`;
const onDisk = (id: string) => fs.readFile(path.join(workspace, ".hivemind", "issues", `${id}.md`), "utf8").catch(() => "");

test.beforeAll(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "hm-issues-wf-"));
  const root = path.join(workspace, ".hivemind");
  await fs.mkdir(path.join(root, "issues"), { recursive: true });
  await fs.writeFile(path.join(root, "config.yaml"), "prefix: PAY\nnext_id: 4\nagents: {}\n", "utf8");
  await fs.writeFile(path.join(root, "workflow.yaml"), WORKFLOW, "utf8");
  await fs.writeFile(path.join(root, "issues", "PAY-1.md"), issueFile("PAY-1", "Retry failed webhooks", "jira:10001", "todo"), "utf8");
  await fs.writeFile(path.join(root, "issues", "PAY-2.md"), issueFile("PAY-2", "Sign the payload", "jira:10001", "todo"), "utf8");
  await fs.writeFile(path.join(root, "issues", "PAY-3.md"), issueFile("PAY-3", "Rotate the keys", "jira:10002", "in_progress"), "utf8");

  app = await launchWindow({ cwd: workspace, args: [`--user-data-dir=/tmp/hm-issues-wf-ud-${Date.now()}`] });
  page = app.page;
  await page.waitForLoadState("domcontentloaded");
  await page.waitForSelector(".react-flow", { timeout: 15_000 });
  await expect.poll(async () => {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "issues" })));
    return page.locator('[data-tool-plugin="@hivemind/issues"]').count();
  }, { timeout: 15_000 }).toBeGreaterThan(0);
});

test.afterAll(async () => {
  await app?.close();
  await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
});

const tile = () => page.locator('[data-tool-plugin="@hivemind/issues"]');
const column = (name: string) => tile().locator(`[data-column="${name}"]`);
const card = (id: string) => tile().getByRole("button", { name: `Open issue ${id}` });
/** An HTML5 drag of a card onto a column, as the browser sends it: dragstart, dragover, drop,
 *  dragend. A mouse drag through the canvas under xvfb does not reliably deliver them (the target
 *  columns lie past the tile's edge, inside its scroller). */
async function drag(id: string, to: string) {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await card(id).dispatchEvent("dragstart", { dataTransfer });
  await column(to).dispatchEvent("dragover", { dataTransfer });
  await column(to).dispatchEvent("drop", { dataTransfer });
  await card(id).dispatchEvent("dragend", { dataTransfer });
}

test("the columns are the board's, a status no column holds placed by its state", async () => {
  await expect(column("Ready")).toBeVisible({ timeout: 10_000 });
  const names = await tile().locator("[data-column]").evaluateAll((els) => els.map((e) => e.getAttribute("data-column")));
  // Won't Do is cancelled: Done shows it only with Show cancelled.
  expect(names).toEqual(["Backlog", "To Do", "In Progress", "Review", "Ready", "Done"]);
  await expect(column("In Progress").getByRole("button", { name: "Open issue PAY-3" })).toBeVisible();
  // A card in a column of several statuses names its own.
  await expect(card("PAY-3").locator("[data-card-status]")).toHaveText("Blocked");
  await tile().screenshot({ path: test.info().outputPath("board.png") });
});

test("a card dragged to a one-status column lands in that status", async () => {
  // Cards drag only while the tile is focused.
  await column("Backlog").click({ position: { x: 100, y: 10 } });
  await expect(card("PAY-1")).toHaveAttribute("draggable", "true");
  await drag("PAY-1", "Ready");
  await expect.poll(() => onDisk("PAY-1"), { timeout: 6_000, intervals: [300] }).toMatch(/status: '?jira:10005'?/);
  expect(await onDisk("PAY-1")).toMatch(/state: in_review/);
  await expect(column("Ready").getByRole("button", { name: "Open issue PAY-1" })).toBeVisible();
});

test("a card dropped on a column of several statuses asks which, and lands in the one picked", async () => {
  await drag("PAY-2", "Review");
  const picker = tile().locator("[data-status-picker]");
  await expect(picker).toBeVisible();
  await expect(picker.locator("[data-status]")).toHaveCount(3);
  await expect(picker.locator('[data-status="hive:pr-created"] [data-hive-only]')).toBeVisible();
  await picker.locator('[data-status="hive:pr-created"]').click();
  await expect.poll(() => onDisk("PAY-2"), { timeout: 6_000, intervals: [300] }).toMatch(/status: '?hive:pr-created'?/);
  expect(await onDisk("PAY-2")).toMatch(/state: in_review/);
  await expect(picker).toHaveCount(0);
  await expect(card("PAY-2").locator("[data-card-status]")).toHaveText("PR Created");
});
