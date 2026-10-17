// Your devices (M3, design §5.2–5.3; spec/pairing.md 0.10): two computers of one person, each the app
// with its own data. The desktop offers to connect in Settings → Connect; the laptop enters its six
// words under Join, found on this network; the person at the desktop says it is theirs, the one at
// the laptop that the words match, and it becomes the desktop's person, the workspace it had moving
// with it. Each lists the
// other; the laptop's Open recent lists the desktop's workspace, which it opens as its owner, and a
// shell started there runs on the desktop, in the desktop's folder; and the desktop opens the
// laptop's the same way. A computer on a network of its own offers a link that lets the device
// entering it onto that network first (spec/pairing.md 0.6).
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readDoc } from "@hivemind/workspace-host/doc-file";
import { parseConnectLink } from "@hivemind/workspace-host/connect";
import { hiveNetBuilt, join, ownNetwork, person, share, tiles } from "./helpers/multiplayer";
import { stopDaemons } from "./helpers/daemons";
import { itsMe, offerToConnect } from "./helpers/phone";

let root: string;
const apps: ElectronApplication[] = [];
/** A network's server, stopped after each test. */
const procs: ChildProcess[] = [];
test.beforeEach(() => { root = fs.mkdtempSync("/tmp/hm-devices-"); });
test.afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  stopDaemons(root);
  for (const p of procs.splice(0)) p.kill();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** The laptop uses the desktop's offer, made from Home: the person at the desktop says it is theirs,
 *  and the one at the laptop that the words match. The offer's link. */
async function connectLaptop(desktop: Page, laptop: Page): Promise<string> {
  const { link } = await desktop.evaluate(() => window.hive.connectOffer(null));
  const entered = laptop.evaluate((l) => window.hive.connectEnter(l), link);
  await itsMe(desktop);
  // Asked once the desktop said so: until then nothing waits on the yes.
  await expect.poll(() => laptop.evaluate(() => window.hive.connectSure(true).then(() => true, () => false)), { timeout: 30_000 }).toBe(true);
  await entered;
  return link;
}

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
  const api = repo("api");
  const desktop = await person(root, "desktop", api, apps);
  await desktop.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await expect.poll(async () => (await tiles(desktop)).length).toBeGreaterThan(0);
  const notes = repo("notes");
  const laptop = await person(root, "laptop", notes, apps);
  await laptop.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await expect.poll(async () => (await tiles(laptop)).length).toBeGreaterThan(0);
  const [desktopIs, laptopWas] = await Promise.all([desktop.evaluate(() => window.hive.identity()), laptop.evaluate(() => window.hive.identity())]);
  expect(laptopWas.personId).not.toBe(desktopIs.personId);
  await expect.poll(() => ownerOf("laptop", notes)).toBe(laptopWas.personId);

  // The desktop offers; the laptop enters its words, read off the desktop's screen; each person says yes.
  await offerToConnect(desktop);
  const words = (await desktop.locator("[data-connect-code]").textContent())!;
  await laptop.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-recent", { detail: { join: true } })));
  await laptop.locator("[data-join-link]").fill(words);
  await laptop.locator("[data-join-go]").click();
  await itsMe(desktop);
  await laptop.locator("[data-connect-sure-yes]").click({ timeout: 20_000 });
  await expect(laptop.locator('[data-join-result="theirs"]')).toBeVisible({ timeout: 20_000 });
  await laptop.keyboard.press("Escape");
  const devices = (w: typeof desktop) => w.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: "connect" } })));
  await devices(laptop);

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

  const link = await connectLaptop(desktop, laptop);
  const voucher = parseConnectLink(link)!.admission!.voucher as { nonce: string; kind: string };
  expect(voucher.kind).toBe("visit");
  const kept = JSON.parse(fs.readFileSync(path.join(net.data, "access.json"), "utf8")) as { redeemed: Record<string, number> };
  expect(kept.redeemed[voucher.nonce]).toBe(1);
  expect(await allowed()).toBe("true");
});

test("unpaired, a laptop is let into the desktop's workspace no more and is off its network, though it keeps the person key", async () => {
  test.skip(!hiveNetBuilt(), "build hive-net first: cargo build in crates/hive-net");
  test.setTimeout(180_000);
  const net = await ownNetwork(root, procs, "closed");
  const desktop = await person(root, "desktop", repo("api"), apps);
  expect(await desktop.evaluate((l) => window.hive.useNetwork(l), net.link)).toMatchObject({ admission: "enrolled" });
  const laptop = await person(root, "laptop", repo("notes"), apps);
  const laptopIs = (await laptop.evaluate(() => window.hive.identity())).deviceId;
  const allowed = async () => (await fetch(`${net.access}/allowed/${laptopIs}`)).text();
  await connectLaptop(desktop, laptop);
  await expect.poll(allowed).toBe("true");

  // Paired, the laptop opens the desktop's workspace as its owner.
  const banner = laptop.locator("[data-shared-banner]");
  const open = async () => {
    await laptop.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-recent")));
    await laptop.locator("[data-host-workspace]").filter({ hasText: "api" }).click({ timeout: 20_000 });
  };
  await open();
  await expect(banner).toHaveAttribute("data-state", "connected", { timeout: 30_000 });
  await expect(banner).toHaveAttribute("data-access", "owner");

  // Unpaired on the desktop: let go at once, and off the network the desktop vouched it onto.
  await desktop.evaluate((d) => window.hive.unpair(d), laptopIs);
  await expect(banner).not.toHaveAttribute("data-state", "connected", { timeout: 20_000 });
  await expect.poll(allowed, { timeout: 20_000 }).toBe("false");
  // Opened again, it is not let back in: each opening dials once, and a dial is answered in seconds.
  await laptop.keyboard.press("Escape");
  await open().catch(() => {});
  const states: string[] = [];
  for (let i = 0; i < 20; i++) {
    states.push((await banner.getAttribute("data-state").catch(() => null)) ?? "none");
    await laptop.waitForTimeout(1_000);
  }
  expect(states).not.toContain("connected");
});

test("unpaired, a laptop that joined someone else's workspace as this person is let in there no more", async () => {
  test.skip(!hiveNetBuilt(), "build hive-net first: cargo build in crates/hive-net");
  test.setTimeout(240_000);
  const design = repo("design");
  const priya = await person(root, "priya", design, apps);
  await priya.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  const desktop = await person(root, "desktop", repo("api"), apps);
  const laptop = await person(root, "laptop", repo("notes"), apps);
  const laptopIs = (await laptop.evaluate(() => window.hive.identity())).deviceId;
  await connectLaptop(desktop, laptop);

  // As the desktop's person, the laptop joins Priya's workspace and opens it.
  await join(laptop, priya, await share(priya, "edit"));
  await laptop.locator("[data-join-open]").click();
  const banner = laptop.locator("[data-shared-banner]");
  await expect(banner).toHaveAttribute("data-state", "connected", { timeout: 30_000 });
  await expect(banner).toHaveAttribute("data-access", "edit");
  const devicesThere = async () => (await priya.evaluate((r) => window.hive.people(r), design)).flatMap((p) => p.devices);
  expect(await devicesThere()).toContain(laptopIs);

  // What Unpair does, and what it does not, said before it is pressed.
  await desktop.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: "connect" } })));
  await expect(desktop.locator(`[data-device="${laptopIs}"] [data-unpair]`)).toBeVisible();
  await expect(desktop.locator("[data-unpair-says]")).toHaveText(
    "Unpair lets that device into nothing on this computer, takes it off your network if this computer let it on, and tells the computers of people whose workspaces it joined as you to let it in no more (one that is off hears it once it is back). A phone is forgotten by your other devices too. A computer or host stays paired with your other devices until you unpair it on each, and keeps your person key: with it, it can still join workspaces and pair devices as you.");
  await desktop.locator(`[data-device="${laptopIs}"] [data-unpair]`).click();
  // Priya's computer is told: it lets the laptop go, and keeps it off her list, Asha still on it.
  await expect(banner).toHaveAttribute("data-state", "removed", { timeout: 30_000 });
  expect(await devicesThere()).not.toContain(laptopIs);
  expect(await priya.evaluate((r) => window.hive.people(r), design)).toHaveLength(1);
});
