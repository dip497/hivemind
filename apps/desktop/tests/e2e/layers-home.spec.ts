// The panel as a home: every workspace here under Projects, with what runs in it, and this
// workspace's past agent sessions under Recents, each a click from being resumed: those of every
// folder its agents run in, the workspace's own included. What an agent started is listed under it.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { seedAgents } from "./helpers/agents";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-layers-home-"));
const xdg = path.join(root, "config");
const home = path.join(root, "home");
const bin = path.join(root, "bin");
const repoA = path.join(root, "alpha");
const repoB = path.join(root, "beta");
const session = randomUUID();
const cli = path.resolve(process.cwd(), "../cli/src/index.ts");
const env = {
  ...process.env, XDG_CONFIG_HOME: xdg, HOME: home, HIVEMIND_PTY_DAEMON: "0", HIVEMIND_SHELL_ENV: "0",
  PATH: `${bin}${path.delimiter}${process.env.PATH}`,
} as Record<string, string>;
delete env.ELECTRON_RUN_AS_NODE;
delete env.HIVE_HCP_SOCK; delete env.HCP_TOKEN; delete env.HIVEMIND_TILE;
let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  seedAgents(xdg);
  for (const [repo, prefix] of [[repoA, "ALPHA"], [repoB, "BETA"]] as const) {
    fs.mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("bun", [cli, "init", `--prefix=${prefix}`, "--no-agentic"], { cwd: repo, env });
  }
  // A Claude that says what it was started with, and stays.
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\n[ "$1" = --version ] && echo '2.0.0 (Claude Code)' && exit 0\necho "$@" > ${JSON.stringify(path.join(root, "claude-args"))}\nexec sleep 60\n`, { mode: 0o755 });
  // A session Claude kept for alpha, as it keeps them.
  const dir = path.join(home, ".claude", "projects", repoA.replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${session}.jsonl`), JSON.stringify({ type: "user", cwd: repoA, sessionId: session, message: { role: "user", content: "fix the share dialog" } }) + "\n");
  app = await electron.launch({ args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox", `--user-data-dir=${path.join(root, "ud")}`], cwd: repoA, env });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 30_000 });
  // A tile, so the panel shows.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await expect(page.locator(".react-flow__node-terminal")).toHaveCount(1);
});
test.afterAll(async () => { await app?.close(); fs.rmSync(root, { recursive: true, force: true }); });

const panel = () => page.locator('aside[aria-label="Layers"]');

const pane = (name: "tiles" | "recents" | "machines") => panel().locator(`[data-layers-rail="${name}"]`).click();

test("Recents lists this workspace's past sessions, and one click resumes it", async () => {
  await pane("recents");
  const row = panel().locator(`[data-layers-recent="${session}"]`);
  await expect(row).toContainText("fix the share dialog", { timeout: 15_000 });
  await row.click();
  await expect.poll(() => fs.existsSync(path.join(root, "claude-args")) && fs.readFileSync(path.join(root, "claude-args"), "utf8"), { timeout: 15_000 })
    .toContain(`--resume ${session}`);
});

test("Recents groups by agent, by project or not at all, and a group folds away", async () => {
  await pane("recents");
  const by = async (choice: string) => {
    await panel().locator("[data-layers-recents-by]").click();
    await page.locator(`[data-layers-recents-choice="${choice}"]`).click();
    await expect(page.locator("[data-layers-recents-choice]")).toHaveCount(0);
  };
  const row = panel().locator(`[data-layers-recent="${session}"]`);
  // By agent, the default: under Claude.
  await expect(panel().locator('[data-layers-recents-group="claude"]')).toContainText("Claude");
  await expect(panel().locator('[data-layers-recents="claude"]').locator(`[data-layers-recent="${session}"]`)).toBeVisible();
  await panel().locator('[data-layers-recents-group="claude"]').click();
  await expect(row).toHaveCount(0);
  await panel().locator('[data-layers-recents-group="claude"]').click();
  await expect(row).toBeVisible();
  // By project: under the project it ran in, by its name.
  await by("project");
  await expect(panel().locator("[data-layers-recents-by]")).toHaveText(/By project/);
  await expect(panel().locator("[data-layers-recents-group]")).toContainText("alpha");
  // Not at all: no headings.
  await by("none");
  await expect(panel().locator("[data-layers-recents-group]")).toHaveCount(0);
  await expect(row).toBeVisible();
  await by("agent");
});

test("an agent's started agents are listed under it, and fold away", async () => {
  await pane("tiles");
  const parentRow = panel().locator('[data-layer-tile^="tile-claude"]').first();
  const parent = (await parentRow.getAttribute("data-layer-tile"))!;
  // As an agent does it: `hive ctl spawn` from inside its tile.
  const ud = path.join(root, "ud");
  const { stdout } = await promisify(execFile)("bun", [cli, "ctl", "spawn", "--agent", "claude", "--name", "helper", "--json"], {
    env: { ...env, HIVE_HCP_SOCK: path.join(ud, "hcp.sock"), HCP_TOKEN: fs.readFileSync(path.join(ud, "hcp.token"), "utf8").trim(), HIVEMIND_TILE: parent },
  });
  const child = JSON.parse(stdout.trim().split("\n").pop()!).tileId as string;
  const started = panel().locator(`[data-layer-started="${parent}"]`);
  await expect(started.locator(`[data-layer-tile="${child}"]`)).toBeVisible({ timeout: 15_000 });
  await expect(panel().locator(`[data-layer-tile="${child}"]`)).toHaveCount(1);
  await panel().locator(`[data-layer-fold="${parent}"]`).click();
  await expect(panel().locator(`[data-layer-tile="${child}"]`)).toHaveCount(0);
  await expect(panel().locator(`[data-layer-tile="${parent}"]`)).toHaveAttribute("aria-expanded", "false");
  await panel().locator(`[data-layer-fold="${parent}"]`).click();
  await expect(started.locator(`[data-layer-tile="${child}"]`)).toBeVisible();
});

test("New agent asks which agent, from the ones installed here, the default marked by its key", async () => {
  const claudes = panel().locator('[data-layer-tile^="tile-claude"]');
  const before = await claudes.count();
  await panel().locator('[data-layers-action="agent"]').click();
  const menu = page.locator("[data-layers-new-agent]");
  // Claude is the only agent this test installs, so it is the default: first, with its key.
  await expect(menu.locator("[data-layers-new-agent-choice]").first()).toHaveAttribute("data-layers-new-agent-choice", "claude");
  await expect(menu.locator('[data-layers-new-agent-choice="claude"]')).toContainText("2");
  await menu.locator('[data-layers-new-agent-choice="claude"]').click();
  await expect(claudes).toHaveCount(before + 1);
});

test("with no frame bound to its folder, Recents still lists the workspace's own sessions", async () => {
  // Delete the workspace's frame, keeping its tiles: nothing names the folder but the workspace.
  const frame = panel().locator("[data-layers-frame]").first();
  await frame.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete frame" }).click();
  await page.locator("[data-delete-frame-keep]").click();
  await expect(panel().locator("[data-layers-frame]")).toHaveCount(0);
  await page.waitForTimeout(600); // Recents reads again a moment after the folders change
  await pane("recents");
  await expect(panel().locator(`[data-layers-recent="${session}"]`)).toContainText("fix the share dialog", { timeout: 15_000 });
});

test("the title's menu lists every workspace here; another one opens in this window", async () => {
  await panel().locator("[data-layers-title]").click();
  const workspaces = page.locator("[data-layers-workspaces]");
  await expect(workspaces.locator('[data-layers-workspace="alpha"]')).toHaveAttribute("data-disabled", "");
  await workspaces.locator('[data-layers-workspace="beta"]').click();
  await expect(panel().locator("[data-layers-title]")).toHaveText(/beta/, { timeout: 15_000 });
});
