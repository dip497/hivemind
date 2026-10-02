// The phone apps against a real computer (docs/design/phone-app-2026-10-02.md §7): the Android app
// on an emulator, or the iOS app on a simulator, pairs with the desktop app by the link its Settings
// → Devices → Pair a phone shows, and drives an agent there. This is the computer's side, once for
// both platforms: the desktop with the workspace `api` and a stand-in agent asked something at the
// computer; the link; the platform's own UI test, run with the link and told what to find there
// (apps/android/maestro/computer, or HivePhoneUITests/ComputerUITests); and what the computer shows
// once the phone is done: the phone among the person's devices, and its message heard by the agent,
// once. The phone workflows run it once an emulator or a simulator is up: phone-android.yml with
// PHONE_APP=android (the app installed, Maestro on the PATH), phone-ios.yml with PHONE_APP=ios,
// PHONE_SIMULATOR and PHONE_DERIVED_DATA (where the app and its UI tests were built for testing).
// Skipped without PHONE_APP.
import { test, expect, type ElectronApplication, type TestInfo } from "@playwright/test";
import { execSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hiveNetBuilt, person } from "./helpers/multiplayer";
import { offerPhonePairing, talkerAgent } from "./helpers/phone";

const platform = process.env.PHONE_APP === "android" || process.env.PHONE_APP === "ios" ? process.env.PHONE_APP : null;

/** What the phone's UI test is told: the link, and what it should find and say there. The same
 *  names on both platforms: Maestro takes each as `-e NAME=…`, the XCUITest as xcodebuild hands its
 *  runner each `TEST_RUNNER_NAME` it is given. */
type Told = Record<"PAIR_LINK" | "PAIR_PERSON" | "PAIR_COMPUTER" | "PAIR_AGENT" | "PAIR_LINE" | "PAIR_SAID" | "PAIR_MESSAGE" | "PAIR_ANSWER" | "PAIR_HEARD", string>;

let root: string | undefined;
const apps: ElectronApplication[] = [];
/** The phone's UI test while it runs: stopped with the test. */
let phone: ChildProcess | undefined;
/** This test's terminal daemons, stopped: an app closing waits on them. */
const reap = () => { try { execSync(`pkill -f "out/main/pty-daemon.js ${root}/"`, { stdio: "ignore" }); } catch { /* none */ } };
test.afterEach(async ({}, testInfo) => {
  phone?.kill("SIGKILL");
  phone = undefined;
  const failed = testInfo.status !== testInfo.expectedStatus;
  for (const a of apps.splice(0)) {
    if (failed) {
      await a.context().tracing.stop({ path: testInfo.outputPath("trace.zip") }).catch(() => undefined);
      await (await a.firstWindow()).screenshot({ path: testInfo.outputPath("desktop.png") }).catch(() => undefined);
    }
    reap();
    const gone = await Promise.race([a.close().then(() => true, () => true), new Promise<boolean>((r) => setTimeout(() => r(false), 15_000))]);
    if (!gone) a.process().kill("SIGKILL");
  }
  if (!root) return;
  reap();
  try { execSync(`pkill -KILL -f -- "--user-data-dir=${root}/"`, { stdio: "ignore" }); } catch { /* none */ }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  root = undefined;
});

/** Who said what in the conversations the talker kept under `home`, in the order it wrote them. */
function said(home: string): Array<[string, string]> {
  const dir = path.join(home, "talk");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").split("\n")).flatMap((line): Array<[string, string]> => {
    try {
      const r = JSON.parse(line) as { type: string; message: { content: string | Array<{ text: string }> } };
      return [r.type === "user" ? ["person", r.message.content as string] : ["agent", (r.message.content as Array<{ text: string }>)[0]!.text]];
    } catch {
      return []; // a line not written whole yet
    }
  });
}

/** The phone's own UI test, told `told`: the Maestro flow on the emulator, or the XCUITest on the
 *  simulator, with a phone paired with nothing. What it printed goes to `phone.log` beside its
 *  report under the test's output; how it ended, and the last of what it printed. */
async function runPhoneTest(on: "android" | "ios", told: Told, testInfo: TestInfo): Promise<{ code: number | null; tail: string }> {
  const out = testInfo.outputPath(on);
  fs.mkdirSync(out, { recursive: true });
  let p: ChildProcess;
  if (on === "android") {
    p = spawn("maestro", [
      "test", ...Object.entries(told).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
      "--format", "junit", "--output", path.join(out, "report.xml"), "--debug-output", path.join(out, "debug"), "--flatten-debug-output",
      path.resolve("../android/maestro/computer/agent.yaml"),
    ], { env: { ...process.env, MAESTRO_CLI_NO_ANALYTICS: "1" } });
  } else {
    const simulator = process.env.PHONE_SIMULATOR!;
    // Booted, and without the app: what an earlier run kept goes with it.
    spawnSync("xcrun", ["simctl", "bootstatus", simulator, "-b"], { stdio: "ignore", timeout: 300_000 });
    spawnSync("xcrun", ["simctl", "uninstall", simulator, "com.hivemind.phone"], { stdio: "ignore" });
    p = spawn("xcodebuild", [
      "test-without-building", "-project", path.resolve("../ios/HivePhone.xcodeproj"), "-scheme", "HivePhone",
      "-destination", `platform=iOS Simulator,id=${simulator}`, "-derivedDataPath", process.env.PHONE_DERIVED_DATA!,
      "-resultBundlePath", path.join(out, "HivePhone.xcresult"), "-only-testing:HivePhoneUITests/ComputerUITests", "CODE_SIGNING_ALLOWED=NO",
    ], { env: { ...process.env, ...Object.fromEntries(Object.entries(told).map(([name, value]) => [`TEST_RUNNER_${name}`, value])) } });
  }
  phone = p;
  const log = fs.createWriteStream(path.join(out, "phone.log"));
  let tail = "";
  const keep = (b: Buffer) => { log.write(b); tail = (tail + b.toString()).slice(-6_000); };
  p.stdout!.on("data", keep);
  p.stderr!.on("data", keep);
  const code = await new Promise<number | null>((resolve) => {
    p.on("error", (e) => { tail += `\n${String(e)}`; resolve(null); });
    p.on("close", resolve);
  });
  log.end();
  phone = undefined;
  return { code, tail };
}

test("the phone app pairs with the computer by the link it shows, finds it and its agent, reads the agent's terminal and what it and the person said, and sends it a message from the reply box, which the agent hears once and answers; the computer lists the phone among the person's devices", async ({}, testInfo) => {
  test.skip(!platform, "the phone apps against the desktop: PHONE_APP=android|ios, with an emulator or a simulator up (phone-android.yml, phone-ios.yml)");
  expect(hiveNetBuilt(), "hive-net built: cargo build in crates/hive-net").toBe(true);
  if (platform === "ios") expect([process.env.PHONE_SIMULATOR, process.env.PHONE_DERIVED_DATA], "PHONE_SIMULATOR and PHONE_DERIVED_DATA").not.toContain(undefined);
  test.setTimeout(20 * 60_000);
  root = fs.mkdtempSync("/tmp/hm-phone-app-");

  // The person's computer, Priya's: the workspace `api`, its terminals in a daemon as outside tests
  // (a phone watches them there), and the talker on its board, its conversation kept under `home`.
  const repo = path.join(root, "api");
  fs.mkdirSync(repo);
  execSync("git init -q", { cwd: repo });
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const env = talkerAgent(root);
  // Its own data under `root` on every platform (on Linux XDG_CONFIG_HOME puts it there already); on
  // a Mac, Chromium's own keys kept off the runner's keychain, which nothing here should ask about.
  const args = [`--user-data-dir=${path.join(root, "desktop", "hivemind-dev")}`, ...(process.platform === "darwin" ? ["--use-mock-keychain"] : [])];
  const desktop = await person(root, "desktop", repo, apps, { HIVEMIND_PTY_DAEMON: "1", HOME: home, ...env }, args);
  const app = apps[0]!;
  await app.context().tracing.start({ screenshots: true, snapshots: true });
  const log = fs.createWriteStream(testInfo.outputPath("desktop.log"));
  app.process().stdout?.pipe(log, { end: false });
  app.process().stderr?.pipe(log, { end: false });
  await desktop.evaluate(() => window.hive.settingsSet("profile.name", "Priya"));
  await desktop.evaluate(() => window.hive.settingsSet("agents.defaultAgent", "talker"));
  await desktop.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:shortcut", { detail: "agent" })));
  const terminal = desktop.locator(".react-flow__node-terminal");
  await expect(terminal).toHaveCount(1, { timeout: 20_000 });
  const tile = (await terminal.getAttribute("data-id"))!;

  // Asked something at the computer: typed into its terminal (again while it is not up yet), the
  // talker hears it, says so on its screen and answers in its conversation.
  await expect.poll(async () => {
    if (said(home).length === 0) await desktop.evaluate((t) => window.hive.ptyWrite(t, "fix the nav\r"), `hm:${tile}`);
    return said(home);
  }, { timeout: 30_000, intervals: [2_000] }).toEqual(expect.arrayContaining([["person", "fix the nav"], ["agent", "You said fix the nav"]]));

  // Pair a phone: the link, and the phone's own UI test with it, told what it should find there.
  const told: Told = {
    PAIR_LINK: await offerPhonePairing(desktop),
    PAIR_PERSON: "Priya",
    PAIR_COMPUTER: os.hostname(),
    PAIR_AGENT: "Talker #1",
    PAIR_LINE: "heard: fix the nav",
    PAIR_SAID: "You said fix the nav",
    PAIR_MESSAGE: "Priya says ship it",
    PAIR_ANSWER: "You said Priya says ship it",
    PAIR_HEARD: "heard: Priya says ship it",
  };
  const ran = await runPhoneTest(platform!, told, testInfo);
  expect(ran.code, `the phone's UI test (its output: ${testInfo.outputPath(platform!)}):\n${ran.tail}`).toBe(0);

  // The computer lists the phone among the person's devices, as a phone.
  await desktop.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: "devices" } })));
  await expect(desktop.locator('[data-devices] [data-device-kind="phone"]')).toHaveCount(1, { timeout: 30_000 });
  // What the phone sent is what the agent heard, as the person's, once; and it answered.
  await expect.poll(() => said(home), { timeout: 30_000 }).toContainEqual(["agent", told.PAIR_ANSWER]);
  expect(said(home).filter(([who, text]) => who === "person" && text === told.PAIR_MESSAGE)).toHaveLength(1);
});
