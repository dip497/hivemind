// Settings → Connect (docs/design/connect-2026-10-13.md §5.4): one line says what it is for; the offer
// comes first, then Have a code? Join, then who is connected, the people in this window's workspace
// shown without a click, with where it runs. The offer's QR code fills its box with the four-module
// margin a reader needs, opens as large as the window allows and closes with Esc, and a phone's
// camera frame of it reads back the link, by the phone page's own reader (crates/hive-web); it stays
// inside its box. Join closes Settings for the join form.
import { test, expect, _electron as electron, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { HIVE_NET, hiveNetBuilt, openConnect } from "./helpers/multiplayer";

const PKG = path.resolve("../../crates/hive-web/www/pkg");
const pageBuilt = (): boolean => fs.existsSync(path.join(PKG, "hive_web_bg.wasm"));

let app: ElectronApplication;
let page: Page;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-people-page-"));

test.beforeAll(async () => {
  test.skip(!hiveNetBuilt(), "build hive-net first: cargo build in crates/hive-net");
  const repo = path.join(root, "api");
  execFileSync("git", ["init", "-q", repo]);
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(root, "config"), HIVEMIND_HIVE_NET: HIVE_NET } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.resolve("out/main/index.js"), "--no-sandbox"], cwd: repo, env });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow");
  await page.evaluate(() => window.hive.settingsSet("profile.name", "Asha Rao"));
  await openConnect(page);
});

test.afterAll(async () => { await app?.close(); fs.rmSync(root, { recursive: true, force: true }); });

/** Where `a` is in the page relative to `b`: -1 before it, 1 after. */
async function order(a: Locator, b: Locator): Promise<number> {
  const other = await b.elementHandle();
  return a.evaluate((x, y) => (x.compareDocumentPosition(y!) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1), other);
}

test("one line says what it is for; the offer comes first, then Join, then who is connected, the people here shown without a click, with where it runs", async () => {
  await expect(page.locator("[data-connect-page] [data-page-lead]")).toHaveText("Another computer, a phone, or someone else uses this computer's offer; you say who they are when they do.");
  const [offer, join, connected] = [page.locator("[data-connect-offer]"), page.locator("[data-connect-join]"), page.locator("[data-connected]")];
  expect(await order(offer, join)).toBe(-1);
  expect(await order(join, connected)).toBe(-1);
  const access = page.locator("[data-share-access]");
  await expect(access.locator("[data-people-owner]")).toContainText("Asha Rao");
  await expect(access.locator("[data-people-owner]")).toContainText("Owner");
  await expect(access.locator("[data-people-none]")).toBeVisible();
  await expect(page.locator("[data-hosting-status]")).toHaveText("Runs on this computer; offline while it sleeps.");
  // With no host yet, Keep it running says how to get one.
  await page.locator("[data-keep-running]").click();
  await expect(page.locator("[data-hosting-how]")).toContainText("Run hive host pair on a server and enter the words it shows under Join.");
});

/** The pixels a locator shows, as the screen draws them, read in the page: rows of 0 (dark) / 1 (light). */
async function shown(target: Locator): Promise<{ w: number; h: number; light: (x: number, y: number) => boolean; png: string }> {
  const png = (await target.screenshot()).toString("base64");
  const { w, h, bits } = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    [c.width, c.height] = [img.width, img.height];
    const g = c.getContext("2d")!;
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let bits = "";
    for (let i = 0; i < d.length; i += 4) bits += d[i]! + d[i + 1]! + d[i + 2]! > 384 ? "1" : "0";
    return { w: c.width, h: c.height, bits };
  }, png);
  return { w, h, png, light: (x, y) => bits[y * w + x] === "1" };
}

/** A code's size in modules, each module's size in pixels, and its white margin on the left and the right in modules. */
async function measure(code: Locator) {
  const n = Number(await code.locator("svg").getAttribute("data-qr-modules"));
  const px = await shown(code.locator("svg"));
  // In CSS pixels, which are device pixels here; the shot of a box on a half pixel is one wider.
  const module = (await code.locator("svg").boundingBox())!.width / n;
  // Across the top finder patterns: dark first at the left one, last at the right one. A box on a
  // half pixel blends its outer column with the page behind it: that column is the margin's too.
  const y = Math.floor(7.5 * module);
  const inward = (at: (i: number) => boolean): number => {
    let i = 0;
    while (i < 2 && !at(i)) i++;
    while (i < px.w && at(i)) i++;
    return i;
  };
  const left = inward((i) => px.light(i, y));
  const right = inward((i) => px.light(px.w - 1 - i, y));
  return { n, module, left: left / module, right: right / module, png: px.png };
}

test("its QR code fills its box with a four-module margin, opens large and closes with Esc, and a phone's camera reads it", async () => {
  test.skip(!pageBuilt(), "no page build: run crates/hive-web/build.sh");
  await page.locator("[data-connect-offer]").click();
  const card = page.locator("[data-connect-qr]");
  await expect(card).toBeVisible({ timeout: 20_000 });
  const link = (await page.locator("[data-connect-copy]").getAttribute("title"))!;
  const small = await measure(card);
  expect((await card.boundingBox())!.width).toBeGreaterThanOrEqual(200);
  // Every module the same whole number of pixels, and four of them white each side.
  expect(small.module).toBe(Math.round(small.module));
  for (const side of [small.left, small.right]) expect(Math.abs(side - 4)).toBeLessThanOrEqual(0.5);

  await card.click();
  const large = page.locator("[data-qr-large]");
  await expect(large).toBeVisible();
  const big = await measure(large);
  expect(big.n).toBe(small.n);
  expect(big.module).toBeGreaterThan(small.module * 2);
  expect(big.module).toBe(Math.round(big.module));
  for (const side of [big.left, big.right]) expect(Math.abs(side - 4)).toBeLessThanOrEqual(0.5);
  await page.keyboard.press("Escape");
  await expect(large).toHaveCount(0);
  await expect(page.locator("[data-connect-page]")).toBeVisible();

  // A camera frame as the phone page reads one (640 by 480, scan.ts) with the card's code in it as
  // the screen shows it, slightly soft.
  const frame = (png: string) => page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    [c.width, c.height] = [640, 480];
    const g = c.getContext("2d")!;
    g.fillStyle = "#8a8a8a";
    g.fillRect(0, 0, 640, 480);
    g.filter = "blur(0.6px)";
    g.drawImage(img, (640 - img.width) >> 1, (480 - img.height) >> 1);
    return Array.from(g.getImageData(0, 0, 640, 480).data);
  }, png);
  // As an ES module, which the page loads it as.
  const module = path.join(root, "hive_web.mjs");
  fs.copyFileSync(path.join(PKG, "hive_web.js"), module);
  const wasm = await import(pathToFileURL(module).href);
  await wasm.default({ module_or_path: fs.readFileSync(path.join(PKG, "hive_web_bg.wasm")) });
  expect(wasm.readQr(Uint8Array.from(await frame(small.png)), 640, 480)).toBe(link);
});

test("the offer's code, with this computer's addresses, stays inside its box, whole pixels a module, and what is beside it starts after it", async () => {
  const offered = page.locator("[data-connect-offered]");
  if (!(await offered.count())) await page.locator("[data-connect-offer]").click();
  const code = offered.locator("[data-connect-qr]");
  await expect(code).toBeVisible({ timeout: 20_000 });
  const n = Number(await code.locator("svg").getAttribute("data-qr-modules"));
  const box = (await code.boundingBox())!;
  const svg = (await code.locator("svg").boundingBox())!;
  expect(svg.width / n).toBe(Math.round(svg.width / n));
  expect(svg.x).toBeGreaterThanOrEqual(box.x);
  expect(svg.x + svg.width).toBeLessThanOrEqual(box.x + box.width);
  // What is beside it starts after it.
  const text = (await offered.locator("p").first().boundingBox())!;
  expect(text.y >= box.y + box.height || text.x >= box.x + box.width).toBe(true);
});

test("Join closes Settings and opens the join form, where a code from elsewhere is entered", async () => {
  await page.locator("[data-connect-join-open]").click();
  await expect(page.locator(".settings-dialog")).toHaveCount(0);
  await expect(page.locator("[data-join-link]")).toBeVisible();
  await page.keyboard.press("Escape");
});
