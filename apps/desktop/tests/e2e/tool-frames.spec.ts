// A tool can frame a server on this machine (127.0.0.1, localhost) and nothing else; when the
// page's policy blocks a frame, or its code throws, its tile says why and the agent reads it as
// failed in `hive ctl plugin list`. The tool is a fixture, `@example/frames`, framing its setting.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { seedAgents } from "./helpers/agents";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-tool-frames-"));
const xdg = path.join(root, "config");
seedAgents(xdg, ["claude"]);
const repo = path.join(root, "repo");
const env = { ...process.env, XDG_CONFIG_HOME: xdg, HIVEMIND_SHELL_ENV: "0" } as Record<string, string>;
delete env.ELECTRON_RUN_AS_NODE;
const cli = path.resolve(process.cwd(), "../cli/src/index.ts");
const fixture = path.resolve(process.cwd(), "tests/e2e/fixtures/tools/frames");
let hcp: Record<string, string> = {};
const hive = (...args: string[]) => {
  const result = spawnSync("bun", [cli, ...args, "--json"], { cwd: repo, env: { ...env, ...hcp }, encoding: "utf8" });
  if (!result.stdout.trim()) throw new Error(result.stderr);
  return { status: result.status, data: JSON.parse(result.stdout) };
};

let app: ElectronApplication;
let page: Page;
let server: http.Server;
let local = "";
let evilAsked = 0;

test.beforeAll(async () => {
  fs.mkdirSync(repo, { recursive: true });
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url === "/evil") { evilAsked++; res.end("<p>not the app</p>"); return; }
    res.end('<p>served from this machine</p><button onclick="top.location = \'/evil\'">leave</button>');
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  local = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  expect(hive("plugins", "install", fixture).status).toBe(0);
  expect(hive("plugins", "enable", "tool:@example/frames").status).toBe(0);
  expect(hive("plugins", "set", "tool:@example/frames", "url", local).status).toBe(0);
  app = await electron.launch({ args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox"], cwd: repo, env });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 30_000 });
  const userData = path.join(xdg, "hivemind-dev");
  await expect.poll(() => fs.existsSync(path.join(userData, "hcp.token"))).toBe(true);
  hcp = { HIVEMIND_APP_DATA: userData };
});
test.afterAll(async () => { await app?.close(); server?.close(); fs.rmSync(root, { recursive: true, force: true }); });

const tile = () => page.locator('[data-tool-plugin="@example/frames"]');
const stateOf = () => (hive("ctl", "plugin", "list").data.plugins as Array<{ plugin: string; state: string; reason?: string }>).find((p) => p.plugin === "@example/frames");

test("a tool frames a server on this machine", async () => {
  await expect.poll(() => hive("ctl", "open-tool", "@example/frames").status).toBe(0);
  await expect.poll(async () => {
    const frame = page.frames().find((f) => f.url() === local);
    return frame ? await frame.locator("p").textContent().catch(() => null) : null;
  }, { timeout: 20_000 }).toBe("served from this machine");
  await expect.poll(() => stateOf()?.state).toBe("ready");
});

test("a framed page cannot send the app's window to another page", async () => {
  const before = page.url();
  const framed = page.frameLocator('iframe[title="framed"]');
  await framed.getByRole("button", { name: "leave" }).click();
  await page.waitForTimeout(1500);
  expect(page.url()).toBe(before);
  expect(evilAsked).toBe(0);
  expect(await page.evaluate(() => typeof window.hive)).toBe("object");
});

test("a frame of another machine is blocked, and the tile fails saying why", async () => {
  expect(hive("plugins", "set", "tool:@example/frames", "url", "http://192.0.2.1/").status).toBe(0);
  await expect(tile()).toContainText("security policy blocked", { timeout: 20_000 });
  await expect.poll(() => stateOf()?.state).toBe("failed");
  expect(stateOf()?.reason).toContain("frame-src");
});

test("a page that is not the app's, in the app's window, is given no bridge", async () => {
  const evil = `${local}evil`;
  await app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows()[0]!.loadURL(url), evil);
  await expect.poll(() => page.url()).toBe(evil);
  expect(await page.evaluate(() => typeof (window as { hive?: unknown }).hive)).toBe("undefined");
});
