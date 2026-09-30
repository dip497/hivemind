// Settings → Network (R16, design §13.2–13.3): a fresh install is on the local network, with no
// servers; a network link from its admin is used from then on, its relay answers, and the app's
// network reaches out through it (an invite link names it); and the update check, when off, asks
// GitHub nothing until it is turned on again.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HIVE_NET, hiveNetBuilt } from "./helpers/multiplayer";

let root: string;
let app: ElectronApplication | undefined;
let relay: ChildProcess | undefined;
test.beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-network-")); });
test.afterEach(async () => {
  await app?.close().catch(() => {});
  app = undefined;
  relay?.kill();
  relay = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

async function launch(env: Record<string, string> = {}, settings?: object): Promise<Page> {
  const config = path.join(root, "config");
  fs.mkdirSync(config, { recursive: true });
  const file = path.join(config, "settings.json");
  if (settings) fs.writeFileSync(file, JSON.stringify(settings));
  execFileSync("git", ["init", "-q", path.join(root, "api")]);
  const all = { ...process.env, XDG_CONFIG_HOME: config, HIVE_SETTINGS: file, HIVEMIND_HIVE_NET: HIVE_NET, ...env } as Record<string, string>;
  delete all.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.resolve("out/main/index.js"), "--no-sandbox"], cwd: path.join(root, "api"), env: all });
  const page = await app.firstWindow();
  await page.waitForSelector(".react-flow");
  return page;
}
async function openSettings(page: Page, which: string): Promise<void> {
  await page.getByLabel("settings", { exact: true }).click();
  await page.locator(`[data-settings-page="${which}"]`).click();
}

/** A relay, and a network profile naming it, signed by its admin, as a link. */
async function network(): Promise<{ url: string; link: string }> {
  relay = spawn(HIVE_NET, ["serve", "--relay", "--bind", "127.0.0.1:0"], { stdio: ["ignore", "pipe", "ignore"] });
  const url = await new Promise<string>((resolve) => relay!.stdout!.once("data", (d: Buffer) => resolve(d.toString().trim().replace("relay serving on ", ""))));
  const admin = path.join(root, "admin.key");
  fs.writeFileSync(admin, `${"ab".repeat(32)}\n`);
  const id = JSON.parse(execFileSync(HIVE_NET, ["access", "voucher", "--kind", "enrol", "--admin", admin], { encoding: "utf8" })).by as string;
  const text = path.join(root, "profile.json");
  fs.writeFileSync(text, JSON.stringify({ v: 1, name: "Test network", relays: [{ url }], admin: id, local: { mdns: true } }));
  const signed = path.join(root, "signed.json");
  fs.writeFileSync(signed, execFileSync(HIVE_NET, ["profile", "sign", text, "--admin", admin]));
  return { url, link: execFileSync(HIVE_NET, ["profile", "link", signed], { encoding: "utf8" }).trim() };
}

test("a fresh install is on the local network; a network's link is used from then on, its relay answers, and invites reach out through it", async () => {
  test.skip(!hiveNetBuilt(), "build hive-net first: cargo build in crates/hive-net");
  const { url, link } = await network();
  const page = await launch();
  /** The relay an invite from here names: where the app's network waits for others. */
  const inviteRelay = async (): Promise<string | null> => {
    await page.locator("[data-share]").click();
    await page.locator("[data-share-create]").click();
    const invite = (await page.locator("[data-share-link]").textContent())!;
    await page.keyboard.press("Escape");
    const r = (JSON.parse(Buffer.from(invite.split("#")[1]!, "base64url").toString("utf8")) as { r: string | null }).r;
    return r ? r.replace(/\/$/, "") : null;
  };
  // On the local network the app's network runs, and names no server; Share says the link works
  // here only, and inviting someone elsewhere asks for a way through, which can wait.
  expect(await inviteRelay()).toBeNull();
  await page.locator("[data-share]").click();
  await expect(page.locator("[data-share-dialog]")).toContainText("Works for people on this network.");
  await page.locator("[data-invite-elsewhere]").click();
  await expect(page.locator("[data-reach-chooser]")).toBeVisible();
  await page.locator("[data-reach-not-now]").click();
  await expect(page.locator("[data-share-dialog]")).toContainText("Stays on this network: the link works only here.");
  await page.keyboard.press("Escape");
  await openSettings(page, "network");
  await expect(page.locator("[data-network-name]")).toHaveText("Local network");
  await expect(page.locator("[data-relay]")).toHaveCount(0);

  await page.locator("[data-network-change]").click();
  await page.locator("[data-network-link]").fill(link);
  await page.locator('[data-use-network="link"]').click();
  await expect(page.locator("[data-network-name]")).toHaveText("Test network");
  await page.locator("[data-network-check]").click();
  await expect(page.locator(`[data-relay="${url}"]`)).toHaveAttribute("data-ok", "true", { timeout: 20_000 });
  await page.keyboard.press("Escape");

  // The running network started again on it: an invite now names its relay.
  await expect.poll(inviteRelay, { timeout: 20_000 }).toBe(url.replace(/\/$/, ""));

  // Back to the local network.
  await openSettings(page, "network");
  await page.locator("[data-network-change]").click();
  await page.locator('[data-use-network="local"]').click();
  await expect(page.locator("[data-network-name]")).toHaveText("Local network");
});

test("with the update check off, nothing is asked: About says so, and turning it on checks again", async () => {
  const page = await launch({ HIVEMIND_TEST_UPDATE: JSON.stringify({ latest: "9999.1.0" }) }, { network: { updateCheck: false } });
  await openSettings(page, "about");
  const about = page.locator(".settings-dialog");
  await expect(about.locator("[data-update-off]")).toBeVisible();
  await expect(about.getByText(/Update available/)).toHaveCount(0);
  await about.getByRole("button", { name: "Turn it on" }).click();
  await expect(about.getByText(/Update available — v9999\.1\.0/)).toBeVisible();

  await page.locator('[data-settings-page="network"]').click();
  await page.locator("[data-update-check]").click();
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(root, "config", "settings.json"), "utf8")).network).toEqual({ updateCheck: false });
});
