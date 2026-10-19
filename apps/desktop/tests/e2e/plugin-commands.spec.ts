// What an agent can do with the plugins in the app, through the CLI it has: get one running, list
// the commands they declare, run one and read its answer. A widget, a view and a tool from the
// test fixtures: the Progress widget's steps, the Agent board's notes, the Commits tool's list.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { seedAgents } from "./helpers/agents";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-plugin-commands-"));
const xdg = path.join(root, "config");
seedAgents(xdg);
const repo = path.join(root, "repo");
const env = { ...process.env, XDG_CONFIG_HOME: xdg, HIVEMIND_SHELL_ENV: "0" } as Record<string, string>;
delete env.ELECTRON_RUN_AS_NODE;
const cli = path.resolve(process.cwd(), "../cli/src/index.ts");
const fixtures = path.resolve(process.cwd(), "tests/e2e/fixtures");
let hcp: Record<string, string> = {};
/** The CLI an agent runs, with what it prints and how it exits. Never run synchronously: the test
 *  process must stay free to let the app's new workers start, which Playwright holds until then. */
const hive = (...args: string[]) => new Promise<{ status: number | null; out: string; err: string }>((resolve) => {
  const child = spawn("bun", [cli, ...args], { cwd: repo, env: { ...env, ...hcp } });
  let out = ""; let err = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  child.on("close", (status) => resolve({ status, out: out.trim(), err: err.trim() }));
});
const call = async (...args: string[]) => {
  const r = await hive("ctl", "plugin", "call", ...args, "--json");
  return { status: r.status, data: JSON.parse(r.out || "null") as { result?: unknown; ok?: false; code?: string; message?: string } };
};

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
  for (const [kind, dir, record] of [
    ["widgets", "widgets/progress", "widget:@example/progress"],
    ["views", "views/agent-board", "view:agent-board"],
    ["tools", "tools/commits", "tool:@example/commits"],
  ] as const) {
    const installed = await hive(kind, "install", path.join(fixtures, dir));
    expect(installed.status, installed.err).toBe(0);
    expect((await hive("plugins", "enable", record)).status).toBe(0);
  }
  app = await electron.launch({ args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox"], cwd: repo, env });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 30_000 });
  const userData = path.join(xdg, "hivemind-dev");
  await expect.poll(async () => fs.existsSync(path.join(userData, "hcp.token"))).toBe(true);
  hcp = { HIVEMIND_APP_DATA: userData };
});
test.afterAll(async () => { await app?.close(); fs.rmSync(root, { recursive: true, force: true }); });

const commands = async () => JSON.parse((await hive("ctl", "plugin", "commands", "--json")).out) as { plugins: Array<{ plugin: string; kind: string; commands: Array<{ name: string }> }> };
const running = async () => JSON.parse((await hive("ctl", "plugin", "list", "--json")).out) as { plugins: Array<{ plugin: string; instance: string; state: string }>; views: Array<{ id: string; active: boolean }> };

test("a widget's commands: an agent lists them, adds and ticks steps, and the card shows what it did", async () => {
  // Not running yet: nothing to call, the agent is told how to get it running, and its exit says not found.
  expect((await commands()).plugins.find((p) => p.plugin === "@example/progress")).toBeUndefined();
  const absent = await call("@example/progress", "list");
  expect([absent.status, absent.data.code]).toEqual([5, "NOT_FOUND"]);
  expect(absent.data.message).toContain("is not running here");

  // Opened, it answers once its code can be called: the first call straight after it runs.
  const opened = await hive("ctl", "plugin", "open", "widget:@example/progress", "--json");
  expect(opened.status, opened.err).toBe(0);
  const widget = JSON.parse(opened.out) as { widget: string; instance: string; state: string; commands: Array<{ name: string }> };
  expect(widget.widget).toMatch(/^widget-/);
  expect([widget.instance, widget.state, widget.commands.map((c) => c.name)]).toEqual([widget.widget, "ready", ["set-title", "add", "check", "list", "clear"]]);
  expect((await call("@example/progress", "set-title", '{"title":"Ship the release"}')).data.result).toEqual({ title: "Ship the release" });
  expect((await running()).plugins.find((p) => p.instance === widget.widget)?.state).toBe("ready");
  expect((await call("@example/progress", "add", '{"text":"Run the tests"}')).data.result).toEqual({ index: 0 });
  expect((await call("@example/progress", "add", '{"text":"Tag it"}')).data.result).toEqual({ index: 1 });
  expect((await call("@example/progress", "check", '{"index":0}')).data.result).toEqual({ text: "Run the tests", done: true });
  await expect(page.getByText("Ship the release")).toBeVisible();
  await expect(page.getByText("1 of 2 done")).toBeVisible();
  await expect(page.getByRole("button", { name: /✓\s+Run the tests/ })).toBeVisible();
  expect((await call("@example/progress", "list")).data.result).toEqual({
    title: "Ship the release", steps: [{ text: "Run the tests", done: true }, { text: "Tag it", done: false }],
  });

  // What the plugin refuses, and a command it does not have, come back as the agent's error.
  const bad = await call("@example/progress", "check", '{"index":7}');
  expect([bad.status, bad.data.code]).toEqual([1, "FAILED"]);
  expect(bad.data.message).toContain("there is no step 7");
  const launch = await call("@example/progress", "launch");
  expect([launch.status, launch.data.code]).toEqual([5, "NOT_FOUND"]);
  expect(launch.data.message).toContain('has no command "launch"');

  // Closed, it leaves the board and the plugins that run.
  const closed = await hive("ctl", "plugin", "close", widget.widget, "--json");
  expect(closed.status, closed.err).toBe(0);
  expect(JSON.parse(closed.out)).toEqual({ closed: widget.widget, plugin: "@example/progress", kind: "widget" });
  expect((await running()).plugins.find((p) => p.instance === widget.widget)).toBeUndefined();
  await expect(page.getByText("Ship the release")).toHaveCount(0);
});

test("a view's commands: an agent pins notes to the Agent board while it is the view shown", async () => {
  expect((await commands()).plugins.find((p) => p.plugin === "agent-board")).toBeUndefined();
  expect((await running()).views.map((v) => v.id)).toEqual(expect.arrayContaining(["canvas", "agent-board"]));
  expect(JSON.parse((await hive("ctl", "plugin", "open", "view:agent-board", "--json")).out)).toMatchObject({ view: "agent-board", instance: "agent-board", state: "ready" });
  expect((await call("agent-board", "post", '{"text":"Tests pass on main","from":"claude #1","kind":"done"}')).data).toEqual({ result: { notes: 1 } });
  const board = page.frameLocator('[data-community-view="agent-board"] iframe');
  await expect(board.locator("article[data-note='done']")).toContainText("Tests pass on main");
  expect(((await call("agent-board", "list")).data.result as Array<{ from: string }>)[0]!.from).toBe("claude #1");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: "canvas" } })));
  // Another view shown: its commands are gone with it.
  await expect.poll(async () => (await commands()).plugins.find((p) => p.plugin === "agent-board")).toBeUndefined();
});

test("a tool's commands: an agent asks an open Commits tile what is there", async () => {
  // Named by its plugin alone: its first tool opens.
  const opened = await hive("ctl", "plugin", "open", "tool:@example/commits", "--json");
  expect(opened.status, opened.err).toBe(0);
  const tool = JSON.parse(opened.out) as { tile: string; instance: string; state: string };
  expect([tool.instance, tool.state]).toEqual([tool.tile, "ready"]);
  await expect.poll(async () => (await call("@example/commits", "list")).data.result).toEqual(["init"]);
  // Closed by its instance, as `plugin list` names it: its tile goes.
  expect((await hive("ctl", "plugin", "close", tool.tile, "--json")).status).toBe(0);
  expect((await running()).plugins.find((p) => p.instance === tool.tile)).toBeUndefined();
});

test("what is not here to open is refused, with how to get it", async () => {
  const widget = await hive("ctl", "plugin", "open", "widget:@nobody/nothing", "--json");
  expect(widget.status).not.toBe(0);
  expect(JSON.parse(widget.out).message).toContain("hive plugins install");
  const view = await hive("ctl", "plugin", "open", "view:nothing", "--json");
  expect([view.status, JSON.parse(view.out).code]).toEqual([5, "NOT_FOUND"]);
  expect(JSON.parse(view.out).message).toContain("hive plugins enable view:nothing");
  expect(JSON.parse(view.out).message).toContain("these are: canvas");
  expect(JSON.parse((await hive("ctl", "plugin", "open", "tool:@nobody/nothing", "--json")).out).message).toContain("has no tool to open");
  expect(JSON.parse((await hive("ctl", "plugin", "open", "nothing", "--json")).out).code).toBe("BAD_REQUEST");
});
