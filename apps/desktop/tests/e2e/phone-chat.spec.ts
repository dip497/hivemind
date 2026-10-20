// Messages sent from the phone page's chat (crates/hive-web/www/app/agent.ts). One sent while its
// agent works: Claude Code takes a line typed mid-turn into the turn that runs and records it, not
// as a prompt of the person's, but as a queued_command attachment; the page shows it at once, and
// keeps showing it once the session file has it. One held for an agent that reads none mid-turn
// shows as queued and goes when its turn ends. Photos picked go with a message, kept on the
// computer, and the agent is given their paths. The agent is the scripted stand-in
// (fixtures/fake-agent.cjs) behind the real claude manifest and hooks, on a network of its own whose
// server serves the page.
import { test, expect, chromium, type Browser, type ElectronApplication } from "@playwright/test";
import { execSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedAgents } from "./helpers/agents";
import { hiveNetBuilt, ownNetwork, person } from "./helpers/multiplayer";
import { connectPage, offerToConnect } from "./helpers/phone";
import { stopDaemons } from "./helpers/daemons";

const WWW = path.resolve("../../crates/hive-web/www");
const hiveWebBuilt = () => fs.existsSync(path.join(WWW, "pkg", "hive_web_bg.wasm")) && fs.existsSync(path.join(WWW, "main.js"));
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-agent.cjs");

let root: string;
let browser: Browser | undefined;
const apps: ElectronApplication[] = [];
const procs: ChildProcess[] = [];
test.beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync("/tmp/hm-midturn-")); });
test.afterEach(async () => {
  await browser?.close();
  browser = undefined;
  for (const p of procs.splice(0)) p.kill("SIGKILL");
  for (const a of apps.splice(0)) await a.close();
  stopDaemons(root);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** Claude Code's stand-in on the person's computer, its phone page paired and showing its chat.
 *  `steers`: it takes a line typed mid-turn into that turn, as its manifest says; else its manifest
 *  says nothing of it, as an agent's that reads one only at its prompt. */
async function chatWith(steers: boolean) {
  const net = await ownNetwork(root, procs, "closed", WWW);
  const repo = path.join(root, "api");
  fs.mkdirSync(repo);
  execSync("git init -q", { cwd: repo });
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  for (const d of [home, bin]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(bin, "claude"), `#!/usr/bin/env bash\nexport FAKE_PROMPT="❯ "\n${steers ? "FAKE_STEER=1 " : ""}exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FIXTURE)} claude "$@"\n`, { mode: 0o755 });
  seedAgents(path.join(root, "desktop"), ["claude"]);
  if (!steers) {
    const manifest = path.join(root, "desktop", "hivemind", "agents", "claude", "agent.yaml");
    fs.writeFileSync(manifest, fs.readFileSync(manifest, "utf8").replace(/^steer: true\n/m, ""));
  }
  const desktop = await person(root, "desktop", repo, apps, { HOME: home, PATH: `${bin}:${process.env.PATH}`, HIVEMIND_SHELL_ENV: "0" });
  expect(await desktop.evaluate((l) => window.hive.useNetwork(l), net.link)).toMatchObject({ admission: "enrolled" });
  const me = await desktop.evaluate(() => window.hive.identity());

  const link = await offerToConnect(desktop, true);
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.goto(link);
  await connectPage(page, desktop);
  await expect(page.locator("[data-paired]")).toHaveAttribute("data-paired", me.deviceId, { timeout: 30_000 });
  await desktop.keyboard.press("Escape");

  await desktop.evaluate(() => window.hive.settingsSet("agents.defaultAgent", "claude"));
  await desktop.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:shortcut", { detail: "agent" })));
  const terminal = desktop.locator(".react-flow__node-terminal");
  await expect(terminal).toHaveCount(1, { timeout: 20_000 });
  const tile = (await terminal.getAttribute("data-id"))!;
  await expect(page.locator(`[data-agent="${tile}"]`)).toBeVisible({ timeout: 30_000 });
  await page.locator(`[data-agent="${tile}"]`).click();
  const box = page.locator("[data-message] textarea");
  const send = async (text: string) => {
    await box.fill(text);
    await page.locator("[data-message] button[type=submit]").click();
  };
  const transcripts = path.join(home, ".claude", "projects");
  const recorded = () => fs.readdirSync(transcripts, { recursive: true }).filter((f) => String(f).endsWith(".jsonl")).map((f) => fs.readFileSync(path.join(transcripts, String(f)), "utf8")).join("");
  return { page, box, send, recorded, home, person: page.locator('[data-chat] [data-who="person"]'), agent: page.locator('[data-chat] [data-who="agent"]') };
}

test("a message sent from the phone while Claude Code works shows in its chat at once, as the person's, and stays there once Claude Code takes it into the running turn", async ({}, testInfo) => {
  test.skip(!hiveNetBuilt() || !hiveWebBuilt(), "build hive-net (cargo build in crates/hive-net) and the page (crates/hive-web/build.sh) first");
  test.setTimeout(240_000);
  const { page, box, send, recorded, person: said, agent } = await chatWith(true);
  const first = "sleep 10; echo first done";
  await send(first);
  await expect(said).toHaveText([first], { timeout: 30_000 });
  await expect(page.locator("[data-working-line]")).toBeVisible({ timeout: 30_000 });

  // While it works: sent, the box empties and the chat shows it at once.
  await send("also check the logout page");
  await expect(box).toHaveValue("", { timeout: 5_000 });
  await expect(said).toHaveText([first, "also check the logout page"], { timeout: 3_000 });
  await page.screenshot({ path: testInfo.outputPath("sent-mid-turn.png") });

  // Claude Code took it into the running turn, and recorded it as it records one.
  await expect.poll(recorded, { timeout: 30_000 }).toContain('"type":"queued_command","prompt":"also check the logout page"');
  await expect(agent.last()).toContainText("heard while working: also check the logout page", { timeout: 30_000 });
  // Once the session file has it, the chat still shows it, once, where it was sent.
  await expect(said).toHaveText([first, "also check the logout page"]);
  await expect(page.locator("[data-chat] [data-pending]")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("after-turn.png") });
});

test("messages sent from the phone while an agent that reads only at its prompt works show as queued at once, and go when its turn ends, in order, each a turn", async ({}, testInfo) => {
  test.skip(!hiveNetBuilt() || !hiveWebBuilt(), "build hive-net (cargo build in crates/hive-net) and the page (crates/hive-web/build.sh) first");
  test.setTimeout(240_000);
  const { page, box, send, recorded, person: said, agent } = await chatWith(false);
  const first = "sleep 8; echo first done";
  await send(first);
  await expect(page.locator("[data-working-line]")).toBeVisible({ timeout: 30_000 });

  await send("echo second");
  await expect(box).toHaveValue("", { timeout: 5_000 });
  await send("echo third");
  const held = page.locator('[data-chat] [data-pending="held"]');
  await expect(held).toHaveCount(2, { timeout: 3_000 });
  await expect(held.locator('[data-who="person"]')).toHaveText(["echo second", "echo third"]);
  await expect(held.first().locator("[data-pending-state]")).toContainText("Queued · sends when it finishes");
  await expect(held.first().locator("[data-send-now]")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("queued.png") });

  // Its turn over, each goes as a turn of its own, in the order sent.
  await expect(agent).toHaveText(["first done", "second", "third"], { timeout: 60_000 });
  await expect(said).toHaveText([first, "echo second", "echo third"]);
  await expect(page.locator("[data-chat] [data-pending]")).toHaveCount(0);
  const prompts = recorded().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string; message?: { content: unknown } }).filter((r) => r.type === "user").map((r) => r.message!.content);
  expect(prompts).toEqual([first, "echo second", "echo third"]);
  await page.screenshot({ path: testInfo.outputPath("queued-sent.png") });
});

test("photos picked on the phone go with a message: shown before it is sent, one removed stays behind, and the agent is given the path of each, kept on the computer outside the project, bytes intact", async ({}, testInfo) => {
  test.skip(!hiveNetBuilt() || !hiveWebBuilt(), "build hive-net (cargo build in crates/hive-net) and the page (crates/hive-web/build.sh) first");
  test.setTimeout(240_000);
  const { page, box, recorded } = await chatWith(true);
  // Screenshots, as a phone's camera roll holds them: PNGs drawn by the browser.
  const drawn = async (color: string) => Buffer.from(await page.evaluate(async (c) => {
    const canvas = Object.assign(document.createElement("canvas"), { width: 240, height: 160 });
    const g = canvas.getContext("2d")!;
    g.fillStyle = c;
    g.fillRect(0, 0, 240, 160);
    g.fillStyle = "#fff";
    g.font = "28px sans-serif";
    g.fillText("Log in", 70, 90);
    const blob = await new Promise<Blob>((done) => canvas.toBlob((b) => done(b!), "image/png"));
    return [...new Uint8Array(await blob.arrayBuffer())];
  }, color));
  const photo = await drawn("#d9480f");
  const other = await drawn("#1971c2");
  await page.locator("[data-photo-picker]").setInputFiles([
    { name: "login.png", mimeType: "image/png", buffer: photo },
    { name: "again.png", mimeType: "image/png", buffer: other },
  ]);
  const thumbs = page.locator("[data-message] [data-photo]");
  await expect(thumbs).toHaveCount(2);
  // Drawn, as the page's policy lets it draw an image.
  await expect.poll(() => thumbs.locator("img").evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).naturalWidth))).toEqual([240, 240]);
  await page.screenshot({ path: testInfo.outputPath("attach-picked.png") });
  await thumbs.nth(1).locator("[data-photo-remove]").click();
  await expect(thumbs).toHaveCount(1);
  await box.fill("echo what is wrong here");
  await page.locator("[data-message] button[type=submit]").click();
  await expect(box).toHaveValue("", { timeout: 10_000 });
  await expect(thumbs).toHaveCount(0);
  await expect(page.locator("[data-chat] [data-pending-photos] img")).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("attach-sent.png") });

  // The agent was given the words, then the photo's path, as a person drags a file into its
  // terminal: one prompt, pasted whole.
  const prompts = () => recorded().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string; message?: { content: unknown } })
    .filter((r) => r.type === "user" && typeof r.message?.content === "string").map((r) => r.message!.content as string);
  await expect.poll(prompts, { timeout: 30_000 }).toHaveLength(1);
  const [given] = prompts();
  expect(given).toMatch(/^echo what is wrong here\s+\/\S+\.png$/);
  const kept = given!.split(/\s+/).at(-1)!;
  expect(path.isAbsolute(kept)).toBe(true);
  expect(fs.readFileSync(kept)).toEqual(photo);
  expect(kept.startsWith(path.join(root, "desktop", "hivemind-dev", "photos") + path.sep)).toBe(true);
  expect(fs.statSync(kept).mode & 0o777).toBe(0o600);
  await expect(page.locator('[data-chat] [data-who="person"]')).toHaveText([given!], { timeout: 30_000 });
  await expect(page.locator("[data-chat] [data-pending]")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("attach-delivered.png") });
});
