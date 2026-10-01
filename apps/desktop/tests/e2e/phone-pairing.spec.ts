// A phone pairs (M5, design §9.2, spec/pairing.md 0.3): Settings → Devices → Pair a phone shows a
// QR code of this computer's link, and the phone (`hive-phone`: the phone's Rust core, in a
// terminal) pairs with it over hive/pair/1. The phone is given a certificate naming it as the
// person's and never the person key; each lists the other; the phone is never a place to open a
// workspace on, move one to or run a frame on; let in by the computer as the person's device, it
// is served what a phone does and nothing more (what it sends to start a terminal there starts
// nothing); and unpairing it on the computer forgets it.
import { test, expect, type ElectronApplication } from "@playwright/test";
import { execFile, execSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { HiveNet } from "@hivemind/workspace-host/hive-net";
import { parsePairLink } from "@hivemind/workspace-host/pairing";
import { heldWorkspaces } from "@hivemind/host/peer-links";
import { HIVE_NET, hiveNetBuilt, person } from "./helpers/multiplayer";

const HIVE_PHONE = path.resolve("../../crates/hive-phone/target/debug/hive-phone");
const run = promisify(execFile);

let root: string;
const apps: ElectronApplication[] = [];
/** What the phone runs that keeps running: stopped after each test. */
const procs: ChildProcess[] = [];
test.beforeEach(() => { root = fs.mkdtempSync("/tmp/hm-phone-"); });
test.afterEach(async () => {
  for (const p of procs.splice(0)) p.kill("SIGKILL");
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

/** The desktop, the person's computer, with the workspace `api` open and its terminals in a
 *  daemon, as outside tests (one a phone might try to start something in); `env` more of its
 *  environment. */
async function desktopWith(env: Record<string, string> = {}) {
  const repo = path.join(root, "api");
  fs.mkdirSync(repo);
  execSync("git init -q", { cwd: repo });
  const desktop = await person(root, "desktop", repo, apps, { HIVEMIND_PTY_DAEMON: "1", ...env });
  const me = await desktop.evaluate(() => window.hive.identity());
  const devices = () => desktop.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: "devices" } })));
  return { repo, desktop, me, devices };
}

/** Settings → Devices → Pair a phone, on `d`: a QR code of the computer's link (read here off its
 *  Copy button, as the phone reads it off the code), which the phone scans, and pairs. */
async function pairPhone(d: Awaited<ReturnType<typeof desktopWith>>) {
  await d.devices();
  await d.desktop.locator("[data-pair-phone]").click();
  await expect(d.desktop.locator('[data-pair-offered="phone"] [data-pair-qr]')).toBeVisible();
  const link = (await d.desktop.locator("[data-pair-copy]").getAttribute("title"))!;
  expect(link).toMatch(/^hivemind:\/\/pair\//);
  const phone = path.join(root, "phone");
  const paired = JSON.parse((await run(HIVE_PHONE, ["pair", link, "--identity", phone, "--name", "Priya's phone", "--json"], { timeout: 60_000 })).stdout) as Record<string, unknown>;
  const phoneId = (await run(HIVE_PHONE, ["id", "--identity", phone])).stdout.trim();
  return { link, phone, paired, phoneId };
}

test("a phone scans the computer's code and is certified as the person's: each lists the other, it holds no person key, and nothing is opened, moved or run on it", async () => {
  test.skip(!hiveNetBuilt() || !fs.existsSync(HIVE_PHONE), "build hive-net and hive-phone first: cargo build in crates/hive-net and crates/hive-phone");
  test.setTimeout(120_000);
  const d = await desktopWith();
  const { repo, desktop, me, devices } = d;
  const { link, phone, paired, phoneId } = await pairPhone(d);
  expect(paired).toMatchObject({ device: me.deviceId, kind: "app", person: me.personId });

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

  // On its own connection to the computer, with its own key: answered which workspaces are there,
  // and what it sends to start a terminal in the computer's daemon starts nothing.
  const where = parsePairLink(link)!;
  const net = await HiveNet.start({ bin: HIVE_NET, identity: phone, socket: path.join(root, "phone-net.sock"), onIncoming: (l) => l.close(), onPairRequest: async () => ({ ok: false }) });
  try {
    const conn = await net.dial(me.deviceId, { addrs: where.addrs, relay: where.relay });
    const ran = path.join(root, "ran");
    conn.send("pty", `${JSON.stringify({ t: "attach", reqId: "p1", id: "hm:from-phone", spec: { cwd: root, cmd: "/bin/sh", args: ["-c", `touch ${ran}`], cols: 80, rows: 24 } })}\n`);
    expect((await heldWorkspaces(conn)).map((w) => w.repo)).toContain(repo);
    await new Promise((r) => setTimeout(r, 1_500));
    expect(fs.existsSync(ran)).toBe(false);
  } finally {
    net.stop();
  }

  // Unpaired on the computer: forgotten there.
  await devices();
  await desktop.locator(`[data-device="${phoneId}"] [data-unpair]`).click();
  await expect(desktop.locator(`[data-device="${phoneId}"]`)).toHaveCount(0);
});

test("the phone asks the computer what needs the person: an agent there waiting on a permission, by what it says it is doing, in its workspace; watches its terminal, read-only; and nothing waits once it works again", async () => {
  test.skip(!hiveNetBuilt() || !fs.existsSync(HIVE_PHONE), "build hive-net and hive-phone first: cargo build in crates/hive-net and crates/hive-phone");
  test.setTimeout(120_000);
  // A stand-in agent, read from its screen: it says what it is doing in its title, and asks to
  // edit a file until it is answered, then draws its screen afresh, working.
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "probe-agent"), [
    "#!/bin/bash",
    "printf '\\033]0;Editing Nav.tsx\\007Allow edit to Nav.tsx? (y/n) '",
    "read -r answer",
    "printf '\\033[2J\\033[Hprobe is thinking\\n'",
    "exec sleep 600",
  ].join("\n"), { mode: 0o755 });
  const agent = path.join(root, "desktop", "hivemind", "agents", "probe");
  fs.mkdirSync(agent, { recursive: true });
  fs.writeFileSync(path.join(agent, "agent.yaml"), [
    "manifestVersion: 2", "id: probe", "label: Probe", "bin: probe-agent", "enabled: true",
    "caps: { promptDelivery: typed, turnSignal: false, resume: none, supervise: human, blockedDetection: true }",
    "detect:", "  default: idle", "  rules:",
    "  - when: { contains: 'Allow edit to Nav.tsx?' }", "    then: permission",
    "  - when: { contains: probe is thinking }", "    then: working", "",
  ].join("\n"));
  const d = await desktopWith({ PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` });
  const { phone } = await pairPhone(d);
  await d.desktop.keyboard.press("Escape");
  const needs = async () => JSON.parse((await run(HIVE_PHONE, ["needs", "--identity", phone, "--json"], { timeout: 30_000 })).stdout) as { needs: Array<Record<string, unknown>>; away: unknown[] };
  expect(await needs()).toEqual({ needs: [], away: [] });

  // The agent starts on the desktop, and asks.
  await d.desktop.evaluate(() => window.hive.settingsSet("agents.defaultAgent", "probe"));
  await d.desktop.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:shortcut", { detail: "agent" })));
  const terminal = d.desktop.locator(".react-flow__node-terminal");
  await expect(terminal).toHaveCount(1, { timeout: 20_000 });
  const tile = (await terminal.getAttribute("data-id"))!;
  let waiting: Record<string, unknown> | undefined;
  await expect.poll(async () => (waiting = (await needs()).needs[0])?.kind, { timeout: 30_000 }).toBe("permission");
  expect(waiting).toMatchObject({ name: "api", tile, agent: "Editing Nav.tsx", kind: "permission" });
  expect(Date.now() - (waiting!.since as number)).toBeLessThan(60_000);

  // Watched from the phone: its screen as it is, then what it prints as it comes.
  const watching = spawn(HIVE_PHONE, ["watch", waiting!.workspace as string, tile, "--identity", phone]);
  procs.push(watching);
  let seen = "";
  watching.stdout!.on("data", (b: Buffer) => { seen += b.toString(); });
  await expect.poll(() => seen, { timeout: 20_000 }).toContain("Allow edit to Nav.tsx?");

  // Answered at the desktop, it works again: the phone sees it, and nothing waits.
  await d.desktop.evaluate((id) => window.dispatchEvent(new CustomEvent("hivemind:focus-tile", { detail: id })), tile);
  await d.desktop.locator(`.react-flow__node[data-id="${tile}"] .xterm-helper-textarea`).focus();
  await d.desktop.keyboard.type("y\n");
  await expect.poll(() => seen, { timeout: 20_000 }).toContain("probe is thinking");
  await expect.poll(async () => (await needs()).needs.length, { timeout: 30_000 }).toBe(0);
});
