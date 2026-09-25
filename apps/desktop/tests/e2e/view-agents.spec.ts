// View protocol 1.4 end to end: a view lists the agents and a folder's past sessions, continues
// one, sees its agent status, and gives it an instruction the user confirms in the host's dialog.
import { test, expect, _electron as electron, type ElectronApplication, type Page, type Frame } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";

test.use({ trace: "off" });

const APP_DIR = process.cwd();
const CLI = path.resolve(APP_DIR, "../cli/src/index.ts");
const FAKE = path.join(APP_DIR, "tests/e2e/fixtures/fake-agent.cjs");
const VIEW = path.join(APP_DIR, "tests/e2e/fixtures/views/agent-driver");
const XDG = process.env.XDG_CONFIG_HOME!;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "hm-viewagents-home-"));
const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "hm-viewagents-bin-"));
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "hm-viewagents-repo-"));
const SESSION = "0d3c2a10-1111-4222-8333-444455556666";

let app: ElectronApplication;
let page: Page;
let view: Frame;
let hcp: Record<string, string> = {};

const onPath = (bin: string) => {
  for (const d of (process.env.PATH ?? "").split(":")) if (fs.existsSync(path.join(d, bin))) return path.join(d, bin);
  throw new Error(`${bin} not on PATH`);
};
const hive = (...args: string[]) => {
  const r = spawnSync(onPath("bun"), [CLI, ...args, "--json"], { cwd: repo, encoding: "utf8", env: { ...process.env, ...hcp } });
  try { return JSON.parse(r.stdout.trim().split("\n").pop()!); } catch { throw new Error(`hive ${args.join(" ")} → ${r.status}\n${r.stdout}\n${r.stderr}`); }
};

test.beforeAll(async () => {
  test.setTimeout(120_000);
  execSync("git init -q", { cwd: repo });
  // A session this folder had before, where Claude keeps its transcripts.
  const proj = path.join(home, ".claude", "projects", "-repo");
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, `${SESSION}.jsonl`), JSON.stringify({ type: "user", cwd: repo, message: { content: "earlier work" } }) + "\n");
  fs.writeFileSync(path.join(fakeBin, "claude"), `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} claude "$@"\n`);
  fs.chmodSync(path.join(fakeBin, "claude"), 0o755);
  const installed = spawnSync(onPath("bun"), [CLI, "views", "install", VIEW, "--json"], { cwd: repo, encoding: "utf8", env: process.env });
  expect(installed.status, installed.stdout + installed.stderr).toBe(0);
  app = await electron.launch({
    args: [path.join(APP_DIR, "out/main/index.js"), "--no-sandbox"],
    cwd: repo,
    env: { ...process.env, HOME: home, PATH: `${fakeBin}:${process.env.PATH}`, HIVEMIND_PTY_DAEMON: "1", HIVEMIND_SHELL_ENV: "0" } as Record<string, string>,
  });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 20_000 });
  const userData = path.join(XDG, "hivemind-dev");
  await expect.poll(() => fs.existsSync(path.join(userData, "hcp.token")), { timeout: 20_000 }).toBe(true);
  hcp = { HIVE_HCP_SOCK: path.join(userData, "hcp.sock"), HCP_TOKEN: fs.readFileSync(path.join(userData, "hcp.token"), "utf8").trim() };
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: "agent-driver" } })));
  await page.waitForSelector('[data-community-view="agent-driver"][data-community-ready="1"]', { timeout: 20_000 });
  view = page.frame({ name: "hm-view:agent-driver" })!;
  await expect.poll(() => view.evaluate(() => document.body.dataset.ready ?? null)).toBe("1");
});

test.afterAll(async () => {
  try { execSync(`pkill -f "out/main/pty-daemon.js ${XDG}/"`, { stdio: "ignore" }); } catch { /* none */ }
  await Promise.race([app?.close(), new Promise((r) => setTimeout(r, 10_000))]);
  try { execSync(`pkill -f "fixtures/fake-agent\\.cjs claude "`, { stdio: "ignore" }); } catch { /* none */ }
  for (const d of [home, fakeBin, repo]) fs.rmSync(d, { recursive: true, force: true });
});

test("a view lists agents and a folder's sessions, continues one, and prompts it once the user sends", async () => {
  const features = await view.evaluate(() => (window as any).hm.features);
  expect(features).toEqual(expect.arrayContaining(["agentStatus", "agents", "sessions", "prompt"]));
  const agents = await view.evaluate(() => (window as any).hm.agents());
  expect(agents).toEqual(expect.arrayContaining([expect.objectContaining({ id: "claude", turns: true, resumes: true, sessions: true })]));

  await view.evaluate(() => (window as any).hm.commands.addFrame());
  await expect.poll(() => view.evaluate(() => (window as any).structure.frames.length), { timeout: 10_000 }).toBeGreaterThan(0);
  const frameId = await view.evaluate(() => (window as any).structure.frames[0].id);
  const sessions = await view.evaluate((f) => (window as any).hm.sessions("claude", f), frameId);
  expect(sessions).toEqual([{ id: SESSION, updated: expect.any(Number), prompt: "earlier work" }]);

  await view.evaluate(([f, s]) => (window as any).hm.commands.spawnAgent("claude", f, { resume: s }), [frameId, SESSION]);
  await expect.poll(() => view.evaluate(() => (window as any).structure.tiles.filter((t: any) => t.agent === "claude").length), { timeout: 15_000 }).toBe(1);
  const tileId = await view.evaluate(() => (window as any).structure.tiles.find((t: any) => t.agent === "claude").id);
  await view.evaluate((t) => (window as any).watch(t), tileId);
  // Its terminal is up once it reports a status: until then there is nothing to type into.
  await expect.poll(() => view.evaluate((t) => ((window as any).statuses[t] ?? []).length, tileId), { timeout: 20_000 }).toBeGreaterThan(0);

  // The instruction waits for the user: the dialog shows it, and Cancel sends nothing.
  const cancelled = view.evaluate((t) => (window as any).hm.prompt(t, "echo never"), tileId);
  await expect(page.locator("[data-prompt-dialog]")).toContainText("echo never");
  await page.getByRole("button", { name: "Cancel" }).click();
  expect(await cancelled).toBe("cancelled");

  const sent = view.evaluate((t) => (window as any).hm.prompt(t, "echo resumed=$FAKE_RESUMED"), tileId);
  await expect(page.locator("[data-prompt-dialog]")).toContainText("echo resumed=$FAKE_RESUMED");
  await page.getByRole("button", { name: "Send" }).click();
  expect(await sent).toBe("sent");
  const read = hive("ctl", "read", tileId, "--timeout", "40000");
  expect(read).toMatchObject({ text: `resumed=${SESSION}`, finalStatus: "turn" });
  // The view saw the turn through the agent's own status, not only the bucket.
  await expect.poll(() => view.evaluate((t) => (window as any).statuses[t], tileId), { timeout: 10_000 }).toEqual(expect.arrayContaining(["working", "done"]));

  // Keystrokes never reach the dialog.
  const bad = await view.evaluate((t) => (window as any).hm.prompt(t, "ok\u001b[2J").then(() => "sent", (e: Error) => e.message), tileId);
  expect(bad).toMatch(/control/);
});
