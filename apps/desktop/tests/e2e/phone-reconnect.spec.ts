// A paired phone page comes back by itself. The computer's network process killed under it, the app
// starts it again, with no page opened on the computer. A connection lost under a terminal or a chat
// is not their end: they carry on once the computer is reached. Coming back to the page, a dead
// connection is noticed in seconds, not half a minute. It says whether the server or the computer
// is what does not answer. And a phone away keeps its way onto the network's relay.
import { test, expect, chromium, type Browser, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync, execSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { HIVE_NET, hiveNetBuilt, ownNetwork, person } from "./helpers/multiplayer";
import { connectPage, offerToConnect, talkerAgent } from "./helpers/phone";
import { stopDaemons } from "./helpers/daemons";

const WWW = path.resolve("../../crates/hive-web/www");
const hiveWebBuilt = () => fs.existsSync(path.join(WWW, "pkg", "hive_web_bg.wasm")) && fs.existsSync(path.join(WWW, "main.js"));

let root: string;
let browser: Browser | undefined;
const apps: ElectronApplication[] = [];
const procs: ChildProcess[] = [];
test.beforeEach(() => { root = fs.mkdtempSync("/tmp/hm-reconnect-"); });
test.afterEach(async () => {
  await browser?.close();
  browser = undefined;
  for (const p of procs.splice(0)) p.kill("SIGKILL");
  for (const a of apps.splice(0)) await a.close();
  stopDaemons(root);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** The running `hive-net daemon` of this test's app, by its pid. */
function networkProcess(): number | null {
  for (const pid of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    let argv: string[];
    try { argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0"); } catch { continue; }
    if (argv[1] === "daemon" && argv.some((a) => a.startsWith(root + path.sep))) return Number(pid);
  }
  return null;
}

/** The person's computer on a network of its own, and a phone page paired with it, connected;
 *  `silence(true)` cuts the page off from the relay without closing anything, as a phone's lost
 *  network does. */
async function paired(more: Record<string, string> = {}): Promise<{ desktop: Page; page: Page; net: Awaited<ReturnType<typeof ownNetwork>>; repo: string; home: string; me: { deviceId: string; personId: string }; phone: string; silence(on: boolean): void; status(): Promise<string | null> }> {
  const net = await ownNetwork(root, procs, "closed", WWW);
  const repo = path.join(root, "api");
  fs.mkdirSync(repo);
  execSync("git init -q", { cwd: repo });
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  for (const rc of [".bashrc", ".bash_profile"]) fs.writeFileSync(path.join(home, rc), "PS1='$ '\n");
  const desktop = await person(root, "desktop", repo, apps, { HOME: home, SHELL: "/bin/bash", HIVEMIND_SHELL_ENV: "0", HISTFILE: "/dev/null", ...more });
  expect(await desktop.evaluate((l) => window.hive.useNetwork(l), net.link)).toMatchObject({ admission: "enrolled" });
  const me = await desktop.evaluate(() => window.hive.identity());
  const link = await offerToConnect(desktop, true);
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  let silent = false;
  await context.routeWebSocket(/\/relay/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => { if (!silent) server.send(m); });
    server.onMessage((m) => { if (!silent) ws.send(m); });
  });
  await page.goto(link);
  const phone = (await page.locator("[data-id]").getAttribute("data-id", { timeout: 30_000 }))!;
  await connectPage(page, desktop);
  await expect(page.locator("[data-paired]")).toHaveAttribute("data-paired", me.deviceId, { timeout: 30_000 });
  await desktop.keyboard.press("Escape");
  const status = () => page.locator(`[data-computer="${me.deviceId}"] .status`).textContent();
  await expect.poll(status, { timeout: 60_000 }).toBe("connected");
  return { desktop, page, net, repo, home, me, phone, silence: (on) => { silent = on; }, status };
}

test("hive-net killed under a live phone page: the app starts it again by itself, and the page is connected again with nothing opened on the computer", async () => {
  test.skip(!hiveNetBuilt() || !hiveWebBuilt(), "build hive-net (cargo build in crates/hive-net) and the page (crates/hive-web/build.sh) first");
  test.setTimeout(240_000);
  const { desktop, page, status } = await paired();
  const was = networkProcess()!;
  process.kill(was, "SIGKILL");
  await expect.poll(() => networkProcess(), { timeout: 30_000 }).not.toBe(null);
  expect(networkProcess()).not.toBe(was);
  // What happens on the computer from now on reaches the page: its connection is to the new one.
  await desktop.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await expect(page.locator(`[data-tree] [data-row][data-kind="shell"]`)).toHaveCount(1, { timeout: 90_000 });
  expect(await status()).toBe("connected");
});

test("a connection lost under a terminal and a chat on the page is no end of them: nothing says it ended, and each carries on once the computer is reached", async () => {
  test.skip(!hiveNetBuilt() || !hiveWebBuilt(), "build hive-net (cargo build in crates/hive-net) and the page (crates/hive-web/build.sh) first");
  test.setTimeout(420_000);
  const { desktop, page, silence, status } = await paired(talkerAgent(root));
  const lost = async () => {
    silence(true);
    await expect.poll(status, { timeout: 60_000 }).not.toBe("connected");
    silence(false);
    await expect.poll(status, { timeout: 90_000 }).toBe("connected");
  };

  await desktop.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  const row = page.locator(`[data-tree] [data-row][data-kind="shell"]`);
  await expect(row).toHaveCount(1, { timeout: 30_000 });
  await row.click();
  const screen = page.locator('[data-screen="terminal"]');
  const lines = async () => (await screen.locator("[data-term-text] > div").allTextContents()).join("\n");
  await expect.poll(lines, { timeout: 30_000 }).toContain("$");
  await lost();
  await expect(screen.locator("[data-term-ended]")).toBeHidden();
  await screen.locator(".term-view").tap();
  await page.keyboard.type("echo back-$((6*7))\n");
  await expect.poll(lines, { timeout: 20_000 }).toContain("back-42");
  await page.locator("[data-back]:visible").click();

  await desktop.evaluate(() => window.hive.settingsSet("agents.defaultAgent", "talker"));
  await desktop.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:shortcut", { detail: "agent" })));
  const talker = desktop.locator('.react-flow__node-terminal:not([data-id="' + (await desktop.locator(".react-flow__node-terminal").first().getAttribute("data-id")) + '"])');
  await expect(talker).toHaveCount(1, { timeout: 20_000 });
  const tile = (await talker.getAttribute("data-id"))!;
  await page.locator(`[data-agent="${tile}"]`).first().click({ timeout: 30_000 });
  const box = page.locator("[data-message] textarea");
  const say = async (text: string) => {
    await box.fill(text);
    await page.locator("[data-message] button[type=submit]").click();
    await expect(page.locator('[data-chat] [data-who="person"]', { hasText: text })).toBeVisible({ timeout: 30_000 });
  };
  await say("before");
  await lost();
  await expect(page.locator("[data-chat] .ended:visible")).toHaveCount(0);
  await say("after");
  await expect(page.locator('[data-chat] [data-who="agent"]', { hasText: "after" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("[data-chat] .ended:visible")).toHaveCount(0);
});

test("coming back to the page, a dead connection is noticed in seconds, and the page says it is the way to the server that does not answer", async () => {
  test.skip(!hiveNetBuilt() || !hiveWebBuilt(), "build hive-net (cargo build in crates/hive-net) and the page (crates/hive-web/build.sh) first");
  test.setTimeout(240_000);
  const { page, silence, status } = await paired();
  // A connection that still answers is kept, through the check.
  await page.evaluate(() => {
    const c = document.querySelector("[data-computer] .status")!;
    (window as unknown as { leftConnected: boolean }).leftConnected = false;
    new MutationObserver(() => { if (c.textContent !== "connected") (window as unknown as { leftConnected: boolean }).leftConnected = true; }).observe(c, { characterData: true, childList: true, subtree: true });
    window.dispatchEvent(new Event("online"));
  });
  await page.waitForTimeout(10_000);
  expect(await page.evaluate(() => (window as unknown as { leftConnected: boolean }).leftConnected)).toBe(false);
  expect(await status()).toBe("connected");

  silence(true);
  // The network is back, as the browser tells the page: half a minute early, what it knows is stale.
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  const told = Date.now();
  await expect.poll(status, { timeout: 15_000 }).not.toBe("connected");
  expect(Date.now() - told).toBeLessThan(15_000);
  await expect(page.locator("[data-error]")).toContainText("this phone cannot reach your server", { timeout: 60_000 });
  silence(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(status, { timeout: 60_000 }).toBe("connected");
  await expect(page.locator("[data-error]")).toBeHidden();
});

test("the computer not answering while the server does: the page says the server answers, and asks whether the computer is awake", async () => {
  test.skip(!hiveNetBuilt() || !hiveWebBuilt(), "build hive-net (cargo build in crates/hive-net) and the page (crates/hive-web/build.sh) first");
  test.setTimeout(240_000);
  const { page, status } = await paired();
  const asleep = networkProcess()!;
  process.kill(asleep, "SIGSTOP");
  try {
    await expect(page.locator("[data-error]")).toContainText("Your server answers this phone: is the computer awake and online?", { timeout: 90_000 });
  } finally {
    process.kill(asleep, "SIGCONT");
  }
  await expect.poll(status, { timeout: 90_000 }).toBe("connected");
});

test("a phone's way onto a closed network's relay is renewed by the computer while the phone is away", async () => {
  test.skip(!hiveNetBuilt() || !hiveWebBuilt(), "build hive-net (cargo build in crates/hive-net) and the page (crates/hive-web/build.sh) first");
  test.setTimeout(240_000);
  const { page, net, phone, repo, home } = await paired();
  await page.close();
  const allowed = async () => (await fetch(`${net.access}/allowed/${phone}`)).text();
  expect(await allowed()).toBe("true");
  // The app quit, and the phone's visit lapses, as it does after a month away.
  await apps.splice(0)[0]!.close();
  execFileSync(HIVE_NET, ["access", "revoke", net.access, phone, "--identity", path.join(root, "desktop", "hivemind-dev", "identity")]);
  expect(await allowed()).toBe("false");
  // Started again, with the phone nowhere: only the computer can say so.
  await person(root, "desktop", repo, apps, { HOME: home, SHELL: "/bin/bash", HIVEMIND_SHELL_ENV: "0", HISTFILE: "/dev/null" });
  await expect.poll(allowed, { timeout: 60_000 }).toBe("true");
});
