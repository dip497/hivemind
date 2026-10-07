// What an agent can do with the plugins running in the app, through the CLI it has: list the
// commands they declare, run one and read its answer. The example widget, view and tool from the
// repository: the Progress widget's steps, the Agent board view's notes, the Worktrees tool's list.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { seedAgents } from "./helpers/agents";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-plugin-commands-"));
const xdg = path.join(root, "config");
seedAgents(xdg);
const repo = path.join(root, "repo");
const env = { ...process.env, XDG_CONFIG_HOME: xdg, HIVEMIND_PTY_DAEMON: "0", HIVEMIND_SHELL_ENV: "0" } as Record<string, string>;
delete env.ELECTRON_RUN_AS_NODE;
const cli = path.resolve(process.cwd(), "../cli/src/index.ts");
const examples = path.resolve(process.cwd(), "../../examples");
let hcp: Record<string, string> = {};
/** The CLI an agent runs, with what it prints and how it exits. */
const hive = (...args: string[]) => {
  const r = spawnSync("bun", [cli, ...args], { cwd: repo, env: { ...env, ...hcp }, encoding: "utf8" });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};
const call = (...args: string[]) => {
  const r = hive("ctl", "plugin", "call", ...args, "--json");
  return { status: r.status, data: JSON.parse(r.out || "null") as { result?: unknown; ok?: false; code?: string; message?: string } };
};

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
  for (const [kind, dir, record] of [
    ["widgets", "widgets/progress", "widget:@dip497/progress"],
    ["views", "views/agent-board", "view:agent-board"],
    ["tools", "tools/worktrees", "tool:dip497/worktrees"],
  ] as const) {
    const installed = hive(kind, "install", path.join(examples, dir));
    expect(installed.status, installed.err).toBe(0);
    expect(hive("plugins", "enable", record).status).toBe(0);
  }
  app = await electron.launch({ args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox"], cwd: repo, env });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 30_000 });
  const userData = path.join(xdg, "hivemind-dev");
  await expect.poll(() => fs.existsSync(path.join(userData, "hcp.token"))).toBe(true);
  hcp = { HIVE_HCP_SOCK: path.join(userData, "hcp.sock"), HCP_TOKEN: fs.readFileSync(path.join(userData, "hcp.token"), "utf8").trim() };
});
test.afterAll(async () => { await app?.close(); fs.rmSync(root, { recursive: true, force: true }); });

const commands = () => JSON.parse(hive("ctl", "plugin", "commands", "--json").out) as { plugins: Array<{ plugin: string; kind: string; commands: Array<{ name: string }> }> };

test("a widget's commands: an agent lists them, adds and ticks steps, and the card shows what it did", async () => {
  // Not running yet: nothing to call, and the agent is told how to get it running.
  expect(commands().plugins.find((p) => p.plugin === "@dip497/progress")).toBeUndefined();
  expect(call("@dip497/progress", "list").data.message).toContain("is not running here");

  await page.locator('[data-toolbar-action="board"]').click();
  await page.locator('[data-board-choice="widget:@dip497/progress"]').click();
  await expect.poll(() => commands().plugins.find((p) => p.plugin === "@dip497/progress")?.commands.map((c) => c.name), { timeout: 15_000 })
    .toEqual(["set-title", "add", "check", "list", "clear"]);

  expect(call("@dip497/progress", "set-title", '{"title":"Ship the release"}').data.result).toEqual({ title: "Ship the release" });
  expect(call("@dip497/progress", "add", '{"text":"Run the tests"}').data.result).toEqual({ index: 0 });
  expect(call("@dip497/progress", "add", '{"text":"Tag it"}').data.result).toEqual({ index: 1 });
  expect(call("@dip497/progress", "check", '{"index":0}').data.result).toEqual({ text: "Run the tests", done: true });
  await expect(page.getByText("Ship the release")).toBeVisible();
  await expect(page.getByText("1 of 2 done")).toBeVisible();
  await expect(page.getByRole("button", { name: /✓\s+Run the tests/ })).toBeVisible();
  expect(call("@dip497/progress", "list").data.result).toEqual({
    title: "Ship the release", steps: [{ text: "Run the tests", done: true }, { text: "Tag it", done: false }],
  });

  // What the plugin refuses, and a command it does not have, come back as the agent's error.
  const bad = call("@dip497/progress", "check", '{"index":7}');
  expect(bad.status).not.toBe(0);
  expect(bad.data.message).toContain("there is no step 7");
  expect(call("@dip497/progress", "launch").data.message).toContain('has no command "launch"');
});

test("a view's commands: an agent pins notes to the Agent board while it is the view shown", async () => {
  expect(commands().plugins.find((p) => p.plugin === "agent-board")).toBeUndefined();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: "agent-board" } })));
  await expect.poll(() => commands().plugins.find((p) => p.plugin === "agent-board")?.kind, { timeout: 15_000 }).toBe("view");
  expect(call("agent-board", "post", '{"text":"Tests pass on main","from":"claude #1","kind":"done"}').data).toEqual({ result: { notes: 1 } });
  const board = page.frameLocator('[data-community-view="agent-board"] iframe');
  await expect(board.locator("article[data-note='done']")).toContainText("Tests pass on main");
  expect((call("agent-board", "list").data.result as Array<{ from: string }>)[0]!.from).toBe("claude #1");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: "canvas" } })));
  // Another view shown: its commands are gone with it.
  await expect.poll(() => commands().plugins.find((p) => p.plugin === "agent-board")).toBeUndefined();
});

test("a tool's commands: an agent asks an open Worktrees tile what is there", async () => {
  expect(hive("ctl", "open-tool", "dip497/worktrees/worktrees").status).toBe(0);
  await expect.poll(() => {
    const r = call("dip497/worktrees", "list");
    return Array.isArray(r.data.result) ? (r.data.result as Array<{ branch: string; main: boolean }>).map((w) => [w.branch, w.main]) : r.data.message;
  }, { timeout: 20_000 }).toEqual([["main", true]]);
});
