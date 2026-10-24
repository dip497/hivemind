// A tool plugin's service (D8) in the app: switched on, it waits for a workspace to be picked on
// its page; picked, it runs and drives that workspace through the drive socket as a grant of its
// own, refused what its role does not reach, its log on the page; it reads the secret the person
// typed on its page (never shown again, never in settings.json) and its options, writes an issue
// signed as itself, hears an issue the CLI changed, and answers `hive ctl plugin call` with no
// tile open; switched off, it stops and its grant is taken back; and it does not outlive the app.
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
  // What it answers on stdout; a failure, `{ error: { code, message } }`, on stderr.
  if (r.stdout.trim()) return { status: r.status, data: JSON.parse(r.stdout) };
  try { return { status: r.status, data: JSON.parse(r.stderr).error }; } catch { throw new Error(r.stderr); }
};

// The plugin: a tool, and a service that says who it drives as, what of the app's environment it
// was given, and what its role lets it do.
const plugin = path.join(root, "watcher");
fs.mkdirSync(plugin, { recursive: true });
fs.writeFileSync(path.join(plugin, "hivemind-tool.json"), JSON.stringify({
  id: "@acme/watcher", name: "Watcher", version: "1.0.0", apiVersion: 1, entry: "index.js",
  tools: [{ key: "watch", label: "Watch", tileKind: "acme-watch" }],
  settings: [{ id: "token", label: "API token", type: "secret" }, { id: "site", label: "Site", type: "text", default: "acme.example" }],
  service: { command: ["node", "service.js"], role: "edit" },
}));
const SECRET = "e2e-secret-value";
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
    for (const e of Array.isArray(m) ? m : m.event ? [m] : []) {
      if (e.event === "issue.changed") console.log("changed " + e.params[1].id + " " + e.params[1].fields.join(",") + " by " + e.params[1].by);
      if (e.event === "plugin.called") c.write(JSON.stringify({ method: "plugin.answer", params: [e.params[0].call, { result: { pong: e.params[0].args } }] }) + "\n");
    }
    if (Array.isArray(m) || m.event) continue;
    if (m.hello) { console.log("as " + JSON.stringify(m.hello.as)); call(1, "agent.list", [m.hello.as.workspace]); }
    else if (m.id === 1) { console.log("agents " + (m.error ? m.error.code : "listed")); call(2, "git.push", [${JSON.stringify(repo)}]); }
    else if (m.id === 2) { console.log("push " + (m.error ? m.error.code : "done")); call(3, "plugin.options", []); }
    else if (m.id === 3) { console.log("options " + JSON.stringify(m.result)); call(4, "secret.get", ["token"]); }
    else if (m.id === 4) { console.log("secret " + (m.result === ${JSON.stringify(SECRET)} ? "read" : "wrong")); call(5, "issue.create", [${JSON.stringify(path.join(repo, ".hivemind"))}, { title: "from the service" }]); }
    else if (m.id === 5) {
      console.log("issue " + (m.error ? m.error.code : m.result.id));
      c.write(JSON.stringify({ method: "plugin.serve", params: [[{ name: "ping", description: "answers pong" }]] }) + "\n");
      console.log("serving");
    }
  }
});
`);

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  fs.mkdirSync(repo, { recursive: true });
  execSync("git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m first", { cwd: repo });
  expect(hive("init", "--prefix", "TT").status).toBe(0);
  expect(hive("plugins", "install", plugin).status).toBe(0);
  expect(hive("plugins", "enable", "tool:@acme/watcher").status).toBe(0);
  app = await electron.launch({ args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox"], cwd: repo, env });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 30_000 });
});
test.afterAll(async () => { await app?.close(); fs.rmSync(root, { recursive: true, force: true }); });

const section = () => page.locator('[data-service="@acme/watcher"]');
const state = () => section().locator("[data-service-state]");
const ours = () => (hive("grant", "list").data.grants as Array<{ name: string; plugin?: string; repos: string[]; role: string }>).filter((g) => g.plugin === "@acme/watcher");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("switched on, it waits for a workspace; picked, it drives that one as its own grant and no more", async () => {
  await page.locator('[aria-label="settings"]').click();
  await page.locator('[data-settings-page="plugins"]').click();
  await page.locator('[data-plugins-kind="tool"]').click();
  await page.locator('[data-plugin-open="tool:@acme/watcher"]').click();
  await page.locator('[data-plugin-tab="about"]').click();
  await expect(page.getByText("Keeps node service.js running while it is on")).toBeVisible();
  await page.locator('[data-plugin-tab="settings"]').click();
  await expect(state()).toHaveAttribute("data-service-state", "stopped");
  await expect(state()).toContainText("no workspace is picked for it");
  expect(ours()).toEqual([]);

  // Its secret, typed on its page: masked, and never shown again; settings.json keeps only that
  // one is set.
  const secret = page.locator('[data-setting="token"]');
  await expect(secret.locator("[data-secret]")).toHaveAttribute("data-secret", "not set");
  const field = secret.locator('input[type="password"]');
  await field.fill(SECRET);
  await field.press("Enter");
  await expect(secret.locator("[data-secret]")).toHaveAttribute("data-secret", "set");
  await expect(field).toHaveValue("");
  await page.screenshot({ path: test.info().outputPath("secret-set.png") });
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(xdg, "hivemind", "settings.json"), "utf8")).plugins.state["tool:@acme/watcher"]?.options?.token).toBe(true);
  expect(fs.readFileSync(path.join(xdg, "hivemind", "settings.json"), "utf8")).not.toContain(SECRET);
  expect(await page.content()).not.toContain(SECRET);

  await section().locator(`[data-service-workspace="${repo}"]`).getByRole("switch").click();
  await expect(state()).toHaveAttribute("data-service-state", "running", { timeout: 10_000 });
  const log = section().locator("[data-service-log]");
  await expect(log).toContainText(`as ${JSON.stringify({ client: "@acme/watcher (service)", role: "edit", workspace: repo })}`, { timeout: 10_000 });
  await expect(log).toContainText("agents listed");
  await expect(log).toContainText("push FORBIDDEN");
  await expect(log).toContainText("tokens none");
  expect(ours()).toMatchObject([{ name: "@acme/watcher (service)", role: "edit", repos: [repo] }]);
});

test("it reads its own options and secret, writes an issue signed as itself, hears one the CLI changes, and answers a plugin call with no tile open", async () => {
  const log = section().locator("[data-service-log]");
  await expect(log).toContainText(`options ${JSON.stringify({ values: { site: "acme.example" }, secrets: ["token"] })}`, { timeout: 10_000 });
  await expect(log).toContainText("secret read");
  await expect(log).toContainText("issue TT-1");
  await expect(log).toContainText("serving");
  expect(hive("show", "TT-1").data.sections.activity.map((a: { who: string }) => a.who)).toEqual(["@acme/watcher (service)"]);

  expect(hive("update", "TT-1", "--title", "renamed from the CLI").status).toBe(0);
  await expect(log).toContainText(/changed TT-1 title,[a-z,]*activity by \S+/, { timeout: 10_000 });

  expect(hive("ctl", "plugin", "call", "@acme/watcher", "ping", '{"n":1}').data).toEqual({ result: { pong: { n: 1 } } });
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
