// What a page in a Browser tile does beyond showing itself, for a person clicking in it and for an
// agent on the agents' port (as agent-browser drives it): downloads, pop-ups, printing, reloading.
import { test, expect, _electron as electron, type ElectronApplication, type Page, type Locator } from "@playwright/test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocket as Socket } from "ws";

const PORT = String(9700 + Math.floor(Math.random() * 100));
const ud = fs.mkdtempSync(path.join(os.tmpdir(), "hm-page-ud-"));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "hm-page-home-"));
let app: ElectronApplication;
let page: Page;
let site: http.Server;
let base = "";
let downloadsFolder = "";
let tile: Locator;
let tileId = "";
let pageLoads = 0;

const FILE = Buffer.alloc(4096, 7);
const ACTIONS = `<!doctype html><title>actions</title><body style="margin:0">
<a id=file href="/file.bin" style="position:absolute;left:0;top:0;width:200px;height:60px;background:#ddd">file</a>
<a id=tab href="/opened" target=_blank style="position:absolute;left:0;top:80px;width:200px;height:60px;background:#ddd">tab</a>
</body>`;

interface Reply { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string; result?: Record<string, unknown>; error?: { message: string } }

/** A connection to the agents' port as agent-browser makes one: the browser's, with sessions. */
async function agent() {
  const version = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()) as { webSocketDebuggerUrl: string };
  const ws = new Socket(version.webSocketDebuggerUrl);
  await new Promise((r) => ws.once("open", r));
  let n = 0;
  const events: Reply[] = [];
  const waiting = new Map<number, (m: Reply) => void>();
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString()) as Reply;
    if (typeof m.id === "number") waiting.get(m.id)?.(m);
    else events.push(m);
  });
  const send = (method: string, params: object = {}, sessionId?: string) => new Promise<Reply>((resolve) => {
    const id = ++n;
    waiting.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const attach = async (url: string) => {
    const targets = (await send("Target.getTargets")).result!.targetInfos as { targetId: string; url: string }[];
    const targetId = targets.find((t) => t.url === url)!.targetId;
    const sessionId = (await send("Target.attachToTarget", { targetId, flatten: true })).result!.sessionId as string;
    await send("Page.enable", {}, sessionId);
    return { targetId, sessionId };
  };
  const click = async (sessionId: string, x: number, y: number) => {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, sessionId);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, sessionId);
  };
  return { send, attach, click, events, close: () => ws.close() };
}

/** The page's title and the like, as the tile's page has them. */
const inPage = <T,>(expression: string) => page.evaluate(async ([id, ex]) => ((await window.hive.browserCdp(id!, "Runtime.evaluate", { expression: ex, returnByValue: true })) as { result: { value: T } }).result.value, [tileId, expression] as const);

async function show(url: string) {
  await page.evaluate(([id, u]) => window.hive.browserCdp(id!, "Page.navigate", { url: u }), [tileId, url]);
  await expect.poll(() => inPage<string>("location.href + document.readyState")).toBe(`${url}complete`);
}

/** A real mouse click at a point of the tile's page. */
async function personClicks(x: number, y: number) {
  await tile.locator(".tile-drag-handle").click({ position: { x: 300, y: 8 } });
  await expect(tile.locator(".hm-node-selected")).toHaveCount(1);
  await page.waitForTimeout(300);
  const box = (await tile.locator("webview:visible").boundingBox())!;
  const [w, h] = [await inPage<number>("innerWidth"), await inPage<number>("innerHeight")];
  await page.mouse.click(box.x + (x * box.width) / w, box.y + (y * box.height) / h);
}

test.beforeAll(async () => {
  site = http.createServer((req, res) => {
    if (req.url === "/file.bin") {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="file.bin"' });
      res.end(FILE);
      return;
    }
    if (req.url === "/counted") pageLoads++;
    res.writeHead(200, { "content-type": "text/html" });
    res.end(req.url === "/opened" ? "<title>opened</title>opened" : ACTIONS);
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
  const env = { ...process.env, HOME: home, HIVEMIND_BROWSER_CDP: "1", HIVEMIND_BROWSER_CDP_PORT: PORT } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.resolve("out/main/index.js"), "--no-sandbox", `--user-data-dir=${ud}`], cwd: path.resolve("."), env });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 15_000 });
  await page.evaluate(() => window.hive.settingsSet("plugins.state.tool:@hivemind/web", { enabled: true }));
  downloadsFolder = await app.evaluate(({ app: a }) => a.getPath("downloads"));
  expect(downloadsFolder.startsWith(home)).toBe(true);
  fs.mkdirSync(downloadsFolder, { recursive: true });
  await page.keyboard.press("6");
  await page.waitForSelector(".react-flow__node-frame");
  const frameId = await page.locator(".react-flow__node-frame").first().getAttribute("data-id");
  await page.evaluate((fid) => window.dispatchEvent(new CustomEvent("hivemind:frame-open", { detail: { frameId: fid, kind: "browser" } })), frameId);
  tile = page.locator(".react-flow__node-browser").first();
  tileId = (await tile.getAttribute("data-id"))!;
  await expect.poll(() => page.evaluate(async (id) => {
    try { await window.hive.browserCdp(id, "Runtime.evaluate", { expression: "1" }); return true; } catch { return false; }
  }, tileId), { timeout: 25_000 }).toBe(true);
  // This suite's connections name no agent: a tile shared with every agent is what they reach.
  await page.evaluate((id) => window.hive.settingsSet("agentBrowser.tiles", { [id]: "all" }), tileId);
});
test.afterAll(async () => {
  await app?.close();
  site?.close();
  fs.rmSync(ud, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test("a person's download goes to Downloads under a free name, and the tile says what was saved and shows it", async () => {
  await show(`${base}/`);
  fs.writeFileSync(path.join(downloadsFolder, "file.bin"), "already here");
  await personClicks(100, 30);
  const notice = tile.locator('[data-page-download="saved"]');
  await expect(notice).toContainText("file (1).bin", { timeout: 15_000 });
  expect(fs.readFileSync(path.join(downloadsFolder, "file.bin"), "utf8")).toBe("already here");
  expect(fs.readFileSync(path.join(downloadsFolder, "file (1).bin")).equals(FILE)).toBe(true);

  await app.evaluate(({ shell }) => {
    const shown: string[] = [];
    (globalThis as unknown as { shown: string[] }).shown = shown;
    shell.showItemInFolder = (p: string) => { shown.push(p); };
  });
  await notice.getByRole("button", { name: "Show in folder" }).click();
  await expect.poll(() => app.evaluate(() => (globalThis as unknown as { shown: string[] }).shown)).toEqual([path.join(downloadsFolder, "file (1).bin")]);
  await notice.getByRole("button", { name: /dismiss/ }).click();
  await expect(notice).toHaveCount(0);
  // Only what a page saved: not any path the window names.
  await page.evaluate(() => window.hive.browserShowDownload!("/etc/passwd"));
  expect(await app.evaluate(() => (globalThis as unknown as { shown: string[] }).shown)).toHaveLength(1);
});

test("an agent's download lands where it asked and it hears the file finish; once it has gone quiet, a person's is the person's", async () => {
  await show(`${base}/`);
  const a = await agent();
  const { sessionId, targetId } = await a.attach(`${base}/`);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "hm-page-agent-"));
  const before = fs.readdirSync(downloadsFolder).length;
  expect((await a.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: folder, eventsEnabled: true })).error).toBeUndefined();
  await a.click(sessionId, 100, 30);

  await expect.poll(() => a.events.find((e) => e.method === "Browser.downloadProgress" && e.params?.state === "completed"), { timeout: 15_000 }).toBeTruthy();
  const began = a.events.find((e) => e.method === "Browser.downloadWillBegin")!;
  expect(began.params).toMatchObject({ frameId: targetId, url: `${base}/file.bin`, suggestedFilename: "file.bin" });
  const guid = began.params!.guid as string;
  // One name for the one file: what it hears never names another.
  expect(a.events.filter((e) => /download/i.test(e.method ?? "")).every((e) => e.params?.guid === guid)).toBe(true);
  expect(fs.readFileSync(path.join(folder, guid)).equals(FILE)).toBe(true);
  expect(fs.readdirSync(downloadsFolder)).toHaveLength(before);
  // Said on the tile too: a person's click in an agent's window lands here, and they should know.
  await expect(tile.locator('[data-page-download="saved"]')).toContainText("An agent:");
  await tile.locator('[data-page-download="saved"]').getByRole("button", { name: /dismiss/ }).click();

  await page.waitForTimeout(11_000);
  await personClicks(100, 30);
  await expect(tile.locator('[data-page-download="saved"]')).toContainText("file", { timeout: 15_000 });
  await expect(tile.locator('[data-page-download="saved"]')).not.toContainText("An agent:");
  expect(fs.readdirSync(downloadsFolder)).toHaveLength(before + 1);
  expect(fs.readdirSync(folder)).toEqual([guid]);
  await tile.locator('[data-page-download="saved"]').getByRole("button", { name: /dismiss/ }).click();

  // An agent that says no: nothing is saved.
  const count = fs.readdirSync(downloadsFolder).length;
  a.events.length = 0;
  await a.send("Browser.setDownloadBehavior", { behavior: "deny", eventsEnabled: true });
  await a.click(sessionId, 100, 30);
  await expect.poll(() => a.events.find((e) => e.method === "Browser.downloadProgress" && e.params?.state === "canceled"), { timeout: 15_000 }).toBeTruthy();
  expect(fs.readdirSync(downloadsFolder)).toHaveLength(count);
  await a.send("Browser.setDownloadBehavior", { behavior: "default" });
  a.close();
  fs.rmSync(folder, { recursive: true, force: true });
});

test("printing a tile's page gives the agent a PDF", async () => {
  await show(`${base}/`);
  const a = await agent();
  const { sessionId } = await a.attach(`${base}/`);
  const printed = await a.send("Page.printToPDF", { printBackground: true, landscape: true, paperWidth: 5, paperHeight: 5, marginTop: 0 }, sessionId);
  expect(printed.error).toBeUndefined();
  expect(Buffer.from(printed.result!.data as string, "base64").subarray(0, 5).toString()).toBe("%PDF-");
  a.close();
});

test("reloading a tile's page reloads that page, not the app around it, and the agent keeps its session", async () => {
  await show(`${base}/counted`);
  await page.evaluate(() => { (window as unknown as { notReloaded: boolean }).notReloaded = true; });
  const a = await agent();
  const { sessionId, targetId } = await a.attach(`${base}/counted`);
  const loads = pageLoads;
  await inPage("window.oldDocument = true");
  expect((await a.send("Page.reload", {}, sessionId)).error).toBeUndefined();
  await expect.poll(() => a.events.some((e) => e.method === "Page.loadEventFired" && e.sessionId === sessionId), { timeout: 10_000 }).toBe(true);
  expect(pageLoads).toBe(loads + 1);
  expect(a.events.some((e) => e.method === "Target.targetDestroyed" && e.params?.targetId === targetId)).toBe(false);
  expect(((await a.send("Runtime.evaluate", { expression: "String(window.oldDocument)", returnByValue: true }, sessionId)).result!.result as { value: string }).value).toBe("undefined");
  expect(await page.evaluate(() => (window as unknown as { notReloaded?: boolean }).notReloaded)).toBe(true);
  a.close();
});

test("a pop-up opens as a new tab, from a person's click and an agent's, and the agent sees both tabs", async () => {
  await show(`${base}/`);
  const webviews = tile.locator("webview");
  await expect(webviews).toHaveCount(1);
  await personClicks(100, 110);
  await expect(webviews).toHaveCount(2);
  await tile.getByRole("button", { name: "actions" }).click();

  const a = await agent();
  const { sessionId, targetId } = await a.attach(`${base}/`);
  await a.send("Target.setDiscoverTargets", { discover: true });
  await a.click(sessionId, 100, 110);
  await expect(webviews).toHaveCount(3);
  const listed = async () => ((await a.send("Target.getTargets")).result!.targetInfos as { targetId: string; url: string }[]);
  await expect.poll(async () => (await listed()).filter((t) => t.url === `${base}/opened`).length, { timeout: 10_000 }).toBe(2);
  expect((await listed()).map((t) => t.targetId)).toContain(targetId);
  // It heard of the new tab, as it would of any new tab.
  await expect.poll(() => a.events.some((e) => (e.method === "Target.targetCreated" || e.method === "Target.targetInfoChanged") && (e.params?.targetInfo as { url?: string } | undefined)?.url === `${base}/opened`), { timeout: 10_000 }).toBe(true);
  // A tab not in front answers too.
  const first = await a.attach(`${base}/opened`);
  expect((await a.send("Runtime.evaluate", { expression: "document.title", returnByValue: true }, first.sessionId)).result!.result).toMatchObject({ value: "opened" });
  a.close();
  // The tile drives the new tab once it has loaded.
  await expect.poll(() => inPage<string>("location.href")).toBe(`${base}/opened`);
});

test("an agent answers a page's dialog: the page gets the answer, and the box the person saw goes", async () => {
  // Playwright, attached to every page, would answer it first. A real run has no such thing.
  const held = () => {};
  app.context().on("dialog", held);
  await show(`${base}/`);
  await app.evaluate(({ dialog }) => {
    const boxes: AbortSignal[] = [];
    (globalThis as unknown as { boxes: AbortSignal[] }).boxes = boxes;
    const real = dialog.showMessageBox.bind(dialog) as (...a: unknown[]) => Promise<unknown>;
    (dialog as unknown as { showMessageBox: unknown }).showMessageBox = (...a: unknown[]) => {
      boxes.push((a[a.length - 1] as { signal: AbortSignal }).signal);
      return real(...a);
    };
  });
  const a = await agent();
  const { sessionId } = await a.attach(`${base}/`);
  const asked = a.send("Runtime.evaluate", { expression: "String(confirm('sure?'))", returnByValue: true }, sessionId);
  await expect.poll(() => a.events.find((e) => e.method === "Page.javascriptDialogOpening")?.params?.message).toBe("sure?");
  expect(await app.evaluate(() => (globalThis as unknown as { boxes: AbortSignal[] }).boxes.map((s) => s.aborted))).toEqual([false]);
  await a.send("Page.handleJavaScriptDialog", { accept: true }, sessionId);
  expect(((await asked).result!.result as { value: string }).value).toBe("true");
  expect(await app.evaluate(() => (globalThis as unknown as { boxes: AbortSignal[] }).boxes.map((s) => s.aborted))).toEqual([true]);
  a.close();
  app.context().off("dialog", held);
});

test("a page opens tabs only on web pages, and not without end", async () => {
  await show(`${base}/`);
  const webviews = tile.locator("webview");
  const tabs = await webviews.count();
  await inPage("window.open('file:///etc/passwd'); window.open('data:text/html,not a web page'); 1");
  await page.waitForTimeout(500);
  await expect(webviews).toHaveCount(tabs);
  await inPage("for (let i = 0; i < 12; i++) window.open('about:blank'); 1");
  await page.waitForTimeout(1500);
  const opened = (await webviews.count()) - tabs;
  expect(opened).toBeGreaterThan(0);
  expect(opened).toBeLessThanOrEqual(5);
});
