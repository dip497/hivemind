// Two app instances on one network, as two people (M1): each its own profile and data folder, each
// with hive-net's daemon (crates/hive-net's debug build). And the steps of sharing and joining.
import { expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

export const HIVE_NET = path.resolve("../../crates/hive-net/target/debug/hive-net");
export const hiveNetBuilt = (): boolean => fs.existsSync(HIVE_NET);

/** Start the app as person `name` (their data under `root/name`), with `cwd` as its project. */
export async function person(root: string, name: string, cwd: string, apps: ElectronApplication[]): Promise<Page> {
  const config = path.join(root, name);
  const env = { ...process.env, XDG_CONFIG_HOME: config, HIVE_SETTINGS: path.join(config, "settings.json"), HIVEMIND_HIVE_NET: HIVE_NET } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.resolve("out/main/index.js"), "--no-sandbox"], cwd, env });
  apps.push(app);
  const page = await app.firstWindow();
  await page.waitForSelector(".react-flow");
  return page;
}

/** The host makes an invite link for `role` from Share. */
export async function share(host: Page, role: "view" | "edit" | "terminals"): Promise<string> {
  await host.locator("[data-share]").click();
  await host.locator("#share-role").selectOption(role);
  await host.locator("[data-share-create]").click();
  const link = (await host.locator("[data-share-link]").textContent())!;
  await host.keyboard.press("Escape");
  return link;
}

/** The guest pastes `link` and asks to join; the host allows. The guest is left at "You're in". */
export async function join(guest: Page, host: Page, link: string): Promise<void> {
  await guest.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-recent")));
  await guest.locator("[data-join]").click();
  await guest.locator("[data-join-link]").fill(link);
  await guest.locator("[data-join-go]").click();
  await host.locator(".hm-join-request").getByRole("button", { name: "Allow" }).click();
  await expect(guest.locator('[data-join-result="in"]')).toBeVisible();
}
