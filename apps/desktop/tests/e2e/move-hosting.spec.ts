// Moving a workspace's hosting (M3, design §5.7 B, spec/hosting.md), end to end on one machine: a
// laptop (the app) shares a workspace with a guest (another app) and is paired with a host (`hive
// host`, the built binary, with its own data, as on a server). From Share it moves the workspace to
// the host: its window opens it from there, as its owner; the guest is told where it went and
// follows within seconds, with no new invite; the board is the same for both and what one writes
// the other sees; the shell the laptop had in it is the same process, on the laptop, in its
// folder; and the laptop opening its folder again opens it from the host.
import { test, expect, type ElectronApplication } from "@playwright/test";
import { execSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { HIVE_NET, hiveNetBuilt, join, note, notes, person, share, tiles } from "./helpers/multiplayer";

const HIVE = path.resolve("../cli/dist/hive");
const hostable = fs.existsSync(HIVE) && `${spawnSync(HIVE, ["host", "--help"], { encoding: "utf8" }).stdout}`.includes("pair");

let root: string;
const apps: ElectronApplication[] = [];
const procs: ChildProcess[] = [];
const hostEnv = () => ({ ...process.env, HIVEMIND_APP_DATA: path.join(root, "server"), HIVEMIND_PTY_SOCK: path.join(root, "pty.sock"), HIVEMIND_HIVE_NET: HIVE_NET, HIVEMIND_SHELL_ENV: "0" }) as Record<string, string>;
const hive = (...args: string[]) => spawnSync(HIVE, args, { env: hostEnv(), encoding: "utf8", timeout: 60_000 });
interface HostStatus { running: boolean; device: string; devices: unknown[]; workspaces: Array<{ repo: string; workspace: string | null }> }
const status = (): HostStatus | undefined => {
  try { return (JSON.parse(hive("host", "status", "--json").stdout) as { data?: HostStatus }).data; } catch { return undefined; }
};
const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "");

test.beforeEach(() => { root = fs.mkdtempSync("/tmp/hm-move-"); });
test.afterEach(async () => {
  // The apps' daemons first: closing waits on them. An app not gone after a while is killed.
  const reap = () => { try { execSync(`pkill -f "out/main/pty-daemon.js ${root}/"`, { stdio: "ignore" }); } catch { /* none */ } };
  reap();
  for (const a of apps.splice(0)) {
    const gone = await Promise.race([a.close().then(() => true, () => true), new Promise<boolean>((r) => setTimeout(() => r(false), 15_000))]);
    if (!gone) a.process().kill("SIGKILL");
  }
  hive("host", "stop");
  for (const p of procs.splice(0)) p.kill("SIGKILL");
  hive("daemon", "stop");
  reap();
  try { execSync(`pkill -KILL -f -- "--user-data-dir=${root}/"`, { stdio: "ignore" }); } catch { /* none */ }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test("a laptop moves a shared workspace to its host: its window and the guest follow, the board is one, and its shell runs on the laptop still", async () => {
  test.skip(!hiveNetBuilt() || !hostable, "needs hive-net (cargo build in crates/hive-net) and a current apps/cli/dist/hive (cd apps/cli && bun scripts/build.ts)");
  test.setTimeout(240_000);
  const host = spawn(HIVE, ["host", "run"], { env: hostEnv(), stdio: "ignore" });
  procs.push(host);
  await expect.poll(() => status()?.running ?? false, { timeout: 30_000 }).toBe(true);
  const hostDevice = status()!.device;

  // The laptop, with a shell in its workspace, its terminals in its daemon as outside tests.
  const api = path.join(root, "api");
  fs.mkdirSync(api);
  execSync("git init -q", { cwd: api });
  const laptop = await person(root, "laptop", api, apps, { HIVEMIND_PTY_DAEMON: "1" });
  await laptop.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await expect.poll(async () => (await tiles(laptop)).length).toBeGreaterThan(0);

  // Paired with the host by its link.
  const pairing = spawn(HIVE, ["host", "pair", "--json"], { env: hostEnv() });
  procs.push(pairing);
  const offer = await new Promise<{ link: string }>((resolve) => {
    let out = "";
    pairing.stdout!.on("data", (d: Buffer) => {
      out += d.toString();
      const nl = out.indexOf("\n");
      if (nl >= 0) resolve((JSON.parse(out.slice(0, nl)) as { data: { offer: { link: string } } }).data.offer);
    });
  });
  await laptop.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: "devices" } })));
  await laptop.locator("[data-pair-link]").fill(offer.link);
  await laptop.locator("[data-pair-go]").click();
  await expect(laptop.locator('[data-pair-result="paired"]')).toBeVisible({ timeout: 20_000 });
  await laptop.keyboard.press("Escape");
  await expect.poll(() => status()?.devices.length ?? 0, { timeout: 30_000 }).toBe(1);

  // A guest is in, on the laptop.
  const elsewhere = path.join(root, "elsewhere");
  fs.mkdirSync(elsewhere);
  const guest = await person(root, "guest", elsewhere, apps);
  const link = await share(laptop, "edit");
  await join(guest, laptop, link);
  await guest.locator("[data-join-open]").click();
  await expect.poll(() => tiles(guest), { timeout: 20_000 }).toEqual(await tiles(laptop));
  const before = await tiles(laptop);
  // The laptop's shell, before the move: which process it is.
  const shell = before.find((t) => t.startsWith("tile-shell"))!;
  const type = async (file: string, command: string) => {
    const terminal = laptop.locator(`.react-flow__node-terminal[data-id="${shell}"]`);
    await expect.poll(async () => {
      await laptop.evaluate((id) => window.dispatchEvent(new CustomEvent("hivemind:focus-tile", { detail: id })), shell);
      return terminal.locator(".hm-node-selected").count();
    }, { timeout: 20_000, intervals: [500] }).toBe(1);
    // Selected, it takes a click to have the keyboard (a dialog that closed left it on the page).
    await terminal.locator(".xterm-screen").click();
    await expect(terminal.locator("textarea.xterm-helper-textarea")).toBeFocused({ timeout: 10_000 });
    await expect.poll(async () => {
      if (!read(path.join(api, file))) await laptop.keyboard.type(`${command} > ${file}\n`);
      return read(path.join(api, file));
    }, { timeout: 30_000, intervals: [1_000] }).not.toBe("");
    return read(path.join(api, file));
  };
  const pid = await type("pid-before.txt", "echo $$");

  // Share → move it to the host.
  await laptop.locator("[data-share]").click();
  await expect(laptop.locator("[data-move-to]")).toHaveValue(hostDevice);
  const moved = Date.now();
  await laptop.locator("[data-move-hosting]").click();

  // The laptop's window opens it from the host, as its owner; the host holds it under the
  // laptop's folder for it.
  await expect(laptop.locator('[data-shared-banner][data-state="connected"]')).toHaveAttribute("data-access", "owner", { timeout: 20_000 });
  await expect.poll(() => status()?.workspaces.some((w) => w.repo.endsWith(api) && w.repo.startsWith("machine://")) ?? false, { timeout: 10_000 }).toBe(true);
  // The guest follows it there within seconds, with no new invite.
  await expect.poll(async () => ((await guest.evaluate(() => window.hive.joined()))[0] as { host?: string } | undefined)?.host, { timeout: 10_000 }).toBe(hostDevice);
  await expect(guest.locator('[data-shared-banner][data-state="connected"]')).toHaveAttribute("data-access", "edit", { timeout: 10_000 });
  expect(Date.now() - moved).toBeLessThan(20_000);

  // The board is the same for both, and what the guest writes the laptop sees, through the host.
  await expect.poll(() => tiles(laptop), { timeout: 20_000 }).toEqual(before);
  await expect.poll(() => tiles(guest), { timeout: 20_000 }).toEqual(before);
  await note(guest, "after the move");
  await expect.poll(() => notes(laptop), { timeout: 20_000 }).toContain("after the move");

  // The laptop's shell runs on the laptop still, the same process, in its folder: through the host.
  expect(await type("pid-after.txt", "echo $$")).toBe(pid);
  expect(await type("where.txt", "pwd")).toBe(api);

  // Opening its folder again (a restart that reopens the last project) opens it from the host.
  await laptop.evaluate((folder) => window.localStorage.setItem("hivemind:last-project", folder), api);
  await laptop.reload();
  await expect(laptop.locator('[data-shared-banner][data-state="connected"]')).toHaveAttribute("data-access", "owner", { timeout: 20_000 });
  await expect.poll(() => notes(laptop), { timeout: 20_000 }).toContain("after the move");
});
