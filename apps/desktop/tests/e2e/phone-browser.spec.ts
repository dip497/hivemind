// A browser pairs as a phone does (docs/design/phone-browser-2026-10-03.md, B1 and B2): the
// computer, on a network of its own, offers its link (Settings → Devices → Pair a phone); a page
// running hive-web (crates/hive-web: the phone's Rust core in wasm) gets onto that network as the
// link says, pairs with the computer through the network's relay, and is listed there as the
// person's phone. It follows the computer's agents, what waits on the person and each agent's
// state, live; reopened, it is the same device, still paired; unpaired on the computer, it is
// refused.
import { test, expect, chromium, type Browser, type ElectronApplication } from "@playwright/test";
import { execSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { hiveNetBuilt, ownNetwork, person } from "./helpers/multiplayer";
import { offerPhonePairing, probeAgent, startProbe } from "./helpers/phone";
import { stopDaemons } from "./helpers/daemons";

const WWW = path.resolve("../../crates/hive-web/www");
const hiveWebBuilt = () => fs.existsSync(path.join(WWW, "pkg", "hive_web_bg.wasm"));

let root: string;
let browser: Browser | undefined;
const apps: ElectronApplication[] = [];
const procs: ChildProcess[] = [];
const servers: http.Server[] = [];
test.beforeEach(() => { root = fs.mkdtempSync("/tmp/hm-browser-"); });
test.afterEach(async () => {
  await browser?.close();
  browser = undefined;
  for (const s of servers.splice(0)) s.close();
  for (const p of procs.splice(0)) p.kill("SIGKILL");
  for (const a of apps.splice(0)) await a.close();
  stopDaemons(root);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** hive-web's pages, served as any static host would: where. */
async function servePages(): Promise<string> {
  const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm" };
  const server = http.createServer((req, res) => {
    const file = path.join(WWW, path.normalize(new URL(req.url!, "http://x").pathname));
    if (!file.startsWith(WWW) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test("a browser pairs with the computer through its network's relay, as the person's phone, and follows its agents live: what waits on the person, and each one's state as it changes; reopened, it is the same device, still paired; unpaired on the computer, it is refused", async () => {
  test.skip(!hiveNetBuilt() || !hiveWebBuilt(), "build hive-net (cargo build in crates/hive-net) and hive-web (crates/hive-web/build.sh) first");
  test.setTimeout(150_000);
  const net = await ownNetwork(root, procs, "closed");
  const repo = path.join(root, "api");
  fs.mkdirSync(repo);
  execSync("git init -q", { cwd: repo });
  const desktop = await person(root, "desktop", repo, apps, probeAgent(root));
  expect(await desktop.evaluate((l) => window.hive.useNetwork(l), net.link)).toMatchObject({ admission: "enrolled" });
  const me = await desktop.evaluate(() => window.hive.identity());
  const link = await offerPhonePairing(desktop);

  // The link opened in a browser: it pairs, let onto the network with the voucher the link carries.
  browser = await chromium.launch();
  const page = await browser.newPage();
  const pages = await servePages();
  await page.goto(`${pages}/pair.html#pair=${encodeURIComponent(link)}&name=${encodeURIComponent("Priya's browser")}`);
  await expect(page.locator("[data-paired]")).toHaveAttribute("data-paired", me.deviceId, { timeout: 30_000 });
  const id = (await page.locator("[data-id]").getAttribute("data-id"))!;
  expect(await page.evaluate(() => (window as unknown as { phone: { paired: unknown } }).phone.paired)).toMatchObject({
    with: { device: me.deviceId, kind: "app" },
    certificate: { person: me.personId, device: id },
    admission: "vouched for by the app",
  });
  expect(await (await fetch(`${net.access}/allowed/${id}`)).text()).toBe("true");
  // The code, a secret, is gone from the page's address once read.
  expect(new URL(page.url()).hash).toBe("");
  // The computer lists it as the person's phone.
  await expect(desktop.locator(`[data-device="${id}"][data-device-kind="phone"]`)).toContainText("Priya's browser", { timeout: 10_000 });
  await desktop.keyboard.press("Escape");

  // An agent on the computer begins waiting on the person: the page lists it, and what it waits for.
  const tile = await startProbe(desktop);
  const agent = page.locator(`[data-agent="${tile}"]`);
  await expect(agent).toHaveAttribute("data-state", "waiting", { timeout: 30_000 });
  await expect(page.locator(`[data-need="${tile}"]`)).toHaveAttribute("data-kind", "permission");
  // Asked outright, as the phone asks: the same wait, one the computer can allow or deny.
  const asked = await page.evaluate(async () => {
    const host = await (window as unknown as { phone: { reach(): Promise<{ needs(): Promise<unknown>; close(): Promise<void> }> } }).phone.reach();
    try { return await host.needs(); } finally { await host.close(); }
  });
  expect(asked).toMatchObject({ needs: [{ tile, kind: "permission", decide: true, name: "api" }], working: 0 });

  // Answered on the computer: it works, and the page shows it as it changes.
  await desktop.evaluate((t) => window.hive.ptyWrite(t, "y\r"), `hm:${tile}`);
  await expect(agent).toHaveAttribute("data-state", "working", { timeout: 30_000 });
  await expect(page.locator("[data-need]")).toHaveCount(0);
  await expect(page.locator("[data-working]")).toHaveText("1 at work");

  // Reopened: the same device, still paired, without the code.
  await page.reload();
  await expect(page.locator("[data-id]")).toHaveAttribute("data-id", id);
  await expect(agent).toHaveAttribute("data-state", "working", { timeout: 30_000 });

  // Unpaired on the computer: refused from then on.
  await desktop.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: "devices" } })));
  await desktop.locator(`[data-device="${id}"] [data-unpair]`).click();
  await expect(desktop.locator(`[data-device="${id}"]`)).toHaveCount(0);
  await page.reload();
  await expect(page.locator("[data-error]")).toContainText("not admitted", { timeout: 30_000 });
  await expect(page.locator("[data-agent]")).toHaveCount(0);
});
