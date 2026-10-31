// Messages sent from the phone page's chat (crates/hive-web/www/app/agent.ts). One sent while its
// agent works: Claude Code takes a line typed mid-turn into the turn that runs and records it, not
// as a prompt of the person's, but as a queued_command attachment; the page shows it at once, and
// keeps showing it once the session file has it. One held for an agent that reads none mid-turn
// shows as queued and goes when its turn ends. Photos picked go with a message, kept on the
// computer, and the agent is given their paths. What the agent's own program writes into its session
// file shows as quiet lines, not as the person's. The agent is the scripted stand-in
// (fixtures/fake-agent.cjs) behind the real claude manifest and hooks, on a network of its own whose
// server serves the page.
import { test, expect, chromium, type Browser, type ElectronApplication, type Page } from "@playwright/test";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { addComment } from "@hivemind/core/review";
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
async function chatWith(steers: boolean, marks = false) {
  const net = await ownNetwork(root, procs, "closed", WWW);
  const repo = path.join(root, "api");
  fs.mkdirSync(repo);
  execSync("git init -q", { cwd: repo });
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  for (const d of [home, bin]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(bin, "claude"), `#!/usr/bin/env bash\nexport FAKE_PROMPT="❯ "\n${steers ? "FAKE_STEER=1 " : ""}${marks ? "FAKE_PHOTO_MARKS=1 " : ""}exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FIXTURE)} claude "$@"\n`, { mode: 0o755 });
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
  const sessionFile = () => path.join(transcripts, String(fs.readdirSync(transcripts, { recursive: true }).find((f) => String(f).endsWith(".jsonl"))));
  const prompts = () => recorded().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string; message?: { content: unknown } })
    .filter((r) => r.type === "user" && typeof r.message?.content === "string").map((r) => r.message!.content as string);
  return { desktop, page, box, send, recorded, prompts, sessionFile, tile, home, person: page.locator('[data-chat] [data-who="person"]'), agent: page.locator('[data-chat] [data-who="agent"]') };
}

/** Photos as a phone's camera takes them: a `width` by `height` picture of noise, a PNG, far past
 *  what the page keeps as it is. */
const cameraPhotos = (page: Page, count: number, width = 1600, height = 1200) => page.evaluate(async ([count, width, height]) => {
  const shots: number[][] = [];
  for (let n = 0; n < count; n++) {
    const canvas = Object.assign(document.createElement("canvas"), { width, height });
    const g = canvas.getContext("2d")!;
    const noise = g.createImageData(width, height);
    for (let i = 0; i < noise.data.length; i += 4) {
      const v = Math.random() * 255;
      [noise.data[i], noise.data[i + 1], noise.data[i + 2], noise.data[i + 3]] = [v, 255 - v, (v * n) % 255, 255];
    }
    g.putImageData(noise, 0, 0);
    const blob = await new Promise<Blob>((done) => canvas.toBlob((b) => done(b!), "image/png"));
    shots.push([...new Uint8Array(await blob.arrayBuffer())]);
  }
  return shots;
}, [count, width, height]).then((shots) => shots.map((bytes, n) => ({ name: `camera-${n}.png`, mimeType: "image/png", buffer: Buffer.from(bytes) })));

test("a question on a Browser tile reaches the phone over the network, and the phone's answer ends it", async () => {
  test.skip(!hiveNetBuilt() || !hiveWebBuilt(), "build hive-net (cargo build in crates/hive-net) and the page (crates/hive-web/build.sh)");
  test.setTimeout(240_000);
  const { desktop, page } = await chatWith(true);
  await desktop.evaluate(() => window.hive.settingsSet("plugins.state.tool:@hivemind/web", { enabled: true }));
  const frame = (await desktop.locator(".react-flow__node-frame").last().getAttribute("data-id"))!;
  await desktop.evaluate((f) => window.dispatchEvent(new CustomEvent("hivemind:frame-open", { detail: { frameId: f, kind: "browser" } })), frame);
  await expect(desktop.locator(".react-flow__node-browser")).toHaveCount(1, { timeout: 20_000 });
  const browserTile = (await desktop.locator(".react-flow__node-browser").getAttribute("data-id"))!;
  await expect.poll(() => desktop.evaluate(async (id) => {
    try { await window.hive.browserCdp!(id, "Runtime.evaluate", { expression: "1" }); return true; } catch { return false; }
  }, browserTile), { timeout: 25_000 }).toBe(true);

  const data = await apps[apps.length - 1]!.evaluate(({ app }) => app.getPath("userData"));
  const asked = new Promise<{ code: number | null; out: string }>((resolve) => {
    const c = spawn("bun", [path.resolve("../cli/src/index.ts"), "ctl", "browser", "ask", "Please sign in", "--tile", browserTile, "--json"],
      { env: { ...process.env, HIVEMIND_APP_DATA: data, HIVEMIND_TILE: "", HCP_TOKEN: "", HIVE_HCP_SOCK: "", HIVE_DRIVE_SOCK: "" }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    c.on("close", (code) => resolve({ code, out }));
  });
  const card = page.locator("[data-browser-asks]");
  await expect(card).toContainText("Please sign in", { timeout: 20_000 });
  await card.locator('[data-browser-ask-answer="done"]').click();
  const r = await asked;
  expect(r.out).toContain('"outcome":"done"');
  expect(r.code).toBe(0);
  await expect(card).toBeHidden({ timeout: 10_000 });

  // The notes on pages there, over the same network: listed, and one marked done.
  const reviews = path.join(root, "api", ".hivemind");
  fs.mkdirSync(reviews, { recursive: true });
  await addComment(reviews, { id: "c-phone", body: "bigger on phones", author: "you", page: { url: "http://x/", viewport: { width: 1, height: 1 }, elements: [{ name: 'button "Go"', selector: "#go", box: { x: 0, y: 0, width: 1, height: 1 } }] } });
  await page.locator("[data-more]").click();
  await page.locator("[data-open-notes]").click();
  await expect(page.locator('[data-page-notes] [data-note="c-phone"]')).toContainText("bigger on phones", { timeout: 20_000 });
});

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

test("a photo the agent attaches is shown with the message it went with, once: the agent's mark for it is not shown as words", async ({}, testInfo) => {
  test.skip(!hiveNetBuilt() || !hiveWebBuilt(), "build hive-net (cargo build in crates/hive-net) and the page (crates/hive-web/build.sh) first");
  test.setTimeout(240_000);
  const { page, box, person } = await chatWith(false, true);
  const png = Buffer.from(await page.evaluate(async () => {
    const canvas = Object.assign(document.createElement("canvas"), { width: 120, height: 80 });
    canvas.getContext("2d")!.fillRect(0, 0, 120, 80);
    const blob = await new Promise<Blob>((done) => canvas.toBlob((b) => done(b!), "image/png"));
    return [...new Uint8Array(await blob.arrayBuffer())];
  }));
  await page.locator("[data-photo-picker]").setInputFiles([{ name: "shot.png", mimeType: "image/png", buffer: png }]);
  await box.fill("echo fix this");
  await page.locator("[data-message] button[type=submit]").click();
  await expect(page.locator("[data-chat] [data-pending]")).toHaveCount(0, { timeout: 30_000 });
  await expect(person).toHaveText(["echo fix this"]);
  await expect(person.locator(".photos img")).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("photo-delivered.png") });
});

/** A record the agent's own program writes, as Claude Code's session file holds one, its text invented. */
const written = (id: string, content: unknown, more: object = {}) => `${JSON.stringify({ type: "user", uuid: id, timestamp: new Date().toISOString(), message: { role: "user", content }, ...more })}\n`;
const notification = (summary: string, more = "") => `<task-notification>\n<task-id>af46</task-id>\n<output-file>/tmp/invented/tasks/af46.output</output-file>\n<status>completed</status>\n<summary>${summary}</summary>\n${more}<usage><total_tokens>1234</total_tokens></usage>\n</task-notification>`;
const fromProgram = { origin: { kind: "task-notification" } };

test("what the agent's own program writes shows as quiet lines, never as the person's: a run of them is one line with a count that opens to each, a helper's report only when opened; the person's own words about one stay theirs", async ({}, testInfo) => {
  test.skip(!hiveNetBuilt() || !hiveWebBuilt(), "build hive-net (cargo build in crates/hive-net) and the page (crates/hive-web/build.sh) first");
  test.setTimeout(240_000);
  const { page, send, sessionFile, person: said, agent } = await chatWith(true);
  await send("echo ready");
  await expect(agent).toHaveText(["ready"], { timeout: 30_000 });

  fs.appendFileSync(sessionFile(), [
    ...["Build the site", "Run the unit tests", "Lint"].map((what, n) => written(`b${n}`, notification(`Background command "${what}" completed (exit code 0)`), fromProgram)),
    written("w0", notification('Agent "Tidy the docs" is waiting on its own background work', "<note>Still running.</note>\n<result>This agent has not reported yet.</result>\n"), fromProgram),
    written("f0", notification('Agent "Tidy the docs" finished', "<result>Tidied **three** pages.</result>\n"), fromProgram),
    written("mine", "why does <task-notification> show on my phone?", { origin: { kind: "human" } }),
    written("w1", notification('Agent "Check the links" is waiting on its own background work'), fromProgram),
    written("w2", notification('Agent "Check the sizes" is waiting on its own background work'), fromProgram),
    written("mine2", "and what about this one?", { origin: { kind: "human" } }),
    written("alone", notification('Background command "Deploy" failed with exit code 2'), fromProgram),
  ].join(""));

  // The person's words stay theirs, and nothing else is shown as theirs.
  await expect(said).toHaveText(["echo ready", "why does <task-notification> show on my phone?", "and what about this one?"], { timeout: 30_000 });
  const chat = page.locator("[data-chat]");
  for (const raw of ["af46", "/tmp/invented", "total_tokens", "<summary>", "<result>"]) await expect(chat).not.toContainText(raw);

  // One that stands alone says itself.
  await expect(page.locator('[data-entry="alone"]')).toHaveText("Background command failed: Deploy");

  // A run is one line: what says something counted, what only says it still waits not.
  const fold = page.locator("[data-notices]").first();
  await expect(fold.locator("[data-notices-summary]")).toHaveText("4 background updates");
  await expect(fold.locator(".notices-list")).toBeHidden();
  await expect(fold.locator('[data-entry="b0"]')).toBeHidden();
  // A run that only waits barely registers.
  await expect(page.locator("[data-notices]").nth(1).locator("[data-notices-summary]")).toHaveText("2 background updates");
  await expect(page.locator("[data-notices]").nth(1)).toHaveAttribute("data-quiet", "");
  await page.screenshot({ path: testInfo.outputPath("notices-folded.png") });

  await fold.locator("> button").click();
  await expect(fold.locator('[data-entry="b0"]')).toHaveText("Background command finished: Build the site");
  await expect(fold.locator('[data-entry="w0"]')).toContainText("Helper is waiting on its own background work");
  const helper = fold.locator('[data-entry="f0"]');
  await expect(helper.locator("[data-notice-line]")).toHaveText("Helper finished: Tidy the docs");
  await expect(helper.locator("[data-notice-detail]")).toBeHidden();
  await helper.locator("button").click();
  await expect(helper.locator("[data-notice-detail]")).toHaveText("Tidied three pages.");
  await page.screenshot({ path: testInfo.outputPath("notices-opened.png") });
});

test("sending with photos: the box empties at once and the message moves into the chat; on failure it says so and offers Try again and Put back, kept while the person looks away, words and photos whole", async ({}, testInfo) => {
  test.skip(!hiveNetBuilt() || !hiveWebBuilt(), "build hive-net (cargo build in crates/hive-net) and the page (crates/hive-web/build.sh) first");
  test.setTimeout(300_000);
  const { page, box, prompts, tile, person: said, agent } = await chatWith(false);
  await page.locator("[data-photo-picker]").setInputFiles(await cameraPhotos(page, 4, 800, 600));
  const inBox = page.locator("[data-message] [data-photo]");
  await expect(inBox).toHaveCount(4, { timeout: 30_000 });
  const message = "echo what is wrong in these";
  await box.fill(message);
  const shotAt = testInfo.outputPath("sending-at-once.png");

  // Tapped twice, nothing goes twice: the box was emptied by the first.
  await page.locator("[data-message] button[type=submit]").dblclick();
  await expect(box).toHaveValue("");
  await expect(inBox).toHaveCount(0);
  const bubble = page.locator("[data-chat] [data-pending]");
  await expect(bubble).toHaveCount(1);
  await expect(bubble.locator("[data-pending-photos] img")).toHaveCount(4);
  await page.screenshot({ path: shotAt });
  await expect.poll(prompts, { timeout: 30_000 }).toHaveLength(1);
  await expect(agent).toHaveCount(1, { timeout: 30_000 });
  await expect(page.locator("[data-chat] [data-pending]")).toHaveCount(0, { timeout: 30_000 });
  await expect(said.locator(".photos img")).toHaveCount(4);

  // With the link gone it cannot go, and says so.
  await page.locator("[data-photo-picker]").setInputFiles(await cameraPhotos(page, 2, 800, 600));
  await expect(inBox).toHaveCount(2, { timeout: 30_000 });
  const second = "echo again with two";
  await box.fill(second);
  await page.context().setOffline(true);
  await page.locator("[data-message] button[type=submit]").click();
  await expect(box).toHaveValue("");
  const failed = page.locator('[data-chat] [data-pending="failed"]');
  await expect(failed).toHaveCount(1, { timeout: 90_000 });
  await expect(failed.locator("[data-pending-state]")).toContainText("Not sent");
  // Trial clicks: whatever floats above the box while the link is gone leaves them to be tapped.
  await failed.locator("[data-try-again]").click({ trial: true });
  await failed.locator("[data-put-back]").click({ trial: true });
  await expect(failed.locator('[data-who="person"]')).toHaveText(second);
  await expect(failed.locator("[data-pending-photos] img")).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath("sending-failed.png") });

  // Looked away from, it is still there.
  await page.locator('[data-screen="agent"] [data-back]').click();
  await expect(page.locator(`[data-agent="${tile}"]`)).toBeVisible();
  await page.locator(`[data-agent="${tile}"]`).click();
  await expect(failed).toHaveCount(1);
  await expect(failed.locator("[data-pending-photos] img")).toHaveCount(2);

  // Put back: in the box, words and photos, and out of the chat.
  await failed.locator("[data-put-back]").click();
  await expect(page.locator("[data-chat] [data-pending]")).toHaveCount(0);
  await expect(box).toHaveValue(second);
  await expect(inBox).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath("sending-put-back.png") });

  // Sent again, failed again, and tried again with the link back: it goes, once.
  await page.locator("[data-message] button[type=submit]").click();
  await expect(failed).toHaveCount(1, { timeout: 90_000 });
  await page.context().setOffline(false);
  await expect(page.locator("[data-paired]")).toBeAttached({ timeout: 60_000 });
  await expect(async () => {
    if (await failed.count()) await failed.locator("[data-try-again]").click({ timeout: 2_000 });
    await expect(page.locator("[data-chat] [data-pending]")).toHaveCount(0, { timeout: 8_000 });
  }).toPass({ timeout: 120_000 });
  await expect.poll(prompts, { timeout: 30_000 }).toHaveLength(2);
  expect(prompts()[1]).toContain(second);
  await page.screenshot({ path: testInfo.outputPath("sending-delivered.png") });
});
