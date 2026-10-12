// One agent on the phone page (crates/hive-web/www/app/agent.ts), in a phone-sized Chromium with no
// computer: the page's built modules (crates/hive-web/build.sh) served from www by route, the
// computer's overview given by the test through `window.show(overview)`.
import { test, expect, chromium, type Browser, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const WWW = path.resolve("../../crates/hive-web/www");
const built = () => fs.existsSync(path.join(WWW, "js", "agent.js"));

let browser: Browser | undefined;
test.afterEach(async () => {
  await browser?.close();
  browser = undefined;
});

const agent = (tile: string, name: string, more: object = {}) => ({
  workspace: "w0", name: "project", tile, agent: name, program: { id: "claude", label: "Claude" }, state: "idle", since: 1,
  machine: "desk", conversation: true, interrupt: true, device: "d0", ...more,
});
const overview = (...agents: object[]) => ({ agents, needs: [], working: 0 });

/** The agent screen; `window.open(tile, started)` opens it as the page does, `window.show(o)` tells it the agents. */
async function screen(): Promise<Page> {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page.on("pageerror", (e) => { throw e; });
  await page.route("http://page.test/**", (route) => {
    const name = new URL(route.request().url()).pathname.slice(1);
    if (name === "index.html") {
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="app.css"><main id="app"></main>
<script type="module">
import { AgentScreen } from "./js/agent.js";
window.calls = [];
const app = {
  back() {}, computer: () => "desk",
  conversation: (a) => (window.calls.push(["conversation", a.tile]), () => {}),
  terminal: () => null,
  tool: async () => ({}),
};
const screen = new AgentScreen(app);
document.getElementById("app").append(screen.el);
let last = null;
window.open = (tile, started) => { if (started) screen.starting?.(tile); screen.open(tile, last); };
window.show = (o) => { last = o; screen.show(o); };
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

type Window_ = { open(tile: string, started?: boolean): void; show(o: object): void };
const open = (page: Page, tile: string, started = false) => page.evaluate(([t, s]) => (window as unknown as Window_).open(t as string, s as boolean), [tile, started] as const);
const show = (page: Page, o: object) => page.evaluate((x) => (window as unknown as Window_).show(x), o);

test("an agent just started shows as starting until the computer lists it, never as the agent shown before it, nor as gone", async () => {
  test.skip(!built(), "no page build: run crates/hive-web/build.sh");
  const page = await screen();
  const title = page.locator("[data-screen=agent] header h1");
  const notice = page.locator("[data-screen=agent] > p.quiet");
  await show(page, overview(agent("t1", "Phone test", { state: "waiting" })));
  await open(page, "t1");
  await expect(title).toHaveText("Phone test");
  // Back to Home, Start, and the new agent opens before the computer lists it.
  await open(page, "t9", true);
  await expect(title).toHaveText("");
  await expect(page.locator("[data-screen=agent] .sub")).toHaveText("");
  await expect(notice).toHaveText("Starting…");
  await expect(notice).toBeVisible();
  await show(page, overview(agent("t1", "Phone test"), agent("t9", "Reply with exactly", { state: "working" })));
  await expect(title).toHaveText("Reply with exactly");
  await expect(notice).toBeHidden();
  // Listed once, it is no longer starting: closed, it is gone.
  await show(page, overview(agent("t1", "Phone test")));
  await expect(notice).toHaveText("No agent runs there now.");
  // Opened from an old link, an agent never started here is gone at once.
  await open(page, "t5");
  await expect(notice).toHaveText("No agent runs there now.");
  await expect(notice).toBeVisible();
});
