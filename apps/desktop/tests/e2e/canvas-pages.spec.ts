// Pages on the one canvas: a page is a frame you go inside. Going inside flies the camera to it,
// dims what is outside and shows the path at the top left; Backspace, the path or a click outside
// come back out. Nothing hides. Each test launches on a fresh repo and profile.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const cli = path.resolve("../cli/src/index.ts");

let root: string;
let app: ElectronApplication | undefined;
let page: Page;
let repo: string;
let env: Record<string, string>;

test.beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-pages-"));
  repo = path.join(root, "api");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  const config = path.join(root, "config");
  env = {
    ...process.env, XDG_CONFIG_HOME: config, HIVE_SETTINGS: path.join(config, "settings.json"), HIVEMIND_APP_DATA: path.join(config, "hivemind-dev"),
    HIVEMIND_SHELL_ENV: "0", HIVEMIND_HIVE_NET: path.join(root, "none"), HCP_TOKEN: "", HIVEMIND_TILE: "", HIVE_DRIVE_SOCK: "", HIVE_HCP_SOCK: "",
  } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.resolve("out/main/index.js"), "--no-sandbox"], cwd: repo, env });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 30_000 });
  await page.waitForTimeout(500);
});

test.afterEach(async () => {
  await app?.close();
  app = undefined;
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function hive(args: string[], input?: string): { code: number | null; json: Record<string, any> } {
  const r = spawnSync("bun", [cli, ...args, "--json"], { env, encoding: "utf8", cwd: repo, input });
  const out = r.stdout.trim() || r.stderr.trim();
  let json: Record<string, any> = {};
  try { json = JSON.parse(out) as Record<string, any>; } catch { json = { raw: out }; }
  return { code: r.status, json };
}

const shapeNode = (text: string) => page.locator(".react-flow__node-shape", { hasText: text });
const frameNode = (id: string) => page.locator(`.react-flow__node-frame[data-id="${id}"]`);
const path_ = () => page.locator("[data-page-path]");
const dimmed = () => page.locator(".react-flow__node.hm-outside-focus");

test("a page is a frame on the canvas: going inside flies to it, dims what is outside, shows the path; Backspace comes back out", async () => {
  test.setTimeout(120_000);
  const made = hive(["ctl", "page", "new", "Payments"]);
  expect(made.code).toBe(0);
  const id = String(made.json.id);
  await expect(frameNode(id)).toBeVisible({ timeout: 10_000 });
  await expect(frameNode(id).locator("[data-frame-page-mark]")).toBeVisible();

  expect(hive(["ctl", "draw", "--page", id], JSON.stringify({ title: "Inside", boxes: [{ id: "a", text: "Checkout box" }] })).code).toBe(0);
  expect(hive(["ctl", "draw", "--page", "top"], JSON.stringify({ title: "Outside", boxes: [{ id: "b", text: "Top box" }] })).code).toBe(0);
  // Both are on the one canvas, and nothing dims.
  await expect(shapeNode("Top box")).toHaveCount(1, { timeout: 10_000 });
  await expect(shapeNode("Checkout box")).toHaveCount(1);
  await expect(path_()).toHaveCount(0);
  await expect(dimmed()).toHaveCount(0);

  // Made from the command line, the page is not flown to: on a fresh canvas its label is under the
  // tool island. Fit everything first, as a person would to see it.
  await page.keyboard.press("Escape");
  const label = frameNode(id).locator("[data-frame-label] button").first();
  const island = page.locator("[data-host-island='top'] > div").first();
  await expect.poll(async () => { const l = (await label.boundingBox())!; const i = (await island.boundingBox())!; return l.y > i.y + i.height; }).toBe(true);
  await label.dblclick();
  await expect(path_()).toBeVisible();
  await expect(path_().locator("[aria-current=page]")).toHaveText("Payments");
  await expect(shapeNode("Top box")).toHaveClass(/hm-outside-focus/);
  await expect(shapeNode("Checkout box")).not.toHaveClass(/hm-outside-focus/);
  // The camera lands with the whole page in the pane, below the path, and in its middle.
  await expect.poll(async () => {
    const pane = (await page.locator(".react-flow").boundingBox())!;
    const bar = (await path_().boundingBox())!;
    const box = (await frameNode(id).boundingBox())!;
    const whole = box.x >= pane.x && box.y >= bar.y + bar.height && box.x + box.width <= pane.x + pane.width && box.y + box.height <= pane.y + pane.height;
    return whole && Math.abs(box.x + box.width / 2 - (pane.x + pane.width / 2)) < pane.width / 4;
  }, { timeout: 5000 }).toBe(true);

  // A page inside it: the path names both, and its first page part goes back up to Payments.
  const deeper = String(hive(["ctl", "page", "new", "Checkout", "--in", id]).json.id);
  expect(hive(["ctl", "page", "open", deeper]).code).toBe(0);
  await expect(path_().locator("[aria-current=page]")).toHaveText("Checkout");
  await expect(path_()).toContainText("Payments");
  await path_().locator(`[data-page-path-part="${id}"]`).click();
  await expect(path_().locator("[aria-current=page]")).toHaveText("Payments");

  // Out, with nothing selected: nothing dims and the path goes.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Backspace");
  await expect(path_()).toHaveCount(0);
  await expect(dimmed()).toHaveCount(0);

  // `page open` goes inside from the command line, and `page open top` back out.
  expect(hive(["ctl", "page", "open", id]).code).toBe(0);
  await expect(path_()).toBeVisible();
  expect(hive(["ctl", "page", "open", "top"]).code).toBe(0);
  await expect(path_()).toHaveCount(0);
});

test("a frame made a page keeps its tile drawn, and a click on the page in Layers goes inside it", async () => {
  test.setTimeout(120_000);
  // A terminal: it lands in the workspace's frame.
  await page.locator(".react-flow__pane").click({ position: { x: 20, y: 300 } });
  await page.keyboard.press("1");
  const tileNode = page.locator(".react-flow__node-terminal");
  await expect(tileNode).toHaveCount(1, { timeout: 15_000 });
  const frameId = String(await page.locator(".react-flow__node-frame").first().getAttribute("data-id"));

  await page.locator(`[data-frame-actions="${frameId}"]`).click({ force: true });
  await page.getByRole("menuitem", { name: "Make a page" }).click();
  await expect(frameNode(frameId).locator("[data-frame-page-mark]")).toBeVisible();
  await expect(tileNode).toHaveCount(1);

  await page.locator(`[data-layers-page="${frameId}"]`).first().click();
  await expect(path_()).toBeVisible();
  await expect(tileNode).not.toHaveClass(/hm-outside-focus/);

  // The path's first part is the way back to the whole canvas.
  await path_().locator("[data-page-path-part='']").click();
  await expect(path_()).toHaveCount(0);
});
