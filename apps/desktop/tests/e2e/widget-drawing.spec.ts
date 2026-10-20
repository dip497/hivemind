// A widget that draws a node the app has no drawing for has failed, and says which: an agent sees
// it in `hive ctl plugin list` and `plugin open` exits 1, instead of an empty card and "ready".
import { test, expect, _electron as electron, type ElectronApplication } from "@playwright/test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { seedAgents } from "./helpers/agents";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-widget-drawing-"));
const xdg = path.join(root, "config");
seedAgents(xdg, ["claude"]);
const repo = path.join(root, "repo");
const env = { ...process.env, XDG_CONFIG_HOME: xdg, HIVEMIND_SHELL_ENV: "0" } as Record<string, string>;
delete env.ELECTRON_RUN_AS_NODE;
const cli = path.resolve(process.cwd(), "../cli/src/index.ts");
let hcp: Record<string, string> = {};
const hive = (...args: string[]) => {
  const r = spawnSync("bun", [cli, ...args, "--json"], { cwd: repo, env: { ...env, ...hcp }, encoding: "utf8" });
  return { status: r.status, data: JSON.parse(r.stdout.trim() || "null") };
};
let app: ElectronApplication;

test.beforeAll(async () => {
  fs.mkdirSync(repo, { recursive: true });
  expect(hive("plugins", "install", path.resolve(process.cwd(), "tests/e2e/fixtures/widgets/chart")).status).toBe(0);
  app = await electron.launch({ args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox"], cwd: repo, env });
  await (await app.firstWindow()).waitForSelector(".react-flow", { timeout: 30_000 });
  const userData = path.join(xdg, "hivemind-dev");
  await expect.poll(() => fs.existsSync(path.join(userData, "hcp.token"))).toBe(true);
  hcp = { HIVEMIND_APP_DATA: userData };
});
test.afterAll(async () => { await app?.close(); fs.rmSync(root, { recursive: true, force: true }); });

test("a widget drawing a node the app does not draw is failed, naming it", async () => {
  let opened = { status: null as number | null, data: {} as { state?: string; reason?: string } };
  await expect.poll(() => (opened = hive("ctl", "plugin", "open", "@example/chart")).data?.widget, { timeout: 20_000 }).toBeTruthy();
  const listed = () => (hive("ctl", "plugin", "list").data.plugins as Array<{ plugin: string; state: string; reason?: string }>).find((p) => p.plugin === "@example/chart");
  await expect.poll(() => listed()?.state, { timeout: 20_000 }).toBe("failed");
  expect(listed()?.reason).toContain('children[1] is a "chart", which the app does not draw');
});
