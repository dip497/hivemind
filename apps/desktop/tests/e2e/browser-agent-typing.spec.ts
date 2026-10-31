// What an agent types into a Browser tile's page over the CDP port (agent-browser's `fill` and
// `press`, as the hive-browser skill drives it) lands in that page, whatever has focus in the
// app: never in the tile the person was last typing in.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const PORT = String(9400 + Math.floor(Math.random() * 400));
let app: ElectronApplication;
let page: Page;
const ud = fs.mkdtempSync(path.join(os.tmpdir(), "hm-agent-typing-"));

test.beforeAll(async () => {
  const env = { ...process.env, HIVEMIND_BROWSER_CDP: "1", HIVEMIND_BROWSER_CDP_PORT: PORT } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.resolve("out/main/index.js"), "--no-sandbox", `--user-data-dir=${ud}`], cwd: path.resolve("."), env });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 15_000 });
  await page.evaluate(() => window.hive.settingsSet("plugins.state.tool:@hivemind/web", { enabled: true }));
});
test.afterAll(async () => { await app?.close(); fs.rmSync(ud, { recursive: true, force: true }); });

/** A CDP session on the target whose url starts with `url`, over the app's debug port. */
async function session(url: string) {
  let target: { webSocketDebuggerUrl: string } | undefined;
  await expect.poll(async () => {
    const list = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()) as { url: string; webSocketDebuggerUrl: string }[];
    target = list.find((t) => t.url.startsWith(url));
    return !!target;
  }, { timeout: 15_000 }).toBe(true);
  const ws = new WebSocket(target!.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  const send = (method: string, params: Record<string, unknown> = {}) => new Promise<{ result?: { result?: { value?: unknown } } }>((resolve) => {
    const n = ++id;
    const hear = (e: MessageEvent) => { const m = JSON.parse(String(e.data)); if (m.id === n) { ws.removeEventListener("message", hear); resolve(m); } };
    ws.addEventListener("message", hear);
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  return { send, close: () => ws.close() };
}

const LOGIN = "data:text/html,<title>login</title><form onsubmit=\"document.title='sent:'+email.value;return false\"><input id=email></form>";
const fieldInApp = () => page.evaluate(() => (document.getElementById("elsewhere") as HTMLTextAreaElement).value);
const key = (k: string, text?: string) => [
  { type: text ? "keyDown" : "rawKeyDown", key: k, code: k, windowsVirtualKeyCode: 0, ...(text ? { text, unmodifiedText: text } : {}) },
  { type: "keyUp", key: k, code: k, windowsVirtualKeyCode: 0 },
];

test("what an agent types into a browser tile's page lands in that page, not in the app's focused field", async () => {
  await page.keyboard.press("6");
  await page.waitForSelector(".react-flow__node-frame");
  const frameId = await page.locator(".react-flow__node-frame").first().getAttribute("data-id");
  await page.evaluate((fid) => window.dispatchEvent(new CustomEvent("hivemind:frame-open", { detail: { frameId: fid, kind: "browser" } })), frameId);
  const tileId = await page.locator(".react-flow__node-browser").first().getAttribute("data-id");
  await expect.poll(() => page.evaluate(async (id) => {
    try { await window.hive.browserCdp(id!, "Runtime.evaluate", { expression: "1" }); return true; } catch { return false; }
  }, tileId), { timeout: 25_000 }).toBe(true);
  await page.evaluate(([id, url]) => window.hive.browserCdp(id!, "Page.navigate", { url }), [tileId, LOGIN]);

  // The person was typing somewhere else in the app: a terminal, here a field that stands for one.
  await page.evaluate(() => {
    const f = document.createElement("textarea");
    f.id = "elsewhere";
    document.body.appendChild(f);
    f.focus();
  });

  const guest = await session("data:text/html,<title>login");
  await guest.send("Runtime.evaluate", { expression: "document.getElementById('email').focus()" });
  await guest.send("Input.insertText", { text: "test@example.com" });
  for (const k of [...key("x", "x"), ...key("Backspace"), ...key("Enter", "\r")]) await guest.send("Input.dispatchKeyEvent", k);
  const title = await guest.send("Runtime.evaluate", { expression: "document.title", returnByValue: true });
  guest.close();

  expect(await fieldInApp()).toBe("");
  expect(title.result?.result?.value).toBe("sent:test@example.com");

  // The same through the app's own way in (hive ctl, automation in the app).
  await page.evaluate((id) => window.hive.browserCdp(id!, "Runtime.evaluate", { expression: "document.getElementById('email').value=''; document.getElementById('email').focus()" }), tileId);
  await page.evaluate(() => document.getElementById("elsewhere")!.focus());
  await page.evaluate((id) => window.hive.browserCdp(id!, "Input.insertText", { text: "again" }), tileId);
  expect(await fieldInApp()).toBe("");
  expect(await page.evaluate(async (id) => ((await window.hive.browserCdp(id!, "Runtime.evaluate", { expression: "document.getElementById('email').value", returnByValue: true })) as { result: { value: string } }).result.value, tileId)).toBe("again");

  // And from the page as the app serves it to a browser tab or a phone.
  await page.evaluate((id) => window.hive.browserCdp(id!, "Runtime.evaluate", { expression: "document.getElementById('email').value=''; document.getElementById('email').focus()" }), tileId);
  await page.evaluate((id) => window.hive.browserWatch(id!), tileId);
  await page.evaluate(() => document.getElementById("elsewhere")!.focus());
  await page.evaluate(async (id) => {
    await window.hive.browserInput(id!, { kind: "text", text: "phone" });
    await window.hive.browserInput(id!, { kind: "key", type: "keyDown", key: "Enter", code: "Enter", keyCode: 13, text: "\r", modifiers: 0 });
    await window.hive.browserInput(id!, { kind: "key", type: "keyUp", key: "Enter", code: "Enter", keyCode: 13, text: "", modifiers: 0 });
  }, tileId);
  expect(await fieldInApp()).toBe("");
  await expect.poll(() => page.evaluate(async (id) => ((await window.hive.browserCdp(id!, "Runtime.evaluate", { expression: "document.title", returnByValue: true })) as { result: { value: string } }).result.value, tileId)).toBe("sent:phone");
  await page.evaluate((id) => window.hive.browserUnwatch(id!), tileId);
});

test("a web page cannot drive the app through the agents' port", async () => {
  const { WebSocket: Socket } = await import("ws");
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()) as { webSocketDebuggerUrl: string }[];
  expect(list[0]!.webSocketDebuggerUrl).toContain(`127.0.0.1:${PORT}/`);
  const opened = (headers: Record<string, string>) => new Promise<boolean>((resolve) => {
    const ws = new Socket(list[0]!.webSocketDebuggerUrl, { headers });
    ws.once("open", () => { ws.close(); resolve(true); });
    ws.once("error", () => resolve(false));
  });
  expect(await opened({})).toBe(true);
  expect(await opened({ Origin: "https://example.com" })).toBe(false);
  // A page that renamed itself to this address (DNS rebinding) asks by its own name.
  const status = await new Promise<number>((resolve) => http.get({ host: "127.0.0.1", port: Number(PORT), path: "/json", headers: { Host: `evil.example:${PORT}` } }, (r) => { r.resume(); resolve(r.statusCode ?? 0); }));
  expect(status).toBe(403);
});

test("the agents' port shows only Browser tiles: the app's own window is neither listed nor reachable", async () => {
  const appWindow = await app.evaluate(async ({ BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows()[0]!.webContents;
    if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
    return ((await wc.debugger.sendCommand("Target.getTargetInfo")) as { targetInfo: { targetId: string } }).targetInfo.targetId;
  });
  const listed = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()) as { id: string; url: string }[];
  expect(listed.length).toBeGreaterThan(0);
  expect(listed.map((t) => t.id)).not.toContain(appWindow);
  expect(listed.every((t) => !t.url.includes("index.html"))).toBe(true);

  const { WebSocket: Socket } = await import("ws");
  const opened = (url: string) => new Promise<boolean>((resolve) => {
    const ws = new Socket(url);
    ws.once("open", () => { ws.close(); resolve(true); });
    ws.once("error", () => resolve(false));
  });
  expect(await opened(`ws://127.0.0.1:${PORT}/devtools/page/${listed[0]!.id}`)).toBe(true);
  expect(await opened(`ws://127.0.0.1:${PORT}/devtools/page/${appWindow}`)).toBe(false);

  // The browser's own connection, as agent-browser uses it.
  const version = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()) as { webSocketDebuggerUrl: string };
  const ws = new Socket(version.webSocketDebuggerUrl);
  await new Promise((r) => ws.once("open", r));
  let n = 0;
  const send = (method: string, params: object = {}) => new Promise<{ result?: { targetInfos?: { targetId: string }[] }; error?: { message: string } }>((resolve) => {
    const id = ++n;
    const hear = (d: Buffer) => { const m = JSON.parse(d.toString()); if (m.id === id) { ws.off("message", hear); resolve(m); } };
    ws.on("message", hear);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const targets = (await send("Target.getTargets")).result!.targetInfos!.map((t) => t.targetId);
  expect(targets).not.toContain(appWindow);
  expect(targets).toContain(listed[0]!.id);
  expect((await send("Target.attachToTarget", { targetId: appWindow, flatten: true })).error?.message).toContain("No target");
  ws.close();
});

test("a terminal's agent-browser drives the Browser tiles with no setup: its frame's tile first, and a new tab is a tile beside it", async () => {
  // A second frame, with a Browser tile and a terminal in it.
  const before = await page.locator(".react-flow__node-frame").count();
  await page.evaluate(() => { document.getElementById("elsewhere")?.remove(); (document.activeElement as HTMLElement | null)?.blur(); });
  await page.keyboard.press("6");
  await expect(page.locator(".react-flow__node-frame")).toHaveCount(before + 1);
  const frame = (await page.locator(".react-flow__node-frame").last().getAttribute("data-id"))!;
  const browsers = page.locator(".react-flow__node-browser");
  const tilesBefore = await browsers.count();
  await page.evaluate((f) => window.dispatchEvent(new CustomEvent("hivemind:frame-open", { detail: { frameId: f, kind: "browser" } })), frame);
  await expect(browsers).toHaveCount(tilesBefore + 1);
  const mine = (await browsers.last().getAttribute("data-id"))!;
  await page.evaluate((f) => window.dispatchEvent(new CustomEvent("hivemind:frame-open", { detail: { frameId: f, kind: "shell" } })), frame);
  const term = page.locator(".react-flow__node-terminal").last();
  const shell = (await term.getAttribute("data-id"))!;

  // Its environment names its own tile and a session of its own.
  await term.locator(".xterm-screen").click();
  const screen = () => term.evaluate((el) => ([el, ...el.querySelectorAll("*")].find((e) => "__hmScreen" in e) as (Element & { __hmScreen(): string }) | undefined)?.__hmScreen() ?? "");
  await expect.poll(async () => { await page.keyboard.type('echo "[$AGENT_BROWSER_CDP|$AGENT_BROWSER_SESSION]"\n'); return screen(); }, { timeout: 20_000, intervals: [1500] })
    .toContain(`[http://127.0.0.1:${PORT}/?tile=${shell}|hivemind-${shell}]`);

  // Connected as it would be: the tile in its frame comes first, the one a session takes.
  const target = (tile: string) => page.evaluate(async (id) => {
    for (let i = 0; i < 100; i++) {
      try { return ((await window.hive.browserCdp(id, "Target.getTargetInfo", {})) as { targetInfo: { targetId: string } }).targetInfo.targetId; } catch { await new Promise((r) => setTimeout(r, 200)); }
    }
    return null;
  }, tile);
  const mineTarget = await target(mine);
  const { WebSocket: Socket } = await import("ws");
  const version = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()) as { webSocketDebuggerUrl: string };
  const ws = new Socket(`${version.webSocketDebuggerUrl}?tile=${shell}`);
  await new Promise((r) => ws.once("open", r));
  let n = 0;
  const send = (method: string, params: object = {}) => new Promise<{ result?: { targetId?: string; targetInfos?: { targetId: string }[] }; error?: { message: string } }>((resolve) => {
    const id = ++n;
    const hear = (d: Buffer) => { const m = JSON.parse(d.toString()); if (m.id === id) { ws.off("message", hear); resolve(m); } };
    ws.on("message", hear);
    ws.send(JSON.stringify({ id, method, params }));
  });
  expect((await send("Target.getTargets")).result!.targetInfos![0]!.targetId).toBe(mineTarget);

  // A new tab is a Browser tile, opened in the terminal's frame.
  const made = await send("Target.createTarget", { url: "about:blank" });
  expect(made.error).toBeUndefined();
  await expect(browsers).toHaveCount(tilesBefore + 2);
  const opened = (await browsers.last().getAttribute("data-id"))!;
  expect(await target(opened)).toBe(made.result!.targetId);
  expect(await page.evaluate(([t, f]) => document.querySelector(`.react-flow__node-frame[data-id="${f}"]`) !== null && !!document.querySelector(`.react-flow__node[data-id="${t}"]`), [opened, frame] as const)).toBe(true);
  // Only a web address: not a file of this computer's.
  expect((await send("Target.createTarget", { url: "file:///etc/passwd" })).error?.message).toContain("http and https");
  await expect(browsers).toHaveCount(tilesBefore + 2);
  ws.close();
});
