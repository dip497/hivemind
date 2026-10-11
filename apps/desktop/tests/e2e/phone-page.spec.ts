// The phone page's lists (docs/design/phone-browser-2026-10-03.md, B4), in a phone-sized Chromium
// with no computer and no network: its built modules (crates/hive-web/build.sh) served from www by
// route. An update touches only what changed; rows away from the screen are skipped; past a few
// working agents, their dots stop breathing.
import { test, expect, chromium, type Browser, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const WWW = path.resolve("../../crates/hive-web/www");
const built = () => fs.existsSync(path.join(WWW, "js", "needs.js"));

let browser: Browser | undefined;
test.afterEach(async () => {
  await browser?.close();
  browser = undefined;
});

/** The Needs you and Agents screens, side by side, with `window.overview(n, answered)`: `n` agents
 *  on two machines and three workspaces, every fourth waiting on the person but the first
 *  `answered` of those, the rest working. */
async function screens(shown: "needs" | "agents"): Promise<Page> {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page.on("pageerror", (e) => { throw e; });
  await page.route("http://page.test/**", (route) => {
    const name = new URL(route.request().url()).pathname.slice(1);
    if (name === "index.html") {
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="app.css"><main id="app"></main>
<script type="module">
import { Needs } from "./js/needs.js";
import { Agents } from "./js/agents.js";
const app = { open() {}, answer: async () => true };
const screens = { needs: new Needs(app), agents: new Agents(app) };
for (const [name, s] of Object.entries(screens)) { s.el.hidden = name !== ${JSON.stringify(shown)}; document.getElementById("app").append(s.el); }
window.overview = (n, answered) => {
  const all = Array.from({ length: n }, (_, i) => {
    const waits = i % 4 === 0 && i >= answered * 4;
    return { workspace: "w" + (i % 3), name: "api" + (i % 3), tile: "t" + i, agent: "agent " + i, state: waits ? "waiting" : "working",
      since: 1790000000000 + i, machine: "m" + (i % 2), device: "d", interrupt: true, conversation: false,
      ...(waits ? { waiting: { kind: "permission", since: 1790000000000 + i, decide: true } } : {}) };
  });
  const o = { agents: all, needs: all.filter((a) => a.waiting), working: all.filter((a) => a.state === "working").length };
  for (const s of Object.values(screens)) s.show(o);
};
window.ready = true;
</script>` });
    }
    const file = path.join(WWW, name);
    if (!fs.existsSync(file)) return route.fulfill({ status: 404 });
    return route.fulfill({ contentType: name.endsWith(".css") ? "text/css" : "text/javascript", body: fs.readFileSync(file) });
  });
  await page.goto("http://page.test/index.html");
  await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready);
  return page;
}

test("one wait answered among 200 agents removes its card and makes its agent's row again, and moves nothing else on either list", async () => {
  test.skip(!built(), "build the page first (crates/hive-web/build.sh)");
  const page = await screens("needs");
  const changes = await page.evaluate(async () => {
    const w = window as unknown as { overview(n: number, answered: number): void };
    w.overview(200, 0);
    const seen: Record<string, { added: number; removed: number }> = {};
    const watch = (list: string) => {
      seen[list] = { added: 0, removed: 0 };
      new MutationObserver((records) => {
        for (const r of records) {
          seen[list]!.added += r.addedNodes.length;
          seen[list]!.removed += r.removedNodes.length;
        }
      }).observe(document.querySelector(`[data-${list}]`)!, { childList: true });
    };
    watch("needs");
    watch("agents");
    w.overview(200, 1);
    await Promise.resolve();
    return seen;
  });
  expect(changes).toEqual({ needs: { added: 0, removed: 1 }, agents: { added: 1, removed: 1 } });
});

test("of 200 agents, the rows far below the screen are not rendered until scrolled near, and come in when they are", async () => {
  test.skip(!built(), "build the page first (crates/hive-web/build.sh)");
  const page = await screens("agents");
  await page.evaluate(() => (window as unknown as { overview(n: number, answered: number): void }).overview(200, 0));
  const [first, last] = [page.locator("[data-agent]").first(), page.locator("[data-agent]").last()];
  const rendered = (row: typeof first) => row.locator(".name").evaluate((el) => el.checkVisibility({ contentVisibilityAuto: true }));
  // Which rows are near the screen is found as the next frame renders.
  await expect.poll(() => rendered(first)).toBe(true);
  expect(await rendered(last)).toBe(false);
  await last.scrollIntoViewIfNeeded();
  await expect.poll(() => rendered(last)).toBe(true);
});

test("a working agent's dot breathes, as on Android, while a few work; past 40 working, every dot is still", async () => {
  test.skip(!built(), "build the page first (crates/hive-web/build.sh)");
  const page = await screens("agents");
  const breathing = () => page.locator('[data-agent][data-state="working"] .dot').first().evaluate((el) => el.getAnimations().length);
  await page.evaluate(() => (window as unknown as { overview(n: number, answered: number): void }).overview(40, 0));
  expect(await breathing()).toBe(1);
  await page.evaluate(() => (window as unknown as { overview(n: number, answered: number): void }).overview(200, 0));
  expect(await breathing()).toBe(0);
});
