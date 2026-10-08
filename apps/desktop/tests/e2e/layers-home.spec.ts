// The panel as a home: every workspace here under Projects, with what runs in it, and this
// workspace's past agent sessions under Recents, each a click from being resumed.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
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

test("Recents lists this workspace's past sessions, and one click resumes it", async () => {
  const row = panel().locator(`[data-layers-recent="${session}"]`);
  await expect(row).toContainText("fix the share dialog", { timeout: 15_000 });
  await row.click();
  await expect.poll(() => fs.existsSync(path.join(root, "claude-args")) && fs.readFileSync(path.join(root, "claude-args"), "utf8"), { timeout: 15_000 })
    .toContain(`--resume ${session}`);
});

test("Projects lists every workspace here; another one opens in this window", async () => {
  const projects = panel().locator("[data-layers-projects]");
  await expect(projects.locator('[data-layers-project="alpha"]')).toBeDisabled();
  await projects.locator('[data-layers-project="beta"]').click();
  await expect(panel().locator("[data-layers-title]")).toHaveText(/beta/, { timeout: 15_000 });
});
