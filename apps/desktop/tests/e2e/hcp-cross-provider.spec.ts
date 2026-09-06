// Acceptance test for the CLI-first control plane: two DIFFERENT providers
// (claude + droid) coordinate through `hive ctl` alone — the vocabulary the
// `hivemind` / `hive-workflow` skills teach. Scripted and repeatable: the
// providers are stand-ins on PATH (fixtures/fake-agent.cjs) that honour the real
// hook injection each provider gets (claude: `--settings`; droid: the
// FACTORY_HOME_OVERRIDE hooks.json), so the path under test is the real one —
// spawn → provider transforms → hooks → turn-tracker → transcript gather →
// mailbox delivery — with no LLM in the loop.
//
// Runs with the PTY daemon ON (the in-process PTY path has no provider
// injection); the daemon lives under the isolated XDG profile and is reaped in
// afterAll + global-teardown.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, "../..");
const CLI = path.resolve(APP_DIR, "../cli/src/index.ts");
const FIXTURE = path.join(__dirname, "fixtures", "fake-agent.cjs");

let app: ElectronApplication;
let page: Page;
let repo: string;
let fakeBin: string;
let sock: string;
let token: string;
let orchestrator: string;

function onPath(bin: string): string {
  for (const d of (process.env.PATH ?? "").split(":")) {
    const p = path.join(d, bin);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  throw new Error(`${bin} not on PATH`);
}

/** Run `hive …` exactly as an agent would: a subprocess with the HCP env. */
function hive(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(onPath("bun"), [CLI, ...args], {
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, HIVE_HCP_SOCK: sock, HCP_TOKEN: token, ...env },
  });
  let json: any;
  try { json = JSON.parse(r.stdout.trim().split("\n").pop() || ""); } catch { /* not json */ }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "hm-xprov-"));
  execSync("git init -q", { cwd: repo });
  // Provider stand-ins + a `hive` that runs this checkout's CLI, first on PATH.
  fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "hm-xprov-bin-"));
  for (const name of ["claude", "droid", "codex"]) {
    const shim = path.join(fakeBin, name);
    fs.writeFileSync(shim, `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FIXTURE)} ${name} "$@"\n`);
    fs.chmodSync(shim, 0o755);
  }
  const hiveShim = path.join(fakeBin, "hive");
  fs.writeFileSync(hiveShim, `#!/usr/bin/env bash\nexec ${JSON.stringify(onPath("bun"))} ${JSON.stringify(CLI)} "$@"\n`);
  fs.chmodSync(hiveShim, 0o755);

  app = await electron.launch({
    args: [path.join(APP_DIR, "out/main/index.js"), "--no-sandbox"],
    cwd: repo,
    // HIVEMIND_SHELL_ENV=0: keep OUR PATH (the stand-ins first) instead of the
    // login shell's, which would put the real `claude` back in front.
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, HIVEMIND_PTY_DAEMON: "1", HIVEMIND_SHELL_ENV: "0" } as Record<string, string>,
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForSelector(".react-flow", { timeout: 15_000 });

  // The control-plane socket + token live in the (isolated) userData dir.
  const userData = path.join(process.env.XDG_CONFIG_HOME!, "hivemind-dev");
  sock = path.join(userData, "hcp.sock");
  const tokenFile = path.join(userData, "hcp.token");
  await expect.poll(() => fs.existsSync(sock) && fs.existsSync(tokenFile), { timeout: 20_000 }).toBe(true);
  token = fs.readFileSync(tokenFile, "utf8").trim();
});

test.afterAll(async () => {
  // Reap ONLY the daemon this spec started (its socket is under the test XDG)
  // BEFORE closing the app: electronApp.close() waits on child processes, and
  // the detached daemon would stall teardown.
  try { execSync(`pkill -f "out/main/pty-daemon.js ${process.env.XDG_CONFIG_HOME}/"`, { stdio: "ignore" }); } catch { /* none */ }
  // close() waits on child processes; if the app is wedged on one, kill it
  // outright rather than stall the worker teardown.
  const closed = await Promise.race([app?.close().then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 10_000))]);
  if (!closed) { try { app?.process().kill("SIGKILL"); } catch { /* gone */ } }
  // Stand-in agents this spec's tiles spawned (pattern anchored on the fixture
  // path + provider argv so it can never match an unrelated shell).
  try { execSync(`pkill -f "fixtures/fake-agent\\.cjs (claude|droid|codex|faux) "`, { stdio: "ignore" }); } catch { /* none */ }
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(fakeBin, { recursive: true, force: true });
});

test("spawn a claude worker and read its reply: --settings hooks → turn → transcript", async () => {
  const r = hive(["ctl", "spawn", "--agent", "claude", "--name", "orchestrator", "--prompt", "echo orchestrator ready", "--json"]);
  expect(r.code, r.stderr).toBe(0);
  orchestrator = r.json.tileId;
  expect(orchestrator).toMatch(/^tile-/);
  const read = hive(["ctl", "read", orchestrator, "--timeout", "40000", "--json"]);
  expect(read.code, read.stdout + read.stderr).toBe(0);
  expect(read.json).toMatchObject({ text: "orchestrator ready", finalStatus: "turn" });
  // The worker carries the runtime id hivemind injects (signs Activity rows).
  hive(["ctl", "send", orchestrator, "echo id=$HIVE_AGENT_ID tile=$HIVEMIND_TILE"]);
  const second = hive(["ctl", "read", orchestrator, "--timeout", "40000", "--json"]);
  expect(second.json.text).toBe(`id=claude tile=hm:${orchestrator}`);
});

test("fanout over droid workers from the claude orchestrator: hooks.json injection + typed prompt + gather", async () => {
  const r = hive(
    ["ctl", "workflow", "--shape", "fanout", "--agent", "droid", "--items", "alpha || beta", "--prompt", "echo reviewed {item} by $HIVE_AGENT_ID", "--timeout", "60000", "--close", "--json"],
    { HIVEMIND_TILE: orchestrator },
  );
  expect(r.code, r.stdout + r.stderr).toBe(0);
  expect(r.json.shape).toBe("fanout");
  expect(r.json.items.map((i: any) => [i.item, i.status, i.text])).toEqual([
    ["alpha", "turn", "reviewed alpha by droid"],
    ["beta", "turn", "reviewed beta by droid"],
  ]);
});

test("a droid worker reports back to the claude orchestrator with `hive ctl report`; send/read a follow-up", async () => {
  const spawn = hive(
    ["ctl", "spawn", "--agent", "droid", "--name", "reporter", "--prompt", "hive ctl report 'droid worker done' --json", "--json"],
    { HIVEMIND_TILE: orchestrator },
  );
  expect(spawn.code, spawn.stderr).toBe(0);
  const worker: string = spawn.json.tileId;
  const read = hive(["ctl", "read", worker, "--timeout", "60000", "--json"]);
  expect(read.code, read.stdout + read.stderr).toBe(0);
  expect(read.json.finalStatus).toBe("turn");
  expect(JSON.parse(read.json.text)).toMatchObject({ delivered: true });
  // The report is typed into the orchestrator's terminal (mailbox delivery) —
  // visible on its screen via stream --snapshot.
  await expect
    .poll(() => hive(["ctl", "stream", orchestrator, "--lines", "60", "--snapshot"]).stdout, { timeout: 30_000, intervals: [500] })
    .toContain("droid worker done");

  hive(["ctl", "send", worker, "echo second turn from $HIVE_AGENT_ID"]);
  const again = hive(["ctl", "read", worker, "--timeout", "40000", "--json"]);
  expect(again.json).toMatchObject({ text: "second turn from droid", finalStatus: "turn" });

  const list = hive(["ctl", "list", "--json"]);
  const ids = list.json.frames.flatMap((f: any) => f.tiles.map((t: any) => t.tileId));
  expect(ids).toEqual(expect.arrayContaining([orchestrator, worker]));
  expect(hive(["ctl", "close", worker, "--json"]).json).toEqual({ ok: true });
  await expect
    .poll(() => hive(["ctl", "list", "--json"]).json.frames.flatMap((f: any) => f.tiles.map((t: any) => t.tileId)), { timeout: 10_000 })
    .not.toContain(worker);
});

test("structured failures: bad token exits 6, missing tile exits 5", async () => {
  const bad = hive(["ctl", "list", "--json"], { HCP_TOKEN: "nope" });
  expect(bad.code).toBe(6);
  expect(bad.json).toMatchObject({ ok: false, code: "UNAUTHORIZED" });
  const gone = hive(["ctl", "send", "tile-does-not-exist", "hi", "--json"]);
  expect(gone.code).toBe(5);
  expect(gone.json).toMatchObject({ ok: false, code: "TILE_NOT_FOUND" });
});

test("a runtime without a turn signal is refused up front, not timed out (exit 7 UNSUPPORTED)", async () => {
  // Client-side: `workflow` needs gatherable replies — refused before any tile is spawned.
  const wf = hive(["ctl", "workflow", "--shape", "fanout", "--agent", "codex", "--items", "a", "--prompt", "echo {item}", "--json"], { HIVEMIND_TILE: orchestrator });
  expect(wf.code).toBe(7);
  expect(wf.json).toMatchObject({ ok: false, code: "UNSUPPORTED" });
  expect(String(wf.json.message)).toContain("codex");
  // An unknown runtime is a usage error listing the spawnable ids.
  const unknown = hive(["ctl", "spawn", "--agent", "nope", "--prompt", "x", "--json"]);
  expect(unknown.code).toBe(2);
  expect(String(unknown.json.message)).toContain("claude");
  // Spawning it is fine (a manual tile); reading from it is refused by the control plane.
  const spawn = hive(["ctl", "spawn", "--agent", "codex", "--name", "manual", "--prompt", "echo raw", "--json"]);
  expect(spawn.code, spawn.stderr).toBe(0);
  const read = hive(["ctl", "read", spawn.json.tileId, "--poll", "--json"]);
  expect(read.code).toBe(7);
  expect(read.json).toMatchObject({ ok: false, code: "UNSUPPORTED" });
  expect(String(read.json.message)).toMatch(/codex has no turn signal/);
  expect(hive(["ctl", "close", spawn.json.tileId, "--json"]).json).toEqual({ ok: true });
});
