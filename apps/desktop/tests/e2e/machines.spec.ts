// Machines, end to end against a real OpenSSH server this spec starts on 127.0.0.1 with its own
// keys, agent and remote $HOME: add a machine (hive installed over ssh), run a frame on it, adopt a
// job started with `hive run` there, lose the server and get it back. Skips without sshd or a built `hive`.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HIVE = path.resolve(APP_DIR, "../cli/dist/hive");
const SSHD = "/usr/sbin/sshd";
/** A stale `dist/hive` (one without the daemon) would be installed on the fixture and rejected there,
 *  which reads as a product failure; skip instead and say what to build. */
const hiveRunsDaemon = fs.existsSync(HIVE) && `${spawnSync(HIVE, ["daemon", "--help"], { encoding: "utf8" }).stdout}`.includes("bridge");
const usable = process.platform === "linux" && fs.existsSync(SSHD) && hiveRunsDaemon && spawnSync("ssh-agent", ["-k"], { stdio: "ignore" }).error === undefined;

test.describe.configure({ mode: "serial" });
test.skip(!usable, "needs /usr/sbin/sshd, ssh-agent and a current apps/cli/dist/hive (cd apps/cli && bun scripts/build.ts)");

let dir = "";
let app: ElectronApplication;
let page: Page;
let agentPid = 0;
let port = 0;
/** The terminal opened on the machine (the canvas also has a local one). */
let remoteTile = "";
const sshdCfg = () => path.join(dir, "sshd_config");
const rhive = () => path.join(dir, "rhome/.local/bin/hive");
const remote = (cmd: string) => execFileSync("ssh", ["-F", path.join(dir, "ssh_config"), "-T", "rtest", cmd], { encoding: "utf8", timeout: 30_000 });
const startSshd = () => execFileSync(SSHD, ["-f", sshdCfg()]);
const sshdPid = () => Number(fs.readFileSync(path.join(dir, "sshd.pid"), "utf8"));
const chipState = () => page.locator('button[aria-label="machine build-box"]').getAttribute("data-machine-state");
const terminalText = () => page.evaluate(() => [...document.querySelectorAll(".xterm")]
  .map((x) => (x.parentElement as (HTMLElement & { __hmScreen?: () => string }) | null)?.__hmScreen?.() ?? "").join("\n"));

async function freePort(): Promise<number> {
  return new Promise((resolve) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });
}

test.beforeAll(async () => {
  // Short: the remote daemon's socket lives here and must fit a unix socket path.
  dir = fs.mkdtempSync("/tmp/hm-mach-");
  for (const d of ["rhome", "home", "xdg"]) fs.mkdirSync(path.join(dir, d));
  for (const k of ["host_key", "client_key"]) execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path.join(dir, k)]);
  fs.copyFileSync(path.join(dir, "client_key.pub"), path.join(dir, "authorized_keys"));
  port = await freePort();
  fs.writeFileSync(sshdCfg(), [
    `Port ${port}`, "ListenAddress 127.0.0.1", `HostKey ${dir}/host_key`, `AuthorizedKeysFile ${dir}/authorized_keys`,
    `PidFile ${dir}/sshd.pid`, "PasswordAuthentication no", "KbdInteractiveAuthentication no", "UsePAM no", "StrictModes no", "LogLevel ERROR",
    `SetEnv HOME=${dir}/rhome XDG_CONFIG_HOME=${dir}/rhome/.config HIVEMIND_PTY_SOCK=${dir}/r.sock`, "",
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "ssh_config"), [
    "Host rtest", "  HostName 127.0.0.1", `  Port ${port}`, `  IdentityFile ${dir}/client_key`, "  IdentitiesOnly yes",
    `  UserKnownHostsFile ${dir}/known_hosts`, "  StrictHostKeyChecking accept-new", "  BatchMode yes", "",
  ].join("\n"));
  startSshd();
  const agent = execFileSync("ssh-agent", ["-a", path.join(dir, "agent.sock"), "-s"], { encoding: "utf8" });
  agentPid = Number(/SSH_AGENT_PID=(\d+)/.exec(agent)?.[1] ?? 0);
  execFileSync("ssh-add", [path.join(dir, "client_key")], { env: { ...process.env, SSH_AUTH_SOCK: path.join(dir, "agent.sock") }, stdio: "ignore" });

  app = await electron.launch({
    // Launched by package dir, not by the built script: Electron reads the real version from package.json,
    // and the installer only offers a local `hive` that matches it.
    args: [APP_DIR, "--no-sandbox"],
    cwd: APP_DIR,
    // Own HOME and config: saved hosts and machines of the person running the suite stay out of it.
    // Persistence ON (the suite defaults it off): a remote tile must keep a stable session id and
    // detach — not kill — when it unmounts, which is how the app really runs.
    env: { ...process.env, HOME: path.join(dir, "home"), XDG_CONFIG_HOME: path.join(dir, "xdg"), SSH_AUTH_SOCK: path.join(dir, "agent.sock"), HIVE_BIN: HIVE, HIVEMIND_PTY_DAEMON: "1" },
  });
  app.process().stderr.on("data", (d) => { for (const l of String(d).split("\n")) if (/\[remote\]|\[machines\]/.test(l)) console.log("  [main]", l.slice(0, 200)); });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await page.waitForSelector(".react-flow__node-terminal");
});

test.afterAll(async () => {
  try { await Promise.race([app?.close(), new Promise((r) => setTimeout(r, 10_000))]); } catch { /* already gone */ }
  if (!dir) return;
  try { remote(`${rhive()} daemon stop`); } catch { /* not running */ }
  // The "remote" daemon is a local process; its socket path is unique to this spec.
  spawnSync("pkill", ["-f", `${dir}/r.sock`]);
  try { const listener = sshdPid(); spawnSync("pkill", ["-P", String(listener)]); process.kill(listener); } catch { /* not running */ }
  if (agentPid) try { process.kill(agentPid); } catch { /* gone */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("add a machine: probe, install hive over ssh, save", async () => {
  test.setTimeout(180_000);
  await page.getByRole("button", { name: "add machine" }).click();
  await page.getByLabel("Host").fill(`ssh://${os.userInfo().username}@127.0.0.1:${port}`);
  await page.getByLabel("Name", { exact: true }).fill("build-box");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const row = page.locator('ul[aria-label="machines"] li', { hasText: "build-box" });
  await expect(row).toContainText("online", { timeout: 150_000 });
  expect(fs.existsSync(rhive())).toBe(true);
  await page.keyboard.press("Escape");
  // Layers is where machines live: listed before anything runs there, with its link and actions.
  const header = page.locator('.hm-layers [data-machine-header="build-box"]');
  await expect(header).toBeVisible();
  await expect(header.locator("[data-machine-state]")).not.toHaveText(/offline|off/);
  await expect(header.getByRole("button", { name: "open folder on build-box" })).toBeVisible();
  await expect(page.locator('.hm-layers [data-machine-header="local"]')).toContainText("This computer");
});

test("a frame runs on the machine: chip online with a round trip, terminals run there", async () => {
  test.setTimeout(90_000);
  await page.evaluate(() => {
    const id = document.querySelector(".react-flow__node-frame")?.getAttribute("data-id");
    window.dispatchEvent(new CustomEvent("hivemind:attach-remote", { detail: { frameId: id } }));
  });
  await page.locator('ul[aria-label="machines"] li', { hasText: "build-box" }).locator("button").first().click();
  await page.getByRole("button", { name: "Open here" }).click();
  await expect.poll(chipState, { timeout: 60_000 }).toBe("online");
  // A terminal opened after the bind runs on the machine; one that was already open keeps its own session.
  await page.evaluate(() => {
    const id = document.querySelector(".react-flow__node-frame")?.getAttribute("data-id");
    window.dispatchEvent(new CustomEvent("hivemind:frame-open", { detail: { frameId: id, kind: "shell" } }));
  });
  await expect.poll(async () => (await page.locator(".react-flow__node-terminal").count()), { timeout: 30_000 }).toBeGreaterThan(1);
  remoteTile = (await page.locator(".react-flow__node-terminal").last().getAttribute("data-id")) ?? "";
  await expect(page.locator('button[aria-label="machine build-box"]')).toContainText(/\d+ms/, { timeout: 30_000 });
  await expect.poll(() => remote(`${rhive()} ps`), { timeout: 30_000 }).toContain("bash");
});

test("a job started with `hive run` there opens from the chip as a live tile", async () => {
  test.setTimeout(60_000);
  remote(`${rhive()} run --id build-job -- sh -c 'i=0; while :; do i=$((i+1)); echo build step $i; sleep 1; done'`);
  await page.locator('button[aria-label="machine build-box"]').click();
  await page.getByRole("button", { name: /Sessions running there/ }).click();
  await page.getByRole("button", { name: /build-job/ }).click();
  await expect.poll(terminalText, { timeout: 20_000 }).toMatch(/build step \d+/);
  expect(await terminalText()).not.toContain("no longer running");
});

test("a login that stops working parks the machine, and fixing it brings the terminal back", async () => {
  test.setTimeout(120_000);
  // The app's credential stops working (rotated key, changed password); the spec keeps its own, so it can still look.
  const agentEnv = { ...process.env, SSH_AUTH_SOCK: path.join(dir, "agent.sock") };
  execFileSync("ssh-add", ["-D"], { env: agentEnv, stdio: "ignore" });
  spawnSync("pkill", ["-P", String(sshdPid())]);
  for (const p of spawnSync("pgrep", ["-x", "ssh"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean)) {
    try { if (fs.readFileSync(`/proc/${p}/cmdline`, "utf8").includes("daemon bridge")) process.kill(Number(p)); } catch { /* gone */ }
  }
  await expect.poll(chipState, { timeout: 60_000 }).toBe("attention");
  const parked = await chipState();
  await page.waitForTimeout(5_000);
  expect(await chipState()).toBe(parked); // waits for a person instead of hammering the login

  execFileSync("ssh-add", [path.join(dir, "client_key")], { env: agentEnv, stdio: "ignore" });
  await page.evaluate(async () => {
    const snap = await window.hive.machinesGet();
    await window.hive.machineReconnect(snap.machines[0]!.hostId);
  });
  await expect.poll(chipState, { timeout: 60_000 }).toBe("online");
  // Both sessions must still be there, now with this app watching them again.
  expect(remote(`${rhive()} ps`)).toContain("build-job");
  // Recovery means the terminal is attached again, which the machine itself reports: its session has a viewer.
  const viewers = () => {
    const row = remote(`${rhive()} ps`).split("\n").find((l) => l.startsWith(`hm:${remoteTile} `));
    return Number(row?.split(/\s+/)[2] ?? 0);
  };
  await expect.poll(viewers, { timeout: 60_000 }).toBeGreaterThan(0);
});

test("the server goes away and comes back: chip and banner say so, the job never stopped", async () => {
  test.setTimeout(120_000);
  // Every connection, not just the listener: a live shared connection would carry the reconnect.
  const listener = sshdPid();
  spawnSync("pkill", ["-P", String(listener)]);
  process.kill(listener);
  for (const p of spawnSync("pgrep", ["-x", "ssh"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean)) {
    try { if (fs.readFileSync(`/proc/${p}/cmdline`, "utf8").includes("daemon bridge")) process.kill(Number(p)); } catch { /* gone */ }
  }
  await expect.poll(chipState, { timeout: 30_000 }).toBe("reconnecting");
  const banner = page.getByRole("status").filter({ hasText: "Reconnecting to build-box" });
  await expect(banner.first()).toBeVisible();
  startSshd();
  // The backoff may win the race; the button only skips the wait.
  await banner.first().getByRole("button", { name: "Retry now" }).click({ timeout: 3_000 }).catch(() => {});
  await expect.poll(chipState, { timeout: 60_000 }).toBe("online");
  await expect(banner).toHaveCount(0);
  expect(remote(`${rhive()} ps`)).toContain("build-job");
  remote(`${rhive()} kill build-job`);
});

test("the Layers rail groups frames by the computer they run on, in every view", async () => {
  const rail = page.locator(".hm-layers");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:add-frame"))); // a frame on this computer too
  await expect(rail.locator('[data-machine-group="build-box"]')).toBeVisible();
  await expect(rail.locator('[data-machine-group="local"]')).toContainText("This computer");
  // Collapse and reopen: the rail must survive both (its hooks run before the collapsed return).
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:toggle-layers")));
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:toggle-layers")));
  await expect(rail.locator('[data-machine-group="build-box"]')).toBeVisible();
  // The rail is shared, so the Windows view gets the same grouping.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: "windows" } })));
  await expect(page.locator('.hm-layers [data-machine-group="build-box"]')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: "canvas" } })));
});

test("turning a machine off disconnects it and keeps its terminals running there; on brings them back", async () => {
  test.setTimeout(90_000);
  const header = page.locator('.hm-layers [data-machine-header="build-box"]');
  await header.getByRole("button", { name: "build-box actions" }).click();
  await page.getByRole("button", { name: "Turn off" }).click();
  await expect(header.locator("[data-machine-state]")).toHaveText("off");
  await expect(page.locator('[data-link-banner="off"]').first()).toBeVisible({ timeout: 10_000 });
  expect(remote(`${rhive()} ps`)).toContain("bash");
  // The tile may sit off-screen on the canvas; the banner's own button is what a user there clicks.
  await page.locator('[data-link-banner="off"]').first().locator("xpath=..").getByRole("button", { name: "Turn on" }).dispatchEvent("click");
  await expect.poll(chipState, { timeout: 60_000 }).toBe("online");
  await expect(page.locator('[data-link-banner="off"]')).toHaveCount(0);
});

test("editing a machine's address: a bad one is refused and nothing moves; a good one moves its frames", async () => {
  test.setTimeout(120_000);
  const header = page.locator('.hm-layers [data-machine-header="build-box"]');
  const openEdit = async () => {
    await header.getByRole("button", { name: "build-box actions" }).click();
    await page.getByRole("button", { name: "Manage machines…" }).click();
    await page.locator('ul[aria-label="machines"] li', { hasText: "build-box" }).getByRole("button", { name: "build-box actions" }).click();
    await page.getByRole("button", { name: "Edit…" }).click();
  };
  await openEdit();
  await page.getByLabel("Host").fill(`ssh://${os.userInfo().username}@127.0.0.1:1`);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("dialog")).toContainText(/refused|connect|port 1/i, { timeout: 60_000 });
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator('ul[aria-label="machines"] li', { hasText: "build-box" })).toContainText(`127.0.0.1:${port}`);
  await page.keyboard.press("Escape");

  await openEdit();
  await page.getByLabel("Host").fill(`ssh://${os.userInfo().username}@localhost:${port}`);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator('ul[aria-label="machines"] li', { hasText: "build-box" })).toContainText(`localhost:${port}`, { timeout: 60_000 });
  await page.keyboard.press("Escape");
  await expect(page.locator('.hm-layers [data-machine-group="build-box"] .group\\/grp')).toHaveCount(1); // its frame came along
  await expect.poll(chipState, { timeout: 60_000 }).toBe("online");
});

test("removing a machine in use asks first, says what it touches, and leaves its terminals running", async () => {
  test.setTimeout(90_000);
  await page.locator('.hm-layers [data-machine-header="build-box"]').getByRole("button", { name: "build-box actions" }).click();
  await page.getByRole("button", { name: "Manage machines…" }).click();
  const row = page.locator('ul[aria-label="machines"] li', { hasText: "build-box" });
  await row.getByRole("button", { name: "build-box actions" }).click();
  await page.getByRole("button", { name: "Remove…" }).click();
  const confirm = page.getByRole("alertdialog", { name: "remove build-box" });
  await expect(confirm).toBeVisible();
  await expect(confirm.locator("[data-usage]")).toContainText(/Used by 1 frame · [1-9]\d* terminals?/);
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused(); // a stray Enter keeps it
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(row).toBeVisible();

  // Remove without ending its terminals: the machine goes, the terminal on it keeps running.
  await row.getByRole("button", { name: "build-box actions" }).click();
  await page.getByRole("button", { name: "Remove…" }).click();
  await page.getByRole("alertdialog", { name: "remove build-box" }).getByRole("button", { name: "Remove", exact: true }).click();
  await expect(row).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(() => remote(`${rhive()} ps`), { timeout: 15_000 }).toContain("bash");
  expect(await page.locator(`.react-flow__node[data-id="${remoteTile}"]`).count()).toBe(1);
});
