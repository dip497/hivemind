// Your devices (M3, design §5.2–5.3): two computers of one person, each the app with its own data.
// The desktop shows a code in Settings → Devices; the laptop enters its six words, found on this
// network, and becomes the desktop's person, the workspace it had moving with it. Each lists the
// other; the laptop's Open recent lists the desktop's workspace, which it opens as its owner, and a
// shell started there runs on the desktop, in the desktop's folder; and the desktop opens the
// laptop's the same way. A computer on a network of its own offers a link that lets the device
// entering it onto that network first (spec/pairing.md 0.6).
import { test, expect, type ElectronApplication } from "@playwright/test";
import { execFileSync, execSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readDoc } from "@hivemind/workspace-host/doc-file";
import { parsePairLink } from "@hivemind/workspace-host/pairing";
import { hiveNetBuilt, ownNetwork, person, tiles } from "./helpers/multiplayer";

let root: string;
const apps: ElectronApplication[] = [];
/** A network's server, stopped after each test. */
const procs: ChildProcess[] = [];
test.beforeEach(() => { root = fs.mkdtempSync("/tmp/hm-devices-"); });
test.afterEach(async () => {
  // The two apps' daemons only, before the apps close (closing waits on them) and after. An app
  // not gone after a while is killed, and the processes it started with it.
  const reap = () => { try { execSync(`pkill -f "out/main/pty-daemon.js ${root}/"`, { stdio: "ignore" }); } catch { /* none */ } };
  reap();
  for (const a of apps.splice(0)) {
    const gone = await Promise.race([a.close().then(() => true, () => true), new Promise<boolean>((r) => setTimeout(() => r(false), 15_000))]);
    if (!gone) a.process().kill("SIGKILL");
  }
  reap();
  for (const p of procs.splice(0)) p.kill();
  try { execSync(`pkill -KILL -f -- "--user-data-dir=${root}/"`, { stdio: "ignore" }); } catch { /* none */ }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "");
/** Whose the workspace `repo` is, as the document an app keeps for it says. */
const ownerOf = (app: string, repo: string) =>
  readDoc(path.join(root, app, "hivemind-dev", "workspaces"), repo, () => {}).getMap("meta").get("owner");
const repo = (name: string) => {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
};

test("a laptop enters the desktop's six words and becomes its person; each opens the other's workspace as its own, and a shell there runs on the other", async () => {
  test.skip(!hiveNetBuilt(), "build hive-net first: cargo build in crates/hive-net");
  test.setTimeout(180_000);
  // Terminals run in each app's daemon, as outside tests: that is what names a session by its tile.
  const env = { HIVEMIND_PTY_DAEMON: "1" };
  const api = repo("api");
  const desktop = await person(root, "desktop", api, apps, env);
  await desktop.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await expect.poll(async () => (await tiles(desktop)).length).toBeGreaterThan(0);
  const notes = repo("notes");
  const laptop = await person(root, "laptop", notes, apps, env);
  await laptop.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await expect.poll(async () => (await tiles(laptop)).length).toBeGreaterThan(0);
  const [desktopIs, laptopWas] = await Promise.all([desktop.evaluate(() => window.hive.identity()), laptop.evaluate(() => window.hive.identity())]);
  expect(laptopWas.personId).not.toBe(desktopIs.personId);
  await expect.poll(() => ownerOf("laptop", notes)).toBe(laptopWas.personId);

  // The desktop shows a code; the laptop enters its words, read off the desktop's screen.
  const devices = (w: typeof desktop) => w.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: "devices" } })));
  await devices(desktop);
  await desktop.locator("[data-pair-offer]").click();
  const words = (await desktop.locator("[data-pair-code]").textContent())!;
  await devices(laptop);
  await laptop.locator("[data-pair-link]").fill(words);
  await laptop.locator("[data-pair-go]").click();
  await expect(laptop.locator('[data-pair-result="paired"]')).toContainText("this computer is you there too", { timeout: 20_000 });

  // The laptop is the desktop's person now, its own workspace with it; each lists the other.
  expect((await laptop.evaluate(() => window.hive.identity())).personId).toBe(desktopIs.personId);
  expect(ownerOf("laptop", notes)).toBe(desktopIs.personId);
  await expect(laptop.locator('[data-device-kind="app"]')).toHaveCount(1);
  await expect(desktop.locator('[data-device-kind="app"]')).toHaveCount(1, { timeout: 10_000 });
  await laptop.keyboard.press("Escape");

  // Open recent on the laptop lists the desktop's workspace, and opens it as the laptop's own.
  await laptop.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-recent")));
  await laptop.locator("[data-host-workspace]").filter({ hasText: "api" }).click({ timeout: 20_000 });
  await expect(laptop.locator('[data-shared-banner][data-state="connected"]')).toHaveAttribute("data-access", "owner", { timeout: 20_000 });

  // A shell started there runs on the desktop, in its folder. Flown to first, as a notification
  // does: where a new tile lands on the desktop's board depends on how the laptop's view sits.
  const before = await tiles(laptop);
  await laptop.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  let made = "";
  await expect.poll(async () => (made = (await tiles(laptop)).find((t) => !before.includes(t)) ?? "")).not.toBe("");
  await laptop.evaluate((id) => window.dispatchEvent(new CustomEvent("hivemind:focus-tile", { detail: id })), made);
  const terminal = laptop.locator(`.react-flow__node-terminal[data-id="${made}"]`);
  await terminal.locator(".xterm-screen").click();
  await expect.poll(async () => {
    if (!read(path.join(api, "up.txt"))) await laptop.keyboard.type("pwd > up.txt\n");
    return read(path.join(api, "up.txt"));
  }, { timeout: 30_000, intervals: [1_000] }).toBe(api);

  // And the other way: the desktop lists the laptop's workspace, and opens it as its owner too.
  await desktop.keyboard.press("Escape");
  await desktop.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-recent")));
  await desktop.locator("[data-host-workspace]").filter({ hasText: "notes" }).click({ timeout: 20_000 });
  await expect(desktop.locator('[data-shared-banner][data-state="connected"]')).toHaveAttribute("data-access", "owner", { timeout: 20_000 });
});

test("a computer on a network of its own offers a link that gets the device entering it onto that network first, with the voucher it carries", async () => {
  test.skip(!hiveNetBuilt(), "build hive-net first: cargo build in crates/hive-net");
  test.setTimeout(120_000);
  const net = await ownNetwork(root, procs, "closed");
  const desktop = await person(root, "desktop", repo("api"), apps);
  expect(await desktop.evaluate((l) => window.hive.useNetwork(l), net.link)).toMatchObject({ admission: "enrolled" });
  const laptop = await person(root, "laptop", repo("notes"), apps);
  const laptopIs = (await laptop.evaluate(() => window.hive.identity())).deviceId;
  const allowed = async () => (await fetch(`${net.access}/allowed/${laptopIs}`)).text();
  expect(await allowed()).toBe("false");

  const { link } = await desktop.evaluate(() => window.hive.pairOffer()) as { link: string };
  const voucher = parsePairLink(link)!.admission!.voucher as { nonce: string; kind: string };
  expect(voucher.kind).toBe("visit");
  await laptop.evaluate((l) => window.hive.pairEnter(l), link);
  const kept = JSON.parse(fs.readFileSync(path.join(net.data, "access.json"), "utf8")) as { redeemed: Record<string, number> };
  expect(kept.redeemed[voucher.nonce]).toBe(1);
  expect(await allowed()).toBe("true");
});
