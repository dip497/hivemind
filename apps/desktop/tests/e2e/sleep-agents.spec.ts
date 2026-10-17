// An agent put to sleep (spec/agents.md "Sleep"): `hive ctl sleep` ends its process, and its tile
// shows Resume on a black screen; Resume starts it again in the same conversation, live, taking
// keys. The stand-in keeps its conversation in a file named by the id the app binds, and shows it
// again when resumed with that id, as an agent that resumes does.
import { test, expect, type ElectronApplication } from "@playwright/test";
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { person } from "./helpers/multiplayer";
import { stopDaemons } from "./helpers/daemons";

const CLI = path.resolve("../cli/src/index.ts");
let root: string;
const apps: ElectronApplication[] = [];
test.beforeEach(() => { root = fs.mkdtempSync("/tmp/hm-sleep-"); });
test.afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  stopDaemons(root);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** The stand-in on PATH and its manifest in the app's agents folder; what the app's environment needs. */
function sleepyAgent(): { PATH: string; SLEEPY_TALKS: string } {
  const bin = path.join(root, "bin");
  const talks = path.join(root, "talks");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(talks);
  fs.writeFileSync(path.join(bin, "sleepy-agent"), [
    "#!/bin/bash",
    // The app counts it installed only when it answers as a CLI does.
    "[ \"$1\" = --version ] && { echo 'sleepy 1.0.0'; exit 0; }",
    "id=''; resumed=''",
    "while [ $# -gt 0 ]; do case \"$1\" in --session-id) id=\"$2\"; shift 2;; --resume) id=\"$2\"; resumed=1; shift 2;; *) shift;; esac; done",
    "talk=\"$SLEEPY_TALKS/${id:-none}\"",
    "echo $$ > \"$SLEEPY_TALKS/pid\"",
    "if [ -n \"$resumed\" ]; then cat \"$talk\"; else printf 'MARK\\n' | tee \"$talk\"; fi",
    "printf 'sleepy> '",
    "while read -r line; do printf 'echo %s\\n' \"$line\" | tee -a \"$talk\"; printf 'sleepy> '; done",
  ].join("\n"), { mode: 0o755 });
  const agent = path.join(root, "desktop", "hivemind", "agents", "sleepy");
  fs.mkdirSync(agent, { recursive: true });
  fs.writeFileSync(path.join(agent, "agent.yaml"), [
    "manifestVersion: 2", "id: sleepy", "label: Sleepy", "bin: sleepy-agent", "enabled: true",
    "caps: { promptDelivery: typed, turnSignal: false, resume: none, supervise: human, blockedDetection: false }",
    "detect: { default: idle, rules: [] }",
    "session:",
    "  bind: { args: [--session-id, '{newId}'], unless: [--session-id, --resume] }",
    "  resume: { args: [--resume, '{id}'], position: before, from: { bound: --session-id } }",
    "",
  ].join("\n"));
  return { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, SLEEPY_TALKS: talks };
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("an agent put to sleep ends, its tile shows Resume; Resume brings it back in its conversation, taking keys", async () => {
  test.setTimeout(120_000);
  const repo = path.join(root, "api");
  fs.mkdirSync(repo);
  execSync("git init -q", { cwd: repo });
  const env = sleepyAgent();
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const desktop = await person(root, "desktop", repo, apps, { ...env, HIVEMIND_SHELL_ENV: "0", HOME: home });
  await desktop.evaluate(() => window.hive.settingsSet("agents.defaultAgent", "sleepy"));
  await expect(desktop.getByRole("group", { name: "Workspace tools" }).getByRole("button", { name: "Sleepy", exact: true })).toBeVisible({ timeout: 20_000 });
  await desktop.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:shortcut", { detail: "agent" })));
  const node = desktop.locator(".react-flow__node-terminal");
  await expect(node).toHaveCount(1, { timeout: 20_000 });
  const tile = (await node.getAttribute("data-id"))!;
  const pidFile = path.join(env.SLEEPY_TALKS, "pid");
  await expect.poll(() => fs.existsSync(pidFile), { timeout: 20_000 }).toBe(true);
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  const screen = () => desktop.evaluate(() => [...document.querySelectorAll(".xterm")]
    .map((x) => (x.parentElement as (HTMLElement & { __hmScreen?: () => string }) | null)?.__hmScreen?.() ?? "").join("\n"));
  await expect.poll(screen, { timeout: 20_000 }).toContain("MARK");

  const userData = path.join(root, "desktop", "hivemind-dev");
  const r = spawnSync("bun", [CLI, "ctl", "sleep", tile, "--repo", repo, "--json"], { cwd: repo, encoding: "utf8", timeout: 60_000, env: { ...process.env, ...env, HIVEMIND_APP_DATA: userData } });
  expect(r.status, r.stderr).toBe(0);
  expect(JSON.parse(r.stdout.trim().split("\n").pop()!)).toEqual({ slept: [tile], skipped: [] });

  const sleeping = node.locator("[data-sleeping]");
  await expect(sleeping.getByRole("button", { name: "resume agent" })).toBeVisible({ timeout: 20_000 });
  await expect(sleeping).not.toContainText("MARK");
  await expect.poll(() => alive(pid), { timeout: 20_000 }).toBe(false);

  await sleeping.getByRole("button", { name: "resume agent" }).click();
  await expect(node.locator("[data-sleeping]")).toHaveCount(0, { timeout: 20_000 });
  await expect.poll(screen, { timeout: 20_000 }).toContain("MARK");
  await desktop.evaluate((t) => window.hive.ptyWrite(`hm:${t}`, "after the nap\r"), tile);
  await expect.poll(screen, { timeout: 20_000 }).toContain("echo after the nap");
  // The same conversation: what it said before it slept, then what it took after.
  expect(fs.readFileSync(path.join(env.SLEEPY_TALKS, fs.readdirSync(env.SLEEPY_TALKS).find((f) => f !== "pid")!), "utf8")).toBe("MARK\necho after the nap\n");
});
