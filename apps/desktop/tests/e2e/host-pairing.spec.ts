// An always-on host (R14), end to end on one machine: `hive host` (the built binary, with its own
// data folder, as on a server) serves a folder as a workspace; the app pairs with it from
// Settings → Devices, entering the link `hive host pair` prints; Open recent lists the workspace on
// the host and opens it; a shell started there runs on the host, in its folder, and goes on after
// the app has quit.
import { test, expect, type ElectronApplication } from "@playwright/test";
import { execSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { HIVE_NET, hiveNetBuilt, person } from "./helpers/multiplayer";

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
  for (const a of apps.splice(0)) await a.close().catch(() => {});
  hive("host", "stop");
  for (const p of procs.splice(0)) p.kill("SIGKILL");
  hive("daemon", "stop");
  // The app's own daemon, which outlives it, and the processes of an app whose main was killed.
  try { execSync(`pkill -f "out/main/pty-daemon.js ${root}/"`, { stdio: "ignore" }); } catch { /* none */ }
  try { execSync(`pkill -KILL -f -- "--user-data-dir=${root}/"`, { stdio: "ignore" }); } catch { /* none */ }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test("the app pairs with a host, opens the workspace it holds, and a shell started there runs on after the app quits", async () => {
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
  const link = (JSON.parse(await printed()) as { data: { offer: { link: string } } }).data.offer.link;
  await laptop.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: "devices" } })));
  await laptop.locator("[data-pair-link]").fill(link);
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
