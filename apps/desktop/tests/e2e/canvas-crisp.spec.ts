// A board scrolled by a trackpad moves by fractions of a pixel. At rest it lands on whole pixels,
// or the text of every tile it carries is drawn between pixels and reads blurred.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "hm-crisp-"));
  execSync("git init -q -b main", { cwd: repo });
  const env = { ...process.env } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox", `--user-data-dir=/tmp/hm-crisp-ud-${Date.now()}`],
    cwd: repo, env,
  });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 15_000 });
});
test.afterAll(async () => { await app?.close(); });

const offset = () => page.locator(".react-flow__viewport").evaluate((el) => {
  const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec((el as HTMLElement).style.transform);
  return m ? [Number(m[1]), Number(m[2])] : null;
});

test("a board scrolled by fractions of a pixel comes to rest on whole pixels", async () => {
  const before = await offset();
  await page.mouse.move(1200, 900);
  await page.mouse.wheel(13.3, 7.7);
  await expect.poll(offset).not.toEqual(before);
  await expect.poll(async () => (await offset())!.every(Number.isInteger), { timeout: 3_000 }).toBe(true);
});
