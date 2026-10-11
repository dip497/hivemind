// The phone in a browser (docs/design/phone-browser-2026-10-03.md, B1 to B3): the computer, on a
// network of its own whose server also serves the phone page (`hive-net serve --phone`), offers its
// pairing link inside the page's address (Settings → Devices → Pair a phone); a phone-sized browser
// opens it, gets onto the network with the voucher the link carries, pairs with the computer
// through the network's relay, and is listed there as the person's phone. It is the phone app: what
// waits on the person, answered from there; every agent, live; one agent's chat, and a message
// sent to it. The computer sees both, done by that device. Reopened with no network, it shows what
// it last knew at once; unpaired on the computer, it is refused.
import { test, expect, chromium, type Browser, type ElectronApplication } from "@playwright/test";
import { execSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { hiveNetBuilt, ownNetwork, person } from "./helpers/multiplayer";
import { offerPhonePairing, probeAgent, startProbe, talkerAgent } from "./helpers/phone";
import { stopDaemons } from "./helpers/daemons";

const WWW = path.resolve("../../crates/hive-web/www");
const hiveWebBuilt = () => fs.existsSync(path.join(WWW, "pkg", "hive_web_bg.wasm")) && fs.existsSync(path.join(WWW, "js", "main.js"));

let root: string;
let browser: Browser | undefined;
const apps: ElectronApplication[] = [];
const procs: ChildProcess[] = [];
test.beforeEach(() => { root = fs.mkdtempSync("/tmp/hm-browser-"); });
test.afterEach(async () => {
  await browser?.close();
  browser = undefined;
  for (const p of procs.splice(0)) p.kill("SIGKILL");
  for (const a of apps.splice(0)) await a.close();
  stopDaemons(root);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test("a phone's browser opens the page the computer's QR code names and pairs through the network's relay, as the person's phone; it answers what waits on the person and sends an agent a message, and the computer does both, as that device; reopened offline it shows what it last knew; unpaired on the computer, it is refused", async ({}, testInfo) => {
  test.skip(!hiveNetBuilt() || !hiveWebBuilt(), "build hive-net (cargo build in crates/hive-net) and the page (crates/hive-web/build.sh) first");
  test.setTimeout(240_000);
  const net = await ownNetwork(root, procs, "closed", WWW);
  const repo = path.join(root, "api");
  fs.mkdirSync(repo);
  execSync("git init -q", { cwd: repo });
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const desktop = await person(root, "desktop", repo, apps, { ...probeAgent(root), ...talkerAgent(root), HOME: home });
  expect(await desktop.evaluate((l) => window.hive.useNetwork(l), net.link)).toMatchObject({ admission: "enrolled" });
  const me = await desktop.evaluate(() => window.hive.identity());
  const audit = () => fs.readFileSync(path.join(root, "desktop", "hivemind-dev", "audit.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

  // The QR code is the page's address on the network's own server, the link in its fragment.
  const link = await offerPhonePairing(desktop);
  expect(link.startsWith(`${net.relay}/phone/#pair=hivemind://pair/`), link).toBe(true);

  // Opened on a phone: it pairs, let onto the network with the voucher the link carries.
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: "dark" });
  const page = await context.newPage();
  await page.goto(`${link}&name=${encodeURIComponent("Priya's phone")}`);
  await expect(page.locator("[data-paired]")).toHaveAttribute("data-paired", me.deviceId, { timeout: 30_000 });
  const id = (await page.locator("[data-id]").getAttribute("data-id"))!;
  const kept = await page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open("hive-web");
    open.onsuccess = () => { const get = open.result.transaction("kept").objectStore("kept").get("paired"); get.onsuccess = () => resolve(get.result); get.onerror = reject; };
    open.onerror = reject;
  }));
  expect(kept).toMatchObject({ with: { device: me.deviceId, kind: "app" }, certificate: { person: me.personId, device: id }, admission: "vouched for by the app" });
  expect(await (await fetch(`${net.access}/allowed/${id}`)).text()).toBe("true");
  // The code, a secret, is gone from the page's address once read.
  expect(page.url()).not.toContain("pair");
  await expect(desktop.locator(`[data-device="${id}"][data-device-kind="phone"]`)).toContainText("Priya's phone", { timeout: 10_000 });
  await desktop.keyboard.press("Escape");

  // An agent on the computer begins waiting on the person: Needs you shows it, with its answers.
  const tile = await startProbe(desktop);
  const need = page.locator(`[data-need="${tile}"]`);
  await expect(need).toHaveAttribute("data-kind", "permission", { timeout: 30_000 });
  await expect(page.locator("[data-tab-dot]")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("needs.png") });

  // Reopened with no network (offline, and the relay's WebSocket refused, which offline alone does
  // not stop): the same device, still paired, and what waited, shown from what the page kept.
  let away = true;
  await context.routeWebSocket(/./, (ws) => (away ? ws.close() : ws.connectToServer()));
  await context.setOffline(true);
  // When the card is put on screen, since the page was asked for, on a CPU a quarter as fast (a
  // mid phone's): measured, not held to the 500 ms budget on a shared machine.
  await context.addInitScript(() => new MutationObserver((_, o) => {
    if (!document.querySelector("[data-need]")) return;
    (window as unknown as { shown: number }).shown = performance.now();
    o.disconnect();
  }).observe(document, { childList: true, subtree: true }));
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page.reload();
  await expect(need).toBeVisible();
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  console.log(`first screen from what the page kept, offline, CPU 4x slower: ${(await page.evaluate(() => (window as unknown as { shown: number }).shown)).toFixed(0)} ms`);
  await expect(page.locator("[data-id]")).toHaveAttribute("data-id", id);
  await expect(page.locator("[data-error]")).toContainText("is not reached", { timeout: 30_000 });
  away = false;
  await context.setOffline(false);
  await expect(page.locator("[data-error]")).toBeHidden({ timeout: 30_000 });

  // Allowed from the browser: the computer answers the agent as that device did, and it works.
  await need.locator('[data-answer="allow"]').click();
  await expect(page.locator(`[data-agent="${tile}"]`)).toHaveAttribute("data-state", "working", { timeout: 30_000 });
  await expect.poll(audit, { timeout: 10_000 }).toContainEqual(expect.objectContaining({ verb: "agent.answer", outcome: "ok", actor: expect.objectContaining({ kind: "peer", device: id }) }));
  await expect(page.locator("[data-need]")).toHaveCount(0);
  await expect(page.locator("[data-working]")).toHaveText("Nothing needs you. 1 agent working.");

  // Another agent, one that keeps a conversation: listed under the computer and its workspace.
  await desktop.evaluate(() => window.hive.settingsSet("agents.defaultAgent", "talker"));
  await desktop.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:shortcut", { detail: "agent" })));
  await expect(desktop.locator(".react-flow__node-terminal")).toHaveCount(2, { timeout: 20_000 });
  const talker = (await desktop.locator(".react-flow__node-terminal").evaluateAll((els) => els.map((e) => e.getAttribute("data-id")))).find((t) => t !== tile)!;
  await page.locator('[data-tab="agents"]').click();
  await expect(page.locator(`[data-agent="${talker}"]`)).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: testInfo.outputPath("agents.png") });

  // Opened, and sent a message: the computer types it in as that device sent it, the agent hears
  // it, and the chat shows what each said.
  await page.locator(`[data-agent="${talker}"]`).click();
  await page.locator("[data-message] textarea").fill("fix the login redirect");
  await page.locator("[data-message] button[type=submit]").click();
  await expect.poll(audit, { timeout: 20_000 }).toContainEqual(expect.objectContaining({ verb: "agent.send", outcome: "ok", actor: expect.objectContaining({ kind: "peer", device: id }) }));
  const talk = path.join(home, "talk");
  await expect.poll(() => fs.existsSync(talk) && fs.readdirSync(talk).map((f) => fs.readFileSync(path.join(talk, f), "utf8")).join(""), { timeout: 20_000 }).toContain("fix the login redirect");
  await expect(page.locator('[data-chat] [data-who="person"]')).toHaveText(["fix the login redirect"], { timeout: 30_000 });
  await expect(page.locator('[data-chat] [data-who="agent"]')).toHaveText(["You said fix the login redirect"]);
  await expect(page.locator("[data-message] textarea")).toHaveValue("");
  await page.screenshot({ path: testInfo.outputPath("agent.png") });

  // Unpaired on the computer: refused from then on.
  await desktop.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: "devices" } })));
  await desktop.locator(`[data-device="${id}"] [data-unpair]`).click();
  await expect(desktop.locator(`[data-device="${id}"]`)).toHaveCount(0);
  await page.reload();
  await expect(page.locator("[data-error]")).toContainText("not admitted", { timeout: 30_000 });
});
