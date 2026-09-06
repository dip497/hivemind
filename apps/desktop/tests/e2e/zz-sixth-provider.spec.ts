// Acceptance for the provider catalog: a THROWAWAY sixth provider added by
// dropping one directory (a def + its plugin object) into packages/hive-agents
// and adding one line to catalog.ts (+ one to node.ts's PLUGINS) must appear in the UI's agent list,
// the CLI's --agent choices and HCP spawn, and pass the lifecycle proof from
// the adding-an-agent-provider checklist through the fake-agent fixture.
//
// The spec edits the source tree for real (that IS the claim under test),
// rebuilds the desktop bundle, runs, then restores the tree and rebuilds again
// so the on-disk bundle matches the checkout. It refuses to run if the files it
// touches are already dirty. Named zz- so it runs last.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, "../..");
const ROOT = path.resolve(APP_DIR, "../..");
const CLI = path.join(ROOT, "apps/cli/src/index.ts");
const FIXTURE = path.join(__dirname, "fixtures", "fake-agent.cjs");
const PKG = path.join(ROOT, "packages/hive-agents/src");
const CATALOG = path.join(PKG, "catalog.ts");
const NODE = path.join(PKG, "node.ts");
const DIR = path.join(PKG, "providers/faux");
const DEF = path.join(DIR, "index.ts");
const DEF_NODE = path.join(DIR, "node.ts");

let app: ElectronApplication | undefined;
let page: Page;
let repo: string;
let fakeBin: string;
let sock: string;
let token: string;

function onPath(bin: string): string {
  for (const d of (process.env.PATH ?? "").split(":")) {
    const p = path.join(d, bin);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  throw new Error(`${bin} not on PATH`);
}
function hive(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(onPath("bun"), [CLI, ...args], {
    encoding: "utf8", timeout: 120_000,
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, HIVE_HCP_SOCK: sock, HCP_TOKEN: token, ...env },
  });
  let json: any;
  try { json = JSON.parse(r.stdout.trim()); } catch { try { json = JSON.parse(r.stdout.trim().split("\n").pop() || ""); } catch { /* not json */ } }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}
function build(): void {
  const r = spawnSync("pnpm", ["build"], { cwd: APP_DIR, encoding: "utf8", timeout: 300_000 });
  if (r.status !== 0) throw new Error(`desktop build failed:\n${r.stdout}\n${r.stderr}`);
}

/** Drop the provider in: one directory (def + plugin), one line in each list. */
function installSixthProvider(): void {
  fs.mkdirSync(DIR, { recursive: true });
  fs.copyFileSync(path.join(__dirname, "fixtures/sixth-provider/faux/index.ts"), DEF);
  fs.copyFileSync(path.join(__dirname, "fixtures/sixth-provider/faux/node.ts"), DEF_NODE);
  const cat = fs.readFileSync(CATALOG, "utf8");
  fs.writeFileSync(CATALOG, cat
    .replace('import { openclaw } from "./providers/openclaw/index.js";', 'import { openclaw } from "./providers/openclaw/index.js";\nimport { faux } from "./providers/faux/index.js";')
    .replace("  claude, codex, opencode, droid, pi, kiro,", "  claude, codex, opencode, droid, pi, kiro, faux,"));
  const node = fs.readFileSync(NODE, "utf8");
  fs.writeFileSync(NODE, node
    .replace('import { plugin as piPlugin } from "./providers/pi/node.js";', 'import { plugin as piPlugin } from "./providers/pi/node.js";\nimport { plugin as fauxPlugin } from "./providers/faux/node.js";')
    .replace("[claudePlugin, codexPlugin, droidPlugin, kiroPlugin, piPlugin]", "[claudePlugin, codexPlugin, droidPlugin, kiroPlugin, piPlugin, fauxPlugin]"));
  for (const [file, needle] of [[CATALOG, "kiro, faux,"], [NODE, "piPlugin, fauxPlugin]"]] as const) {
    if (!fs.readFileSync(file, "utf8").includes(needle)) throw new Error(`could not add the sixth provider to ${path.basename(file)} — anchor moved`);
  }
}
function removeSixthProvider(): void {
  execSync(`git checkout -- ${JSON.stringify(CATALOG)} ${JSON.stringify(NODE)}`, { cwd: ROOT, stdio: "ignore" });
  fs.rmSync(DIR, { recursive: true, force: true });
}

test.beforeAll(async () => {
  test.setTimeout(420_000);
  const dirty = execSync(`git status --porcelain -- ${JSON.stringify(CATALOG)} ${JSON.stringify(NODE)} ${JSON.stringify(DEF)} ${JSON.stringify(DEF_NODE)}`, { cwd: ROOT, encoding: "utf8" }).trim();
  if (dirty) throw new Error(`refusing to edit a dirty catalog:\n${dirty}`);
  installSixthProvider();
  build();

  repo = fs.mkdtempSync(path.join(os.tmpdir(), "hm-sixth-"));
  execSync("git init -q", { cwd: repo });
  fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "hm-sixth-bin-"));
  for (const [bin, provider] of [["faux-agent", "faux"], ["claude", "claude"]] as const) {
    const shim = path.join(fakeBin, bin);
    fs.writeFileSync(shim, `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FIXTURE)} ${provider} "$@"\n`);
    fs.chmodSync(shim, 0o755);
  }
  fs.writeFileSync(path.join(fakeBin, "hive"), `#!/usr/bin/env bash\nexec ${JSON.stringify(onPath("bun"))} ${JSON.stringify(CLI)} "$@"\n`);
  fs.chmodSync(path.join(fakeBin, "hive"), 0o755);

  app = await electron.launch({
    args: [path.join(APP_DIR, "out/main/index.js"), "--no-sandbox"],
    cwd: repo,
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, HIVEMIND_PTY_DAEMON: "1", HIVEMIND_SHELL_ENV: "0" } as Record<string, string>,
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForSelector(".react-flow", { timeout: 15_000 });
  const userData = path.join(process.env.XDG_CONFIG_HOME!, "hivemind-dev");
  sock = path.join(userData, "hcp.sock");
  await expect.poll(() => fs.existsSync(sock) && fs.existsSync(path.join(userData, "hcp.token")), { timeout: 20_000 }).toBe(true);
  token = fs.readFileSync(path.join(userData, "hcp.token"), "utf8").trim();
});

test.afterAll(async () => {
  test.setTimeout(420_000);
  try { execSync(`pkill -f "out/main/pty-daemon.js ${process.env.XDG_CONFIG_HOME}/"`, { stdio: "ignore" }); } catch { /* none */ }
  // close() waits on child processes; if the app is wedged on one, kill it
  // outright rather than stall the worker teardown.
  const closed = await Promise.race([app?.close().then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 10_000))]);
  if (!closed) { try { app?.process().kill("SIGKILL"); } catch { /* gone */ } }
  // Stand-in agents this spec's tiles spawned (pattern anchored on the fixture
  // path + provider argv so it can never match an unrelated shell).
  try { execSync(`pkill -f "fixtures/fake-agent\\.cjs (claude|droid|codex|faux) "`, { stdio: "ignore" }); } catch { /* none */ }
  removeSixthProvider();
  build(); // the on-disk bundle matches the checkout again
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(fakeBin, { recursive: true, force: true });
});

test("the sixth provider appears in the UI's agent switcher", async () => {
  await page.getByRole("button", { name: "switch agent" }).click();
  await expect(page.getByText("Faux", { exact: true }).first()).toBeVisible({ timeout: 5_000 });
  await page.keyboard.press("Escape");
});

test("the CLI offers and validates it; `hive agent detect` probes its binary", async () => {
  const help = spawnSync(onPath("bun"), [CLI, "ctl", "spawn", "--help"], { encoding: "utf8" }).stdout;
  expect(help).toContain("faux");
  // `hive agent detect` needs a workspace: a throwaway one, with the stand-in on PATH.
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "hm-sixth-ws-"));
  spawnSync(onPath("bun"), [CLI, "init", "--prefix", "SX", "--no-agentic"], { cwd: ws, encoding: "utf8", env: { ...process.env, XDG_CONFIG_HOME: path.join(ws, "xdg") } });
  const r = spawnSync(onPath("bun"), [CLI, "agent", "detect", "--json"], { cwd: ws, encoding: "utf8", env: { ...process.env, PATH: `${fakeBin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, XDG_CONFIG_HOME: path.join(ws, "xdg") } });
  expect(JSON.parse(r.stdout).data["faux-agent"]).toBeTruthy();
  fs.rmSync(ws, { recursive: true, force: true });
});

test("lifecycle proof: spawn → working/idle → send → read → report → workflow → close", async () => {
  // Spawn from the launcher via HCP; the argv prompt runs; hooks report the turn.
  const orch = hive(["ctl", "spawn", "--agent", "claude", "--name", "orchestrator", "--prompt", "echo up", "--json"]);
  expect(orch.code, orch.stderr).toBe(0);
  const orchestrator: string = orch.json.tileId;
  expect(hive(["ctl", "read", orchestrator, "--timeout", "40000", "--json"]).json.text).toBe("up");

  const w = hive(["ctl", "spawn", "--agent", "faux", "--name", "faux-1", "--prompt", "echo faux ready from $HIVE_AGENT_ID", "--json"], { HIVEMIND_TILE: orchestrator });
  expect(w.code, w.stderr).toBe(0);
  const worker: string = w.json.tileId;
  // Turn signal → read returns the transcript reply, not a timeout.
  const first = hive(["ctl", "read", worker, "--timeout", "40000", "--json"]);
  expect(first.code, first.stdout + first.stderr).toBe(0);
  expect(first.json).toMatchObject({ text: "faux ready from faux", finalStatus: "turn" });
  // Status: the tile went working then idle (hook-driven) — visible through list.
  await expect.poll(() => {
    const l = hive(["ctl", "list", "--json"]).json;
    return l.frames.flatMap((f: any) => f.tiles).find((t: any) => t.tileId === worker)?.status;
  }, { timeout: 10_000 }).toBe("idle");
  // send → read a follow-up turn.
  hive(["ctl", "send", worker, "echo second"]);
  expect(hive(["ctl", "read", worker, "--timeout", "40000", "--json"]).json.text).toBe("second");
  // report back to the orchestrator.
  hive(["ctl", "send", worker, "hive ctl report 'faux done' --json"]);
  const rep = hive(["ctl", "read", worker, "--timeout", "40000", "--json"]);
  expect(JSON.parse(rep.json.text)).toMatchObject({ delivered: true });
  await expect.poll(() => hive(["ctl", "stream", orchestrator, "--lines", "60", "--snapshot"]).stdout, { timeout: 30_000, intervals: [500] }).toContain("faux done");
  // workflow gathers from a fleet of the new runtime.
  const wf = hive(["ctl", "workflow", "--shape", "fanout", "--agent", "faux", "--items", "x || y", "--prompt", "echo did {item}", "--timeout", "60000", "--close", "--json"], { HIVEMIND_TILE: orchestrator });
  expect(wf.code, wf.stdout + wf.stderr).toBe(0);
  expect(wf.json.items.map((i: any) => [i.status, i.text])).toEqual([["turn", "did x"], ["turn", "did y"]]);
  // close → no leaked tile.
  expect(hive(["ctl", "close", worker, "--json"]).json).toEqual({ ok: true });
  await expect.poll(() => hive(["ctl", "list", "--json"]).json.frames.flatMap((f: any) => f.tiles.map((t: any) => t.tileId)), { timeout: 10_000 }).not.toContain(worker);
});
