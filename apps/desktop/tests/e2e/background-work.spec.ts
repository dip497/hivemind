// An agent that ended its turn and still waits on work it started shows as working, in its tile and
// to `hive ctl`, until that work is over; a shell it left running holds nothing. A stand-in agent
// (fixtures/fake-agent.cjs) with Claude's published plugin: its Stop hook counts what the stand-in
// says is running in the background.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedAgents } from "./helpers/agents";
import { stopDaemons } from "./helpers/daemons";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, "../..");
const CLI = path.resolve(APP_DIR, "../cli/src/index.ts");
const FIXTURE = path.join(__dirname, "fixtures", "fake-agent.cjs");
const XDG = process.env.XDG_CONFIG_HOME!;

let app: ElectronApplication;
let page: Page;
let repo: string;
let fakeBin: string;

function onPath(bin: string): string {
  for (const d of (process.env.PATH ?? "").split(":")) {
    const p = path.join(d, bin);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  throw new Error(`${bin} not on PATH`);
}

function hive(...args: string[]) {
  const r = spawnSync(onPath("bun"), [CLI, ...args], { cwd: repo, encoding: "utf8", timeout: 120_000, env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, HIVEMIND_APP_DATA: path.join(XDG, "hivemind-dev") } });
  let json: any = null;
  try { json = JSON.parse(r.stdout); } catch { /* it said no JSON */ }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

const runningInBackground = (...types: string[]) => fs.writeFileSync(path.join(repo, ".fake-background.json"), JSON.stringify(types.map((type) => ({ type, status: "running" }))));
const stateOf = (tile: string) => hive("ctl", "agents", "--json").json.agents.find((a: { tile: string }) => a.tile === tile)?.state;
const look = (tile: string) => page.locator(`.react-flow__node-terminal[data-id="${tile}"] .hm-term-root [data-status-look]`).first();

test.beforeAll(async () => {
  test.setTimeout(180_000);
  seedAgents(XDG, ["claude"]);
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "hm-background-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "hm-background-bin-"));
  fs.writeFileSync(path.join(fakeBin, "claude"), `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FIXTURE)} claude "$@"\n`);
  fs.chmodSync(path.join(fakeBin, "claude"), 0o755);
  app = await electron.launch({
    args: [path.join(APP_DIR, "out/main/index.js"), "--no-sandbox"],
    cwd: repo,
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, HIVEMIND_SHELL_ENV: "0" } as Record<string, string>,
  });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 30_000 });
  await expect.poll(() => fs.existsSync(path.join(XDG, "hivemind-dev", "drive.sock")), { timeout: 20_000 }).toBe(true);
});

test.afterAll(async () => {
  test.setTimeout(120_000);
  await app?.close();
  stopDaemons(XDG);
  for (const d of [repo, fakeBin]) fs.rmSync(d, { recursive: true, force: true });
  fs.rmSync(path.join(XDG, "hivemind", "agents", "claude"), { recursive: true, force: true });
});

test("a turn that ends with a workflow running stays working, its reply readable, until a later turn ends with none", async () => {
  test.setTimeout(150_000);
  runningInBackground("workflow", "shell");
  const spawned = hive("ctl", "spawn", "--agent", "claude", "--name", "leader", "--prompt", "echo started a workflow", "--json");
  expect(spawned.code, spawned.stderr).toBe(0);
  const tile: string = spawned.json.tile;
  expect(hive("ctl", "read", tile, "--timeout", "40000", "--json").json).toMatchObject({ text: "started a workflow", finalStatus: "turn", awaiting: 1 });
  expect(stateOf(tile)).toBe("working");
  await expect(look(tile)).toHaveAttribute("data-status-look", "working", { timeout: 15_000 });

  fs.rmSync(path.join(repo, ".fake-background.json"));
  hive("ctl", "send", tile, "echo the workflow found 3 bugs");
  const over = hive("ctl", "read", tile, "--timeout", "40000", "--json").json;
  expect(over).toMatchObject({ text: "the workflow found 3 bugs", finalStatus: "turn" });
  expect(over.awaiting).toBeUndefined();
  await expect.poll(() => stateOf(tile), { timeout: 10_000 }).toBe("done");
  await expect(look(tile)).not.toHaveAttribute("data-status-look", "working", { timeout: 15_000 });
});

test("a turn that ends with only a dev server running is done", async () => {
  test.setTimeout(90_000);
  runningInBackground("shell");
  const tile: string = hive("ctl", "spawn", "--agent", "claude", "--name", "server", "--prompt", "echo the server is up", "--json").json.tile;
  const read = hive("ctl", "read", tile, "--timeout", "40000", "--json").json;
  expect(read).toMatchObject({ text: "the server is up", finalStatus: "turn" });
  expect(read.awaiting).toBeUndefined();
  await expect.poll(() => stateOf(tile), { timeout: 10_000 }).toBe("done");
  await expect(look(tile)).not.toHaveAttribute("data-status-look", "working", { timeout: 15_000 });
});
