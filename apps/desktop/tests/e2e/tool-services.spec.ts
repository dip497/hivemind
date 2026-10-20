// A tool plugin's service (D8) in the app: switched on, it waits for a workspace to be picked on
// its page; picked, it runs and drives that workspace through the drive socket as a grant of its
// own, refused what its role does not reach, its log on the page; switched off, it stops and its
// grant is taken back; and it does not outlive the app.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { seedAgents } from "./helpers/agents";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hm-tool-services-")));
const xdg = path.join(root, "config");
seedAgents(xdg);
const repo = path.join(root, "repo");
const userData = path.join(xdg, "hivemind-dev");
const env = { ...process.env, XDG_CONFIG_HOME: xdg } as Record<string, string>;
delete env.ELECTRON_RUN_AS_NODE;
// The app this suite runs from may itself run in an agent's tile: none of that reaches the service.
env.HCP_TOKEN = "agent-token-of-the-parent";
env.HIVEMIND_TILE = "hm:parent";
const cli = path.resolve(process.cwd(), "../cli/src/index.ts");
const hive = (...args: string[]) => {
  const r = spawnSync("bun", [cli, ...args, "--json"], { cwd: repo, env: { ...env, HCP_TOKEN: "", HIVEMIND_TILE: "", HIVEMIND_APP_DATA: userData }, encoding: "utf8" });
  if (!r.stdout.trim()) throw new Error(r.stderr);
  return { status: r.status, data: JSON.parse(r.stdout) };
};

// The plugin: a tool, and a service that says who it drives as, what of the app's environment it
// was given, and what its role lets it do.
const plugin = path.join(root, "watcher");
fs.mkdirSync(plugin, { recursive: true });
fs.writeFileSync(path.join(plugin, "hivemind-tool.json"), JSON.stringify({
  id: "@acme/watcher", name: "Watcher", version: "1.0.0", apiVersion: 1, entry: "index.js",
  tools: [{ key: "watch", label: "Watch", tileKind: "acme-watch" }],
  service: { command: ["node", "service.js"], role: "view" },
}));
fs.writeFileSync(path.join(plugin, "index.js"), "export default { tiles: {} };\n");
fs.writeFileSync(path.join(plugin, "service.js"), `
const net = require("node:net");
console.log("tokens " + (["HCP_TOKEN", "HIVEMIND_TILE"].filter((k) => k in process.env).join(",") || "none"));
process.stdin.on("end", () => process.exit(0)).resume();
const c = net.connect(process.env.HIVE_DRIVE_SOCK, () => c.write(JSON.stringify({ hello: { token: process.env.HIVE_DRIVE_TOKEN } }) + "\\n"));
let buf = "";
const call = (id, method, params) => c.write(JSON.stringify({ id, method, params }) + "\\n");
c.on("data", (d) => {
  buf += d;
  for (let i; (i = buf.indexOf("\\n")) >= 0; ) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (Array.isArray(m) || m.event) continue;
    if (m.hello) { console.log("as " + JSON.stringify(m.hello.as)); call(1, "agent.list", [m.hello.as.workspace]); }
    else if (m.id === 1) { console.log("agents " + (m.error ? m.error.code : "listed")); call(2, "git.push", [${JSON.stringify(repo)}]); }
    else if (m.id === 2) console.log("push " + (m.error ? m.error.code : "done"));
  }
});
`);

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  fs.mkdirSync(repo, { recursive: true });
  execSync("git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m first", { cwd: repo });
  expect(hive("plugins", "install", plugin).status).toBe(0);
  expect(hive("plugins", "enable", "tool:@acme/watcher").status).toBe(0);
  app = await electron.launch({ args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox"], cwd: repo, env });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 30_000 });
});
test.afterAll(async () => { await app?.close(); fs.rmSync(root, { recursive: true, force: true }); });

const section = () => page.locator('[data-service="@acme/watcher"]');
const state = () => section().locator("[data-service-state]");
const ours = () => (hive("grant", "list").data.data as Array<{ name: string; plugin?: string; repos: string[]; role: string }>).filter((g) => g.plugin === "@acme/watcher");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("switched on, it waits for a workspace; picked, it drives that one as its own grant and no more", async () => {
  await page.locator('[aria-label="settings"]').click();
  await page.locator('[data-settings-page="plugins"]').click();
  await page.locator('[data-plugin-open="tool:@acme/watcher"]').click();
  await page.locator('[data-plugin-tab="about"]').click();
  await expect(page.getByText("Keeps node service.js running while it is on")).toBeVisible();
  await page.locator('[data-plugin-tab="settings"]').click();
  await expect(state()).toHaveAttribute("data-service-state", "stopped");
  await expect(state()).toContainText("no workspace is picked for it");
  expect(ours()).toEqual([]);

  await section().locator(`[data-service-workspace="${repo}"]`).getByRole("switch").click();
  await expect(state()).toHaveAttribute("data-service-state", "running", { timeout: 10_000 });
  const log = section().locator("[data-service-log]");
  await expect(log).toContainText(`as ${JSON.stringify({ client: "Watcher service", role: "view", workspace: repo })}`, { timeout: 10_000 });
  await expect(log).toContainText("agents listed");
  await expect(log).toContainText("push FORBIDDEN");
  await expect(log).toContainText("tokens none");
  expect(ours()).toMatchObject([{ name: "Watcher service", role: "view", repos: [repo] }]);
});

test("switched off, it stops and its grant is taken back; on again, it does not outlive the app", async () => {
  const pids = async () => [...(await section().locator("[data-service-log]").innerText()).matchAll(/started, pid (\d+)/g)].map((m) => Number(m[1]));
  const [first] = await pids();
  expect(hive("plugins", "disable", "tool:@acme/watcher").status).toBe(0);
  await expect(state()).toHaveAttribute("data-service-state", "off");
  await expect.poll(() => alive(first!)).toBe(false);
  expect(ours()).toEqual([]);

  expect(hive("plugins", "enable", "tool:@acme/watcher").status).toBe(0);
  await expect(state()).toHaveAttribute("data-service-state", "running", { timeout: 10_000 });
  await expect.poll(async () => (await pids()).length).toBe(2);
  const second = (await pids())[1]!;
  expect(alive(second)).toBe(true);
  await app.close();
  await expect.poll(() => alive(second)).toBe(false);
  // The app stopped it; its stdin closing would have too, as the contract asks of a service.
  expect(fs.readFileSync(path.join(userData, "services", "acme--watcher.log"), "utf8")).toContain("stopping: the app stopped");
});
