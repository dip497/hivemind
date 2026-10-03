// A guest starts in the host's selected view, can leave it, and may follow the host's live camera.
// Host-only community views arrive through the workspace API and run in the normal sandbox.
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hiveNetBuilt, join, person, share } from "./helpers/multiplayer";

let root: string;
const apps: ElectronApplication[] = [];
test.beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-host-view-")); });
test.afterEach(async () => {
  for (const app of apps.splice(0)) await app.close().catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
});

const select = (page: Page, id: string) => page.evaluate((mode) =>
  window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode } })), id);

async function connect(role: "view" | "edit", view: string): Promise<{ host: Page; guest: Page }> {
  const repo = path.join(root, "api");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const host = await person(root, "host", repo, apps);
  await host.evaluate(() => window.hive.settingsSet("profile.name", "Adarsh"));
  await select(host, view);
  await expect(host.locator("[data-active-view]")).toHaveAttribute("data-active-view", view);
  const elsewhere = path.join(root, "elsewhere");
  fs.mkdirSync(elsewhere);
  const guest = await person(root, "guest", elsewhere, apps);
  const link = await share(host, role);
  await join(guest, host, link);
  await guest.locator("[data-join-open]").click();
  await expect(guest.locator("[data-shared-banner]")).toHaveAttribute("data-state", "connected", { timeout: 15_000 });
  await expect(guest.locator("[data-active-view]")).toHaveAttribute("data-active-view", view, { timeout: 15_000 });
  return { host, guest };
}

test("the host's view opens for a guest; switching stays personal; following tracks the host until the guest zooms", async () => {
  test.skip(!hiveNetBuilt(), "build hive-net first: cargo build in crates/hive-net");
  const { host, guest } = await connect("view", "windows");
  await select(guest, "canvas");
  await expect(host.locator("[data-active-view]")).toHaveAttribute("data-active-view", "windows");
  await select(host, "canvas");
  const follow = guest.getByRole("button", { name: "Follow Adarsh" });
  await expect(follow).toBeVisible({ timeout: 10_000 });
  await follow.click();
  const toggle = guest.locator("[data-people-here] button[aria-pressed]");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await host.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:zoom", { detail: "in" })));
  const zoom = (page: Page) => page.locator(".react-flow__viewport").evaluate((el) => {
    const transform = (el as HTMLElement).style.transform;
    return Number(transform.match(/scale\(([^)]+)\)/)?.[1] ?? 1);
  });
  await expect.poll(async () => Math.abs((await zoom(host)) - (await zoom(guest))), { timeout: 10_000 }).toBeLessThan(0.05);
  const pane = (await guest.locator(".react-flow__pane").boundingBox())!;
  // Off-centre: the empty canvas shows its hint card in the middle.
  await guest.mouse.move(pane.x + pane.width * 0.15, pane.y + pane.height * 0.3);
  await guest.mouse.wheel(0, -400);
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
});

test("a view-role guest opens the host's community view without installing it", async () => {
  test.skip(!hiveNetBuilt(), "build hive-net first: cargo build in crates/hive-net");
  const dir = path.join(root, "host", "hivemind", "views", "people");
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.cpSync(path.resolve("tests/e2e/fixtures/views/people"), dir, { recursive: true });
  const { guest } = await connect("view", "people");
  await expect(guest.locator('[data-community-view="people"]')).toHaveAttribute("data-community-ready", "1", { timeout: 20_000 });
  await expect.poll(() => guest.frame({ name: "hm-view:people" })?.evaluate(() => document.body.dataset.ready ?? null)).toBe("1");
  expect(fs.existsSync(path.join(root, "guest", "hivemind", "views", "people"))).toBe(false);
  await select(guest, "canvas");
  await expect(guest.locator("[data-active-view]")).toHaveAttribute("data-active-view", "canvas");
});
