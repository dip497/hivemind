// A phone pairs (M5, design §9.2, spec/pairing.md 0.3): Settings → Devices → Pair a phone shows a
// QR code of this computer's link, and the phone (`hive-phone`: the phone's Rust core, in a
// terminal) pairs with it over hive/pair/1. The phone is given a certificate naming it as the
// person's and never the person key; each lists the other; the phone is never a place to open a
// workspace on, move one to or run a frame on; and unpairing it on the computer forgets it.
import { test, expect, type ElectronApplication } from "@playwright/test";
import { execFile, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { hiveNetBuilt, person } from "./helpers/multiplayer";

const HIVE_PHONE = path.resolve("../../crates/hive-phone/target/debug/hive-phone");
const run = promisify(execFile);

let root: string;
const apps: ElectronApplication[] = [];
test.beforeEach(() => { root = fs.mkdtempSync("/tmp/hm-phone-"); });
test.afterEach(async () => {
  // The app's daemons only, before it closes (closing waits on them) and after. An app not gone
  // after a while is killed, and the processes it started with it.
  const reap = () => { try { execSync(`pkill -f "out/main/pty-daemon.js ${root}/"`, { stdio: "ignore" }); } catch { /* none */ } };
  reap();
  for (const a of apps.splice(0)) {
    const gone = await Promise.race([a.close().then(() => true, () => true), new Promise<boolean>((r) => setTimeout(() => r(false), 15_000))]);
    if (!gone) a.process().kill("SIGKILL");
  }
  reap();
  try { execSync(`pkill -KILL -f -- "--user-data-dir=${root}/"`, { stdio: "ignore" }); } catch { /* none */ }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test("a phone scans the computer's code and is certified as the person's: each lists the other, it holds no person key, and nothing is opened, moved or run on it", async () => {
  test.skip(!hiveNetBuilt() || !fs.existsSync(HIVE_PHONE), "build hive-net and hive-phone first: cargo build in crates/hive-net and crates/hive-phone");
  test.setTimeout(120_000);
  const repo = path.join(root, "api");
  fs.mkdirSync(repo);
  execSync("git init -q", { cwd: repo });
  const desktop = await person(root, "desktop", repo, apps);
  const me = await desktop.evaluate(() => window.hive.identity());
  const devices = () => desktop.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: "devices" } })));

  // Settings → Devices → Pair a phone: a QR code of the computer's link (read here off its Copy
  // button, as the phone reads it off the code).
  await devices();
  await desktop.locator("[data-pair-phone]").click();
  await expect(desktop.locator('[data-pair-offered="phone"] [data-pair-qr]')).toBeVisible();
  const link = (await desktop.locator("[data-pair-copy]").getAttribute("title"))!;
  expect(link).toMatch(/^hivemind:\/\/pair\//);

  // The phone scans it, and pairs.
  const phone = path.join(root, "phone");
  const paired = JSON.parse((await run(HIVE_PHONE, ["pair", link, "--identity", phone, "--name", "Priya's phone", "--json"], { timeout: 60_000 })).stdout) as Record<string, unknown>;
  expect(paired).toMatchObject({ device: me.deviceId, kind: "app", person: me.personId });
  const phoneId = (await run(HIVE_PHONE, ["id", "--identity", phone])).stdout.trim();

  // The computer lists it as a phone; the phone lists the computer, and holds a certificate
  // naming it as the person's, and no person key.
  await expect(desktop.locator(`[data-device="${phoneId}"][data-device-kind="phone"]`)).toContainText("Priya's phone", { timeout: 10_000 });
  const listed = JSON.parse((await run(HIVE_PHONE, ["devices", "--identity", phone, "--json"])).stdout) as Array<{ device: string; kind: string; certificate: { person: string } }>;
  expect(listed.map((d) => [d.device, d.kind, d.certificate.person])).toEqual([[me.deviceId, "app", me.personId]]);
  const cert = JSON.parse(fs.readFileSync(path.join(phone, "device.cert"), "utf8")) as { person: string; device: string };
  expect([cert.person, cert.device]).toEqual([me.personId, phoneId]);
  expect(fs.readdirSync(phone).sort()).toEqual(["device.cert", "device.key", "devices.json"]);
  await desktop.keyboard.press("Escape");

  // Never a place to run anything: it holds no workspaces to open, a workspace does not move to it,
  // and the frame chooser does not offer it.
  expect(await desktop.evaluate(() => window.hive.deviceWorkspaces())).toEqual([]);
  const moved = await desktop.evaluate(([r, d]) => window.hive.moveHosting(r, d).then(() => "moved", (e: unknown) => String(e)), [repo, phoneId]);
  expect(moved).toMatch(/not one of your computers or hosts/);
  await desktop.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await expect(desktop.locator(".react-flow__node-frame")).toHaveCount(1, { timeout: 20_000 });
  const frameId = (await desktop.locator(".react-flow__node-frame").first().getAttribute("data-id"))!;
  await desktop.evaluate((id) => window.dispatchEvent(new CustomEvent("hivemind:attach-remote", { detail: { frameId: id } })), frameId);
  await expect(desktop.getByText("Run this frame on…")).toBeVisible();
  await expect(desktop.locator(`[data-pick-device="${phoneId}"]`)).toHaveCount(0);
  await desktop.keyboard.press("Escape");

  // Unpaired on the computer: forgotten there.
  await devices();
  await desktop.locator(`[data-device="${phoneId}"] [data-unpair]`).click();
  await expect(desktop.locator(`[data-device="${phoneId}"]`)).toHaveCount(0);
});
