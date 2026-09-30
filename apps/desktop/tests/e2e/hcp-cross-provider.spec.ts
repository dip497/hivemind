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
import { execSync, spawn, spawnSync } from "node:child_process";
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
const home = fs.mkdtempSync(path.join(os.tmpdir(), "hm-xprov-home-"));
let sock: string;
let token: string;
let orchestrator: string;
let userData: string;

function onPath(bin: string): string {
  for (const d of (process.env.PATH ?? "").split(":")) {
    const p = path.join(d, bin);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  throw new Error(`${bin} not on PATH`);
}

const hiveEnv = (env: Record<string, string>) =>
  ({ ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, HIVE_HCP_SOCK: sock, HCP_TOKEN: token, ...env });
function lastJson(stdout: string): any {
  try { return JSON.parse(stdout.trim().split("\n").pop() || ""); } catch { return undefined; }
}

/** Run `hive …` exactly as an agent would: a subprocess with the HCP env. */
function hive(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(onPath("bun"), [CLI, ...args], { encoding: "utf8", timeout: 120_000, env: hiveEnv(env) });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json: lastJson(r.stdout) };
}

/** `hive …` left running, for a call that waits on what the test does next. */
function hiveLater(args: string[]): Promise<{ code: number | null; json: any }> {
  return new Promise((resolve) => {
    const child = spawn(onPath("bun"), [CLI, ...args], { env: hiveEnv({}) });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", (code) => resolve({ code, json: lastJson(out) }));
  });
}

/** The processes running for a tile: an agent and what it starts carry the tile's id. */
function processesOf(tileId: string): string[] {
  return fs.readdirSync("/proc").filter((pid) => {
    if (!/^\d+$/.test(pid)) return false;
    try { return fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(`HIVEMIND_TILE=hm:${tileId}`); } catch { return false; }
  });
}

/** What the app's audit log says was done, without when. */
const audited = () =>
  fs.readFileSync(path.join(userData, "audit.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => { const { at: _at, ...rest } = JSON.parse(l); return rest; });

/** The tiles the canvas has a place for, as main's store keeps them for this workspace. */
const placed = () => page.evaluate((r) => Object.keys((window.hive.workspaceViewSync(r, "canvas") as { data?: { positions?: object } } | null)?.data?.positions ?? {}), repo);

test.beforeAll(async () => {
  test.setTimeout(180_000);
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "hm-xprov-"));
  execSync("git init -q", { cwd: repo });
  // Provider stand-ins + a `hive` that runs this checkout's CLI, first on PATH.
  fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "hm-xprov-bin-"));
  for (const name of ["claude", "droid", "cursor-agent"]) {
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
    // HOME of its own: the sessions this spec lists are written there, never in a real one.
    env: { ...process.env, HOME: home, PATH: `${fakeBin}:${process.env.PATH}`, HIVEMIND_PTY_DAEMON: "1", HIVEMIND_SHELL_ENV: "0" } as Record<string, string>,
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForSelector(".react-flow", { timeout: 15_000 });

  // The control-plane socket + token live in the (isolated) userData dir.
  userData = path.join(process.env.XDG_CONFIG_HOME!, "hivemind-dev");
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
  // Closing, the app found its daemon gone and started another to let go of its tiles: reap
  // that one too, or the next spec on this profile's socket runs in this spec's environment.
  try { execSync(`pkill -f "out/main/pty-daemon.js ${process.env.XDG_CONFIG_HOME}/"`, { stdio: "ignore" }); } catch { /* none */ }
  // Stand-in agents this spec's tiles spawned (pattern anchored on the fixture
  // path + provider argv so it can never match an unrelated shell).
  try { execSync(`pkill -f "fixtures/fake-agent\\.cjs (claude|droid|cursor-agent|faux) "`, { stdio: "ignore" }); } catch { /* none */ }
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(fakeBin, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test("spawn a claude worker and read its reply: --settings hooks → reply → turn", async () => {
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

test("an unnamed tile is called by what its agent says it is doing — the host's reading of its title", async () => {
  const r = hive(["ctl", "spawn", "--agent", "claude", "--prompt", "echo titled", "--json"]);
  expect(r.code, r.stderr).toBe(0);
  const nameOf = () => hive(["ctl", "list", "--json"]).json.frames.flatMap((f: any) => f.tiles).find((t: any) => t.tileId === r.json.tileId)?.name;
  await expect.poll(nameOf, { timeout: 20_000 }).toBe("echo titled");
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
  expect(processesOf(worker)).not.toEqual([]);
  await expect.poll(placed).toContain(worker);
  expect(hive(["ctl", "close", worker, "--json"]).json).toEqual({ ok: true });
  await expect
    .poll(() => hive(["ctl", "list", "--json"]).json.frames.flatMap((f: any) => f.tiles.map((t: any) => t.tileId)), { timeout: 10_000 })
    .not.toContain(worker);
  // Closed is ended: nothing is left running for it in the daemon, and the window keeps nothing of it.
  await expect.poll(() => processesOf(worker), { timeout: 10_000 }).toEqual([]);
  await expect.poll(placed).not.toContain(worker);
  // Each was done by someone the app's audit log names: the report by the worker, with the token
  // its tile was given; the spawn (for the orchestrator), the send and the close by the person at
  // this terminal, with the app's.
  expect(audited().filter((l) => l.target === worker || l.actor.tile === worker)).toEqual([
    { actor: { kind: "person" }, verb: "tile.spawn_agent", target: worker, outcome: "ok" },
    { actor: { kind: "tile", tile: worker }, verb: "agent.report", target: orchestrator, outcome: "ok" },
    { actor: { kind: "person" }, verb: "agent.send", target: worker, outcome: "ok" },
    { actor: { kind: "person" }, verb: "tile.close", target: worker, outcome: "ok" },
  ]);
});

test("a busy worker closed in the Windows view ends, and a read waiting on its reply is told so at once", async () => {
  const spawned = hive(["ctl", "spawn", "--agent", "claude", "--name", "closed-early", "--prompt", "sleep 60; echo late", "--json"]);
  expect(spawned.code, spawned.stderr).toBe(0);
  const worker: string = spawned.json.tileId;
  await expect.poll(() => processesOf(worker).length, { timeout: 15_000 }).toBeGreaterThan(0);
  const reading = hiveLater(["ctl", "read", worker, "--timeout", "30000", "--json"]);
  await page.waitForTimeout(1_500); // the read is waiting before the tile goes
  const toView = (mode: string) => page.evaluate((m) => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: m } })), mode);
  await toView("windows");
  const tab = page.getByRole("tab", { name: "closed-early" });
  await tab.hover();
  await tab.getByRole("button", { name: "Close closed-early", exact: true }).click();
  // Told at once, and told it is gone (exit 5): reading it again would wait for nothing.
  expect(await reading).toMatchObject({ code: 5, json: { finalStatus: "closed" } });
  await expect.poll(() => processesOf(worker), { timeout: 10_000 }).toEqual([]);
  await toView("canvas");
});

test("a tile named by the control plane is named in the window at once; with no name it goes back to what it does", async () => {
  const spawned = hive(["ctl", "spawn", "--agent", "claude", "--name", "before", "--prompt", "echo named", "--json"]);
  expect(spawned.code, spawned.stderr).toBe(0);
  const tile: string = spawned.json.tileId;
  // Straight after the spawn: the tile the window made for it is already in main's store.
  expect(hive(["ctl", "rename", tile, "after", "--json"]).json).toEqual({ ok: true, name: "after" });
  await expect(page.locator(".hm-layers").getByText("after", { exact: true })).toBeVisible();
  const nameOf = () => hive(["ctl", "list", "--json"]).json.frames.flatMap((f: any) => f.tiles).find((t: any) => t.tileId === tile)?.name;
  expect(nameOf()).toBe("after");
  // No name: what its agent says it is doing, or what it was started to do.
  expect(hive(["ctl", "rename", tile, "--json"]).json).toEqual({ ok: true, name: "" });
  await expect.poll(nameOf).not.toBe("after");
  expect(hive(["ctl", "rename", "tile-nowhere", "x", "--json"]).code).toBe(5);
});

test("a tile the control plane closes straight after spawning it leaves the window and ends; one no workspace holds is not found", async () => {
  const spawned = hive(["ctl", "spawn", "--agent", "claude", "--name", "brief", "--prompt", "sleep 60; echo late", "--json"]);
  expect(spawned.code, spawned.stderr).toBe(0);
  const tile: string = spawned.json.tileId;
  await expect(page.locator(`.react-flow__node[data-id="${tile}"]`)).toHaveCount(1);
  expect(hive(["ctl", "close", tile, "--json"])).toMatchObject({ code: 0, json: { ok: true } });
  await expect(page.locator(`.react-flow__node[data-id="${tile}"]`)).toHaveCount(0);
  await expect.poll(() => processesOf(tile), { timeout: 10_000 }).toEqual([]);
  expect(hive(["ctl", "close", tile, "--json"])).toMatchObject({ code: 5, json: { code: "TILE_NOT_FOUND" } });
  // Nothing of it is kept: a window that opens now is not sent its status.
  expect((await page.evaluate(() => window.hive.hcpStatusAll())).map((s) => s.tileId)).not.toContain(tile);
});

test("a worker spawned into a frame by its name opens there, and the window lays it out; a name no frame answers to is refused", async () => {
  const [frame] = hive(["ctl", "frames", "--json"]).json.frames;
  const spawned = hive(["ctl", "spawn", "--agent", "claude", "--frame", frame.title.toUpperCase(), "--name", "framed", "--prompt", "echo framed", "--json"]);
  expect(spawned.code, spawned.stderr).toBe(0);
  const tile: string = spawned.json.tileId;
  expect(hive(["ctl", "list", "--frame", frame.id, "--json"]).json.frames[0].tiles.map((t: any) => t.tileId)).toContain(tile);
  await expect.poll(placed).toContain(tile);
  expect(hive(["ctl", "spawn", "--agent", "claude", "--frame", "no-such-frame", "--json"])).toMatchObject({ code: 5, json: { code: "NOT_FOUND" } });
  hive(["ctl", "close", tile]);
});

test("an agent's past sessions are listed for its folder, and one can be continued", async () => {
  const id = "0d3c2a10-1111-4222-8333-444455556666";
  const proj = path.join(home, ".claude", "projects", "-repo");
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, `${id}.jsonl`), JSON.stringify({ type: "user", cwd: repo, message: { content: "earlier work" } }) + "\n");
  const list = hive(["ctl", "sessions", "claude", "--cwd", repo, "--json"]);
  expect(list.code, list.stderr).toBe(0);
  expect(list.json).toMatchObject({ agent: "claude", resumable: true, sessions: [{ id, cwd: repo, title: "earlier work" }] });
  expect(hive(["ctl", "sessions", "claude", "--cwd", "/nowhere", "--json"]).json.sessions).toEqual([]);

  const r = hive(["ctl", "spawn", "--agent", "claude", "--resume", id, "--prompt", "echo resumed=$FAKE_RESUMED", "--json"]);
  expect(r.code, r.stderr).toBe(0);
  const read = hive(["ctl", "read", r.json.tileId, "--timeout", "40000", "--json"]);
  expect(read.json).toMatchObject({ text: `resumed=${id}`, finalStatus: "turn" });
  // An id is never anything but an id on the command line.
  expect(hive(["ctl", "spawn", "--agent", "claude", "--resume", "../x", "--json"]).code).not.toBe(0);
});

test("structured failures: bad token exits 6, missing tile or frame exits 5", async () => {
  const bad = hive(["ctl", "list", "--json"], { HCP_TOKEN: "nope" });
  expect(bad.code).toBe(6);
  expect(bad.json).toMatchObject({ ok: false, code: "UNAUTHORIZED" });
  const gone = hive(["ctl", "send", "tile-does-not-exist", "hi", "--json"]);
  expect(gone.code).toBe(5);
  expect(gone.json).toMatchObject({ ok: false, code: "TILE_NOT_FOUND" });
  expect(hive(["ctl", "list", "--frame", "no-such-frame", "--json"])).toMatchObject({ code: 5, json: { ok: false, code: "NOT_FOUND" } });
  const started = Date.now();
  expect(hive(["ctl", "read", "tile-does-not-exist", "--timeout", "30000", "--json"])).toMatchObject({ code: 5, json: { ok: false, code: "TILE_NOT_FOUND" } });
  expect(Date.now() - started).toBeLessThan(10_000); // at once, not at the timeout
});

test("a runtime without a turn signal is refused up front, not timed out (exit 7 UNSUPPORTED)", async () => {
  // Client-side: `workflow` needs gatherable replies — refused before any tile is spawned.
  const wf = hive(["ctl", "workflow", "--shape", "fanout", "--agent", "cursor", "--items", "a", "--prompt", "echo {item}", "--json"], { HIVEMIND_TILE: orchestrator });
  expect(wf.code).toBe(7);
  expect(wf.json).toMatchObject({ ok: false, code: "UNSUPPORTED" });
  expect(String(wf.json.message)).toContain("cursor");
  // An unknown runtime is a usage error listing the spawnable ids.
  const unknown = hive(["ctl", "spawn", "--agent", "nope", "--prompt", "x", "--json"]);
  expect(unknown.code).toBe(2);
  expect(String(unknown.json.message)).toContain("claude");
  // Spawning it is fine (a manual tile); reading from it is refused by the control plane.
  const spawn = hive(["ctl", "spawn", "--agent", "cursor", "--name", "manual", "--prompt", "echo raw", "--json"]);
  expect(spawn.code, spawn.stderr).toBe(0);
  const read = hive(["ctl", "read", spawn.json.tileId, "--poll", "--json"]);
  expect(read.code).toBe(7);
  expect(read.json).toMatchObject({ ok: false, code: "UNSUPPORTED" });
  expect(String(read.json.message)).toMatch(/cursor has no turn signal/);
  expect(hive(["ctl", "close", spawn.json.tileId, "--json"]).json).toEqual({ ok: true });
});

test("a title read while the agent's manifest is broken shows up when the manifest comes back", async () => {
  // What an app upgraded past a manifest change sees: the agent's manifest on disk is one it
  // refuses, so nothing tells it which of that agent's titles are a task. The titles read
  // meanwhile must not be lost — an idle agent never sets its title again, so putting the
  // manifest back has to be enough. Last in this file: it takes claude's manifest away.
  const r = hive(["ctl", "spawn", "--agent", "claude", "--prompt", "echo first", "--json"]);
  expect(r.code, r.stdout + r.stderr).toBe(0);
  const tile: string = r.json.tileId;
  const nameOf = () => hive(["ctl", "list", "--json"]).json.frames.flatMap((f: any) => f.tiles).find((t: any) => t.tileId === tile)?.name;
  await expect.poll(nameOf, { timeout: 20_000 }).toBe("echo first");

  const dir = path.join(process.env.XDG_CONFIG_HOME!, "hivemind", "agents", "claude");
  const away = `${dir}.away`;
  try {
    fs.renameSync(dir, away); // an install replaces the folder, which is what the host watches
    await new Promise((done) => setTimeout(done, 3000));
    hive(["ctl", "send", tile, "echo second"]);
    await new Promise((done) => setTimeout(done, 6000)); // its new title is read with no manifest to read it
    expect(await nameOf()).not.toMatch(/echo second/);
    fs.renameSync(away, dir);
    await expect.poll(nameOf, { timeout: 30_000 }).toBe("echo second");
  } finally {
    if (fs.existsSync(away)) fs.renameSync(away, dir);
    hive(["ctl", "close", tile, "--json"]);
  }
});
