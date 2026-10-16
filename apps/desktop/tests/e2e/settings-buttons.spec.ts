// Settings, every page and a plugin's page of each kind: a button is as wide as its label, never
// stretched across the page; and a field's focus ring is the selection colour, not the person's
// brand colour, whatever that is.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { HIVE_NET, hiveNetBuilt } from "./helpers/multiplayer";
import { seedAgents } from "./helpers/agents";

let app: ElectronApplication;
let page: Page;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-settings-buttons-"));

test.beforeAll(async () => {
  const xdg = path.join(root, "config");
  seedAgents(xdg);
  const repo = path.join(root, "api");
  execFileSync("git", ["init", "-q", repo]);
  const env = { ...process.env, XDG_CONFIG_HOME: xdg, HIVEMIND_SHELL_ENV: "0", ...(hiveNetBuilt() ? { HIVEMIND_HIVE_NET: HIVE_NET } : {}) } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.resolve("out/main/index.js"), "--no-sandbox", `--user-data-dir=${path.join(root, "ud")}`], cwd: repo, env });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow");
});

test.afterAll(async () => { await app?.close(); fs.rmSync(root, { recursive: true, force: true }); });

const open = (id: string) => page.evaluate((p) => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: p } })), id);

/** Each button shown on the open page: its width, and its width when its column does not stretch
 *  it (its label and padding, or the size it is given). */
const stretched = () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-settings-body] [data-slot="button"]')]
  .filter((b) => b.getClientRects().length > 0)
  .map((b) => {
    const shown = b.getBoundingClientRect().width;
    const was = b.style.alignSelf;
    b.style.alignSelf = "start";
    const own = b.getBoundingClientRect().width;
    b.style.alignSelf = was;
    return { label: (b.textContent || b.getAttribute("aria-label") || "").trim(), shown: Math.round(shown), own: Math.round(own) };
  }));

/** What `read` gives once two reads a moment apart agree: the page has drawn what it loads. */
async function settled<T>(read: () => Promise<T>): Promise<T> {
  let last = JSON.stringify(await read());
  for (;;) {
    await page.waitForTimeout(300);
    const now = await read();
    if (JSON.stringify(now) === last) return now;
    last = JSON.stringify(now);
  }
}

test("no button on any Settings page is wider than its label", async () => {
  await open("profile");
  const ids = await page.locator("[data-settings-page]").evaluateAll((items) => items.map((i) => i.getAttribute("data-settings-page")!));
  expect(ids.length).toBeGreaterThan(5);
  const wide: string[] = [];
  const check = async (where: string) => {
    for (const b of await settled(stretched)) if (b.shown > b.own + 1) wide.push(`${where}: "${b.label}" ${b.shown}px, its label ${b.own}px`);
  };
  for (const id of ids) {
    await open(id);
    await expect(page.locator(`[data-settings-page="${id}"]`)).toHaveAttribute("aria-current", "page");
    await check(id);
  }
  // A plugin's own page, one of each kind.
  for (const kind of ["agent", "view", "widget", "tool"]) {
    await open("plugins");
    const first = page.locator(`[data-plugins-kind="${kind}"] [data-plugin-open]`).first();
    await expect(first).toBeVisible();
    const name = await first.getAttribute("data-plugin-open");
    await first.click();
    await expect(page.locator("[data-plugins-home]")).toHaveCount(0);
    await check(`plugin ${name}`);
  }
  expect(wide).toEqual([]);
});

test("a field's focus ring is the selection colour, not the brand colour", async () => {
  await page.evaluate(() => window.hive.settingsSet("appearance.accent", "amber"));
  await open("browser");
  const more = page.locator("[data-browser-app-more] summary");
  await more.click();
  const expiry = page.locator("#browser-app-port");
  await expect(expiry).toBeVisible();
  await more.focus();
  await page.keyboard.press("Tab");
  await expect(expiry).toBeFocused();
  const [ring, select] = await expiry.evaluate((el) => {
    const probe = document.createElement("i");
    probe.style.color = "var(--color-select)";
    el.parentElement!.append(probe);
    const want = getComputedStyle(probe).color;
    probe.remove();
    return [getComputedStyle(el).outlineColor, want];
  });
  expect(ring).toBe(select);
});
