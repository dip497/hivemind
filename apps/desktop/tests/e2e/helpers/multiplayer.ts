// Two app instances on one network, as two people (M1): each its own profile and data folder, each
// with hive-net's daemon (crates/hive-net's debug build). And the steps of sharing and joining.
import { expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
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

/** The tiles on a person's board (board objects aside), sorted. */
export const tiles = (w: Page) => w.locator(".react-flow__node").evaluateAll((ns) => ns.map((n) => n.getAttribute("data-id")).filter((id) => id && !id.startsWith("note")).sort());
/** The text of each sticky note on a person's board. */
export const notes = (w: Page) => w.locator(".react-flow__node-note [data-board-text]").allTextContents();
const emptySpot = (w: Page) => w.evaluate(() => {
  const pane = document.querySelector(".react-flow__pane")!.getBoundingClientRect();
  for (let y = pane.bottom - 140; y > pane.top + 100; y -= 30) {
    for (let x = pane.left + 320; x < pane.right - 100; x += 30) {
      if (document.elementFromPoint(x, y)?.classList.contains("react-flow__pane")) return { x, y };
    }
  }
  return null;
});
/** A person writes a sticky note with `text` somewhere free on their board. */
export async function note(w: Page, text: string): Promise<void> {
  // Room on the canvas first: a workspace's frame can fill the view.
  for (let i = 0; i < 3; i++) await w.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:zoom", { detail: "out" })));
  await w.waitForTimeout(400);
  const at = (await emptySpot(w))!;
  await w.mouse.click(at.x, at.y);
  await w.keyboard.press("8");
  await w.keyboard.type(text);
  await w.keyboard.press("Escape");
}

/** A host with a shell tile in the workspace `api`, shared for `role` with a guest who joined and
 *  opened it: both see the same tiles. */
export async function sharedWorkspace(root: string, apps: ElectronApplication[], role: "view" | "edit") {
  const repo = path.join(root, "api");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const host = await person(root, "host", repo, apps);
  await host.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await expect.poll(async () => (await tiles(host)).length).toBeGreaterThan(0);
  const guestDir = path.join(root, "elsewhere");
  fs.mkdirSync(guestDir);
  const guest = await person(root, "guest", guestDir, apps);
  const link = await share(host, role);
  await join(guest, host, link);
  await guest.locator("[data-join-open]").click();
  await expect.poll(() => tiles(guest), { timeout: 15_000 }).toEqual(await tiles(host));
  return { host, guest, repo };
}
