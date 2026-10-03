// Share and join (M1, design §4.2 A–B), with two app instances on one network: the host makes an
// invite link, someone pastes it and asks to join, and the host's person decides. Denied, they
// are not let in and the link still works; allowed, they are on the workspace's access list with
// the link's role for their device; the link, used, lets nobody else in.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { person, share } from "./helpers/multiplayer";

const HIVE_NET = path.resolve("../../crates/hive-net/target/debug/hive-net");

let root: string;
const apps: ElectronApplication[] = [];
test.beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-join-")); });
test.afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
});

async function launch(name: string, cwd: string): Promise<Page> {
  const config = path.join(root, name);
  const env = { ...process.env, XDG_CONFIG_HOME: config, HIVE_SETTINGS: path.join(config, "settings.json"), HIVEMIND_HIVE_NET: HIVE_NET } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.resolve("out/main/index.js"), "--no-sandbox"], cwd, env });
  apps.push(app);
  const page = await app.firstWindow();
  await page.waitForSelector(".react-flow");
  return page;
}

test("a person with an invite link asks to join; denied they are not let in, allowed they are on the list, and the link is spent", async () => {
  test.skip(!fs.existsSync(HIVE_NET), "build hive-net first: cargo build in crates/hive-net");
  const repo = path.join(root, "api");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const host = await launch("host", repo);
  const guestDir = path.join(root, "elsewhere");
  fs.mkdirSync(guestDir);
  const guest = await launch("guest", guestDir);

  await host.locator("[data-share]").click();
  await host.locator("#share-role").selectOption("edit");
  await host.locator("[data-share-create]").click();
  const link = (await host.locator("[data-share-link]").textContent())!;
  expect(link).toMatch(/^hivemind:\/\/join\/[0-9a-f]{64}#/);
  await host.keyboard.press("Escape");

  const ask = async () => {
    await guest.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-recent")));
    await guest.locator("[data-join]").click();
    await guest.locator("[data-join-link]").fill(link);
    await expect(guest.locator("[data-join-preview]")).toContainText("api on");
    await guest.locator("[data-join-go]").click();
  };
  const request = host.locator(".hm-join-request");

  // Denied.
  await ask();
  await expect(request).toContainText("wants to join api as Can edit board");
  await request.getByRole("button", { name: "Deny" }).click();
  await expect(guest.locator('[data-join-result="out"]')).toContainText("did not let you in");
  expect(await host.evaluate((r) => window.hive.people(r), repo)).toEqual([]);
  await guest.keyboard.press("Escape");

  // Allowed: the same link, which the refusal did not spend.
  await ask();
  await request.getByRole("button", { name: "Allow" }).click();
  await expect(guest.locator('[data-join-result="in"]')).toContainText("api · Can edit board");
  const me = await guest.evaluate(() => window.hive.identity());
  expect(await host.evaluate((r) => window.hive.people(r), repo)).toEqual([
    { person: me.personId, name: me.suggestedName, color: "", role: "edit", grantedAt: expect.any(Number), expires: null, devices: [me.deviceId], present: false },
  ]);
  await guest.keyboard.press("Escape");

  // Spent: asking again gets nothing, and the host is not asked.
  await ask();
  await expect(guest.locator('[data-join-result="out"]')).toContainText("expired or was used");
  await expect(request).toHaveCount(0);
});

test("two join calls for one invite produce one approval request", async () => {
  test.skip(!fs.existsSync(HIVE_NET), "build hive-net first: cargo build in crates/hive-net");
  const repo = path.join(root, "api");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const host = await person(root, "host", repo, apps);
  await host.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  const guestDir = path.join(root, "elsewhere");
  fs.mkdirSync(guestDir);
  const guest = await person(root, "guest", guestDir, apps);
  const link = await share(host, "view");

  const first = guest.evaluate((invite) => window.hive.join(invite), link);
  const second = guest.evaluate((invite) => window.hive.join(invite), link);
  const requests = host.locator(".hm-join-request");
  await expect(requests).toHaveCount(1);
  await host.waitForTimeout(500);
  await expect(requests).toHaveCount(1);
  await requests.getByRole("button", { name: "Allow" }).click();
  expect(await Promise.all([first, second])).toEqual([
    expect.objectContaining({ ok: true }),
    expect.objectContaining({ ok: true }),
  ]);
});
