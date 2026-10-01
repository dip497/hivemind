// An always-on host (R14), end to end on one machine: `hive host` (the built binary, with its own
// data folder, as on a server) serves a folder as a workspace; the app pairs with it from
// Settings → Devices, entering the six words `hive host pair` prints (the host found by them on
// this network) or its link; Open recent lists the workspace on the host and opens it; a shell
// started there runs on the host, in its folder, and goes on after the app has quit. And a frame
// of the app's own workspace runs on the host (M3): placed on one of the host's folders, its
// shells run in the host's daemon, and go on after the app has quit.
import { test, expect, type ElectronApplication } from "@playwright/test";
import { execSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { HIVE_NET, hiveNetBuilt, person, tiles } from "./helpers/multiplayer";

const HIVE = path.resolve("../cli/dist/hive");
/** A `dist/hive` from before `hive host pair` would fail as if the product did: skip instead. */
const hostable = fs.existsSync(HIVE) && `${spawnSync(HIVE, ["host", "--help"], { encoding: "utf8" }).stdout}`.includes("pair");

let root: string;
const apps: ElectronApplication[] = [];
const procs: ChildProcess[] = [];
// The host's data and its daemon's socket, apart from the app's (sockets want a short path).
const hostEnv = () => ({ ...process.env, HIVEMIND_APP_DATA: path.join(root, "server"), HIVEMIND_PTY_SOCK: path.join(root, "pty.sock"), HIVEMIND_HIVE_NET: HIVE_NET, HIVEMIND_SHELL_ENV: "0" }) as Record<string, string>;
const hive = (...args: string[]) => spawnSync(HIVE, args, { env: hostEnv(), encoding: "utf8", timeout: 60_000 });
const status = () => {
  try { return (JSON.parse(hive("host", "status", "--json").stdout) as { data?: { running: boolean; devices: unknown[] } }).data; } catch { return undefined; }
};
/** The lines a process prints, one at a time. */
function lines(stream: NodeJS.ReadableStream): () => Promise<string> {
  const ready: string[] = [];
  const waiting: Array<(line: string) => void> = [];
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (d: string) => {
    buffer += d;
    for (let nl = buffer.indexOf("\n"); nl !== -1; nl = buffer.indexOf("\n")) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const w = waiting.shift();
      if (w) w(line); else ready.push(line);
    }
  });
  return () => new Promise((resolve) => { const l = ready.shift(); if (l !== undefined) resolve(l); else waiting.push(resolve); });
}
const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "");

test.beforeEach(() => { root = fs.mkdtempSync("/tmp/hm-host-"); });
test.afterEach(async () => {
  // The app's own daemon first: closing waits on it. An app not gone after a while is killed.
  const reap = () => { try { execSync(`pkill -f "out/main/pty-daemon.js ${root}/"`, { stdio: "ignore" }); } catch { /* none */ } };
  reap();
  for (const a of apps.splice(0)) {
    const gone = await Promise.race([a.close().then(() => true, () => true), new Promise<boolean>((r) => setTimeout(() => r(false), 15_000))]);
    if (!gone) a.process().kill("SIGKILL");
  }
  hive("host", "stop");
  for (const p of procs.splice(0)) p.kill("SIGKILL");
  hive("daemon", "stop");
  // The app's own daemon, which outlives it, and the processes of an app whose main was killed.
  try { execSync(`pkill -f "out/main/pty-daemon.js ${root}/"`, { stdio: "ignore" }); } catch { /* none */ }
  try { execSync(`pkill -KILL -f -- "--user-data-dir=${root}/"`, { stdio: "ignore" }); } catch { /* none */ }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

for (const entered of ["words", "link"] as const) test(`the app pairs with a host by its ${entered === "words" ? "six words, found on this network" : "link"}, opens the workspace it holds, and a shell started there runs on after the app quits`, async () => {
  test.skip(!hiveNetBuilt() || !hostable, "needs hive-net (cargo build in crates/hive-net) and a current apps/cli/dist/hive (cd apps/cli && bun scripts/build.ts)");
  const api = path.join(root, "api");
  fs.mkdirSync(api);
  const host = spawn(HIVE, ["host", "run"], { env: hostEnv(), stdio: "ignore" });
  procs.push(host);
  await expect.poll(() => status()?.running ?? false, { timeout: 30_000 }).toBe(true);
  expect(hive("host", "add", api).status).toBe(0);

  // The laptop: the app, on a project of its own. Its terminals run in a daemon, as outside tests:
  // that is what names a session by its tile, which the host knows the workspace's tiles by.
  const elsewhere = path.join(root, "elsewhere");
  fs.mkdirSync(elsewhere);
  const laptop = await person(root, "laptop", elsewhere, apps, { HIVEMIND_PTY_DAEMON: "1" });

  // The host shows a code; the app enters its link in Settings → Devices.
  const pairing = spawn(HIVE, ["host", "pair", "--json"], { env: hostEnv() });
  procs.push(pairing);
  const printed = lines(pairing.stdout!);
  const offer = (JSON.parse(await printed()) as { data: { offer: { code: string; link: string } } }).data.offer;
  await laptop.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: "devices" } })));
  // The words as a person reads them off the host's screen, or its link.
  await laptop.locator("[data-pair-link]").fill(entered === "words" ? offer.code.split("-").join(" ") : offer.link);
  await laptop.locator("[data-pair-go]").click();
  await expect(laptop.locator('[data-pair-result="paired"]')).toBeVisible({ timeout: 20_000 });
  await expect(laptop.locator('[data-device-kind="host"]')).toHaveCount(1);
  expect(JSON.parse(await printed())).toMatchObject({ ok: true, data: { paired: { kind: "app" } } });
  await laptop.keyboard.press("Escape");
  // The host starts again as the laptop's person.
  await expect.poll(() => status()?.devices.length ?? 0, { timeout: 30_000 }).toBe(1);

  // Open recent lists the workspace on the host, and opens it.
  await laptop.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-recent")));
  await laptop.locator("[data-host-workspace]").click({ timeout: 20_000 });
  await expect(laptop.locator('[data-shared-banner][data-state="connected"]')).toHaveAttribute("data-access", "owner", { timeout: 20_000 });

  // A shell there runs on the host, in its folder.
  await laptop.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  const terminal = laptop.locator(".react-flow__node-terminal").first();
  await terminal.click();
  await terminal.locator(".xterm-screen").click();
  await expect.poll(async () => {
    if (!read(path.join(api, "up.txt"))) await laptop.keyboard.type("pwd > up.txt\n");
    return read(path.join(api, "up.txt"));
  }, { timeout: 30_000, intervals: [1_000] }).toBe(api);

  // The laptop goes mid-command, at once (its process killed: its connection just drops); the
  // shell finishes the command on the host.
  await laptop.keyboard.type("sleep 5; echo finished > after.txt\n");
  await laptop.waitForTimeout(500);
  for (const a of apps.splice(0)) a.process().kill("SIGKILL");
  expect(read(path.join(api, "after.txt"))).toBe("");
  await expect.poll(() => read(path.join(api, "after.txt")), { timeout: 30_000 }).toBe("finished");
});

test("a frame of the app's own workspace runs on the paired host: placed on one of its folders, a shell there runs in the host's daemon, on after the app quits", async () => {
  test.skip(!hiveNetBuilt() || !hostable, "needs hive-net (cargo build in crates/hive-net) and a current apps/cli/dist/hive (cd apps/cli && bun scripts/build.ts)");
  test.setTimeout(120_000);
  const builds = path.join(root, "builds");
  fs.mkdirSync(builds);
  const host = spawn(HIVE, ["host", "run"], { env: hostEnv(), stdio: "ignore" });
  procs.push(host);
  await expect.poll(() => status()?.running ?? false, { timeout: 30_000 }).toBe(true);
  expect(hive("host", "add", builds).status).toBe(0);
  // Its device, the same once it is the laptop's person.
  const hostDevice = (JSON.parse(hive("host", "status", "--json").stdout) as { data: { device: string } }).data.device;

  const elsewhere = path.join(root, "elsewhere");
  fs.mkdirSync(elsewhere);
  execSync("git init -q", { cwd: elsewhere });
  const laptop = await person(root, "laptop", elsewhere, apps, { HIVEMIND_PTY_DAEMON: "1" });
  const pairing = spawn(HIVE, ["host", "pair", "--json"], { env: hostEnv() });
  procs.push(pairing);
  const offer = (JSON.parse(await lines(pairing.stdout!)()) as { data: { offer: { link: string } } }).data.offer;
  await laptop.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: "devices" } })));
  await laptop.locator("[data-pair-link]").fill(offer.link);
  await laptop.locator("[data-pair-go]").click();
  await expect(laptop.locator('[data-pair-result="paired"]')).toBeVisible({ timeout: 20_000 });
  await laptop.keyboard.press("Escape");
  await expect.poll(() => status()?.devices.length ?? 0, { timeout: 30_000 }).toBe(1);

  // The laptop's own frame (made with its first shell, which stays here), placed on the host's
  // folder from its machine chooser.
  await laptop.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await expect(laptop.locator(".react-flow__node-frame")).toHaveCount(1, { timeout: 20_000 });
  const frameId = (await laptop.locator(".react-flow__node-frame").first().getAttribute("data-id"))!;
  await laptop.evaluate((id) => window.dispatchEvent(new CustomEvent("hivemind:attach-remote", { detail: { frameId: id } })), frameId);
  await laptop.locator(`[data-pick-device="${hostDevice}"]`).click();
  await laptop.locator(`[data-device-folder="${builds}"]`).click({ timeout: 20_000 });
  // The frame says where it runs: the host, by its name.
  await expect(laptop.locator('.react-flow__node-frame button[aria-label^="machine "]')).toBeVisible({ timeout: 10_000 });

  // A shell in it runs in the host's daemon, in the host's folder.
  const before = await tiles(laptop);
  await laptop.evaluate((id) => window.dispatchEvent(new CustomEvent("hivemind:frame-open", { detail: { frameId: id, kind: "shell" } })), frameId);
  let tile = "";
  await expect.poll(async () => (tile = (await tiles(laptop)).find((t) => !before.includes(t)) ?? ""), { timeout: 20_000 }).not.toBe("");
  const terminal = laptop.locator(`.react-flow__node-terminal[data-id="${tile}"]`);
  // Flown to and selected, as a notification does, which puts the keyboard in it.
  await expect.poll(async () => {
    await laptop.evaluate((id) => window.dispatchEvent(new CustomEvent("hivemind:focus-tile", { detail: id })), tile);
    return terminal.locator(".hm-node-selected").count();
  }, { timeout: 20_000, intervals: [500] }).toBe(1);
  await expect.poll(async () => {
    if (!read(path.join(builds, "where.txt"))) await laptop.keyboard.type('echo "$(pwd) $HIVEMIND_APP_DATA" > where.txt\n');
    return read(path.join(builds, "where.txt"));
  }, { timeout: 30_000, intervals: [1_000] }).toBe(`${builds} ${path.join(root, "server")}`);

  // The app goes mid-command; the shell finishes it on the host.
  await laptop.keyboard.type("sleep 4; echo finished > after.txt\n");
  await laptop.waitForTimeout(500);
  for (const a of apps.splice(0)) a.process().kill("SIGKILL");
  expect(read(path.join(builds, "after.txt"))).toBe("");
  await expect.poll(() => read(path.join(builds, "after.txt")), { timeout: 30_000 }).toBe("finished");
});
