// Moving a workspace's hosting (M3, design §5.7 B, spec/hosting.md), end to end on one machine: a
// laptop (the app) shares a workspace with a guest (another app) and is paired with a host (`hive
// host`, the built binary, with its own data, as on a server). From Share it moves the workspace to
// the host: its window opens it from there, as its owner; the guest is told where it went and
// follows within seconds, with no new invite; the board is the same for both and what one writes
// the other sees; the shell the laptop had in it is the same process, on the laptop, in its
// folder; and the laptop opening its folder again opens it from the host. Then the laptop moves it
// back (Move here, on its banner): its window opens the folder as before, the guest follows it home,
// what was done at the host is there, and the shell is the same process still. And on a network
// with a lookup server: while the host has it, the laptop shares it as before (a link made there,
// someone asking to join asked about in its window, a guest given another role in People); the
// host gone, the laptop hosts the workspace from the copy it kept (Host it here), with the list of
// people as the host had it, and the guest finds it there by its record.
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync, execSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
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

/** A network with a lookup server and no relays, signed by its admin: the signed profile. */
async function lookupNetwork(): Promise<string> {
  const server = spawn(HIVE_NET, ["serve", "--lookup", "--data", path.join(root, "lookup"), "--bind", "127.0.0.1:0", "--lookup-limit", "off"], { stdio: ["ignore", "pipe", "ignore"] });
  procs.push(server);
  const lookup = await new Promise<string>((resolve) => {
    let out = "";
    server.stdout!.on("data", (d: Buffer) => {
      out += d.toString();
      const m = /lookup serving on (\S+)/.exec(out);
      if (m) resolve(m[1]!);
    });
  });
  const admin = path.join(root, "admin.key");
  fs.writeFileSync(admin, `${"ef".repeat(32)}\n`);
  const by = (JSON.parse(execFileSync(HIVE_NET, ["access", "voucher", "--kind", "enrol", "--admin", admin], { encoding: "utf8" })) as { by: string }).by;
  const text = path.join(root, "profile.json");
  fs.writeFileSync(text, JSON.stringify({ v: 1, name: "Home", relays: [], lookup, admin: by, local: { mdns: true } }));
  return execFileSync(HIVE_NET, ["profile", "sign", text, "--admin", admin], { encoding: "utf8" });
}

/**
 * The host running, and the laptop (with a shell in its workspace, its terminals in its daemon as
 * outside tests) paired with it by its link, sharing the workspace with a guest who is in and has
 * it open: on the network `profile` when one is given, every one of them.
 */
async function sharedAndPaired(profile?: string) {
  if (profile) {
    fs.mkdirSync(path.join(root, "server", "network"), { recursive: true });
    fs.writeFileSync(path.join(root, "server", "network", "profile"), profile);
  }
  const host = spawn(HIVE, ["host", "run"], { env: hostEnv(), stdio: "ignore" });
  procs.push(host);
  await expect.poll(() => status()?.running ?? false, { timeout: 30_000 }).toBe(true);
  const hostDevice = status()!.device;
  const onNetwork = async (w: Page) => { if (profile) await w.evaluate((p) => window.hive.useNetwork(p), profile); };

  const api = path.join(root, "api");
  fs.mkdirSync(api);
  execSync("git init -q", { cwd: api });
  const laptop = await person(root, "laptop", api, apps, { HIVEMIND_PTY_DAEMON: "1" });
  await onNetwork(laptop);
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
  await onNetwork(guest);
  const link = await share(laptop, "edit");
  await join(guest, laptop, link);
  await guest.locator("[data-join-open]").click();
  await expect.poll(() => tiles(guest), { timeout: 20_000 }).toEqual(await tiles(laptop));
  return { laptop, guest, hostDevice, api, before: await tiles(laptop) };
}

/** Share → move it to the host: the laptop's window opens it from there as its owner, and the
 *  guest follows. */
async function moveToHost(laptop: Page, guest: Page, hostDevice: string): Promise<void> {
  await laptop.locator("[data-share]").click();
  await expect(laptop.locator("[data-move-to]")).toHaveValue(hostDevice);
  await laptop.locator("[data-move-hosting]").click();
  await expect(laptop.locator('[data-shared-banner][data-state="connected"]')).toHaveAttribute("data-access", "owner", { timeout: 20_000 });
  await expect.poll(async () => ((await guest.evaluate(() => window.hive.joined()))[0] as { host?: string } | undefined)?.host, { timeout: 10_000 }).toBe(hostDevice);
  await expect(guest.locator('[data-shared-banner][data-state="connected"]')).toHaveAttribute("data-access", "edit", { timeout: 10_000 });
}

test("a laptop moves a shared workspace to its host: its window and the guest follow, the board is one, and its shell runs on the laptop still; moved back, all of it comes home", async () => {
  test.skip(!hiveNetBuilt() || !hostable, "needs hive-net (cargo build in crates/hive-net) and a current apps/cli/dist/hive (cd apps/cli && bun scripts/build.ts)");
  test.setTimeout(240_000);
  const { laptop, guest, hostDevice, api, before } = await sharedAndPaired();
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

  // Share → move it to the host. The laptop's window opens it from there, as its owner, and the
  // guest follows it within seconds, with no new invite; the host holds it under the laptop's
  // folder for it.
  const moved = Date.now();
  await moveToHost(laptop, guest, hostDevice);
  expect(Date.now() - moved).toBeLessThan(20_000);
  await expect.poll(() => status()?.workspaces.some((w) => w.repo.endsWith(api) && w.repo.startsWith("machine://")) ?? false, { timeout: 10_000 }).toBe(true);

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

  // Moved back: the laptop's window is on its folder again, a workspace of its own, not one joined.
  const laptopDevice = (await laptop.evaluate(() => window.hive.identity())).deviceId;
  await laptop.locator("[data-move-here]").click();
  await expect(laptop.locator("[data-shared-banner]")).toHaveCount(0, { timeout: 20_000 });
  expect(await laptop.evaluate(() => window.hive.joined())).toEqual([]);
  // The guest follows it home with no new invite.
  await expect.poll(async () => ((await guest.evaluate(() => window.hive.joined()))[0] as { host?: string } | undefined)?.host, { timeout: 10_000 }).toBe(laptopDevice);
  await expect(guest.locator('[data-shared-banner][data-state="connected"]')).toHaveAttribute("data-access", "edit", { timeout: 10_000 });
  // The board is the one from the host, and still one.
  await expect.poll(() => tiles(laptop), { timeout: 20_000 }).toEqual(before);
  await expect.poll(() => tiles(guest), { timeout: 20_000 }).toEqual(before);
  await expect.poll(() => notes(laptop), { timeout: 20_000 }).toContain("after the move");
  await note(guest, "back home");
  await expect.poll(() => notes(laptop), { timeout: 20_000 }).toContain("back home");
  // The shell is the same process, in its folder, the laptop's own again.
  expect(await type("pid-home.txt", "echo $$")).toBe(pid);
  expect(await type("where-home.txt", "pwd")).toBe(api);
});

test("on a network with a lookup server, the laptop shares the workspace at the host as before; the host gone, it hosts the workspace from the copy it kept, with the people the host had, and the guest finds it there by its record", async () => {
  test.skip(!hiveNetBuilt() || !hostable, "needs hive-net (cargo build in crates/hive-net) and a current apps/cli/dist/hive (cd apps/cli && bun scripts/build.ts)");
  test.setTimeout(300_000);
  const profile = await lookupNetwork();
  const { laptop, guest, hostDevice, before } = await sharedAndPaired(profile);
  await moveToHost(laptop, guest, hostDevice);
  await note(guest, "at the host");
  await expect.poll(() => notes(laptop), { timeout: 20_000 }).toContain("at the host");

  // At the host it is the laptop's to share still, and not the guest's. Someone asks to join with
  // a link the laptop makes there: the laptop's window is asked, and lets them in.
  await expect(guest.locator("[data-share]")).toHaveCount(0);
  fs.mkdirSync(path.join(root, "third"));
  const third = await person(root, "newcomer", path.join(root, "third"), apps);
  await third.evaluate((p) => window.hive.useNetwork(p), profile);
  const link = await share(laptop, "view");
  await third.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-recent")));
  await third.locator("[data-join]").click();
  await third.locator("[data-join-link]").fill(link);
  await third.locator("[data-join-go]").click();
  const request = laptop.locator(".hm-join-request");
  await expect(request).toContainText("wants to join api as Can view", { timeout: 20_000 });
  await request.getByRole("button", { name: "Allow" }).click();
  await expect(third.locator('[data-join-result="in"]')).toBeVisible({ timeout: 20_000 });
  await third.keyboard.press("Escape");

  // In People, the guest is here, and given another role: they work under it at once.
  const guestId = (await guest.evaluate(() => window.hive.identity())).personId;
  await laptop.locator("[data-share]").click();
  await laptop.locator("[data-share-people]").click();
  const row = laptop.locator(`[data-shared-person="${guestId}"]`);
  await expect(row).toContainText("Here now", { timeout: 10_000 });
  await row.locator("[data-person-role]").selectOption("terminals");
  await expect(guest.locator('[data-shared-banner][data-state="connected"]')).toHaveAttribute("data-access", "terminals", { timeout: 20_000 });
  await laptop.keyboard.press("Escape");

  // The host goes. The laptop cannot reach it, and offers to host the workspace itself again.
  expect(hive("host", "stop").status).toBe(0);
  await expect(laptop.locator('[data-shared-banner][data-state="offline"]')).toBeVisible({ timeout: 60_000 });
  await laptop.locator("[data-take-over]").click();
  // Its window is on its folder again, a workspace of its own, with the board as it last saw it.
  await expect(laptop.locator("[data-shared-banner]")).toHaveCount(0, { timeout: 20_000 });
  expect(await laptop.evaluate(() => window.hive.joined())).toEqual([]);
  await expect.poll(() => notes(laptop), { timeout: 20_000 }).toContain("at the host");
  // The guest, dialling the host again and again, finds it on the laptop by its record.
  const laptopDevice = (await laptop.evaluate(() => window.hive.identity())).deviceId;
  await expect.poll(async () => ((await guest.evaluate(() => window.hive.joined()))[0] as { host?: string } | undefined)?.host, { timeout: 60_000 }).toBe(laptopDevice);
  // As the role given at the host: the laptop kept the list as the host had it.
  await expect(guest.locator('[data-shared-banner][data-state="connected"]')).toHaveAttribute("data-access", "terminals", { timeout: 30_000 });
  await expect.poll(() => tiles(guest), { timeout: 20_000 }).toEqual(before);
  await note(guest, "found it");
  await expect.poll(() => notes(laptop), { timeout: 20_000 }).toContain("found it");
});
