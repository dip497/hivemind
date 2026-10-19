// A tool whose code does not load is still a tile an agent can see, count and close: listed as
// failed with why, opened once when it is one of a kind, closed by `hive ctl plugin close`.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { seedAgents } from "./helpers/agents";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-crashed-tool-"));
const xdg = path.join(root, "config");
seedAgents(xdg, ["claude"]);
const repo = path.join(root, "repo");
const env = { ...process.env, XDG_CONFIG_HOME: xdg, HIVEMIND_SHELL_ENV: "0" } as Record<string, string>;
delete env.ELECTRON_RUN_AS_NODE;
const cli = path.resolve(process.cwd(), "../cli/src/index.ts");
const fixture = path.resolve(process.cwd(), "tests/e2e/fixtures/tools/broken");
let hcp: Record<string, string> = {};
const hive = (...args: string[]) => {
  const result = spawnSync("bun", [cli, ...args, "--json"], { cwd: repo, env: { ...env, ...hcp }, encoding: "utf8" });
  if (!result.stdout.trim()) throw new Error(result.stderr);
  return { status: result.status, data: JSON.parse(result.stdout) };
};

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  fs.mkdirSync(repo, { recursive: true });
  expect(hive("tools", "install", fixture).status).toBe(0);
  expect(hive("plugins", "enable", "tool:example/broken").status).toBe(0);
  app = await electron.launch({ args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox"], cwd: repo, env });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 30_000 });
  const userData = path.join(xdg, "hivemind-dev");
  await expect.poll(() => fs.existsSync(path.join(userData, "hcp.token"))).toBe(true);
  hcp = { HIVEMIND_APP_DATA: userData };
});
test.afterAll(async () => { await app?.close(); fs.rmSync(root, { recursive: true, force: true }); });

const listed = () => (hive("ctl", "plugin", "list").data.plugins as Array<{ plugin: string; instance: string; state: string; reason?: string }>).filter((p) => p.plugin === "example/broken");

test("a tool whose code does not load is listed as failed with why, and opening it says so", async () => {
  let opened = { status: null as number | null, data: {} as { tile?: string; state?: string; reason?: string } };
  await expect.poll(() => (opened = hive("ctl", "plugin", "open", "tool:example/broken")).data.tile, { timeout: 20_000 }).toBeTruthy();
  expect(opened.status).toBe(1);
  expect(opened.data.state).toBe("failed");
  await expect(page.locator('[data-tool-plugin="example/broken"]')).toContainText("stopped", { timeout: 20_000 });
  expect(listed()).toEqual([expect.objectContaining({ instance: opened.data.tile, state: "failed", reason: expect.stringMatching(/./) })]);
});

test("one of a kind: opening it again brings the failed tile forward instead of another", async () => {
  const first = listed()[0]!.instance;
  for (let i = 0; i < 2; i++) expect(hive("ctl", "open-tool", "example/broken").data.tile).toBe(first);
  expect(listed()).toHaveLength(1);
  await expect(page.locator('[data-tool-plugin="example/broken"]')).toHaveCount(1);
});

test("the failed tile closes with plugin close", async () => {
  const closed = hive("ctl", "plugin", "close", "tool:example/broken");
  expect(closed.status).toBe(0);
  await expect(page.locator('[data-tool-plugin="example/broken"]')).toHaveCount(0);
  expect(listed()).toEqual([]);
});
