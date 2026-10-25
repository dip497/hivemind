// A window that joins a session the host started shows what it printed before the window came
// (the host keeps the screen: a window that joins is sent it, then live output).
// An agent started with `hive ctl spawn` beside a shell: the host runs it from its first byte, the
// window joins it, asks for its screen and sizes it to the tile. A resize that took in the screen
// request's queued empty write dropped the answer (xterm's flushSync stops at ""), and the tile
// showed only "[hivemind] spawned …" until a 30 s timeout.
import { test, expect, type ElectronApplication } from "@playwright/test";
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { person } from "./helpers/multiplayer";
import { stopDaemons } from "./helpers/daemons";
import { seedAgents } from "./helpers/agents";

const CLI = path.resolve("../cli/src/index.ts");
const FIXTURE = path.resolve("tests/e2e/fixtures/fake-agent.cjs");
let root: string;
const apps: ElectronApplication[] = [];
test.beforeEach(() => { root = fs.mkdtempSync("/tmp/hm-join-"); });
test.afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  stopDaemons(root);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test("an agent the host starts beside a shell shows its first output in the window that joins it", async () => {
  test.setTimeout(120_000);
  const repo = path.join(root, "api");
  fs.mkdirSync(repo);
  execSync("git init -q", { cwd: repo });
  // The claude stand-in on PATH, answering as an installed CLI does.
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "claude"), [
    "#!/usr/bin/env bash",
    "[ \"$1\" = --version ] && { echo '2.1.0 (Claude Code)'; exit 0; }",
    `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FIXTURE)} claude "$@"`,
  ].join("\n"), { mode: 0o755 });
  const env = { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` };
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  seedAgents(path.join(root, "desktop"), ["claude"]);
  const desktop = await person(root, "desktop", repo, apps, { ...env, HIVEMIND_SHELL_ENV: "0", HOME: home });

  await desktop.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:shortcut", { detail: "new-terminal" })));
  await expect(desktop.locator(".react-flow__node-terminal")).toHaveCount(1, { timeout: 20_000 });

  // Refused until the app has found the stand-in installed.
  const userData = path.join(root, "desktop", "hivemind-dev");
  const spawn = () => spawnSync("bun", [CLI, "ctl", "spawn", "--agent", "claude", "--repo", repo, "--json"], { cwd: repo, encoding: "utf8", timeout: 60_000, env: { ...process.env, ...env, HIVEMIND_APP_DATA: userData } });
  let r = spawn();
  for (let i = 0; i < 20 && r.status !== 0; i++) { await new Promise((w) => setTimeout(w, 1000)); r = spawn(); }
  expect(r.status, r.stderr + r.stdout).toBe(0);
  const tile = JSON.parse(r.stdout.trim().split("\n").pop()!).tile as string;

  const node = desktop.locator(`.react-flow__node[data-id="${tile}"]`);
  await expect(node).toHaveCount(1, { timeout: 20_000 });
  const screen = () => node.evaluate((n) => [...n.querySelectorAll(".xterm")]
    .map((x) => (x.parentElement as (HTMLElement & { __hmScreen?: () => string }) | null)?.__hmScreen?.() ?? "").join("\n"));
  // What it printed as it started, before the window joined.
  await expect.poll(screen, { timeout: 20_000 }).toContain("fake claude up");
});
