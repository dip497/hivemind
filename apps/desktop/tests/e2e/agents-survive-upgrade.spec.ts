// An upgrade of the app does not end the agents it runs: the app quits, a release brings another
// build of the terminal daemon that speaks the same protocol, and the app starts again. The agent
// that was running is the same process, and its tile shows what it wrote while the app was away.
import { test, expect, type ElectronApplication } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { person } from "./helpers/multiplayer";
import { stopDaemons } from "./helpers/daemons";

let root: string;
const apps: ElectronApplication[] = [];
const daemonBundle = path.resolve("out/main/pty-daemon.js");
let builtDaemon: string;
test.beforeEach(() => {
  root = fs.mkdtempSync("/tmp/hm-upgrade-");
  builtDaemon = fs.readFileSync(daemonBundle, "utf8");
});
test.afterEach(async () => {
  fs.writeFileSync(daemonBundle, builtDaemon);
  for (const a of apps.splice(0)) await a.close();
  stopDaemons(root);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** A stand-in agent that writes a numbered line, signed with its pid, three times a second, to its
 *  terminal and to a file; what the app's environment needs to run it. */
function tickingAgent(): { PATH: string; TICKS: string } {
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const ticks = path.join(root, "ticks");
  fs.writeFileSync(path.join(bin, "ticking-agent"), [
    "#!/bin/bash",
    "[ \"$1\" = --version ] && { echo 'ticking 1.0.0'; exit 0; }",
    "n=0",
    "while true; do n=$((n+1)); echo \"tick $$-$n\" | tee -a \"$TICKS\"; sleep 0.3; done",
  ].join("\n"), { mode: 0o755 });
  const agent = path.join(root, "desktop", "hivemind", "agents", "ticking");
  fs.mkdirSync(agent, { recursive: true });
  fs.writeFileSync(path.join(agent, "agent.yaml"), [
    "manifestVersion: 2", "id: ticking", "label: Ticking", "bin: ticking-agent", "enabled: true",
    "caps: { promptDelivery: typed, turnSignal: false, resume: none, supervise: human, blockedDetection: false }",
    "detect: { default: idle, rules: [] }",
    "",
  ].join("\n"));
  return { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, TICKS: ticks };
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const lastTick = (file: string) => fs.readFileSync(file, "utf8").trim().split("\n").pop()!;

test("an agent keeps running through an app upgrade that brings another build of the daemon, and its tile shows what it wrote meanwhile", async () => {
  test.setTimeout(150_000);
  const repo = path.join(root, "api");
  fs.mkdirSync(repo);
  execSync("git init -q", { cwd: repo });
  const env = { ...tickingAgent(), HIVEMIND_SHELL_ENV: "0", HOME: path.join(root, "home") };
  fs.mkdirSync(env.HOME);
  const screen = (w: import("@playwright/test").Page) => w.evaluate(() => [...document.querySelectorAll(".xterm")]
    .map((x) => (x.parentElement as (HTMLElement & { __hmScreen?: () => string }) | null)?.__hmScreen?.() ?? "").join("\n"));

  let desktop = await person(root, "desktop", repo, apps, env);
  await desktop.evaluate(() => window.hive.settingsSet("agents.defaultAgent", "ticking"));
  await expect(desktop.getByRole("group", { name: "Workspace tools" }).getByRole("button", { name: "Ticking", exact: true })).toBeVisible({ timeout: 20_000 });
  await desktop.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:shortcut", { detail: "agent" })));
  await expect(desktop.locator(".react-flow__node-terminal")).toHaveCount(1, { timeout: 20_000 });
  await expect.poll(() => fs.existsSync(env.TICKS) && lastTick(env.TICKS), { timeout: 20_000 }).toMatch(/^tick \d+-\d+$/);
  const pid = Number(/^tick (\d+)-/.exec(lastTick(env.TICKS))![1]);
  await expect.poll(() => screen(desktop), { timeout: 20_000 }).toContain(`tick ${pid}-`);
  // Saved to main's store before the quit, so the tile is shown again.
  await expect.poll(() => desktop.evaluate((r) => ((window.hive.workspaceCoreSync(r) ?? {}) as { tiles?: unknown[] }).tiles?.length ?? 0, repo)).toBe(1);

  await apps.splice(0)[0]!.close();
  fs.appendFileSync(daemonBundle, "\n// another build of the daemon, speaking the same protocol\n");
  // Lines written with no app running.
  const atQuit = lastTick(env.TICKS);
  await expect.poll(() => lastTick(env.TICKS), { timeout: 10_000 }).not.toBe(atQuit);
  const whileAway = lastTick(env.TICKS);

  desktop = await person(root, "desktop", repo, apps, env);
  await expect(desktop.locator(".react-flow__node-terminal")).toHaveCount(1, { timeout: 20_000 });
  await expect.poll(() => screen(desktop), { timeout: 20_000 }).toContain(whileAway);
  expect(alive(pid)).toBe(true);
  expect(lastTick(env.TICKS)).toMatch(new RegExp(`^tick ${pid}-`));
});
