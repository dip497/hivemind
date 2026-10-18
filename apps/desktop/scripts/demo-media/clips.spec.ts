// The short clips' frames, each recorded from the real app over the demo workspace, one test per
// clip: `npx playwright test --config scripts/demo-media/capture.config.ts clips.spec.ts -g widgets`.
// Every tile is a real Claude Code on a real job (stage.ts); nothing on screen is drawn by the
// clip. Run by demo-media.mjs, never by the e2e suite.
import { test, expect, chromium, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { hiveNetBuilt, note, ownNetwork, share } from "../../tests/e2e/helpers/multiplayer";
import { connectPage, offerToConnect } from "../../tests/e2e/helpers/phone";
import { stopDaemons } from "../../tests/e2e/helpers/daemons";
import { DEMO, OUT, ROOT, WWW, allow, busy, demoInstructions, recorder, runnerSettings, stage } from "./stage";

// The showcase plugins, from their own examples folder.
const SHOWCASE = process.env.SHOWCASE ?? path.join(os.homedir(), "projects/hivemind-showcase/examples");
const SHOWCASE_WIDGETS = ["agent-pulse", "waiting-on-you", "issue-burndown", "launchpad", "ci-light"];

let root = "";
const apps: ElectronApplication[] = [];
const procs: ChildProcess[] = [];
const after: (() => void)[] = [];
test.beforeAll(() => test.skip(!fs.existsSync(path.join(DEMO, "fastapi/.hivemind")), "run demo-workspace.sh first"));
test.beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-clip-")); });
test.afterEach(async () => {
  settingsUnchanged([DEMO, root]);
  for (const a of apps.splice(0)) await Promise.race([a.close(), new Promise((r) => setTimeout(r, 8000))]);
  for (const p of procs.splice(0)) p.kill("SIGKILL");
  for (const f of after.splice(0)) f();
  stopDaemons(root);
});

// The only commands a clip answers Yes to, each the one its job names; anything else fails it.
const RUFF = /^ruff check fastapi\/?( --[\w-]+)*(; echo "EXIT=\$\?")?$/;
const FLAKY = /^hive ctl plugin call dip497\/flaky-tests flaky( --json)?$/;

// Jobs a person would give, each about its own folder.
const JOB = {
  ci: "Run ruff check fastapi, then report the result on the CI light: hive ctl plugin call @dip497/ci-light set with state passed or failed, name ruff, branch main and a short detail line",
  triage: "Ask the flaky-tests tool for the last runs with hive ctl plugin call dip497/flaky-tests flaky, then say in two lines which tests to look at first",
  routing: "Read fastapi/routing.py and list three functions that have no docstring",
  docstrings: "Add a short docstring to generate_encoders_by_class_tuples in fastapi/encoders.py",
  review: "Review this branch: read git diff main, then packages/element/src/binding.ts and its tests, and list what could break",
  glob: "Read how --glob and --iglob are combined in crates/core/flags/defs.rs, then list the order they apply in, with one example",
  flags: "Count the flags defined in crates/core/flags/defs.rs and name the five most used in GUIDE.md",
};
let settingsUnchanged: (marks: string[]) => void = () => {};
test.beforeEach(() => {
  settingsUnchanged = runnerSettings();
  demoInstructions(["fastapi", "excalidraw", "arrow-binding", "ripgrep", "glob-order"]);
});
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("widgets", async () => {
  test.setTimeout(900_000);
  const s = await stage(root, apps);
  const { desktop, cli } = s;
  const frames = await s.openFrames(["fastapi"]);
  const ci = await s.agent(frames.fastapi, "ci-check", "acceptEdits");
  const asker = await s.agent(frames.fastapi, "docstrings", "default", JOB.docstrings);
  const routing = await s.agent(frames.fastapi, "routing-review", "default", JOB.routing);
  await expect.poll(() => s.census().of(asker)?.waiting?.kind ?? "", { timeout: 300_000, intervals: [1000] }).toBe("permission");
  await busy(s, [routing]);
  for (const name of SHOWCASE_WIDGETS) {
    const r = cli("widgets", "install", path.join(SHOWCASE, "widgets", name), "--json");
    expect(r.status, r.stdout + r.stderr).toBe(0);
  }
  await desktop.evaluate(() => window.dispatchEvent(new Event("focus")));
  await s.tidy([frames.fastapi]);
  await s.quiet();

  const rec = recorder(s.app, path.join(OUT, "widgets"), OUT);
  await rec.burst("board", 4);
  // One after another, as a person adds them from the Add menu or an agent opens them.
  const adding = rec.beat("adding");
  for (const name of SHOWCASE_WIDGETS) {
    expect(cli("ctl", "plugin", "open", `widget:@dip497/${name}`).status).toBe(0);
    for (let i = 0; i < 3; i++) { await desktop.waitForTimeout(400); await adding(); }
  }
  for (const name of SHOWCASE_WIDGETS) await rec.box(desktop, `[data-widget="@dip497/${name}"]`, name);
  await rec.box(desktop, "[data-widget-layer]", "layer").catch(() => {});
  // A real agent drives one: it runs the check and reports it on the CI light.
  cli("ctl", "send", ci, JOB.ci);
  const light = rec.beat("reporting");
  const approved: string[] = [];
  const said = () => desktop.locator('[data-widget="@dip497/ci-light"]').innerText().catch(() => "");
  const before = await said();
  for (let i = 0; i < 300 && !((await said()) !== before && s.census().of(ci)?.state !== "working"); i++) {
    // What it runs that is not on its list it asks about first; the person allows it.
    allow(s, ci, RUFF, approved);
    await light(); await desktop.waitForTimeout(700);
  }
  expect(await said(), s.show()).not.toBe(before);
  await rec.burst("reported", 6);
  rec.save({ widgets: SHOWCASE_WIDGETS, light: await said(), approved, agents: { "ci-check": "claude", docstrings: "claude", "routing-review": "claude" } });
});

test("tools", async () => {
  test.setTimeout(900_000);
  // The tests flaky-tests runs, built once before the clip so the runs show at their own speed.
  const tests = "cargo test -p globset --lib -q";
  execFileSync("nice", ["-n", "15", "bash", "-c", tests], { cwd: path.join(DEMO, "ripgrep"), stdio: "ignore", timeout: 600_000 });
  const s = await stage(root, apps, { cwd: path.join(DEMO, "ripgrep") });
  const { desktop, cli } = s;
  for (const name of ["flaky-tests", "changelog-writer"]) {
    const r = cli("tools", "install", path.join(SHOWCASE, "tools", name), "--json");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(cli("plugins", "enable", `tool:dip497/${name}`, "--json").status).toBe(0);
  }
  for (const [k, v] of [["command", tests], ["runs", "8"]]) cli("plugins", "set", "tool:dip497/flaky-tests", k!, v!);
  const frames = await s.openFrames(["ripgrep", "glob-order"]);
  const glob = await s.agent(frames["glob-order"], "glob-docs", "default", JOB.glob);
  const triage = await s.agent(frames.ripgrep, "test-triage", "default");
  await busy(s, [glob]);
  await s.tidy(Object.values(frames));
  await s.quiet();

  const rec = recorder(s.app, path.join(OUT, "tools"), OUT);
  const opened = JSON.parse(cli("ctl", "plugin", "open", "tool:dip497/flaky-tests", "--frame", frames.ripgrep, "--json").stdout || "{}").tile as string;
  expect(opened, "flaky-tests opened in a tile").toBeTruthy();
  await s.emit("hivemind:focus-tile", opened);
  await desktop.waitForTimeout(2500);
  await rec.box(desktop, `.react-flow__node[data-id="${opened}"]`, "tool");
  await rec.burst("tool", 3);
  const running = rec.beat("running");
  await desktop.getByRole("button", { name: /^Run 8 times/ }).first().click();
  for (let i = 0; i < 400; i++) {
    await running();
    if (await desktop.getByRole("button", { name: /^Run 8 times/ }).first().isEnabled().catch(() => false) && i > 3) break;
    await desktop.waitForTimeout(600);
  }
  await expect(desktop.locator(`.react-flow__node[data-id="${opened}"]`), "the runs found tests").not.toContainText("No test results", { timeout: 5_000 });
  await rec.burst("ran", 4);
  // An agent asks the same tool, from its own terminal.
  cli("ctl", "send", triage, JOB.triage);
  await s.emit("hivemind:focus-tile", triage);
  await desktop.waitForTimeout(1500);
  await rec.box(desktop, `.react-flow__node[data-id="${triage}"]`, "triage");
  const asking = rec.beat("asking");
  const approved: string[] = [];
  for (let i = 0; i < 300 && !(i > 5 && s.census().of(triage)?.state !== "working"); i++) {
    await asking();
    allow(s, triage, FLAKY, approved);
    await desktop.waitForTimeout(700);
  }
  await rec.burst("answered", 6);
  rec.save({ agents: { "glob-docs": "claude", "test-triage": "claude" }, approved, triage: s.census().of(triage) });
});

test("views", async () => {
  test.setTimeout(900_000);
  const s = await stage(root, apps);
  const { desktop, cli } = s;
  for (const name of ["agents-by-state", "timeline", "constellation"]) {
    const r = cli("views", "install", path.join(SHOWCASE, "views", name), "--json");
    expect(r.status, r.stdout + r.stderr).toBe(0);
  }
  cli("plugins", "set", "view:@dip497/constellation", "frameRate", "30");
  const frames = await s.openFrames(["fastapi", "arrow-binding", "glob-order"]);
  const asker = await s.agent(frames.fastapi, "docstrings", "default", JOB.docstrings);
  const agents = [
    await s.agent(frames["arrow-binding"], "arrow-review", "default", JOB.review),
    await s.agent(frames["glob-order"], "glob-order", "default", JOB.glob),
    await s.agent(frames.fastapi, "routing-review", "default", JOB.routing),
  ];
  await busy(s, agents);
  await s.tidy(Object.values(frames));
  await s.quiet();

  const rec = recorder(s.app, path.join(OUT, "views"), OUT);
  await rec.burst("board", 4);
  for (const name of ["agents-by-state", "timeline", "constellation"]) {
    const id = `@dip497/${name}`;
    expect(cli("ctl", "plugin", "open", `view:${id}`).status).toBe(0);
    await expect(desktop.locator(`[data-community-view="${id}"][data-community-ready="1"]`)).toHaveCount(1, { timeout: 30_000 });
    await desktop.waitForTimeout(1500);
    await rec.burst(name, name === "constellation" ? 16 : 5);
  }
  // The constellation docks the terminal of the agent waiting on you.
  const docking = rec.beat("docking");
  await docking();
  const r = cli("ctl", "plugin", "call", "@dip497/constellation", "show", JSON.stringify({ name: "docstrings" }));
  expect(r.status, r.stdout + r.stderr).toBe(0);
  for (let i = 0; i < 8; i++) { await desktop.waitForTimeout(400); await docking(); }
  await rec.burst("docked", 6);
  rec.save({ agents: { docstrings: "claude", "arrow-review": "claude", "glob-order": "claude", "routing-review": "claude" }, waiting: s.census().of(asker)?.waiting?.kind ?? null });
});

test("machines", async () => {
  test.setTimeout(600_000);
  const HIVE = path.join(ROOT, "apps/cli/dist/hive");
  test.skip(!fs.existsSync("/usr/sbin/sshd") || !fs.existsSync(HIVE), "needs /usr/sbin/sshd and apps/cli/dist/hive");
  // A second machine: this computer over ssh, on port 22422, with its own home and its own name.
  const dir = fs.mkdtempSync("/tmp/hm-clip-m-");
  after.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const d of ["rhome/bin"]) fs.mkdirSync(path.join(dir, d), { recursive: true });
  for (const k of ["host_key", "client_key"]) execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path.join(dir, k)]);
  fs.copyFileSync(path.join(dir, "client_key.pub"), path.join(dir, "authorized_keys"));
  const named = path.join(dir, "build-box.so");
  execFileSync("gcc", ["-shared", "-fPIC", "-x", "c", "-o", named, "-"], { input: '#include <string.h>\nint gethostname(char *n, unsigned long l) { strncpy(n, "build-box", l); return 0; }\n' });
  const port = 22422;
  expect(await new Promise((ok) => { const c = net.connect(port, "127.0.0.1").on("connect", () => { c.destroy(); ok(false); }).on("error", () => ok(true)); }), `port ${port} is taken`).toBe(true);
  fs.writeFileSync(path.join(dir, "sshd_config"), [
    `Port ${port}`, "ListenAddress 127.0.0.1", `HostKey ${dir}/host_key`, `AuthorizedKeysFile ${dir}/authorized_keys`,
    `PidFile ${dir}/sshd.pid`, "PasswordAuthentication no", "KbdInteractiveAuthentication no", "UsePAM no", "StrictModes no", "LogLevel ERROR",
    `SetEnv HOME=${dir}/rhome XDG_CONFIG_HOME=${dir}/rhome/.config HIVEMIND_PTY_SOCK=${dir}/r.sock LD_PRELOAD=${named} USER=hivemind PATH=${dir}/rhome/bin:/usr/local/bin:/usr/bin:/bin`, "",
  ].join("\n"));
  execFileSync("/usr/sbin/sshd", ["-f", path.join(dir, "sshd_config")]);
  after.push(() => { try { process.kill(Number(fs.readFileSync(path.join(dir, "sshd.pid"), "utf8"))); } catch { /* gone */ } });
  const agent = execFileSync("ssh-agent", ["-a", path.join(dir, "agent.sock"), "-s"], { encoding: "utf8" });
  const agentPid = Number(/SSH_AGENT_PID=(\d+)/.exec(agent)?.[1] ?? 0);
  after.push(() => { if (agentPid) try { process.kill(agentPid); } catch { /* gone */ } });
  execFileSync("ssh-add", [path.join(dir, "client_key")], { env: { ...process.env, SSH_AUTH_SOCK: path.join(dir, "agent.sock") }, stdio: "ignore" });

  const s = await stage(root, apps, { byPackage: true, more: { SSH_AUTH_SOCK: path.join(dir, "agent.sock"), HIVE_BIN: HIVE } });
  const { desktop, cli, emit } = s;
  // The agent the machine runs: the same stand-in, on that machine's PATH.
  fs.copyFileSync(path.join(root, "bin/claude"), path.join(dir, "rhome/bin/claude"));
  const frames = await s.openFrames(["fastapi"]);
  const local = await s.agent(frames.fastapi, "routing-review", "default", JOB.routing);
  await busy(s, [local]);
  await s.tidy([frames.fastapi]);

  const rec = recorder(s.app, path.join(OUT, "machines"), OUT);
  await rec.burst("one", 4);
  // Added as a person adds one; the address names no user, so ssh logs in as this one.
  await desktop.locator('.hm-layers [data-layers-rail="machines"]').click();
  await desktop.locator('[data-layers-action="machine"]').click();
  await desktop.getByLabel("Host").fill(`ssh://127.0.0.1:${port}`);
  await desktop.getByLabel("Name", { exact: true }).fill("build-box");
  const adding = rec.beat("adding");
  await adding();
  await desktop.getByRole("button", { name: "Add", exact: true }).click();
  const row = desktop.locator('ul[aria-label="machines"] li', { hasText: "build-box" });
  for (let i = 0; i < 150 && !(await row.textContent().catch(() => ""))?.includes("online"); i++) { if (i % 3 === 0) await adding(); await desktop.waitForTimeout(1000); }
  await expect(row).toContainText("online");
  await adding();
  await desktop.keyboard.press("Escape");
  await desktop.waitForTimeout(600);
  await rec.burst("listed", 4);

  // A frame on build-box, in the repository's copy there, and an agent started in it.
  await s.app.evaluate((_, d) => { process.env.HIVEMIND_TEST_PICK_DIR = d; }, path.join(DEMO, "ripgrep"));
  await emit("hivemind:add-project");
  await desktop.waitForTimeout(1200);
  const remoteFrame = await desktop.$$eval(".react-flow__node-frame", (els) => els.at(-1)?.getAttribute("data-id") ?? "");
  await emit("hivemind:attach-remote", { frameId: remoteFrame });
  await desktop.locator('ul[aria-label="machines"] li', { hasText: "build-box" }).locator("button").first().click();
  await desktop.getByRole("dialog").getByRole("button", { name: "Go to…" }).click().catch(() => {});
  await desktop.getByRole("dialog").getByLabel("path").fill(path.join(DEMO, "ripgrep")).catch(() => {});
  await desktop.keyboard.press("Enter");
  await desktop.getByRole("button", { name: "Open here" }).click();
  await expect.poll(() => desktop.locator(`.react-flow__node[data-id="${remoteFrame}"] button[aria-label="machine build-box"]`).getAttribute("data-machine-state"), { timeout: 60_000 }).toBe("online");
  const there = await s.agent(remoteFrame, "flag-count", "default", JOB.flags);
  await s.tidy([frames.fastapi, remoteFrame]);
  await busy(s, [there]);
  await rec.box(desktop, `.react-flow__node[data-id="${remoteFrame}"]`, "remote");
  await rec.burst("running", 8);
  rec.save({ remote: s.census().of(there), agents: { "routing-review": "claude on studio", "flag-count": "claude on build-box" } });
});

test("devices", async () => {
  test.setTimeout(600_000);
  test.skip(!hiveNetBuilt() || !fs.existsSync(path.join(WWW, "main.js")), "build hive-net and the phone page first");
  const network = await ownNetwork(root, procs, "closed", WWW);
  const s = await stage(root, apps);
  const { desktop, emit } = s;
  expect(await desktop.evaluate((l) => window.hive.useNetwork(l), network.link)).toMatchObject({ admission: "enrolled" });
  const frames = await s.openFrames(["fastapi"]);
  const release = await s.agent(frames.fastapi, "docstrings", "default", JOB.docstrings);
  const routing = await s.agent(frames.fastapi, "routing-review", "default", JOB.routing);
  await busy(s, [routing]);
  await expect.poll(() => s.census().of(release)?.waiting?.kind ?? "", { timeout: 300_000, intervals: [1000] }).toBe("permission");
  await s.tidy([frames.fastapi]);

  const browser = await chromium.launch();
  after.push(() => void browser.close());
  const open = async (viewport: { width: number; height: number }, mobile: boolean): Promise<Page> => {
    const link = await offerToConnect(desktop, true);
    const page = await (await browser.newContext({ viewport, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile, colorScheme: "dark" })).newPage();
    await page.goto(link);
    await connectPage(page, desktop);
    await desktop.keyboard.press("Escape");
    await desktop.waitForTimeout(600);
    await page.getByText("docstrings").first().click({ timeout: 20_000 });
    await page.waitForTimeout(1500);
    return page;
  };
  const web = await open({ width: 1024, height: 640 }, false);
  const phone = await open({ width: 390, height: 844 }, true);
  await emit("hivemind:focus-tile", release);
  await desktop.waitForTimeout(1500);

  const rec = recorder(s.app, path.join(OUT, "devices"), OUT);
  await rec.box(desktop, `.react-flow__node[data-id="${release}"]`, "release");
  // The same question on all three; the person answers it on the phone, and all three move on.
  const desk = rec.beat("desktop");
  const all = async (name: string, n: number) => {
    for (let i = 0; i < n; i++) { await desk(); await rec.still(web, `browser-${name}-${i}`); await rec.still(phone, `phone-${name}-${i}`); await pause(500); }
  };
  await all("asks", 4);
  const allow = phone.getByRole("button", { name: /^allow/i }).first();
  const ab = (await allow.boundingBox())!;
  rec.boxes.allow = { x: ab.x * 2, y: ab.y * 2, w: ab.width * 2, h: ab.height * 2 };
  await allow.click();
  await all("answered", 6);
  rec.save({ agents: { docstrings: "claude", "routing-review": "claude" } });
});

test("join", async () => {
  test.setTimeout(600_000);
  test.skip(!hiveNetBuilt(), "build hive-net first: cargo build in crates/hive-net");
  const host = await stage(root, apps, { name: "host" });
  await host.desktop.evaluate(() => window.hive.settingsSet("profile.name", "Ada"));
  const frames = await host.openFrames(["fastapi"]);
  const agents = [
    await host.agent(frames.fastapi, "routing-review", "default", JOB.routing),
    await host.agent(frames.fastapi, "docstrings", "default", JOB.docstrings),
  ];
  await busy(host, agents.slice(0, 1));
  await host.tidy([frames.fastapi]);
  const elsewhere = path.join(root, "elsewhere");
  fs.mkdirSync(elsewhere);
  const guest = await stage(root, apps, { name: "guest", cwd: elsewhere });
  await guest.desktop.evaluate(() => window.hive.settingsSet("profile.name", "Sam"));

  const rec = recorder(host.app, path.join(OUT, "join"), OUT);
  const both = async (name: string, n = 1) => {
    const b = rec.beat(name);
    for (let i = 0; i < n; i++) { await b(); await rec.still(guest.desktop, `${name}-guest-${i}`); await pause(250); }
  };
  await both("apart", 2);
  const link = await share(host.desktop, "edit", path.join(DEMO, "fastapi"));
  await guest.desktop.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-recent")));
  await guest.desktop.locator("[data-join]").click();
  await guest.desktop.locator("[data-join-link]").fill(link);
  await guest.desktop.locator("[data-join-go]").click();
  await expect(host.desktop.locator(".hm-join-request")).toBeVisible({ timeout: 30_000 });
  await both("asks", 2);
  await host.desktop.locator(".hm-join-request").getByRole("button", { name: "Allow" }).click();
  await expect(guest.desktop.locator('[data-join-result="in"]')).toBeVisible({ timeout: 30_000 });
  await both("in", 1);
  await guest.desktop.locator("[data-join-open]").click();
  await expect.poll(() => guest.desktop.locator(".react-flow__node-terminal").count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  await guest.fit();
  await both("joined", 3);
  await note(host.desktop, "Release on Friday");
  await expect(guest.desktop.locator('[data-widget="note"]')).toContainText("Release on Friday", { timeout: 15_000 });
  await host.desktop.keyboard.press("Escape");
  await both("live", 4);
  rec.save({ agents: { "routing-review": "claude", docstrings: "claude" } });
});
