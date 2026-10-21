// The phone page with several computers and accounts (docs/design/phone-browser-2026-10-03.md):
// paired with one of the person's two computers, it reaches the other too, as the first tells of
// it, and Home shows what waits on the person on both. Paired with someone else's computer as well,
// it keeps both accounts, one shown at a time, and a chip switches between them. Forgetting the one
// shown leaves the other paired.
import { test, expect, chromium, type Browser, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync, execSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { HIVE_NET, hiveNetBuilt, ownNetwork, person } from "./helpers/multiplayer";
import { connectPage, itsMe, offerToConnect, probeAgent, startProbe } from "./helpers/phone";
import { stopDaemons } from "./helpers/daemons";

const WWW = path.resolve("../../crates/hive-web/www");
const hiveWebBuilt = () => fs.existsSync(path.join(WWW, "pkg", "hive_web_bg.wasm")) && fs.existsSync(path.join(WWW, "main.js"));

let root: string;
let browser: Browser | undefined;
const apps: ElectronApplication[] = [];
const procs: ChildProcess[] = [];
test.beforeEach(() => { root = fs.mkdtempSync("/tmp/hm-accounts-"); });
test.afterEach(async () => {
  await browser?.close();
  browser = undefined;
  for (const p of procs.splice(0)) p.kill("SIGKILL");
  for (const a of apps.splice(0)) await a.close();
  stopDaemons(root);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const repo = (name: string) => {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  execSync("git init -q", { cwd: dir });
  return dir;
};

/** `link` with an enrolment voucher of its own, for one more computer. */
function enrolAnother(link: string): string {
  const voucher = JSON.parse(execFileSync(HIVE_NET, ["access", "voucher", "--kind", "enrol", "--admin", path.join(root, "admin.key")], { encoding: "utf8" })) as object;
  const body = JSON.parse(Buffer.from(link.replace("hivemind://network/", ""), "base64url").toString()) as object;
  return `hivemind://network/${Buffer.from(JSON.stringify({ ...body, enrol: voucher })).toString("base64url")}`;
}

/** The phone page's link from `computer`'s offer, for a browser. */
const pageLink = (computer: Page) => offerToConnect(computer, true);

test("a phone's browser paired with one of the person's computers reaches the other as well and shows what waits on both; paired with someone else's computer too it keeps two accounts and switches between them; forgetting one leaves the other", async ({}, testInfo) => {
  test.skip(!hiveNetBuilt() || !hiveWebBuilt(), "build hive-net (cargo build in crates/hive-net) and the page (crates/hive-web/build.sh) first");
  test.setTimeout(300_000);
  const net = await ownNetwork(root, procs, "closed", WWW);
  const env = { ...probeAgent(root), HOME: path.join(root, "home") };
  fs.mkdirSync(env.HOME);
  fs.cpSync(path.join(root, "desktop", "hivemind", "agents"), path.join(root, "laptop", "hivemind", "agents"), { recursive: true });

  // The person's desktop, on the network, and their laptop, which becomes theirs through it.
  const desktop = await person(root, "desktop", repo("api"), apps, env);
  expect(await desktop.evaluate((l) => window.hive.useNetwork(l), net.link)).toMatchObject({ admission: "enrolled" });
  const me = await desktop.evaluate(() => window.hive.identity());
  const laptop = await person(root, "laptop", repo("notes"), apps, env);
  // On the network too: a browser reaches a computer only through its relay.
  expect(await laptop.evaluate((l) => window.hive.useNetwork(l), enrolAnother(net.link))).toMatchObject({ admission: "enrolled" });
  const { link: joining } = await desktop.evaluate(() => window.hive.connectOffer(null));
  const entered = laptop.evaluate((l) => window.hive.connectEnter(l), joining);
  await itsMe(desktop);
  await expect.poll(() => laptop.evaluate(() => window.hive.connectSure(true).then(() => true, () => false)), { timeout: 30_000 }).toBe(true);
  await entered;
  const laptopIs = await laptop.evaluate(() => window.hive.identity());
  expect(laptopIs.personId).toBe(me.personId);

  // A phone-sized browser pairs with the desktop.
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: "dark" });
  const page = await context.newPage();
  await page.goto(`${await pageLink(desktop)}&name=${encodeURIComponent("Priya's phone")}`);
  await connectPage(page, desktop);
  await expect(page.locator(`[data-paired="${me.deviceId}"]`)).toHaveCount(1, { timeout: 30_000 });
  await desktop.keyboard.press("Escape");

  // The desktop tells it of the laptop, which it reaches as the person's phone.
  await page.locator('[data-tab="devices"]').click();
  await expect(page.locator(`[data-computer="${laptopIs.deviceId}"] .status`)).toHaveText("connected", { timeout: 60_000 });
  await expect(page.locator(`[data-computer="${me.deviceId}"] .status`)).toHaveText("connected");

  // An agent on each begins waiting on the person: Home shows both.
  const onDesktop = await startProbe(desktop);
  const onLaptop = await startProbe(laptop);
  await page.locator('[data-tab="home"]').click();
  await expect(page.locator(`[data-need="${onDesktop}"]`)).toHaveAttribute("data-kind", "permission", { timeout: 30_000 });
  await expect(page.locator(`[data-need="${onLaptop}"]`)).toHaveAttribute("data-kind", "permission", { timeout: 30_000 });
  // Answered from the browser, the laptop's agent is answered on the laptop.
  await page.locator(`[data-need="${onLaptop}"] [data-answer="allow"]`).click();
  await expect(page.locator(`[data-agent="${onLaptop}"]`)).toHaveAttribute("data-state", "working", { timeout: 60_000 });
  await expect(page.locator(`[data-need="${onDesktop}"]`)).toBeVisible();
  await expect(page.locator("[data-home-accounts]")).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath("two-computers.png") });

  // Someone else's computer, on the same network: pairing with it adds an account; the person's
  // stays paired.
  const other = await person(root, "other", repo("shop"), apps);
  expect(await other.evaluate((l) => window.hive.useNetwork(l), enrolAnother(net.link))).toMatchObject({ admission: "enrolled" });
  const them = await other.evaluate(() => window.hive.identity());
  expect(them.personId).not.toBe(me.personId);
  await page.goto(await pageLink(other));
  await page.reload();
  await expect(page.locator("[data-pair-adds]")).toBeVisible({ timeout: 30_000 });
  await connectPage(page, other);
  await other.keyboard.press("Escape");
  await expect(page.locator('[data-screen="home"]')).toBeVisible({ timeout: 30_000 });
  const chips = page.locator("[data-home-accounts] .chip");
  await expect(chips).toHaveCount(2);
  await expect(chips.nth(1)).toHaveAttribute("aria-pressed", "true");
  // Their Home: none of the person's agents.
  await expect(page.locator(`[data-need="${onDesktop}"]`)).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator(`[data-agent="${onLaptop}"]`)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("other-account.png") });

  // Switched back: the person's two computers again, without pairing.
  await chips.nth(0).click();
  await expect(chips.nth(0)).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(`[data-need="${onDesktop}"]`)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(`[data-agent="${onLaptop}"]`)).toHaveAttribute("data-state", "working", { timeout: 30_000 });

  // Forgotten, the person's account goes, each of its computers told; the other stays and is shown.
  const listed = (w: Page, d: string) => w.evaluate((id) => window.hive.devices().then((all) => all.some((x: { device: string }) => x.device === id)), d);
  const id = (await page.locator("[data-id]").getAttribute("data-id"))!;
  expect(await listed(desktop, id)).toBe(true);
  await page.locator('[data-tab="devices"]').click();
  await expect(page.locator(`[data-account="${them.personId}"]`)).toBeVisible();
  await page.locator("[data-forget]").click();
  await page.locator("[data-forget-ask] [data-yes]").click();
  await expect.poll(() => listed(desktop, id), { timeout: 20_000 }).toBe(false);
  await expect(page.locator(`[data-paired="${them.deviceId}"]`)).toHaveCount(1, { timeout: 30_000 });
  await expect(page.locator("[data-home-accounts]")).toBeHidden();
  await page.reload();
  await expect(page.locator(`[data-paired="${them.deviceId}"]`)).toHaveCount(1, { timeout: 30_000 });
  // A key of its own for each person: their computer knows this browser by another id.
  await page.locator('[data-tab="devices"]').click();
  const theirs = (await page.locator("[data-id]").getAttribute("data-id"))!;
  expect(theirs).not.toBe(id);
  expect(await listed(other, theirs)).toBe(true);
});
