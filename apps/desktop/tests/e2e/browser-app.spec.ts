// Settings → Devices, "Open in a browser": the app serves itself to a browser tab on 127.0.0.1, and
// the tab is the app — its canvas, a shell typed into and its echo — over the link the page shows.
// Without that link's key the port gives nothing.
import { test, expect, chromium, type Browser, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { freePort, launchWindow, type AppWindow } from "./helpers/window";

let app: AppWindow;
let browser: Browser;
const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hm-browser-app-")));
let port = 0;
let link = "";

test.beforeAll(async () => {
  execFileSync("git", ["init", "-q"], { cwd: repo });
  app = await launchWindow({ cwd: repo, args: [`--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), "hm-browser-app-ud-"))}`] });
  await app.page.waitForSelector(".react-flow", { timeout: 30_000 });
  browser = await chromium.launch(process.env.HIVE_HARNESS_CHROMIUM ? { executablePath: process.env.HIVE_HARNESS_CHROMIUM } : {});
  port = await freePort();
});
test.afterAll(async () => {
  await browser?.close();
  await app?.close();
  fs.rmSync(repo, { recursive: true, force: true });
});

const tab = (): Promise<Page> => browser.newPage({ viewport: { width: 1600, height: 1000 } });

test("off until the person turns it on, then the page shows its link with the key left out", async () => {
  const desktop = app.page;
  await desktop.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: "devices" } })));
  const section = desktop.locator("[data-browser-app]");
  await section.locator("#browser-app-port").fill(String(port));
  await section.locator("#browser-app-port").press("Enter");
  await expect.poll(() => desktop.evaluate(() => window.hive.settingsSync().browserApp.port)).toBe(port);
  await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();

  await section.getByRole("switch", { name: "Serve the app to a browser" }).click();
  const shown = section.locator("[data-browser-app-url]");
  await expect(shown).toHaveText(`http://127.0.0.1:${port}/#token=…`);
  link = (await section.locator("[data-browser-app-open]").getAttribute("href"))!;
  expect(link).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/#token=[A-Za-z0-9_-]{43}$`));
});

test("without the link's key the port gives nothing: not the app's page, its code or its socket", async () => {
  const page = await fetch(`http://127.0.0.1:${port}/`);
  expect(page.status).toBe(401);
  expect(await page.text()).not.toContain("<script type=\"module\"");
  expect((await fetch(`http://127.0.0.1:${port}/browser.html`)).status).toBe(401);

  const stranger = await tab();
  await stranger.goto(`http://127.0.0.1:${port}/#token=${"x".repeat(43)}`);
  await expect(stranger.getByText("This link is from before the app last started")).toBeVisible();
  await expect(stranger.locator(".react-flow")).toHaveCount(0);
  await stranger.close();
});

test("the link opens the app in the tab: its canvas, a shell typed into, and what the shell prints", async () => {
  const page = await tab();
  await page.goto(link);
  await page.waitForSelector(".react-flow", { timeout: 30_000 });
  // The key leaves the address bar and the history as soon as the page has it.
  expect(page.url()).toBe(`http://127.0.0.1:${port}/`);

  await page.locator('[data-toolbar-action="board"]').click();
  await page.locator('[data-board-choice="tile:shell"]').click();
  const term = page.locator(".react-flow__node-terminal").first();
  await expect(term).toHaveCount(1);
  await term.locator(".xterm-screen").click();
  const marker = path.join(repo, "from-the-tab.txt");
  await expect.poll(async () => {
    await page.keyboard.type(`echo from-the-tab-$((6*7)) > ${marker}\n`);
    return fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim() : "";
  }, { timeout: 20_000, intervals: [500] }).toBe("from-the-tab-42");
  await page.keyboard.type("echo printed-$((20+22))\n");
  const screen = () => term.evaluate((el) => {
    const host = [el, ...el.querySelectorAll("*")].find((e) => "__hmScreen" in e) as (Element & { __hmScreen(): string }) | undefined;
    return host?.__hmScreen() ?? "";
  });
  await expect.poll(screen, { timeout: 10_000 }).toContain("printed-42");
  await page.close();
});

test("turned off, the port closes", async () => {
  await app.page.locator("[data-browser-app]").getByRole("switch", { name: "Serve the app to a browser" }).click();
  await expect.poll(() => fetch(`http://127.0.0.1:${port}/`).then(() => "open", () => "closed")).toBe("closed");
});
