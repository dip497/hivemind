// A page in a Browser tile asks before it gets the camera, the microphone, the location or
// notifications: the tile shows who asks for what, and the person's answer is what the page gets,
// remembered per site for this run of the app.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

let app: ElectronApplication;
let page: Page;
let server: Server;
let port = 0;
let tileId = "";
const root = mkdtempSync(path.join(tmpdir(), "hm-permissions-"));

test.beforeAll(async () => {
  server = createServer((_q, r) => { r.setHeader("content-type", "text/html"); r.end("<!doctype html><title>asks</title><p>a site that asks</p>"); });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  port = (server.address() as { port: number }).port;
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
test.afterAll(async () => { await app?.close(); server?.close(); rmSync(root, { recursive: true, force: true }); });

/** Run `expression` in the tile's page; a promise it gives is awaited. */
const inPage = async <T,>(expression: string) =>
  page.evaluate(async ([id, ex]) => ((await window.hive.browserCdp(id!, "Runtime.evaluate", { expression: ex, returnByValue: true, awaitPromise: true })) as { result: { value: unknown } }).result.value, [tileId, expression]) as Promise<T>;
/** Start `expression` in the page without waiting on it: what it settles to lands in `window.answer`. */
const start = (expression: string) => inPage(`window.answer = undefined; Promise.resolve(${expression}).then((r) => { window.answer = r; }, (e) => { window.answer = e.name; }); 0`);
const answer = () => inPage<string | null>("window.answer ?? null");

async function visit(url: string) {
  await page.evaluate(([id, u]) => window.hive.browserCdp(id!, "Page.navigate", { url: u }), [tileId, url]);
  await expect.poll(() => inPage<string>("location.href + document.title")).toBe(`${url}asks`);
}

const ask = () => page.locator(`.react-flow__node[data-id="${tileId}"] [data-permission-ask]`);

test("a site asking for notifications is asked on its tile; Block refuses it, and it is not asked again", async () => {
  await visit(`http://127.0.0.1:${port}/`);
  await start("Notification.requestPermission()");
  await expect(ask()).toContainText(`127.0.0.1:${port}`);
  await expect(ask()).toContainText("notifications");
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
  await visit(`http://localhost:${port}/`);
  expect(await inPage("Notification.permission")).not.toBe("granted");
  await start("Notification.requestPermission()");
  await expect(ask()).toContainText(`localhost:${port}`);
  await ask().getByRole("button", { name: "Allow" }).click();
  await expect.poll(answer).toBe("granted");
  expect(await inPage("Notification.permission")).toBe("granted");
});

test("a question goes when its page leaves, and is asked again rather than kept as a no", async () => {
  const where = "new Promise((ok) => navigator.geolocation.getCurrentPosition(() => ok('granted'), (e) => ok(e.code === 1 ? 'denied' : 'unavailable')))";
  await visit(`http://127.0.0.1:${port}/before`);
  await start(where);
  await expect(ask()).toContainText("location");
  await visit(`http://127.0.0.1:${port}/after`);
  await expect(ask()).toHaveCount(0);
  await start(where);
  await expect(ask()).toContainText("location");
  await ask().getByRole("button", { name: "Block" }).click();
  await expect.poll(answer).toBe("denied");
});

test("a site asking for the microphone is asked, not granted", async () => {
  await visit(`http://localhost:${port}/call`);
  await start("navigator.mediaDevices.getUserMedia({ audio: true }).then(() => 'granted')");
  await expect(ask()).toContainText("microphone");
  await ask().getByRole("button", { name: "Block" }).click();
  await expect.poll(answer).toBe("NotAllowedError");
});
