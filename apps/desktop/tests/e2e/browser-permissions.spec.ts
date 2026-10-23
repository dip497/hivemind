// A page in a Browser tile asks before it gets the camera, the microphone, the location,
// notifications or another program for a link: the tile shows who asks for what, over the page,
// and the person's answer is what the page gets, remembered per site for this run of the app. The
// site's panel by the address answers before a site asks, and takes an answer back. The app's own
// page keeps what the app uses.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

let app: ElectronApplication;
let page: Page;
const servers: Server[] = [];
/** Four servers' ports: four sites on each of two names for this computer. */
const ports: number[] = [];
let tileId = "";
const root = mkdtempSync(path.join(tmpdir(), "hm-permissions-"));

test.beforeAll(async () => {
  for (let i = 0; i < 4; i++) {
    const server = createServer((_q, r) => { r.setHeader("content-type", "text/html"); r.end("<!doctype html><title>asks</title><p>a site that asks</p>"); });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    servers.push(server);
    ports.push((server.address() as { port: number }).port);
  }
  const repo = path.join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(root, "config") } as Record<string, string>;
  delete env["ELECTRON_RUN_AS_NODE"];
  app = await electron.launch({
    // A microphone that is there, so a page's ask reaches the permission and not "no device".
    args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox", "--use-fake-device-for-media-stream", `--user-data-dir=${path.join(root, "ud")}`],
    cwd: repo,
    env,
  });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 15_000 });
  await page.evaluate(() => window.hive.settingsSet("plugins.state.tool:@hivemind/web", { enabled: true }));
  await page.keyboard.press("6");
  await page.waitForSelector(".react-flow__node-frame");
  const frameId = await page.locator(".react-flow__node-frame").first().getAttribute("data-id");
  await page.evaluate((fid) => window.dispatchEvent(new CustomEvent("hivemind:frame-open", { detail: { frameId: fid, kind: "browser" } })), frameId);
  await expect(page.locator(".react-flow__node-browser")).toHaveCount(1);
  tileId = (await page.locator(".react-flow__node-browser").first().getAttribute("data-id"))!;
  await expect.poll(() => page.evaluate(async (id) => {
    try { await window.hive.browserCdp(id, "Runtime.evaluate", { expression: "1" }); return true; } catch { return false; }
  }, tileId), { timeout: 25_000 }).toBe(true);
});
test.afterAll(async () => { await app?.close(); for (const s of servers) s.close(); rmSync(root, { recursive: true, force: true }); });

/** Run `expression` in the tile's page, as from a click there; a promise it gives is awaited. */
const inPage = async <T,>(expression: string) =>
  page.evaluate(async ([id, ex]) => ((await window.hive.browserCdp(id!, "Runtime.evaluate", { expression: ex, returnByValue: true, awaitPromise: true, userGesture: true })) as { result: { value: unknown } }).result.value, [tileId, expression]) as Promise<T>;
/** Start `expression` in the page without waiting on it: what it settles to lands in `window.answer`. */
const start = (expression: string) => inPage(`window.answer = undefined; Promise.resolve(${expression}).then((r) => { window.answer = r; }, (e) => { window.answer = e.name; }); 0`);
const answer = () => inPage<string | null>("window.answer ?? null");

async function visit(url: string) {
  await page.evaluate(([id, u]) => window.hive.browserCdp(id!, "Page.navigate", { url: u }), [tileId, url]);
  await expect.poll(() => inPage<string>("location.href + document.title")).toBe(`${url}asks`);
}

const tile = () => page.locator(`.react-flow__node[data-id="${tileId}"]`);
const ask = () => tile().locator("[data-permission-ask]");
const guest = () => tile().locator("webview:visible");
/** The site's panel, opened and closed by the button by the address. */
const panelButton = () => tile().getByRole("button", { name: "Site permissions" });
async function panel() {
  await panelButton().click();
  return tile().locator("[data-site-rights]");
}
async function closePanel() {
  await panelButton().click();
  await expect(tile().locator("[data-site-rights]")).toHaveCount(0);
}
const right = (name: string) => tile().getByRole("radiogroup", { name });

test("a site asking for notifications is asked on its tile; Block refuses it, and it is not asked again", async () => {
  await visit(`http://127.0.0.1:${ports[0]}/`);
  await start("Notification.requestPermission()");
  await expect(ask()).toContainText(`127.0.0.1:${ports[0]}`);
  await expect(ask()).toContainText("wants to show notifications");
  expect(await answer()).toBeNull();
  await ask().getByRole("button", { name: "Block" }).click();
  await expect.poll(answer).toBe("denied");
  await expect(ask()).toHaveCount(0);
  // Remembered for the site: asking again is answered without a prompt.
  expect(await inPage("Notification.requestPermission()")).toBe("denied");
  await expect(ask()).toHaveCount(0);
  expect(await inPage("Notification.permission")).toBe("denied");
});

test("another site the person allows gets notifications", async () => {
  await visit(`http://localhost:${ports[0]}/`);
  expect(await inPage("Notification.permission")).not.toBe("granted");
  await start("Notification.requestPermission()");
  await expect(ask()).toContainText(`localhost:${ports[0]}`);
  await ask().getByRole("button", { name: "Allow" }).click();
  await expect.poll(answer).toBe("granted");
  expect(await inPage("Notification.permission")).toBe("granted");
});

test("the question shows over the page without moving it, and a click landing the moment it shows answers nothing", async () => {
  await visit(`http://localhost:${ports[1]}/`);
  const before = await guest().boundingBox();
  // A click that arrives as the question appears, where the page drew a button a moment before.
  await page.evaluate(() => {
    const w = window as unknown as { clickedEarly?: boolean };
    new MutationObserver((_, watch) => {
      const allow = [...document.querySelectorAll("[data-permission-ask] button")].find((b) => b.textContent === "Allow") as HTMLButtonElement | undefined;
      if (!allow) return;
      watch.disconnect();
      allow.click();
      w.clickedEarly = true;
    }).observe(document.body, { childList: true, subtree: true });
  });
  await start("Notification.requestPermission()");
  await expect.poll(() => page.evaluate(() => (window as unknown as { clickedEarly?: boolean }).clickedEarly ?? false)).toBe(true);
  await expect(ask()).toBeVisible();
  expect(await guest().boundingBox()).toEqual(before);
  expect(await answer()).toBeNull();
  // Once it has been on screen a moment, a click answers it.
  await ask().getByRole("button", { name: "Block" }).click();
  await expect.poll(answer).toBe("denied");
});

const where = "new Promise((ok) => navigator.geolocation.getCurrentPosition(() => ok('granted'), (e) => ok(e.code === 1 ? 'denied' : 'unavailable')))";

test("each question waits its own moment: a click landing as the next one takes its place answers nothing", async () => {
  await visit(`http://localhost:${ports[3]}/`);
  // Count the questions that reach the window: both are waiting before the first is answered.
  await page.evaluate(() => {
    const w = window as unknown as { asked: number; stopCounting: () => void };
    w.asked = 0;
    w.stopCounting = window.hive.onBrowserPermission((e) => { if (!("done" in e)) w.asked++; });
  });
  await inPage("window.first = undefined; Notification.requestPermission().then((r) => { window.first = r; }); 0");
  await expect(ask()).toContainText("wants to show notifications");
  await start(where);
  await expect.poll(() => page.evaluate(() => (window as unknown as { asked: number }).asked)).toBe(2);
  // A click that arrives as the location question shows where the notifications one was.
  await page.evaluate(() => {
    const w = window as unknown as { clickedEarly?: boolean };
    w.clickedEarly = false;
    new MutationObserver((_, watch) => {
      const question = document.querySelector("[data-permission-ask]");
      if (!question?.getAttribute("aria-label")?.includes("know your location")) return;
      const allow = [...question.querySelectorAll("button")].find((b) => b.textContent === "Allow");
      if (!allow) return;
      watch.disconnect();
      allow.click();
      w.clickedEarly = true;
    }).observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
  });
  // The first has been on screen a while: Playwright's click waits for its buttons to take one.
  await ask().getByRole("button", { name: "Block" }).click();
  await expect.poll(() => inPage("window.first ?? null")).toBe("denied");
  await expect.poll(() => page.evaluate(() => (window as unknown as { clickedEarly?: boolean }).clickedEarly ?? false)).toBe(true);
  await expect(ask()).toContainText("wants to know your location");
  expect(await answer()).toBeNull();
  await ask().getByRole("button", { name: "Block" }).click();
  await expect.poll(answer).toBe("denied");
  await page.evaluate(() => (window as unknown as { stopCounting: () => void }).stopCounting());
});

test("a question goes when its page leaves, and is asked again rather than kept as a no", async () => {
  await visit(`http://127.0.0.1:${ports[0]}/before`);
  await start(where);
  await expect(ask()).toContainText("location");
  await visit(`http://127.0.0.1:${ports[0]}/after`);
  await expect(ask()).toHaveCount(0);
  await start(where);
  await expect(ask()).toContainText("location");
  await ask().getByRole("button", { name: "Block" }).click();
  await expect.poll(answer).toBe("denied");
});

test("a site asking for the microphone is asked, not granted", async () => {
  await visit(`http://localhost:${ports[0]}/call`);
  await start("navigator.mediaDevices.getUserMedia({ audio: true }).then(() => 'granted')");
  await expect(ask()).toContainText("microphone");
  await ask().getByRole("button", { name: "Block" }).click();
  await expect.poll(answer).toBe("NotAllowedError");
});

test("a page keeps at most four questions waiting: one more is told no at once", async () => {
  const away = "IdleDetector.requestPermission()";
  await visit(`http://localhost:${ports[2]}/`);
  // On its own, it is asked.
  await start(away);
  await expect(ask()).toContainText("know when you are away");
  await visit(`http://localhost:${ports[2]}/again`);
  await expect(ask()).toHaveCount(0);
  // Four kinds: the page holds back a second media request until the first is answered.
  for (const question of ["Notification.requestPermission()", where, "navigator.mediaDevices.getUserMedia({ audio: true })", "navigator.requestMIDIAccess()"]) {
    await inPage(`void ${question}; 0`);
  }
  await expect(ask()).toContainText("wants to show notifications");
  expect(await inPage(away)).toBe("denied");
  // Leaving settles all four.
  await visit(`http://localhost:${ports[2]}/after`);
  await expect(ask()).toHaveCount(0);
});

test("a link a site would open in another program is asked about by its scheme", async () => {
  await visit(`http://127.0.0.1:${ports[1]}/`);
  await inPage("location.href = 'mailto:someone@example.com'; 0");
  await expect(ask()).toContainText("wants to open mailto: links in another program");
  await ask().getByRole("button", { name: "Block" }).click();
  await expect(ask()).toHaveCount(0);
  // Kept for this site, and listed in its panel.
  await panel();
  await expect(right("Open mailto: links").getByRole("radio", { name: "Block" })).toHaveAttribute("aria-checked", "true");
  await closePanel();
});

test("the site's panel allows notifications to a site that only reads whether it has them", async () => {
  await visit(`http://127.0.0.1:${ports[1]}/`);
  // A site that reads the state and asks only when it would be shown the question never asks.
  expect(await inPage("Notification.permission")).toBe("denied");
  const rights = await panel();
  await expect(rights).toContainText(`127.0.0.1:${ports[1]}`);
  for (const name of ["Notifications", "Camera", "Microphone", "Location"]) {
    await expect(right(name).getByRole("radio", { name: "Ask" })).toHaveAttribute("aria-checked", "true");
  }
  await right("Notifications").getByRole("radio", { name: "Allow" }).click();
  await expect(right("Notifications").getByRole("radio", { name: "Allow" })).toHaveAttribute("aria-checked", "true");
  await closePanel();
  await expect.poll(() => inPage("Notification.permission")).toBe("granted");
  expect(await inPage("Notification.requestPermission()")).toBe("granted");
  await expect(ask()).toHaveCount(0);
});

test("a Block is taken back in the site's panel: the site is asked again", async () => {
  await visit(`http://127.0.0.1:${ports[2]}/`);
  await start("Notification.requestPermission()");
  await ask().getByRole("button", { name: "Block" }).click();
  await expect.poll(answer).toBe("denied");
  await panel();
  await expect(right("Notifications").getByRole("radio", { name: "Block" })).toHaveAttribute("aria-checked", "true");
  await right("Notifications").getByRole("radio", { name: "Ask" }).click();
  await expect(right("Notifications").getByRole("radio", { name: "Ask" })).toHaveAttribute("aria-checked", "true");
  await closePanel();
  await start("Notification.requestPermission()");
  await expect(ask()).toContainText("wants to show notifications");
  await ask().getByRole("button", { name: "Allow" }).click();
  await expect.poll(answer).toBe("granted");
});

test("the app's own page keeps what the app uses: notifications and copying", async () => {
  expect(await page.evaluate(() => Notification.permission)).toBe("granted");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.focus());
  await page.evaluate(() => navigator.clipboard.writeText("copied by the app"));
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe("copied by the app");
});
