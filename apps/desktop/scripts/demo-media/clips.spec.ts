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
import { DEMO, OUT, ROOT, WWW, demoInstructions, recorder, runnerSettings, stage, working } from "./stage";

const HIVEHUB = "https://hivehub.griiken.workers.dev/api/v1/index.json";
const WIDGETS = path.resolve("scripts/demo-media/widgets");
const PROGRESS = path.join(ROOT, "examples/widgets/progress");

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

// Jobs a person would give, each about its own folder.
const JOB = {
  release: "Track the release on the Progress widget with hive ctl plugin call @dip497/progress: set-title Release 0.116.2, add the steps Bump the version, Write the release notes and Tag and push, then read git log --oneline -n 20 and tick each of the first two steps as you check it. Then hive ctl set-state FAS-2 done",
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
  test.setTimeout(600_000);
  const s = await stage(root, apps);
  const { desktop, cli, emit } = s;
  const frames = await s.openFrames(["fastapi"]);
  const release = await s.agent(frames.fastapi, "release", "acceptEdits");
  const routing = await s.agent(frames.fastapi, "routing-review", "default", JOB.routing);
  await working(s, [routing]);
  for (const dir of [PROGRESS, ...["agents", "issues", "next-up"].map((w) => path.join(WIDGETS, w))]) {
    const r = cli("widgets", "install", dir, "--json");
    expect(r.status, r.stderr).toBe(0);
  }
  await desktop.evaluate(() => window.dispatchEvent(new Event("focus")));
  await s.tidy([frames.fastapi]);
  // Room under the frame for a row of widgets.
  await emit("hivemind:zoom", "out");
  await desktop.waitForTimeout(800);

  const rec = recorder(s.app, path.join(OUT, "widgets"), OUT);
  await rec.box(desktop, `.react-flow__node[data-id="${frames.fastapi}"]`, "frame");
  await rec.burst("board", 6);
  // Each board widget goes where the pointer is when Add opens: in a row under the frame.
  const f = rec.boxes.frame!;
  const adding = rec.beat("adding");
  const add = async (name: string, at?: { x: number; y: number }) => {
    if (at) await desktop.mouse.move(at.x, at.y);
    await emit("hivemind:open-add");
    await desktop.waitForTimeout(500);
    await adding();
    await desktop.locator("[data-board-choice^='widget:']", { hasText: name }).first().click();
    await desktop.waitForTimeout(900);
    await adding();
  };
  const y = (f.y + f.h) / 2 + 30;
  // Each next one beside the last, a gap apart, wherever Add puts a widget against the pointer.
  let at = { x: f.x / 2 + f.w / 6, y };
  for (const [i, name] of ["Agents", "Issues", "Next up"].entries()) {
    await add(name, at);
    await desktop.keyboard.press("Escape");
    const b = await rec.box(desktop, `.react-flow__node-widget >> nth=${i}`, "_");
    const right = (b.x + b.w) / 2;
    at = { x: right + b.w / 20 + (at.x - b.x / 2), y };
  }
  delete rec.boxes._;
  // Closer, as a person zooms in on what they added: round the row's middle until it reads.
  const row = await rec.box(desktop, ".react-flow__node-widget >> nth=1", "issues");
  await desktop.mouse.move(row.x / 2 + row.w / 4, row.y / 2 + row.h / 4);
  for (let i = 0; i < 16 && (await rec.box(desktop, ".react-flow__node-widget >> nth=1", "issues")).w < 300; i++) {
    await desktop.keyboard.down("Control");
    await desktop.mouse.wheel(0, -120);
    await desktop.keyboard.up("Control");
    await desktop.waitForTimeout(250);
  }
  await desktop.mouse.move(10, 500);
  await desktop.waitForTimeout(600);
  for (const [i, name] of ["agents", "issues", "nextUp"].entries()) await rec.box(desktop, `.react-flow__node-widget >> nth=${i}`, name);
  await rec.burst("close", 4);
  const close = rec.beat("ticking");
  await emit("hivemind:open-add");
  await desktop.waitForTimeout(500);
  await desktop.locator("[data-board-choice^='widget:']", { hasText: "Progress" }).first().click();
  await desktop.waitForTimeout(900);
  await close();
  // The release agent keeps the progress widget and closes its issue; the issue widgets follow.
  cli("ctl", "send", release, JOB.release);
  const fas2 = () => { try { return JSON.parse(cli("show", "FAS-2", "--json").stdout).data.state as string; } catch { return ""; } };
  for (let i = 0; i < 300 && !(fas2() === "done" && s.census().of(release)?.state !== "working"); i++) { await close(); await desktop.waitForTimeout(700); }
  expect(fas2(), s.show()).toBe("done");
  await rec.box(desktop, "[data-widget-layer] [data-widget]", "progress");
  await rec.burst("widgets", 8);
  rec.save({ agents: { release: "claude", "routing-review": "claude" } });
  await expect(desktop.locator(".react-flow__node-widget")).toHaveCount(3);
});

test("tools", async () => {
  test.setTimeout(600_000);
  const s = await stage(root, apps, { cwd: path.join(DEMO, "excalidraw"), more: { HIVEMIND_PLUGIN_INDEX: HIVEHUB } });
  const { desktop, cli } = s;
  // The CI runs tool asks `gh`; it answers for the demo's repositories with the runner's GitHub login.
  const gh = execFileSync("bash", ["-c", "command -v gh"], { encoding: "utf8" }).trim();
  fs.writeFileSync(path.join(root, "bin/gh"), `#!/usr/bin/env bash\nGH_CONFIG_DIR="${os.homedir()}/.config/gh" exec "${gh}" "$@"\n`, { mode: 0o755 });
  const frames = await s.openFrames(["excalidraw", "arrow-binding"]);
  const review = await s.agent(frames["arrow-binding"], "arrow-review", "default", JOB.review);
  await working(s, [review]);
  await s.tidy([frames.excalidraw, frames["arrow-binding"]]);

  const rec = recorder(s.app, path.join(OUT, "tools"), OUT);
  // HiveHub, in Plugins: both tools are there to install.
  await s.emit("hivemind:open-settings", { page: "plugins" });
  await desktop.locator('[data-plugins-scope="hub"]').click();
  await desktop.getByLabel("Search plugins").fill("worktrees");
  const entry = desktop.locator("[data-catalog-plugin*='worktrees']").first();
  await expect(entry).toBeVisible({ timeout: 30_000 });
  await rec.burst("hub", 4);
  const hub = rec.beat("installing");
  await entry.getByRole("button", { name: "Install" }).click();
  await hub();
  await desktop.getByRole("button", { name: "Install", exact: true }).last().click();
  await expect(desktop.getByRole("button", { name: "Open its page" })).toBeVisible({ timeout: 60_000 });
  await hub();
  const ci = cli("tools", "install", "dip497/ci-runs", "--json");
  expect(ci.status, ci.stdout + ci.stderr).toBe(0);
  for (const id of ["tool:dip497/worktrees", "tool:dip497/ci-runs"]) expect(cli("plugins", "enable", id, "--json").status).toBe(0);
  await desktop.keyboard.press("Escape");
  await desktop.waitForTimeout(600);

  const opening = rec.beat("opening");
  expect(cli("ctl", "open-tool", "dip497/worktrees/worktrees", "--frame", frames.excalidraw).status).toBe(0);
  const wt = desktop.locator('[data-tool-plugin="dip497/worktrees"]');
  await expect(wt).toContainText("fix/arrow-binding", { timeout: 30_000 });
  await s.emit("hivemind:focus-tile", await wt.evaluate((n) => n.closest(".react-flow__node")?.getAttribute("data-id")));
  await desktop.waitForTimeout(1200);
  await opening();
  await rec.burst("worktrees", 8);
  expect(cli("ctl", "open-tool", "dip497/ci-runs/runs", "--frame", frames.excalidraw).status).toBe(0);
  const runs = desktop.locator('[data-tool-plugin="dip497/ci-runs"]');
  await expect(runs.locator("[data-run]").first()).toBeVisible({ timeout: 60_000 });
  await s.emit("hivemind:focus-tile", await runs.evaluate((n) => n.closest(".react-flow__node")?.getAttribute("data-id")));
  await desktop.waitForTimeout(1200);
  await rec.burst("runs", 6);
  await runs.locator("[data-run]").first().click();
  await desktop.waitForTimeout(2500);
  await rec.burst("run", 8);
  rec.save({ agents: { "arrow-review": "claude" } });
});

test("views", async () => {
  test.setTimeout(600_000);
  const s = await stage(root, apps, { more: { HIVEMIND_PLUGIN_INDEX: HIVEHUB } });
  const { desktop, cli } = s;
  for (const v of ["@dip497/queue", "@dip497/tiled"]) {
    const r = cli("views", "install", v, "--json");
    expect(r.status, r.stdout + r.stderr).toBe(0);
  }
  const frames = await s.openFrames(["fastapi", "arrow-binding", "glob-order"]);
  const busy = [
    await s.agent(frames["arrow-binding"], "arrow-review", "default", JOB.review),
    await s.agent(frames["glob-order"], "glob-order", "default", JOB.glob),
    await s.agent(frames.fastapi, "routing-review", "default", JOB.routing),
  ];
  await working(s, busy);
  await s.tidy(Object.values(frames));

  const rec = recorder(s.app, path.join(OUT, "views"), OUT);
  await rec.burst("board", 6);
  const to = async (view: string) => {
    const name = view.replace(/^@[^/]+\//, "");
    const picking = rec.beat(`pick-${name}`);
    await desktop.locator("[data-view-switch]").click();
    await desktop.waitForTimeout(400);
    await picking();
    await desktop.locator(`[data-view-choice="${view}"]`).click();
    await desktop.waitForTimeout(2000);
    await rec.burst(name, 8);
  };
  const ids = await desktop.locator("[data-view-switch]").click().then(() => desktop.locator("[data-view-choice]").evaluateAll((els) => els.map((e) => e.getAttribute("data-view-choice"))));
  await desktop.keyboard.press("Escape");
  const pick = (part: string) => ids.find((id) => id?.includes(part)) ?? part;
  await to(pick("queue"));
  await to(pick("tiled"));
  await to("canvas");
  rec.save({ views: ids, agents: { "arrow-review": "claude", "glob-order": "claude", "routing-review": "claude" } });
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
  await working(s, [local]);
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
  await working(s, [there]);
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
  await working(s, [routing]);
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
  const busy = [
    await host.agent(frames.fastapi, "routing-review", "default", JOB.routing),
    await host.agent(frames.fastapi, "docstrings", "default", JOB.docstrings),
  ];
  await working(host, busy.slice(0, 1));
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
