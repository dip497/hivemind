// An always-on host (R14), end to end on one machine: `hive host` (the built binary, with its own
// data folder, as on a server) serves a folder as a workspace; the app pairs with it from
// Settings → Devices, entering the six words `hive host pair` prints (the host found by them on
// this network) or its link; Open recent lists the workspace on the host and opens it; a shell
// started there runs on the host, in its folder, and goes on after the app has quit. And a frame
// of the app's own workspace runs on the host (M3): placed on one of the host's folders, its
// shells run in the host's daemon, and go on after the app has quit; and its files and git are the
// host's folder's, read there (M4). And a phone paired with the app is the person's at the host too
// (spec/pairing.md 0.7): the host lets it in, as a phone, and tells it what waits on the person
// there; unpaired on the app, the host forgets it.
import { test, expect, type ElectronApplication } from "@playwright/test";
import { execFile, execSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { HiveNet } from "@hivemind/workspace-host/hive-net";
import { heldWorkspaces } from "@hivemind/host/peer-links";
import { HIVE_NET, hiveNetBuilt, person, tiles } from "./helpers/multiplayer";

const HIVE = path.resolve("../cli/dist/hive");
const HIVE_PHONE = path.resolve("../../crates/hive-phone/target/debug/hive-phone");
const run = promisify(execFile);
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

test("a frame of the app's own workspace runs on the paired host: placed on one of its folders, a shell there runs in the host's daemon, on after the app quits, and a Diff tile there shows the host's folder's changes", async () => {
  test.skip(!hiveNetBuilt() || !hostable, "needs hive-net (cargo build in crates/hive-net) and a current apps/cli/dist/hive (cd apps/cli && bun scripts/build.ts)");
  test.setTimeout(120_000);
  const builds = path.join(root, "builds");
  fs.mkdirSync(builds);
  // A repository, with a change not yet committed.
  fs.writeFileSync(path.join(builds, "notes.md"), "one\n");
  execSync("git init -q && git add notes.md && git -c user.email=t@t -c user.name=T commit -q -m one", { cwd: builds });
  fs.writeFileSync(path.join(builds, "notes.md"), "one\ntwo\n");
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

  // Its files and git are the host's folder's: a Diff tile in it shows the change made there.
  const shown = await tiles(laptop);
  await laptop.evaluate((id) => window.dispatchEvent(new CustomEvent("hivemind:frame-open", { detail: { frameId: id, kind: "diff" } })), frameId);
  let diff = "";
  await expect.poll(async () => (diff = (await tiles(laptop)).find((t) => !shown.includes(t)) ?? ""), { timeout: 20_000 }).not.toBe("");
  await laptop.evaluate((id) => window.dispatchEvent(new CustomEvent("hivemind:focus-tile", { detail: id })), diff);
  await expect(laptop.locator(`.react-flow__node[data-id="${diff}"] [data-diff-file="notes.md"]`)).toHaveCount(1, { timeout: 30_000 });

  // A shell in it runs in the host's daemon, in the host's folder.
  const before = await tiles(laptop);
  await laptop.evaluate((id) => window.dispatchEvent(new CustomEvent("hivemind:frame-open", { detail: { frameId: id, kind: "shell" } })), frameId);
  let tile = "";
  await expect.poll(async () => (tile = (await tiles(laptop)).find((t) => !before.includes(t)) ?? ""), { timeout: 20_000 }).not.toBe("");
  const terminal = laptop.locator(`.react-flow__node-terminal[data-id="${tile}"]`);
  // Flown to and selected, as a notification does, which puts the keyboard in it (once the tile
  // has drawn as selected: keys typed before then are the board's).
  await expect.poll(async () => {
    await laptop.evaluate((id) => window.dispatchEvent(new CustomEvent("hivemind:focus-tile", { detail: id })), tile);
    return terminal.locator(".hm-node-selected").count();
  }, { timeout: 20_000, intervals: [500] }).toBe(1);
  await expect(terminal.locator("textarea.xterm-helper-textarea")).toBeFocused({ timeout: 10_000 });
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

test("a phone paired with the app is the person's at the host too: the host lets it in, as a phone, answers what waits on the person there and tells it when an agent there begins to; unpaired on the app, the host forgets it", async () => {
  test.skip(!hiveNetBuilt() || !hostable || !fs.existsSync(HIVE_PHONE), "needs hive-net and hive-phone (cargo build in crates/hive-net and crates/hive-phone) and a current apps/cli/dist/hive");
  test.setTimeout(180_000);
  // A stand-in agent the host runs, read from its screen: it asks to edit a file until answered.
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "probe-agent"), [
    "#!/bin/bash",
    "printf '\\033]0;Editing Nav.tsx\\007Allow edit to Nav.tsx? (y/n) '",
    "read -r answer",
    "exec sleep 600",
  ].join("\n"), { mode: 0o755 });
  // Its agents are in the host's data folder, where the host and `hive ctl` there look for them,
  // as on a machine whose app data is its config's.
  const agent = path.join(root, "server", "agents", "probe");
  fs.mkdirSync(agent, { recursive: true });
  fs.mkdirSync(path.join(root, "hostcfg"));
  fs.symlinkSync(path.join(root, "server"), path.join(root, "hostcfg", "hivemind"));
  fs.writeFileSync(path.join(agent, "agent.yaml"), [
    "manifestVersion: 2", "id: probe", "label: Probe", "bin: probe-agent", "enabled: true",
    "caps: { promptDelivery: typed, turnSignal: false, resume: none, supervise: human, blockedDetection: true }",
    "detect:", "  default: idle", "  rules:",
    "  - when: { contains: 'Allow edit to Nav.tsx?' }", "    then: permission", "",
  ].join("\n"));
  const onHost = { ...hostEnv(), XDG_CONFIG_HOME: path.join(root, "hostcfg"), PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, HIVE_HCP_SOCK: "", HCP_TOKEN: "", HIVEMIND_TILE: "" };
  const api = path.join(root, "api");
  fs.mkdirSync(api);
  const host = spawn(HIVE, ["host", "run"], { env: onHost, stdio: "ignore" });
  procs.push(host);
  await expect.poll(() => status()?.running ?? false, { timeout: 30_000 }).toBe(true);
  expect(hive("host", "add", api).status).toBe(0);

  // The laptop pairs with the host by its link.
  const elsewhere = path.join(root, "elsewhere");
  fs.mkdirSync(elsewhere);
  const laptop = await person(root, "laptop", elsewhere, apps, { HIVEMIND_PTY_DAEMON: "1" });
  const pairing = spawn(HIVE, ["host", "pair", "--json"], { env: onHost });
  procs.push(pairing);
  const printed = lines(pairing.stdout!);
  const offer = (JSON.parse(await printed()) as { data: { offer: { link: string } } }).data.offer;
  const devices = () => laptop.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: "devices" } })));
  await devices();
  await laptop.locator("[data-pair-link]").fill(offer.link);
  await laptop.locator("[data-pair-go]").click();
  await expect(laptop.locator('[data-pair-result="paired"]')).toBeVisible({ timeout: 20_000 });
  await laptop.keyboard.press("Escape");
  // The host starts again as the laptop's person.
  expect(JSON.parse(await printed())).toMatchObject({ ok: true, data: { paired: { kind: "app" } } });

  // A phone pairs with the laptop: Settings → Devices → Pair a phone.
  await devices();
  await laptop.locator("[data-pair-phone]").click();
  const link = (await laptop.locator("[data-pair-copy]").getAttribute("title"))!;
  const phone = path.join(root, "phone");
  await run(HIVE_PHONE, ["pair", link, "--identity", phone, "--name", "Priya's phone", "--json"], { timeout: 60_000 });
  const phoneId = (await run(HIVE_PHONE, ["id", "--identity", phone])).stdout.trim();
  await laptop.keyboard.press("Escape");

  // The host learns of it from the laptop, as a phone.
  await expect.poll(() => status()?.devices.map((d) => `${(d as { kind: string }).kind} ${(d as { device: string }).device}`).sort(), { timeout: 30_000 })
    .toEqual(["app " + (await laptop.evaluate(() => window.hive.identity())).deviceId, `phone ${phoneId}`].sort());
  const hostDevice = (JSON.parse(hive("host", "status", "--json").stdout) as { data: { device: string } }).data.device;

  // The phone learns of the host from the laptop, and gives both where it is told what happens.
  const pushed = spawn(HIVE_PHONE, ["push", "--listen", "127.0.0.1:0", "--identity", phone, "--json"]);
  procs.push(pushed);
  const told: Array<Record<string, unknown>> = [];
  let line = "";
  pushed.stdout!.on("data", (b: Buffer) => {
    const all = (line + b.toString()).split("\n");
    line = all.pop()!;
    for (const l of all) told.push(JSON.parse(l) as Record<string, unknown>);
  });
  await expect.poll(() => told[0], { timeout: 30_000 }).toMatchObject({ told: [os.hostname(), os.hostname()], away: [] });
  const known = JSON.parse((await run(HIVE_PHONE, ["devices", "--identity", phone, "--json"])).stdout) as Array<{ device: string; kind: string; via?: string[] }>;
  expect(known.find((d) => d.device === hostDevice)).toMatchObject({ kind: "host", via: [(await laptop.evaluate(() => window.hive.identity())).deviceId] });

  // An agent on the host begins waiting on the person: the phone lists it, on the host, and is
  // told so by the host.
  const ctl = { ...onHost, HIVE_HCP_SOCK: path.join(root, "server", "hcp-host.sock"), HCP_TOKEN: read(path.join(root, "server", "hcp.token")) };
  const spawned = spawnSync(HIVE, ["ctl", "spawn", "--agent", "probe", "--name", "nav", "--json"], { env: ctl, encoding: "utf8", timeout: 60_000 });
  expect(spawned.status, spawned.stdout + spawned.stderr).toBe(0);
  const needs = async () => JSON.parse((await run(HIVE_PHONE, ["needs", "--identity", phone, "--json"], { timeout: 30_000 })).stdout) as { needs: Array<Record<string, unknown>>; away: unknown[] };
  let waiting: Record<string, unknown> | undefined;
  await expect.poll(async () => (waiting = (await needs()).needs[0])?.kind, { timeout: 40_000 }).toBe("permission");
  expect(waiting).toMatchObject({ name: "api", agent: "nav", machine: os.hostname() });
  await expect.poll(() => told.slice(1), { timeout: 20_000 }).toContainEqual(expect.objectContaining({ t: "needs", workspace: waiting!.workspace, tile: waiting!.tile }));

  // As a phone: what it sends to start a terminal on the host starts nothing.
  const at = known.find((d) => d.device === hostDevice) as unknown as { addrs: string[]; relay: string | null };
  const net = await HiveNet.start({ bin: HIVE_NET, identity: phone, socket: path.join(root, "phone-net.sock"), onIncoming: (l) => l.close(), onPairRequest: async () => ({ ok: false }) });
  try {
    const conn = await net.dial(hostDevice, { addrs: at.addrs, relay: at.relay });
    const ran = path.join(root, "ran");
    conn.send("pty", `${JSON.stringify({ t: "attach", reqId: "p1", id: "hm:from-phone", spec: { cwd: api, cmd: "/bin/sh", args: ["-c", `touch ${ran}`], cols: 80, rows: 24 } })}\n`);
    expect((await heldWorkspaces(conn)).map((w) => w.repo)).toContain(api);
    await new Promise((r) => setTimeout(r, 1_500));
    expect(fs.existsSync(ran)).toBe(false);
  } finally {
    net.stop();
  }

  // Unpaired on the laptop: the host forgets it.
  await devices();
  await laptop.locator(`[data-device="${phoneId}"] [data-unpair]`).click();
  await expect.poll(() => status()?.devices.map((d) => (d as { kind: string }).kind), { timeout: 30_000 }).toEqual(["app"]);
});
