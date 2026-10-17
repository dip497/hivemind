// View protocol 1.5 end to end (R12): a sample view on the host shows who else is in the shared
// workspace, the tile their pointer is over and the tile they selected, as they do it on their
// canvas; and the host, in that view and not on the canvas, is still here for them.
import { test, expect, type ElectronApplication } from "@playwright/test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hiveNetBuilt, sharedWorkspace, tiles } from "./helpers/multiplayer";

const CLI = path.resolve("../cli/src/index.ts");
const VIEW = path.resolve("tests/e2e/fixtures/views/people");

let root: string;
const apps: ElectronApplication[] = [];
test.beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-viewpeople-")); });
test.afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
});

test("a view shows who else is here, the tile they point at and the one they selected; its own person is still here for them", async () => {
  test.skip(!hiveNetBuilt(), "build hive-net first: cargo build in crates/hive-net");
  const { host, guest } = await sharedWorkspace(root, apps, "edit", { names: { host: "Adarsh", guest: "Priya" } });
  // The host installs the view (their views live under their own profile) and switches to it.
  const installed = spawnSync("bun", [CLI, "views", "install", VIEW, "--json"], { encoding: "utf8", env: { ...process.env, XDG_CONFIG_HOME: path.join(root, "host") } });
  expect(installed.status, installed.stdout + installed.stderr).toBe(0);
  await host.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:reload-views")));
  await host.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: "people" } })));
  await host.waitForSelector('[data-community-view="people"][data-community-ready="1"]', { timeout: 20_000 });
  const view = host.frame({ name: "hm-view:people" })!;
  await expect.poll(() => view.evaluate(() => document.body.dataset.ready ?? null)).toBe("1");
  // A desktop: no finger, not a phone's screen.
  expect(await view.evaluate(() => [document.body.hasAttribute("data-touch"), document.body.hasAttribute("data-compact")])).toEqual([false, false]);

  // Priya selects the shell on her canvas, her pointer over it.
  const tile = (await tiles(guest)).find((id) => !id!.startsWith("frame-"))!;
  await guest.locator(`.react-flow__node[data-id="${tile}"]`).click({ position: { x: 60, y: 14 } });
  const row = () => view.evaluate((id) => {
    const r = document.querySelector<HTMLElement>(`li[data-tile="${id}"]`);
    return r && { selectedBy: r.dataset.selectedBy, pointedBy: r.dataset.pointedBy };
  }, tile);
  await expect.poll(() => view.evaluate(() => [...document.querySelectorAll(".face")].map((f) => f.textContent)), { timeout: 10_000 }).toEqual(["Priya"]);
  await expect.poll(row, { timeout: 10_000 }).toEqual({ selectedBy: "Priya", pointedBy: "Priya" });

  // The host is in the People view, not on the canvas, and still here for Priya.
  const hostPerson = (await host.evaluate(() => window.hive.identity()))!.personId;
  await expect(guest.locator(`[data-people-here] [data-person="${hostPerson}"]`)).toBeVisible({ timeout: 10_000 });

  // Her pointer leaves the board: she points at nothing, and still has the shell selected.
  const faces = (await guest.locator("[data-people-here]").boundingBox())!;
  await guest.mouse.move(faces.x + faces.width / 2, faces.y + faces.height / 2, { steps: 3 });
  await expect.poll(row, { timeout: 10_000 }).toEqual({ selectedBy: "Priya", pointedBy: "" });
});
