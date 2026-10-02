// A phone pairs (M5, design §9.2, spec/pairing.md 0.3): Settings → Devices → Pair a phone shows a
// QR code of this computer's link, and the phone (`hive-phone`: the phone's Rust core, in a
// terminal) pairs with it over hive/pair/1. The phone is given a certificate naming it as the
// person's and never the person key; each lists the other; the phone is never a place to open a
// workspace on, move one to or run a frame on; let in by the computer as the person's device, it
// is served what a phone does and nothing more (what it sends to start a terminal there starts
// nothing); and unpaired from the phone, each forgets the other. Then the phone at work
// (spec/needs.md, spec/push.md): told when an agent on the computer begins waiting on the person,
// it lists it, on that computer, watches and answers it, sends it a message and types into it, and
// counts the agents at work; unpaired on the computer, it is told nothing more. And the computer away: the phone shows what it last
// said; back, as it starts or wakes, it tells the phone, which shows it once it found it away
// (spec/push.md 0.2); and unpaired from the phone while away, only the phone forgets. And the
// computer on a network of its own: its link says how to get onto that network from elsewhere,
// and the phone takes the network and is let onto it (spec/pairing.md 0.5, 0.6); with a push
// server there, the phone registers at it, naming the computer, and is told through it, which
// keeps nothing of what it passes on; unpaired, the computer is named no more (spec/push.md 0.3).
// And a community view on the phone, its host on the computer (P8, spec/workspace-api.md 0.12):
// offered when it says it works on a phone, its files read, opened, told it is on a phone and what
// the board holds, doing there only what the phone may, and closed.
import { test, expect, type ElectronApplication } from "@playwright/test";
import { execFile, execSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { HiveNet } from "@hivemind/workspace-host/hive-net";
import { parsePairLink } from "@hivemind/workspace-host/pairing";
import { heldWorkspaces } from "@hivemind/host/peer-links";
import { HIVE_NET, hiveNetBuilt, ownNetwork, person } from "./helpers/multiplayer";
import { offerPhonePairing, talkerAgent } from "./helpers/phone";

const HIVE_PHONE = path.resolve("../../crates/hive-phone/target/debug/hive-phone");
const CLI = path.resolve("../cli/src/index.ts");
const run = promisify(execFile);

let root: string;
const apps: ElectronApplication[] = [];
/** What the phone runs that keeps running: stopped after each test. */
const procs: ChildProcess[] = [];
test.beforeEach(() => { root = fs.mkdtempSync("/tmp/hm-phone-"); });
/** This test's terminal daemons, stopped: an app closing waits on them. */
const reap = () => { try { execSync(`pkill -f "out/main/pty-daemon.js ${root}/"`, { stdio: "ignore" }); } catch { /* none */ } };
/** Close `a`, its daemons stopped first; one not gone after a while is killed. */
async function closeApp(a: ElectronApplication): Promise<void> {
  reap();
  const gone = await Promise.race([a.close().then(() => true, () => true), new Promise<boolean>((r) => setTimeout(() => r(false), 15_000))]);
  if (!gone) a.process().kill("SIGKILL");
}
test.afterEach(async () => {
  for (const p of procs.splice(0)) p.kill("SIGKILL");
  // The app's daemons only, before it closes and after, and the processes it started with it.
  for (const a of apps.splice(0)) await closeApp(a);
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
  const link = await offerPhonePairing(d.desktop);
  const phone = path.join(root, "phone");
  const paired = JSON.parse((await run(HIVE_PHONE, ["pair", link, "--identity", phone, "--name", "Priya's phone", "--json"], { timeout: 60_000 })).stdout) as Record<string, unknown>;
  const phoneId = (await run(HIVE_PHONE, ["id", "--identity", phone])).stdout.trim();
  return { link, phone, paired, phoneId };
}

/** A stand-in agent, read from its screen: it says what it is doing in its title, and asks to
 *  edit a file until it is answered, then draws its screen afresh, working, and says each line it
 *  hears from then on. Told no, it says so and asks again a moment later; its manifest says `y`
 *  and Enter allow what it asks and `n` and Enter deny it. What the desktop's environment needs to
 *  run it. */
function probeAgent(): Record<string, string> {
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "probe-agent"), [
    "#!/bin/bash",
    "printf '\\033]0;Editing Nav.tsx\\007'",
    "while :; do",
    "  printf 'Allow edit to Nav.tsx? (y/n) '",
    "  read -r answer",
    "  [ \"$answer\" = n ] || break",
    "  printf '\\033[2J\\033[Hprobe was told no\\n'",
    "  sleep 2",
    "done",
    "printf '\\033[2J\\033[Hprobe is thinking\\n'",
    "while read -r line; do printf 'heard: %s\\n' \"$line\"; done",
  ].join("\n"), { mode: 0o755 });
  const agent = path.join(root, "desktop", "hivemind", "agents", "probe");
  fs.mkdirSync(agent, { recursive: true });
  fs.writeFileSync(path.join(agent, "agent.yaml"), [
    "manifestVersion: 2", "id: probe", "label: Probe", "bin: probe-agent", "enabled: true",
    "caps: { promptDelivery: typed, turnSignal: false, resume: none, supervise: human, blockedDetection: true }",
    "answer: { permission: { allow: ['y', enter], deny: ['n', enter] } }",
    "detect:", "  default: idle", "  rules:",
    "  - when: { contains: 'Allow edit to Nav.tsx?' }", "    then: permission",
    "  - when: { contains: probe is thinking }", "    then: working", "",
  ].join("\n"));
  return { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` };
}

/** A second stand-in agent, one the phone starts: it takes each line it is given as something to
 *  write down, in `notes.txt` in the folder it runs in, saying so on its screen (working), and
 *  stops at Ctrl+C, which its manifest says interrupts its turn. Installed beside the first. */
function scribeAgent(): void {
  fs.writeFileSync(path.join(root, "bin", "scribe-agent"), [
    "#!/bin/bash",
    "trap 'printf \"\\033[2J\\033[Hscribe stopped\\n\"' INT",
    "printf 'scribe> '",
    "while :; do",
    "  if read -r line; then",
    "    printf '%s\\n' \"$line\" >> notes.txt",
    "    printf '\\033[2J\\033[Hscribe is writing: %s\\n' \"$line\"",
    "  elif [ $? -le 128 ]; then exit; fi",
    "done",
  ].join("\n"), { mode: 0o755 });
  const agent = path.join(root, "desktop", "hivemind", "agents", "scribe");
  fs.mkdirSync(agent, { recursive: true });
  fs.writeFileSync(path.join(agent, "agent.yaml"), [
    "manifestVersion: 2", "id: scribe", "label: Scribe", "bin: scribe-agent", "enabled: true",
    "caps: { promptDelivery: typed, turnSignal: false, resume: none, supervise: human, blockedDetection: true }",
    "interrupt: [ctrl-c]",
    "detect:", "  default: idle", "  rules:",
    "  - when: { contains: scribe is writing }", "    then: working", "",
  ].join("\n"));
}

/** The stand-in agent started on the board of `d`: its tile. */
async function startProbe(d: Awaited<ReturnType<typeof desktopWith>>): Promise<string> {
  await d.desktop.evaluate(() => window.hive.settingsSet("agents.defaultAgent", "probe"));
  await d.desktop.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:shortcut", { detail: "agent" })));
  const terminal = d.desktop.locator(".react-flow__node-terminal");
  await expect(terminal).toHaveCount(1, { timeout: 20_000 });
  return (await terminal.getAttribute("data-id"))!;
}

/** The phone gives the computer an address of its own to be told at, and takes each notice
 *  there: what it shows, as it comes. */
function listen(phone: string): Array<Record<string, unknown>> {
  const pushed = spawn(HIVE_PHONE, ["push", "--listen", "127.0.0.1:0", "--identity", phone, "--json"]);
  procs.push(pushed);
  const told: Array<Record<string, unknown>> = [];
  let line = "";
  pushed.stdout!.on("data", (b: Buffer) => {
    const lines = (line + b.toString()).split("\n");
    line = lines.pop()!;
    for (const l of lines) told.push(JSON.parse(l) as Record<string, unknown>);
  });
  return told;
}

/** What `phone` is told waits on the person, and of a computer away, what it last said. */
async function needsOf(phone: string) {
  return JSON.parse((await run(HIVE_PHONE, ["needs", "--identity", phone, "--json"], { timeout: 30_000 })).stdout) as {
    needs: Array<Record<string, unknown>>; working: number; away: Array<Record<string, unknown>>;
  };
}

test("a phone scans the computer's code and is certified as the person's, by their name and colour: each lists the other, it holds no person key, nothing is opened, moved or run on it, and unpaired from the phone, each forgets the other", async () => {
  test.skip(!hiveNetBuilt() || !fs.existsSync(HIVE_PHONE), "build hive-net and hive-phone first: cargo build in crates/hive-net and crates/hive-phone");
  test.setTimeout(120_000);
  const d = await desktopWith();
  const { repo, desktop, me } = d;
  await desktop.evaluate(() => window.hive.settingsSet("profile.name", "Priya Shah"));
  await desktop.evaluate(() => window.hive.settingsSet("profile.color", "#3b82f6"));
  const { link, phone, paired, phoneId } = await pairPhone(d);
  expect(paired).toMatchObject({ device: me.deviceId, kind: "app", person: me.personId, profile: { name: "Priya Shah", color: "#3b82f6" } });

  // The computer lists it as a phone; the phone lists the computer, and holds a certificate
  // naming it as the person's, and no person key.
  await expect(desktop.locator(`[data-device="${phoneId}"][data-device-kind="phone"]`)).toContainText("Priya's phone", { timeout: 10_000 });
  const listed = JSON.parse((await run(HIVE_PHONE, ["devices", "--identity", phone, "--json"])).stdout) as Array<{ device: string; kind: string; certificate: { person: string } }>;
  expect(listed.map((d) => [d.device, d.kind, d.certificate.person])).toEqual([[me.deviceId, "app", me.personId]]);
  const cert = JSON.parse(fs.readFileSync(path.join(phone, "device.cert"), "utf8")) as { person: string; device: string };
  expect([cert.person, cert.device]).toEqual([me.personId, phoneId]);
  expect(fs.readdirSync(phone).sort()).toEqual(["device.cert", "device.key", "devices.json", "person.json"]);
  // Whose it is, as the computer's profile says: changed there, the phone is told the next time it
  // asks the computer anything.
  const whose = () => JSON.parse(fs.readFileSync(path.join(phone, "person.json"), "utf8")) as unknown;
  expect(whose()).toEqual({ name: "Priya Shah", color: "#3b82f6" });
  await desktop.evaluate(() => window.hive.settingsSet("profile.name", "Priya S."));
  await run(HIVE_PHONE, ["needs", "--identity", phone, "--json"], { timeout: 30_000 });
  expect(whose()).toEqual({ name: "Priya S.", color: "#3b82f6" });
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

  // Unpaired from the phone: each forgets the other, and the computer records that the phone did.
  const unpaired = JSON.parse((await run(HIVE_PHONE, ["unpair", me.deviceId, "--identity", phone, "--json"], { timeout: 30_000 })).stdout) as unknown;
  expect(unpaired).toEqual({ device: me.deviceId, name: os.hostname(), told: true });
  expect(JSON.parse((await run(HIVE_PHONE, ["devices", "--identity", phone, "--json"])).stdout)).toEqual([]);
  await expect.poll(async () => (await desktop.evaluate(() => window.hive.devices())).map((d) => d.device)).toEqual([]);
  const audit = () => fs.readFileSync(path.join(root, "desktop", "hivemind-dev", "audit.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  await expect.poll(audit).toContainEqual(expect.objectContaining({ verb: "net:unpair", actor: { kind: "peer", person: me.personId, device: phoneId, access: "owner" }, outcome: "ok" }));
});

test("the phone is told when an agent on the computer begins waiting on the person, and asks what needs them: the agent, by what it says it is doing, in its workspace, on that computer; watches its terminal; answers it, once; nothing waits once it works again, and it is at work; sends it a message and types into it, as the person; and unpaired, it is told nothing more", async () => {
  test.skip(!hiveNetBuilt() || !fs.existsSync(HIVE_PHONE), "build hive-net and hive-phone first: cargo build in crates/hive-net and crates/hive-phone");
  test.setTimeout(120_000);
  const d = await desktopWith(probeAgent());
  const { phone, phoneId } = await pairPhone(d);
  await d.desktop.keyboard.press("Escape");
  const told = listen(phone);
  await expect.poll(() => told[0], { timeout: 30_000 }).toMatchObject({ told: [os.hostname()], away: [] });
  const needs = () => needsOf(phone);
  expect(await needs()).toEqual({ needs: [], working: 0, away: [] });

  // The agent starts on the desktop, and asks.
  const tile = await startProbe(d);
  const terminal = d.desktop.locator(".react-flow__node-terminal");
  let waiting: Record<string, unknown> | undefined;
  await expect.poll(async () => (waiting = (await needs()).needs[0])?.kind, { timeout: 30_000 }).toBe("permission");
  expect(waiting).toMatchObject({ name: "api", tile, agent: "Editing Nav.tsx", kind: "permission", machine: os.hostname() });
  expect(Date.now() - (waiting!.since as number)).toBeLessThan(60_000);
  // Told as it began, encrypted to the phone and read by it alone.
  const { machine: _, ...notice } = waiting!;
  await expect.poll(() => told.slice(1), { timeout: 10_000 }).toEqual([{ v: 1, t: "needs", ...notice }]);

  // Watched from the phone: its screen as it is, then what it prints as it comes.
  const watching = spawn(HIVE_PHONE, ["watch", waiting!.workspace as string, tile, "--identity", phone]);
  procs.push(watching);
  let seen = "";
  watching.stdout!.on("data", (b: Buffer) => { seen += b.toString(); });
  await expect.poll(() => seen, { timeout: 20_000 }).toContain("Allow edit to Nav.tsx?");

  // Answered from the phone: the line goes into the agent's terminal, and it works again; the
  // phone sees it, nothing waits, and one agent is at work. The same answer again does nothing:
  // that wait is over.
  const answer = async () => JSON.parse((await run(HIVE_PHONE, ["answer", waiting!.workspace as string, tile, String(waiting!.since), "--text", "y", "--identity", phone, "--json"], { timeout: 30_000 })).stdout) as unknown;
  expect(await answer()).toEqual({ answered: true });
  await expect.poll(() => seen, { timeout: 20_000 }).toContain("probe is thinking");
  await expect.poll(async () => { const n = await needs(); return [n.needs.length, n.working]; }, { timeout: 30_000 }).toEqual([0, 1]);
  expect(await answer()).toEqual({ answered: false });

  // A message from the phone, whatever the agent is doing: it goes in as its next prompt.
  const sent = JSON.parse((await run(HIVE_PHONE, ["send", waiting!.workspace as string, tile, "--text", "also add tests", "--identity", phone, "--json"], { timeout: 30_000 })).stdout) as unknown;
  expect(sent).toEqual({ sent: true });
  await expect.poll(() => seen, { timeout: 20_000 }).toContain("heard: also add tests");
  // Typed from the phone, as the person: each line goes into its terminal, Enter after it.
  const typing = spawn(HIVE_PHONE, ["watch", waiting!.workspace as string, tile, "--type", "--identity", phone]);
  procs.push(typing);
  let shown = "";
  typing.stdout!.on("data", (b: Buffer) => { shown += b.toString(); });
  await expect.poll(() => shown, { timeout: 20_000 }).toContain("heard: also add tests");
  typing.stdin!.write("run them\n");
  await expect.poll(() => seen, { timeout: 20_000 }).toContain("heard: run them");

  // Unpaired on the computer: another agent there begins waiting on the person, and the phone is
  // told nothing of it.
  await d.devices();
  await d.desktop.locator(`[data-device="${phoneId}"] [data-unpair]`).click();
  await expect(d.desktop.locator(`[data-device="${phoneId}"]`)).toHaveCount(0);
  await d.desktop.keyboard.press("Escape");
  await d.desktop.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:shortcut", { detail: "agent" })));
  await expect(terminal).toHaveCount(2, { timeout: 20_000 });
  const other = (await terminal.evaluateAll((ts, first) => ts.map((t) => t.getAttribute("data-id")).find((id) => id !== first), tile))!;
  const state = async () => (await d.desktop.evaluate(() => window.hive.hcpStatusAll())).find((s) => s.tileId.replace(/^hm:/, "") === other)?.status;
  await expect.poll(async () => (await state())?.kind, { timeout: 30_000 }).toBe("permission");
  await new Promise((r) => setTimeout(r, 2_000));
  expect(told).toHaveLength(2);
});

test("the phone drives the person's agents in full: it follows every agent there, live; sees what may be started and starts one with a first prompt, on the computer's board; reads what it changed; interrupts its turn with its agent's keys; and closes it; each recorded as the phone", async () => {
  test.skip(!hiveNetBuilt() || !fs.existsSync(HIVE_PHONE), "build hive-net and hive-phone first: cargo build in crates/hive-net and crates/hive-phone");
  test.setTimeout(150_000);
  const env = probeAgent();
  scribeAgent();
  const d = await desktopWith(env);
  const { phone, phoneId } = await pairPhone(d);
  await d.desktop.keyboard.press("Escape");
  const probe = await startProbe(d);

  // Following: every agent, as each list comes.
  const following = spawn(HIVE_PHONE, ["agents", "--follow", "--identity", phone, "--json"]);
  procs.push(following);
  const lists: Array<{ agents: Array<Record<string, unknown>>; working: number }> = [];
  let line = "";
  following.stdout!.on("data", (b: Buffer) => {
    const lines = (line + b.toString()).split("\n");
    line = lines.pop()!;
    for (const l of lines) lists.push(JSON.parse(l) as (typeof lists)[number]);
  });
  const agent = (tile: string) => lists.at(-1)?.agents.find((a) => a.tile === tile);
  await expect.poll(() => agent(probe)?.waiting, { timeout: 30_000 }).toMatchObject({ kind: "permission", decide: true });
  const workspace = agent(probe)!.workspace as string;
  expect(agent(probe)).toMatchObject({ name: "api", agent: "Editing Nav.tsx", state: "waiting", machine: os.hostname() });

  const phoneCli = async (...args: string[]) => JSON.parse((await run(HIVE_PHONE, [...args, "--identity", phone, "--json"], { timeout: 30_000 })).stdout) as Record<string, unknown>;
  // What may be started there.
  const startable = await phoneCli("start", workspace);
  expect((startable.programs as Array<{ id: string }>).map((p) => p.id)).toEqual(expect.arrayContaining(["probe", "scribe"]));

  // Started from the phone with its first prompt: it opens on the computer's board and is at work.
  const { tile: scribe } = await phoneCli("start", workspace, "scribe", "--prompt", "buy milk") as { tile: string };
  await expect(d.desktop.locator(`.react-flow__node-terminal[data-id="${scribe}"]`)).toHaveCount(1, { timeout: 20_000 });
  await expect.poll(() => agent(scribe)?.state, { timeout: 30_000 }).toBe("working");
  expect(agent(scribe)).toMatchObject({ workspace, program: { id: "scribe", label: "Scribe" }, interrupt: true });

  // What it changed, in the folder it runs in: a new file, shown whole.
  const changes = await phoneCli("diff", workspace, scribe);
  expect(changes.files).toContainEqual({ path: "notes.txt", status: "?", added: 1, removed: 0 });
  expect(changes.patch).toContain("+buy milk");

  // Its turn interrupted with its agent's keys: it stops, and the phone sees it idle. At rest,
  // there is nothing to interrupt.
  expect(await phoneCli("stop", workspace, scribe)).toEqual({ interrupted: true });
  await expect.poll(() => agent(scribe)?.state, { timeout: 30_000 }).toBe("idle");
  expect(await phoneCli("stop", workspace, scribe)).toEqual({ interrupted: false });

  // Closed from the phone: gone from the board and from the list.
  expect(await phoneCli("close", workspace, scribe)).toEqual({ closed: true });
  await expect(d.desktop.locator(`.react-flow__node-terminal[data-id="${scribe}"]`)).toHaveCount(0, { timeout: 20_000 });
  await expect.poll(() => agent(scribe), { timeout: 30_000 }).toBeUndefined();
  expect(agent(probe)).toBeDefined();

  const audit = () => fs.readFileSync(path.join(root, "desktop", "hivemind-dev", "audit.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  const asPhone = { kind: "peer", person: d.me.personId, device: phoneId, access: "owner" };
  for (const verb of ["agent.start", "agent.interrupt", "agent.close"]) {
    expect(audit()).toContainEqual(expect.objectContaining({ verb, target: scribe, actor: asPhone, outcome: "ok" }));
  }
});

test("the phone follows what an agent and the person say to each other, as the agent's session file keeps it: the last of it, then each piece as it is written, and a session the agent begins since from its start", async () => {
  test.skip(!hiveNetBuilt() || !fs.existsSync(HIVE_PHONE), "build hive-net and hive-phone first: cargo build in crates/hive-net and crates/hive-phone");
  test.setTimeout(120_000);
  const env = probeAgent();
  talkerAgent(root);
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const d = await desktopWith({ ...env, HOME: home, TALKER_TRACKS: path.join(root, "desktop", "hivemind-dev", "tile-sessions") });
  const { phone } = await pairPhone(d);
  await d.desktop.keyboard.press("Escape");
  const phoneCli = async (...args: string[]) => JSON.parse((await run(HIVE_PHONE, [...args, "--identity", phone, "--json"], { timeout: 30_000 })).stdout) as Record<string, unknown>;

  // The talker starts on the desktop, and is told something from the phone.
  await d.desktop.evaluate(() => window.hive.settingsSet("agents.defaultAgent", "talker"));
  await d.desktop.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:shortcut", { detail: "agent" })));
  const terminal = d.desktop.locator(".react-flow__node-terminal");
  await expect(terminal).toHaveCount(1, { timeout: 20_000 });
  const tile = (await terminal.getAttribute("data-id"))!;
  let listed: Array<Record<string, unknown>> = [];
  await expect.poll(async () => (listed = (await phoneCli("agents")).agents as typeof listed).length, { timeout: 30_000 }).toBe(1);
  const workspace = listed[0]!.workspace as string;
  expect(await phoneCli("send", workspace, tile, "--text", "fix the nav")).toEqual({ sent: true });
  await expect.poll(() => fs.existsSync(path.join(home, "talk")) && fs.readdirSync(path.join(home, "talk")).length, { timeout: 20_000 }).toBe(1);

  // Followed from the phone: what is said so far, then each piece as it is written.
  const following = spawn(HIVE_PHONE, ["talk", workspace, tile, "--follow", "--identity", phone, "--json"]);
  procs.push(following);
  const pieces: Array<{ entries: Array<Record<string, unknown>>; cursor: number; session: string }> = [];
  let line = "";
  following.stdout!.on("data", (b: Buffer) => {
    const lines = (line + b.toString()).split("\n");
    line = lines.pop()!;
    for (const l of lines) pieces.push(JSON.parse(l) as (typeof pieces)[number]);
  });
  const said = () => pieces.flatMap((p) => p.entries).map((e) => [e.who, e.text]);
  await expect.poll(said, { timeout: 30_000 }).toEqual([["person", "fix the nav"], ["agent", "You said fix the nav"]]);
  expect(await phoneCli("send", workspace, tile, "--text", "add tests")).toEqual({ sent: true });
  await expect.poll(said, { timeout: 30_000 }).toEqual([
    ["person", "fix the nav"], ["agent", "You said fix the nav"], ["person", "add tests"], ["agent", "You said add tests"],
  ]);
  expect(pieces.length).toBeGreaterThan(1);

  // Cleared, the agent begins another session: once its file is written, the phone follows it, the
  // pieces named by it.
  const first = pieces[0]!.session;
  expect(first).toMatch(/^[0-9a-f-]{36}$/);
  expect(await phoneCli("send", workspace, tile, "--text", "/clear")).toEqual({ sent: true });
  expect(await phoneCli("send", workspace, tile, "--text", "a fresh start")).toEqual({ sent: true });
  const since = () => pieces.filter((p) => p.session !== first).flatMap((p) => p.entries).map((e) => [e.who, e.text]);
  await expect.poll(since, { timeout: 30_000 }).toEqual([["person", "a fresh start"], ["agent", "You said a fresh start"]]);
  expect(pieces.at(-1)!.session).toBe(`${first}-2`);
});

test("a community view that says it works on a phone is offered there with its files; opened, its host on the computer tells it it is on a phone and what the board holds; it does only what the phone may, as the phone; and closed, it ends", async () => {
  test.skip(!hiveNetBuilt() || !fs.existsSync(HIVE_PHONE), "build hive-net and hive-phone first: cargo build in crates/hive-net and crates/hive-phone");
  test.setTimeout(120_000);
  const env = probeAgent();
  scribeAgent();
  const d = await desktopWith(env);
  // Two views installed on the computer, as `hive views install` installs one: one says it works on
  // a phone, the other says nothing of it.
  const install = (id: string, manifest: object) => {
    const dir = path.join(root, "views", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "hivemind-view.json"), JSON.stringify({ id, version: "1.0.0", entry: "index.html", protocol: 1, ...manifest }));
    fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html><title>${id}</title><script type="module" src="./main.js"></script>`);
    fs.writeFileSync(path.join(dir, "main.js"), `import { connect } from "@hivemind/view-sdk";\nawait connect();\n`);
    const installed = spawnSync("bun", [CLI, "views", "install", dir, "--json"], { encoding: "utf8", env: { ...process.env, XDG_CONFIG_HOME: path.join(root, "desktop") } });
    expect(installed.status, installed.stdout + installed.stderr).toBe(0);
    return dir;
  };
  const board = install("priya-board", { name: "Priya's board", phone: true, permissions: ["workspace:spawn", "workspace:edit"] });
  install("desk-only", { name: "Desk only" });
  const { phone, phoneId } = await pairPhone(d);
  await d.desktop.keyboard.press("Escape");
  const probe = await startProbe(d);
  const phoneCli = async (...args: string[]) => JSON.parse((await run(HIVE_PHONE, [...args, "--identity", phone, "--json"], { timeout: 30_000 })).stdout) as unknown;
  let listed: Array<Record<string, unknown>> = [];
  await expect.poll(async () => (listed = ((await phoneCli("agents")) as { agents: typeof listed }).agents).length, { timeout: 30_000 }).toBe(1);
  const workspace = listed[0]!.workspace as string;

  // Offered on the phone: the view that says it works there, and its files, read from the computer.
  expect(await phoneCli("views", workspace)).toEqual([{ id: "priya-board", name: "Priya's board", version: "1.0.0", entry: "index.html" }]);
  expect(await phoneCli("views", workspace, "priya-board", "index.html")).toEqual({
    type: "text/html; charset=utf-8", data: fs.readFileSync(path.join(board, "index.html")).toString("base64"),
  });
  await expect(run(HIVE_PHONE, ["views", workspace, "priya-board", "../desk-only/index.html", "--identity", phone])).rejects.toThrow(/not inside priya-board/);
  await expect(run(HIVE_PHONE, ["views", workspace, "desk-only", "index.html", "--identity", phone])).rejects.toThrow(/no view desk-only here works on a phone/);

  // Opened: once it says it is ready, it is told it is on a phone, may start agents and not rename
  // tiles (a phone may not edit the board), and what the board holds.
  const shown = spawn(HIVE_PHONE, ["view", workspace, "priya-board", "--identity", phone, "--json"]);
  procs.push(shown);
  const told: Array<Record<string, unknown>> = [];
  let line = "";
  shown.stdout!.on("data", (b: Buffer) => {
    const lines = (line + b.toString()).split("\n");
    line = lines.pop()!;
    for (const l of lines) told.push(JSON.parse(l) as Record<string, unknown>);
  });
  const ended = new Promise<number | null>((r) => shown.on("exit", (code) => r(code)));
  const post = (message: object) => shown.stdin!.write(`${JSON.stringify(message)}\n`);
  const structures = () => told.filter((m) => m.type === "structure").map((m) => (m.tiles as Array<{ id: string }>).map((t) => t.id));
  post({ type: "ready", v: 1 });
  await expect.poll(structures, { timeout: 30_000 }).toEqual([[probe]]);
  expect(told[0]).toMatchObject({ type: "hello", pluginId: "priya-board", capabilities: ["workspace:spawn"], device: { touch: true, compact: true } });

  // What it may not do is refused: the rename never reaches the board. What it may, it does, as the
  // phone: the agent it starts appears, after the rename would have.
  post({ type: "command", name: "renameTile", args: [probe, "Priya's probe"] });
  post({ type: "command", name: "spawnAgent", args: ["scribe", null] });
  await expect.poll(() => structures().at(-1)?.length, { timeout: 30_000 }).toBe(2);
  const scribe = structures().at(-1)!.find((id) => id !== probe)!;
  expect(told.filter((m) => m.type === "names").map((m) => (m.names as Record<string, string>)[probe])).not.toContain("Priya's probe");
  const audit = () => fs.readFileSync(path.join(root, "desktop", "hivemind-dev", "audit.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  await expect.poll(audit, { timeout: 10_000 }).toContainEqual(expect.objectContaining({
    verb: "agent.start", target: scribe, detail: "view priya-board", outcome: "ok", actor: { kind: "peer", person: d.me.personId, device: phoneId, access: "owner" },
  }));

  // Closed at the end of what the phone sends: the computer says it is, and the view is gone.
  shown.stdin!.end();
  expect(await ended).toBe(0);
  expect(told.at(-1)).toEqual({ closed: true });
});

test("what an agent asks, its computer can allow or deny, and says so in the list and the notice; the phone denies it with the agent's own keys, and it is told no and asks again; allows it, and it works; the same answer again does nothing", async () => {
  test.skip(!hiveNetBuilt() || !fs.existsSync(HIVE_PHONE), "build hive-net and hive-phone first: cargo build in crates/hive-net and crates/hive-phone");
  test.setTimeout(120_000);
  const d = await desktopWith(probeAgent());
  const { phone } = await pairPhone(d);
  await d.desktop.keyboard.press("Escape");
  const told = listen(phone);
  await expect.poll(() => told[0], { timeout: 30_000 }).toMatchObject({ told: [os.hostname()] });
  const tile = await startProbe(d);
  const asked = async () => (await needsOf(phone)).needs[0] as Record<string, unknown> | undefined;
  let first: Record<string, unknown> | undefined;
  await expect.poll(async () => (first = await asked())?.kind, { timeout: 30_000 }).toBe("permission");
  expect(first).toMatchObject({ tile, decide: true });
  await expect.poll(() => told.slice(1), { timeout: 10_000 }).toEqual([expect.objectContaining({ t: "needs", tile, kind: "permission", since: first!.since, decide: true })]);

  const watching = spawn(HIVE_PHONE, ["watch", first!.workspace as string, tile, "--identity", phone]);
  procs.push(watching);
  let seen = "";
  watching.stdout!.on("data", (b: Buffer) => { seen += b.toString(); });
  await expect.poll(() => seen, { timeout: 20_000 }).toContain("Allow edit to Nav.tsx?");
  const decide = async (wait: Record<string, unknown>, decision: "--allow" | "--deny") =>
    JSON.parse((await run(HIVE_PHONE, ["answer", wait.workspace as string, tile, String(wait.since), decision, "--identity", phone, "--json"], { timeout: 30_000 })).stdout) as unknown;

  // Denied from the phone: the agent's keys for no go in, it is told no, and it asks again, anew.
  expect(await decide(first!, "--deny")).toEqual({ answered: true });
  await expect.poll(() => seen, { timeout: 20_000 }).toContain("probe was told no");
  let again: Record<string, unknown> | undefined;
  await expect.poll(async () => (again = await asked())?.since !== undefined && again!.since !== first!.since, { timeout: 30_000 }).toBe(true);
  expect(again).toMatchObject({ tile, kind: "permission", decide: true });
  expect(await decide(first!, "--allow")).toEqual({ answered: false });

  // Allowed from the phone: it works, nothing waits; allowed again, nothing happens.
  expect(await decide(again!, "--allow")).toEqual({ answered: true });
  await expect.poll(() => seen, { timeout: 20_000 }).toContain("probe is thinking");
  await expect.poll(async () => { const n = await needsOf(phone); return [n.needs.length, n.working]; }, { timeout: 30_000 }).toEqual([0, 1]);
  expect(await decide(again!, "--allow")).toEqual({ answered: false });
});

test("a computer away is shown with what it last said needed the person, and when; back, as it starts or wakes, it tells the phone, which shows it only after finding it away; unpaired from the phone while away, only the phone forgets it", async () => {
  test.skip(!hiveNetBuilt() || !fs.existsSync(HIVE_PHONE), "build hive-net and hive-phone first: cargo build in crates/hive-net and crates/hive-phone");
  test.setTimeout(180_000);
  const env = probeAgent();
  const d = await desktopWith(env);
  const { phone } = await pairPhone(d);
  await d.desktop.keyboard.press("Escape");
  const told = listen(phone);
  await expect.poll(() => told[0], { timeout: 30_000 }).toMatchObject({ told: [os.hostname()], away: [] });
  const backs = () => told.filter((t) => t.t === "back");
  const wake = () => apps.at(-1)!.evaluate(({ powerMonitor }) => { powerMonitor.emit("resume"); });
  const tile = await startProbe(d);
  let waiting: Record<string, unknown> | undefined;
  await expect.poll(async () => (waiting = (await needsOf(phone)).needs[0])?.tile, { timeout: 30_000 }).toBe(tile);
  const asked = Date.now();

  // The computer wakes, never found away: the phone shows nothing of it.
  await wake();
  await new Promise((r) => setTimeout(r, 3_000));
  expect(backs()).toEqual([]);

  // The computer goes away: what it said last is shown, and when.
  await closeApp(apps.pop()!);
  const away = await needsOf(phone);
  expect(away).toMatchObject({ needs: [], working: 0, away: [{ device: d.me.deviceId, name: os.hostname(), heard: { needs: [waiting], working: 0 } }] });
  expect(Math.abs((away.away[0]!.heard as { at: number }).at - asked)).toBeLessThan(15_000);

  // It starts again: on its network at once, for the phone paired with it, which it tells it is
  // back; the phone shows it, and finds it there.
  const started = Date.now();
  await person(root, "desktop", d.repo, apps, { HIVEMIND_PTY_DAEMON: "1", ...env });
  await expect.poll(backs, { timeout: 30_000 }).toEqual([{ v: 1, t: "back", device: d.me.deviceId, name: os.hostname(), since: expect.any(Number) }]);
  expect(backs()[0]!.since).toBeGreaterThanOrEqual(started);
  expect((await needsOf(phone)).away).toEqual([]);

  // Its network gone, as while it sleeps, the phone finds it away; it wakes, back on its network,
  // and the phone is told so.
  execSync(`pkill -f "hive-net[ ]daemon .*--identity ${root}/desktop/"`);
  await expect.poll(async () => (await needsOf(phone)).away.map((a) => a.device), { timeout: 30_000 }).toEqual([d.me.deviceId]);
  const woke = Date.now();
  await wake();
  await expect.poll(() => backs().length, { timeout: 30_000 }).toBe(2);
  expect(backs()[1]!.since).toBeGreaterThanOrEqual(woke);
  expect((await needsOf(phone)).away).toEqual([]);

  // Unpaired from the phone while away: the phone forgets it, and says the computer was not told.
  await closeApp(apps.pop()!);
  const unpaired = JSON.parse((await run(HIVE_PHONE, ["unpair", os.hostname(), "--identity", phone, "--json"], { timeout: 30_000 })).stdout) as unknown;
  expect(unpaired).toEqual({ device: d.me.deviceId, name: os.hostname(), told: false });
  expect(JSON.parse((await run(HIVE_PHONE, ["devices", "--identity", phone, "--json"])).stdout)).toEqual([]);
});

for (const [policy, admission] of [["closed", "vouched for by the app"], ["open-pow", "registered"]] as const) {
  test(`a phone pairing with a computer on a network gets onto it as the link says, takes that network and is let onto it (${policy}: ${admission}), and reaches the computer`, async () => {
    test.skip(!hiveNetBuilt() || !fs.existsSync(HIVE_PHONE), "build hive-net and hive-phone first: cargo build in crates/hive-net and crates/hive-phone");
    test.setTimeout(120_000);
    const net = await ownNetwork(root, procs, policy);
    const d = await desktopWith();
    expect(await d.desktop.evaluate((l) => window.hive.useNetwork(l), net.link)).toMatchObject({ admission: policy === "closed" ? "enrolled" : "registered" });
    const allowed = async (device: string) => (await fetch(`${net.access}/allowed/${device}`)).text();

    const { link, phone, paired, phoneId } = await pairPhone(d);
    expect(paired).toMatchObject({ network: "Example Corp", admission });
    // The link said how to get onto the network from elsewhere, and the phone did, as it paired:
    // with the voucher it carried on a closed network.
    const carried = parsePairLink(link)!.admission!;
    expect(carried).toMatchObject({ access: net.access, voucher: policy === "closed" ? expect.objectContaining({ kind: "visit", uses: 1, device: null }) : null });
    if (carried.voucher) {
      const kept = JSON.parse(fs.readFileSync(path.join(net.data, "access.json"), "utf8")) as { redeemed: Record<string, number> };
      expect(kept.redeemed[(carried.voucher as { nonce: string }).nonce]).toBe(1);
    }
    await expect.poll(() => allowed(phoneId)).toBe("true");
    const on = JSON.parse((await run(HIVE_PHONE, ["network", "--identity", phone, "--json"])).stdout) as { profile: { name: string; relays: Array<{ url: string }> } };
    expect([on.profile.name, on.profile.relays.map((r) => r.url)]).toEqual(["Example Corp", [net.relay]]);
    expect(await needsOf(phone)).toEqual({ needs: [], working: 0, away: [] });
  });
}

test("on a network with a push server, the phone registers there, naming the computer, and is told through it what waits on the person, which it allows from the notice alone; the server keeps nothing of what it passes on; unpaired, the computer is named no more", async () => {
  test.skip(!hiveNetBuilt() || !fs.existsSync(HIVE_PHONE), "build hive-net and hive-phone first: cargo build in crates/hive-net and crates/hive-phone");
  test.setTimeout(120_000);
  const net = await ownNetwork(root, procs, "closed");
  const d = await desktopWith(probeAgent());
  expect(await d.desktop.evaluate((l) => window.hive.useNetwork(l), net.link)).toMatchObject({ admission: "enrolled" });
  const { phone, phoneId } = await pairPhone(d);
  await d.desktop.keyboard.press("Escape");

  // The phone registers at the network's push server, which gives the computer its address there.
  const told = listen(phone);
  await expect.poll(() => told[0], { timeout: 30_000 }).toMatchObject({ via: net.push, told: [os.hostname()], away: [] });
  expect(told[0]!.endpoint).toMatch(new RegExp(`^${net.push}/[0-9a-f]{32}$`));
  const registrations = () => Object.values((JSON.parse(fs.readFileSync(path.join(net.data, "push.json"), "utf8")) as { phones: Record<string, Record<string, unknown>> }).phones);
  expect(registrations()).toEqual([expect.objectContaining({ device: phoneId, platform: "unifiedpush", senders: [d.me.deviceId] })]);

  // An agent on the computer begins waiting on the person: the computer posts it, signed, to the
  // push server, which passes it on to the phone, and the phone decrypts it.
  const tile = await startProbe(d);
  await expect.poll(() => told.slice(1), { timeout: 30_000 }).toEqual([expect.objectContaining({ v: 1, t: "needs", name: "api", tile, agent: "Editing Nav.tsx", kind: "permission" })]);
  // What the server keeps names no workspace, agent or wait.
  const kept = fs.readFileSync(path.join(net.data, "push.json"), "utf8");
  for (const secret of ["api", "Editing Nav.tsx", tile, "permission"]) expect(kept).not.toContain(secret);

  // Allowed from the notice alone, as its notification's Allow would be: the agent works again.
  const notice = told[1] as { workspace: string; tile: string; since: number; decide?: boolean };
  expect(notice.decide).toBe(true);
  const allowed = await run(HIVE_PHONE, ["answer", notice.workspace, notice.tile, String(notice.since), "--allow", "--identity", phone, "--json"], { timeout: 30_000 });
  expect(JSON.parse(allowed.stdout)).toEqual({ answered: true });
  await expect.poll(async () => { const n = await needsOf(phone); return [n.needs.length, n.working]; }, { timeout: 30_000 }).toEqual([0, 1]);

  // Unpaired from the phone: it registers again, and the computer is named no more.
  const unpaired = JSON.parse((await run(HIVE_PHONE, ["unpair", d.me.deviceId, "--identity", phone, "--json"], { timeout: 30_000 })).stdout) as unknown;
  expect(unpaired).toMatchObject({ device: d.me.deviceId, told: true });
  expect(registrations()).toEqual([expect.objectContaining({ device: phoneId, senders: [] })]);
});
