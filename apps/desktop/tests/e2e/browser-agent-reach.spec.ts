// What a terminal's agent can reach through the agents' port: the Browser tile beside it, and only
// the cookies of the sites it has a tile on. A person's page in another frame is not its to see,
// until the person says so on that tile; and the person can stop it from the tile.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { WebSocket as Socket } from "ws";
import { tileToken } from "@hivemind/agent-host/hooks/token";

const PORT = String(9800 + Math.floor(Math.random() * 150));
const ud = fs.mkdtempSync(path.join(os.tmpdir(), "hm-reach-"));
const printed = path.join(ud, "agent-cdp.txt");
let app: ElectronApplication;
let page: Page;
let site: http.Server;
let sitePort = 0;
let agentQuery = "";
let beside = ""; // the Browser tile in the agent's frame
let elsewhere = ""; // the person's Browser tile in another frame
let besideTarget = "";
let elsewhereTarget = "";

const targetOf = (tile: string) => page.evaluate(async (id) => {
  for (let i = 0; i < 100; i++) {
    try { return ((await window.hive.browserCdp(id, "Target.getTargetInfo", {})) as { targetInfo: { targetId: string } }).targetInfo.targetId; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error("the tile never showed a page");
}, tile);
const go = (tile: string, url: string) => page.evaluate(([id, to]) => window.hive.browserCdp(id!, "Page.navigate", { url: to }), [tile, url]);
const list = async (query: string) => (await (await fetch(`http://127.0.0.1:${PORT}/json${query}`)).json()) as { id: string; webSocketDebuggerUrl: string }[];

/** A connection to the whole browser, as agent-browser makes one. */
async function connect(query: string) {
  const version = (await (await fetch(`http://127.0.0.1:${PORT}/json/version${query}`)).json()) as { webSocketDebuggerUrl: string };
  const ws = new Socket(version.webSocketDebuggerUrl);
  await new Promise((r) => ws.once("open", r));
  const events: { method: string; params: { targetInfo?: { targetId: string; url: string } } }[] = [];
  ws.on("message", (d: Buffer) => { const m = JSON.parse(d.toString()); if (m.method) events.push(m); });
  let n = 0;
  type Answer = { result?: { targetInfos?: { targetId: string }[]; cookies?: { name: string }[]; sessionId?: string }; error?: { message: string } };
  const send = (method: string, params: object = {}, sessionId?: string) => new Promise<Answer>((resolve) => {
    const id = ++n;
    const hear = (d: Buffer) => { const m = JSON.parse(d.toString()); if (m.id === id) { ws.off("message", hear); resolve(m); } };
    ws.on("message", hear);
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const closed = new Promise<void>((r) => ws.once("close", () => r()));
  return { ws, send, events, closed };
}

test.beforeAll(async () => {
  site = http.createServer((req, res) => {
    const name = /name=(\w+)/.exec(req.url ?? "")?.[1];
    if (name) res.setHeader("set-cookie", `${name}=value; Path=/; HttpOnly`);
    res.setHeader("content-type", "text/html");
    res.end("<!doctype html><title>page</title><input autofocus>");
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  sitePort = (site.address() as { port: number }).port;

  const env = { ...process.env, HIVEMIND_BROWSER_CDP: "1", HIVEMIND_BROWSER_CDP_PORT: PORT } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.resolve("out/main/index.js"), "--no-sandbox", `--user-data-dir=${ud}`], cwd: path.resolve("."), env });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 15_000 });
  await page.evaluate(() => window.hive.settingsSet("plugins.state.tool:@hivemind/web", { enabled: true }));

  // Two frames: the person's Browser tile in one; a Browser tile and a terminal in the other, last, in view.
  const frames = page.locator(".react-flow__node-frame");
  const browsers = page.locator(".react-flow__node-browser");
  const open = (frame: string, kind: string) => page.evaluate(([f, k]) => window.dispatchEvent(new CustomEvent("hivemind:frame-open", { detail: { frameId: f, kind: k } })), [frame, kind]);
  await page.keyboard.press("6");
  await expect(frames).toHaveCount(1);
  await open((await frames.first().getAttribute("data-id"))!, "browser");
  await expect(browsers).toHaveCount(1);
  elsewhere = (await browsers.last().getAttribute("data-id"))!;
  await page.keyboard.press("6");
  await expect(frames).toHaveCount(2);
  const agentsFrame = (await frames.last().getAttribute("data-id"))!;
  await open(agentsFrame, "browser");
  await expect(browsers).toHaveCount(2);
  beside = (await browsers.last().getAttribute("data-id"))!;
  await open(agentsFrame, "shell");
  const term = page.locator(".react-flow__node-terminal").last();
  besideTarget = await targetOf(beside);
  elsewhereTarget = await targetOf(elsewhere);

  // What the terminal was given, as an agent in it would read it.
  await term.locator(".xterm-screen").click();
  // Each try is typed again, and rewrites the file: what a whole one said is kept as it is read.
  await expect.poll(async () => {
    await page.keyboard.type(`printenv AGENT_BROWSER_CDP > ${printed}\n`);
    const now = fs.existsSync(printed) ? fs.readFileSync(printed, "utf8") : "";
    if (now.includes("key=")) agentQuery = new URL(now.trim()).search;
    return agentQuery;
  }, { timeout: 20_000, intervals: [1500] }).toContain("key=");
});
test.afterAll(async () => {
  await app?.close();
  site?.close();
  fs.rmSync(ud, { recursive: true, force: true });
});

test("an agent sees the Browser tile in its frame, and nothing tells it of the person's in another", async () => {
  const listed = await list(agentQuery);
  expect(listed.map((t) => t.id)).toEqual([besideTarget]);
  expect(listed[0]!.webSocketDebuggerUrl).toContain(agentQuery);

  const { ws, send, events } = await connect(agentQuery);
  const targets = (await send("Target.getTargets")).result!.targetInfos!.map((t) => t.targetId);
  expect(targets).toEqual([besideTarget]);
  expect((await send("Target.attachToTarget", { targetId: elsewhereTarget, flatten: true })).error?.message).toContain("No target");
  expect((await send("Target.getTargetInfo", { targetId: elsewhereTarget })).error?.message).toContain("No target");
  expect((await send("Target.closeTarget", { targetId: elsewhereTarget })).error?.message).toContain("No target");

  const socketTo = (target: string) => new Promise<boolean>((resolve) => {
    const s = new Socket(`ws://127.0.0.1:${PORT}/devtools/page/${target}${agentQuery}`);
    s.once("open", () => { s.close(); resolve(true); });
    s.once("error", () => resolve(false));
  });
  expect(await socketTo(besideTarget)).toBe(true);
  expect(await socketTo(elsewhereTarget)).toBe(false);
  expect((await fetch(`http://127.0.0.1:${PORT}/json/close/${elsewhereTarget}${agentQuery}`)).status).toBe(404);
  expect((await fetch(`http://127.0.0.1:${PORT}/json/activate/${elsewhereTarget}${agentQuery}`)).status).toBe(404);
  await expect(page.locator(`.react-flow__node-browser[data-id="${elsewhere}"]`)).toHaveCount(1);

  // A tile the person opens in another frame does not become the agent's next page.
  await send("Target.setDiscoverTargets", { discover: true });
  events.length = 0;
  const frame = (await page.locator(".react-flow__node-frame").first().getAttribute("data-id"))!;
  const browsers = page.locator(".react-flow__node-browser");
  const before = await browsers.count();
  await page.evaluate((f) => window.dispatchEvent(new CustomEvent("hivemind:frame-open", { detail: { frameId: f, kind: "browser" } })), frame);
  await expect(browsers).toHaveCount(before + 1);
  const known = new Set([beside, elsewhere]);
  const ids = await browsers.evaluateAll((els) => els.map((e) => e.getAttribute("data-id")!));
  const opened = await targetOf(ids.find((id) => !known.has(id))!);
  await page.waitForTimeout(500);
  expect(events.map((e) => e.params.targetInfo?.targetId)).not.toContain(opened);
  ws.close();
});

test("a connection that does not prove which agent it is sees no tile until one is shared with every agent", async () => {
  expect(await list("")).toEqual([]);
  const tile = new URLSearchParams(agentQuery).get("tile");
  expect(await list(`?tile=${tile}&key=not-its-key`)).toEqual([]);

  await page.evaluate((id) => window.hive.settingsSet("agentBrowser.tiles", { [id]: "all" }), elsewhere);
  await expect.poll(async () => (await list("")).map((t) => t.id)).toEqual([elsewhereTarget]);
  await page.evaluate(() => window.hive.settingsSet("agentBrowser.tiles", {}));
  await expect.poll(() => list("")).toEqual([]);
});

test("an agent reads the cookies of the sites it has a tile on, and cannot touch what is the person's", async () => {
  await go(elsewhere, `http://localhost:${sitePort}/?name=theirs`);
  await go(beside, `http://127.0.0.1:${sitePort}/?name=mine`);
  await expect.poll(() => page.evaluate((id) => window.hive.browserCdp(id, "Runtime.evaluate", { expression: "location.host", returnByValue: true }) as Promise<{ result: { value: string } }>, beside).then((r) => r.result.value))
    .toBe(`127.0.0.1:${sitePort}`);

  const { ws, send } = await connect(agentQuery);
  const sessionId = (await send("Target.attachToTarget", { targetId: besideTarget, flatten: true })).result!.sessionId!;
  // How the page's browser context answers for every site, as `state save` asks it.
  const cookies = async () => (await send("Network.getAllCookies", {}, sessionId)).result!.cookies!.map((c) => c.name);
  await expect.poll(cookies).toContain("mine");
  expect(await cookies()).not.toContain("theirs");
  expect((await send("Network.setCookie", { name: "x", value: "y", domain: "localhost" })).error?.message).toContain("not open in a Browser tile");
  expect((await send("Storage.clearDataForOrigin", { origin: `http://localhost:${sitePort}`, storageTypes: "cookies" })).error?.message).toContain("not open in a Browser tile");
  expect((await send("Network.clearBrowserCookies")).error?.message).toContain("shared with the person");
  expect((await send("Browser.grantPermissions", { permissions: ["geolocation"] })).error?.message).toContain("shared with the person");
  expect((await send("Browser.close")).error?.message).toContain("shared with the person");
  // The app is still there, and so is the person's login.
  const all = await page.evaluate((id) => window.hive.browserCdp(id, "Network.getCookies", { urls: ["http://localhost/"] }) as Promise<{ cookies: { name: string }[] }>, elsewhere);
  expect(all.cookies.map((c) => c.name)).toContain("theirs");
  ws.close();
});

test("the person shares a tile with every agent from the tile, and takes it back: a connection holding it ends", async () => {
  const menu = (tile: string) => page.locator(`.react-flow__node-browser[data-id="${tile}"] [data-agent-access]`);
  // By keyboard: a frame may be off the canvas's view.
  const choose = async (tile: string, name: string) => {
    await menu(tile).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("menuitemradio", { name }).focus();
    await page.keyboard.press("Enter");
  };
  await choose(elsewhere, "Every agent");
  await expect(menu(elsewhere)).toHaveAttribute("data-agent-access", "all");
  await expect.poll(async () => (await list(agentQuery)).map((t) => t.id).sort()).toEqual([besideTarget, elsewhereTarget].sort());

  const { send, closed } = await connect(agentQuery);
  expect((await send("Target.attachToTarget", { targetId: elsewhereTarget, flatten: true })).result?.sessionId).toBeTruthy();
  await choose(elsewhere, "Agents in this frame");
  await closed;
  expect((await list(agentQuery)).map((t) => t.id)).toEqual([besideTarget]);
});

test("a note on a page is a picture of it: an agent cannot leave one on a tile it may not use", async () => {
  const shell = new URLSearchParams(agentQuery).get("tile")!;
  const token = tileToken(fs.readFileSync(path.join(ud, "hcp.token"), "utf8").trim(), `hm:${shell}`);
  const r = await new Promise<{ code: number | null; out: string }>((resolve) => {
    const c = spawn("bun", [path.resolve("../cli/src/index.ts"), "ctl", "notes", "add", "--tile", elsewhere, "--selector", "input", "--body", "see this", "--json"],
      { env: { ...process.env, HIVEMIND_APP_DATA: ud, HIVEMIND_TILE: shell, HCP_TOKEN: token }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    c.on("close", (code) => resolve({ code, out }));
  });
  expect(r.code).not.toBe(0);
  expect(r.out).toContain("that you can use");
});

test("while an agent changes the page the tile says so, and Stop ends it and shuts the agents out", async () => {
  const { send, closed } = await connect(agentQuery);
  const sessionId = (await send("Target.attachToTarget", { targetId: besideTarget, flatten: true })).result!.sessionId!;
  const tile = page.locator(`.react-flow__node-browser[data-id="${beside}"]`);
  await expect(tile.locator("[data-agent-driving]")).toHaveCount(0);
  await send("Input.insertText", { text: "x" }, sessionId);
  await expect(tile.locator("[data-agent-driving]")).toContainText("is using this page");

  await tile.locator("[data-agent-driving]").getByRole("button", { name: "Stop" }).evaluate((b) => (b as HTMLElement).click());
  await closed;
  await expect(tile.locator("[data-agent-access]")).toHaveAttribute("data-agent-access", "none");
  await expect(tile.locator("[data-agent-driving]")).toHaveCount(0);
  expect(await list(agentQuery)).toEqual([]);
  await page.evaluate(() => window.hive.settingsSet("agentBrowser.tiles", {}));
});
