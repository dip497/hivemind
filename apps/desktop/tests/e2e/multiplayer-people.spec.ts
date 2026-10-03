// People in a shared workspace (M1, design §4.2 E–F), with two app instances: the host sees who is
// on the list and here, changes a guest's role (the guest works under it at once) and removes
// them (disconnected at once, told so, left with a copy to read, and the link spent). When the
// host goes away the guest keeps the board, and what they write meanwhile reaches the host when it
// is back, by itself; a guest who leaves is gone from the host's board.
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hiveNetBuilt, join, note, notes, person, share, sharedWorkspace } from "./helpers/multiplayer";

let root: string;
const apps: ElectronApplication[] = [];
test.beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-people-")); });
test.afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
});

const banner = (w: Page) => w.locator("[data-shared-banner]");
async function openPeople(host: Page): Promise<void> {
  await host.locator("[data-share]").click();
  await host.locator("[data-share-people]").click();
  await expect(host.locator("[data-people-dialog]")).toBeVisible();
}

test("the host changes a guest's role and removes them: the guest works under the new role at once, and once removed is disconnected, told so, and keeps a copy only to read", async () => {
  test.skip(!hiveNetBuilt(), "build hive-net first: cargo build in crates/hive-net");
  const { host, guest } = await sharedWorkspace(root, apps, "edit");
  await guest.evaluate(() => window.hive.settingsSet("profile.name", "Priya Raman"));
  const me = await guest.evaluate(() => window.hive.identity());
  await expect(banner(guest)).toHaveAttribute("data-state", "connected", { timeout: 10_000 });
  await expect(banner(guest)).toContainText("You're in api");
  await expect(banner(guest)).toHaveAttribute("data-access", "edit");

  await openPeople(host);
  const row = host.locator(`[data-shared-person="${me.personId}"]`);
  await expect(row).toContainText("Here now");
  await expect(row.locator("[data-person-role]")).toHaveValue("edit");

  // To viewer: the guest is reconnected under it, and what they write is taken back.
  await row.locator("[data-person-role]").selectOption("view");
  await expect(banner(guest)).toHaveAttribute("data-access", "view", { timeout: 10_000 });
  await expect(banner(guest)).toHaveAttribute("data-state", "connected");
  await host.keyboard.press("Escape");
  await note(guest, "after the change");
  await expect.poll(() => notes(guest), { timeout: 10_000 }).toEqual([]);

  // Removed: disconnected at once and told, gone from the list and the board, with a copy to read.
  await openPeople(host);
  await row.locator("[data-remove]").click();
  await row.locator("[data-remove-confirm]").click();
  await expect(banner(guest)).toHaveAttribute("data-state", "removed", { timeout: 5_000 });
  await expect(host.locator("[data-shared-person]")).toHaveCount(0);
  expect(await host.evaluate((r) => window.hive.people(r), path.join(root, "api"))).toEqual([]);
  await host.keyboard.press("Escape");
  await expect(host.locator(`[data-people-here] [data-person="${me.personId}"]`)).toHaveCount(0, { timeout: 5_000 });
  await note(guest, "after removal");
  await expect.poll(() => notes(guest), { timeout: 10_000 }).toEqual([]);
  await guest.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-recent")));
  await expect(guest.locator("[data-shared-workspace]")).toHaveCount(0); // the one open is not listed
});

test("a second approved invite replaces an open guest session and its role", async () => {
  test.skip(!hiveNetBuilt(), "build hive-net first: cargo build in crates/hive-net");
  const { host, guest } = await sharedWorkspace(root, apps, "view");
  await expect(banner(guest)).toHaveAttribute("data-access", "view");

  const link = await share(host, "terminals");
  await join(guest, host, link);
  await guest.locator("[data-join-open]").click();

  await expect(banner(guest)).toHaveAttribute("data-state", "connected", { timeout: 15_000 });
  await expect(banner(guest)).toHaveAttribute("data-access", "terminals", { timeout: 15_000 });
});

test("the host goes away and comes back: the guest keeps the board, what they wrote meanwhile reaches the host by itself; a guest who leaves is gone from the host's board", async () => {
  test.skip(!hiveNetBuilt(), "build hive-net first: cargo build in crates/hive-net");
  const { host, guest, repo } = await sharedWorkspace(root, apps, "edit");
  const me = await guest.evaluate(() => window.hive.identity());
  await expect(banner(guest)).toHaveAttribute("data-state", "connected", { timeout: 10_000 });

  await apps.shift()!.close();
  await expect(banner(guest)).toHaveAttribute("data-state", /reconnecting|offline/, { timeout: 15_000 });
  await note(guest, "written while away");
  expect(await notes(guest)).toEqual(["written while away"]);

  const back = await person(root, "host", repo, apps);
  await expect(banner(guest)).toHaveAttribute("data-state", "connected", { timeout: 40_000 });
  await expect.poll(() => notes(back), { timeout: 15_000 }).toEqual(["written while away"]);
  // The guest is there again as soon as they are back, without having to move.
  await expect(back.locator(`[data-people-here] [data-person="${me.personId}"]`)).toBeVisible({ timeout: 5_000 });

  await guest.locator("[data-leave]").click();
  await expect(banner(guest)).toHaveAttribute("data-state", "left");
  await expect(back.locator(`[data-people-here] [data-person="${me.personId}"]`)).toHaveCount(0, { timeout: 5_000 });
  await guest.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-recent")));
  await expect(guest.locator("[data-recent-projects]")).toBeVisible();
});
