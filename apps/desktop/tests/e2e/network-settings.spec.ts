// Settings → Servers (R16, R13, design §13.2–13.3): a fresh install is on the local network, with
// no servers, and offers to set one up first; a network link used by `hive network use` shows on
// the open page already checked, and the app's network reaches out through it (an invite link
// names it); a link pasted there is used too; and the update
// check, switched on About and updates only, asks GitHub nothing while off.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HIVE_NET, hiveNetBuilt, openConnect, share } from "./helpers/multiplayer";

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

const appEnv = (): Record<string, string> => ({ ...process.env, XDG_CONFIG_HOME: path.join(root, "config"), HIVEMIND_HIVE_NET: HIVE_NET } as Record<string, string>);
/** `hive network use`, as an agent setting up a server runs it, on this dev app's data. */
const hiveNetworkUse = (given: string) =>
  spawnSync("bun", [path.resolve("../cli/src/index.ts"), "network", "use", given, "--json"], {
    env: { ...appEnv(), HIVEMIND_APP_DATA: path.join(root, "config", "hivemind-dev") }, encoding: "utf8",
  });

async function launch(env: Record<string, string> = {}, settings?: object): Promise<Page> {
  const config = path.join(root, "config");
  fs.mkdirSync(config, { recursive: true });
  const file = path.join(config, "settings.json");
  if (settings) fs.writeFileSync(file, JSON.stringify(settings));
  execFileSync("git", ["init", "-q", path.join(root, "api")]);
  const all = { ...appEnv(), HIVE_SETTINGS: file, ...env } as Record<string, string>;
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

/** A relay and a lookup server, and a network profile naming them, signed by its admin, as a link. */
async function network(): Promise<{ url: string; lookup: string; link: string }> {
  relay = spawn(HIVE_NET, ["serve", "--relay", "--lookup", "--data", path.join(root, "server"), "--bind", "127.0.0.1:0"], { stdio: ["ignore", "pipe", "ignore"] });
  let printed = "";
  await new Promise<void>((resolve) => relay!.stdout!.on("data", (d: Buffer) => { printed += d.toString(); if (printed.includes("lookup serving on ")) resolve(); }));
  const after = (prefix: string) => printed.split("\n").find((l) => l.startsWith(prefix))!.slice(prefix.length).trim();
  const url = after("relay serving on ");
  const lookup = after("lookup serving on ");
  const admin = path.join(root, "admin.key");
  fs.writeFileSync(admin, `${"ab".repeat(32)}\n`);
  const id = JSON.parse(execFileSync(HIVE_NET, ["access", "voucher", "--kind", "enrol", "--admin", admin], { encoding: "utf8" })).by as string;
  const text = path.join(root, "profile.json");
  fs.writeFileSync(text, JSON.stringify({ v: 1, name: "Test network", relays: [{ url }], lookup, admin: id, local: { mdns: true } }));
  const signed = path.join(root, "signed.json");
  fs.writeFileSync(signed, execFileSync(HIVE_NET, ["profile", "sign", text, "--admin", admin]));
  return { url, lookup, link: execFileSync(HIVE_NET, ["profile", "link", signed], { encoding: "utf8" }).trim() };
}

test("a fresh install is on the local network; a network's link is used from then on, its relay and lookup server answer, and invites reach out through it", async () => {
  test.skip(!hiveNetBuilt(), "build hive-net first: cargo build in crates/hive-net");
  const { url, lookup, link } = await network();
  const page = await launch();
  /** The relay an invite from here names: where the app's network waits for others. */
  const inviteRelay = async (): Promise<string | null> => {
    const invite = await share(page, "view");
    const r = (JSON.parse(Buffer.from(invite.split("#")[1]!, "base64url").toString("utf8")) as { r: string | null }).r;
    return r ? r.replace(/\/$/, "") : null;
  };
  // On the local network the app's network runs, and names no server; Connect says its code works
  // here only, and reaching devices elsewhere asks for a way through, which can wait.
  expect(await inviteRelay()).toBeNull();
  await openConnect(page);
  await expect(page.locator("[data-connect-reach]")).toContainText("Works on this network only.");
  await page.locator("[data-connect-elsewhere]").click();
  await expect(page.locator("[data-reach-chooser]")).toBeVisible();
  await page.locator("[data-reach-not-now]").click();
  await expect(page.locator("[data-connect-page]")).toContainText("Stays on this network: the code works only here.");
  await page.keyboard.press("Escape");
  // A fresh install offers to set up a server first.
  await openSettings(page, "servers");
  await expect(page.locator("[data-network-name]")).toHaveText("Local network");
  await expect(page.locator("[data-relay]")).toHaveCount(0);
  await expect(page.locator("[data-servers-setup] [data-serve-with-agent]")).toBeVisible();

  // An agent puts this computer on the network: the open page shows it, already checked, and the
  // offer to set one up is gone.
  const used = hiveNetworkUse(link);
  expect(used.status, used.stderr).toBe(0);
  await expect(page.locator("[data-network-name]")).toHaveText("Test network", { timeout: 20_000 });
  await expect(page.locator(`[data-relay="${url}"]`)).toHaveAttribute("data-ok", "true", { timeout: 20_000 });
  await expect(page.locator(`[data-lookup="${lookup}"]`)).toHaveAttribute("data-ok", "true");
  await expect(page.locator("[data-servers-setup]")).toHaveCount(0);
  await page.keyboard.press("Escape");

  // The running network started again on it: an invite now names its relay.
  await expect.poll(inviteRelay, { timeout: 20_000 }).toBe(url.replace(/\/$/, ""));

  // Back to the local network, then the link pasted on the page.
  await openSettings(page, "servers");
  await page.locator("[data-network-change]").click();
  await page.locator('[data-use-network="local"]').click();
  await expect(page.locator("[data-network-name]")).toHaveText("Local network");
  await expect(page.locator("[data-servers-setup]")).toBeVisible();
  await page.locator("[data-network-change]").click();
  await page.locator("[data-network-link]").fill(link);
  await page.locator('[data-use-network="link"]').click();
  await expect(page.locator("[data-network-name]")).toHaveText("Test network");
  await expect(page.locator(`[data-relay="${url}"]`)).toHaveAttribute("data-ok", "true", { timeout: 20_000 });
});

test("with the update check off, nothing is asked: About says so, and its switch, the only one, turns it back on", async () => {
  const page = await launch({ HIVEMIND_TEST_UPDATE: JSON.stringify({ latest: "9999.1.0" }) }, { network: { updateCheck: false } });
  await openSettings(page, "about");
  const about = page.locator(".settings-dialog");
  await expect(about.locator("[data-update-off]")).toBeVisible();
  await expect(about.getByText(/Update available/)).toHaveCount(0);
  await about.locator("[data-update-check]").click();
  await expect(about.getByText(/Update available — v9999\.1\.0/)).toBeVisible();

  await about.locator("[data-update-check]").click();
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(root, "config", "settings.json"), "utf8")).network).toEqual({ updateCheck: false });
  await page.locator('[data-settings-page="servers"]').click();
  await expect(page.locator("[data-network]")).toBeVisible();
  await expect(page.locator("[data-update-check]")).toHaveCount(0);
});
