// The phone in a browser (docs/design/phone-browser-2026-10-03.md, B1 to B3): the computer, on a
// network of its own whose server also serves the phone page (`hive-net serve --phone`), offers its
// pairing link inside the page's address (Settings → Your devices → Use on your phone); a phone-sized browser
// opens it, asks, and on a tap gets onto the network with the voucher the link carries, pairs with
// the computer through the network's relay, and is listed there as the person's phone. It is the phone app: what
// waits on the person, answered from there; every agent, live; one agent's chat, and a message
// sent to it. The computer sees both, done by that device. Reopened with no network, it shows what
// it last knew at once. An agent started from it, and closed from it, is started and closed on the
// computer as that device asked. Unpaired on the computer, it is turned away and offers to pair
// again; forgotten from it, the computer is told and lists it no more.
import { test, expect, chromium, type Browser, type ElectronApplication } from "@playwright/test";
import { execSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { hiveNetBuilt, ownNetwork, person } from "./helpers/multiplayer";
import { cameraOn, offerPhonePairing, probeAgent, startProbe, talkerAgent } from "./helpers/phone";
import { stopDaemons } from "./helpers/daemons";
import { parsePairLink } from "@hivemind/workspace-host/pairing";
import { encode } from "uqr";

const WWW = path.resolve("../../crates/hive-web/www");
const hiveWebBuilt = () => fs.existsSync(path.join(WWW, "pkg", "hive_web_bg.wasm")) && fs.existsSync(path.join(WWW, "main.js"));

let root: string;
let browser: Browser | undefined;
const apps: ElectronApplication[] = [];
const procs: ChildProcess[] = [];
test.beforeEach(() => { root = fs.mkdtempSync("/tmp/hm-browser-"); });
test.afterEach(async () => {
  await browser?.close();
  browser = undefined;
  for (const p of procs.splice(0)) p.kill("SIGKILL");
  for (const a of apps.splice(0)) await a.close();
  stopDaemons(root);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test("a phone's browser opens the page the computer's QR code names and, asked and tapped, pairs through the network's relay, as the person's phone; it answers what waits on the person, never twice when the computer cannot confirm it, sends an agent a message, starts one and closes it, and the computer does each, as that device; reopened offline it shows what it last knew; unpaired on the computer, it is turned away and pairs again; forgotten from it, the computer forgets it too", async ({}, testInfo) => {
  test.skip(!hiveNetBuilt() || !hiveWebBuilt(), "build hive-net (cargo build in crates/hive-net) and the page (crates/hive-web/build.sh) first");
  test.setTimeout(300_000);
  const net = await ownNetwork(root, procs, "closed", WWW);
  const repo = path.join(root, "api");
  fs.mkdirSync(path.join(repo, "web", "app"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".cache"));
  execSync("git init -q", { cwd: repo });
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const desktop = await person(root, "desktop", repo, apps, { ...probeAgent(root), ...talkerAgent(root), HOME: home });
  expect(await desktop.evaluate((l) => window.hive.useNetwork(l), net.link)).toMatchObject({ admission: "enrolled" });
  const me = await desktop.evaluate(() => window.hive.identity());
  const audit = () => fs.readFileSync(path.join(root, "desktop", "hivemind-dev", "audit.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

  // The QR code is for hivemind on the phone, until asked for the browser: then it is the page's
  // address on the network's server, named as the one who could pair as the person, the link in
  // its fragment.
  const app = await offerPhonePairing(desktop);
  await expect(desktop.locator("[data-pair-server]")).toContainText(`The page comes from ${new URL(net.relay).host}`);
  const inBrowser = async (app: string) => {
    await desktop.locator('[data-pair-browser] [role="switch"]').click();
    const link = (await desktop.locator("[data-pair-copy]").getAttribute("title"))!;
    // The app's link without the addresses, which a browser cannot use: a QR code a camera reads.
    expect(link.startsWith(`${net.relay}/phone/#pair=hivemind://pair/`)).toBe(true);
    expect(parsePairLink(link)).toEqual({ ...parsePairLink(app), addrs: [] });
    console.log(`QR: ${app.length} chars as the app's link, version ${encode(app).version}; ${link.length} as the page's, version ${encode(link).version}`);
    return link;
  };
  const link = await inBrowser(app);
  // The page this build goes with (its hash from build.sh), worked out from what the server serves.
  await expect(desktop.locator("[data-pair-page]")).toHaveAttribute("data-pair-page", "same", { timeout: 30_000 });

  // Opened on a phone: it asks first, naming the computer, as anyone can send a link; nothing is
  // paired until the tap. Then it pairs, let onto the network with the voucher the link carries.
  // Its camera, pointed at nothing yet.
  const camera = path.join(root, "camera.y4m");
  cameraOn(camera, "nothing to pair with");
  browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${camera}`] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: "dark", permissions: ["camera"] });
  const page = await context.newPage();
  await page.goto(`${link}&name=${encodeURIComponent("Priya's phone")}`);
  await expect(page.locator('[data-screen="pair"] h1')).toHaveText(/^Pair with .+\?$/, { timeout: 30_000 });
  await expect(page.locator("[data-pair-replaces]")).toBeHidden();
  const id = (await page.locator("[data-id]").getAttribute("data-id"))!;
  // Nothing to wait on when nothing happens: as long as a pairing takes here, several times over.
  await page.waitForTimeout(3_000);
  expect(await (await fetch(`${net.access}/allowed/${id}`)).text()).toBe("false");
  await expect(desktop.locator(`[data-device="${id}"]`)).toHaveCount(0);
  await page.locator("[data-pair]").click();
  await expect(page.locator("[data-paired]")).toHaveAttribute("data-paired", me.deviceId, { timeout: 30_000 });
  const kept = await page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open("hive-web");
    open.onsuccess = () => { const get = open.result.transaction("kept").objectStore("kept").get("paired"); get.onsuccess = () => resolve(get.result); get.onerror = reject; };
    open.onerror = reject;
  }));
  expect(kept).toMatchObject({ with: { device: me.deviceId, kind: "app" }, certificate: { person: me.personId, device: id }, admission: "vouched for by the app" });
  expect(await (await fetch(`${net.access}/allowed/${id}`)).text()).toBe("true");
  // The code, a secret, is gone from the page's address once read.
  expect(page.url()).not.toContain("pair");
  await expect(desktop.locator(`[data-device="${id}"][data-device-kind="phone"]`)).toContainText("Priya's phone", { timeout: 10_000 });
  await desktop.keyboard.press("Escape");

  // Opened with another link, paired already: it says what pairing would replace, and Keep leaves
  // it as it was.
  await page.goto(await inBrowser(await offerPhonePairing(desktop)));
  await page.reload();
  await expect(page.locator("[data-pair-replaces]")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("[data-pair-replaces]")).toHaveText(/^This page is paired with .+; pairing replaces it\.$/);
  await page.locator("[data-pair-keep]").click();
  await expect(page.locator('[data-screen="home"]')).toBeVisible();
  await expect(page.locator("[data-paired]")).toHaveAttribute("data-paired", me.deviceId);
  await desktop.keyboard.press("Escape");

  // An agent on the computer begins waiting on the person: Home shows it on top, with its answers,
  // and lists it under its project, saying what it waits on.
  const tile = await startProbe(desktop);
  const need = page.locator(`[data-need="${tile}"]`);
  await expect(need).toHaveAttribute("data-kind", "permission", { timeout: 30_000 });
  await expect(page.locator("[data-tab-dot]")).toBeVisible();
  await expect(page.locator(`[data-tree] [data-agent="${tile}"]`)).toHaveAttribute("data-state", "waiting");
  await expect(page.locator("[data-tree] [data-project]")).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("home.png") });

  // Reopened with no network (offline, and the relay's WebSocket refused, which offline alone does
  // not stop): the same device, still paired, and what waited, shown from what the page kept.
  let away = true;
  // While deaf, what the computer says does not reach the page; what the page says still goes.
  let deaf = false;
  await context.routeWebSocket(/./, (ws) => {
    if (away) return ws.close();
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => { if (!deaf) ws.send(m); });
  });
  await context.setOffline(true);
  // When the card is put on screen, since the page was asked for, on a CPU a quarter as fast (a
  // mid phone's): measured, not held to the 500 ms budget on a shared machine.
  await context.addInitScript(() => new MutationObserver((_, o) => {
    if (!document.querySelector("[data-need]")) return;
    (window as unknown as { shown: number }).shown = performance.now();
    o.disconnect();
  }).observe(document, { childList: true, subtree: true }));
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page.reload();
  await expect(need).toBeVisible();
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  console.log(`first screen from what the page kept, offline, CPU 4x slower: ${(await page.evaluate(() => (window as unknown as { shown: number }).shown)).toFixed(0)} ms`);
  await expect(page.locator("[data-id]")).toHaveAttribute("data-id", id);
  await expect(page.locator("[data-error]")).toContainText("is not reached", { timeout: 30_000 });
  away = false;
  await context.setOffline(false);
  await expect(page.locator("[data-error]")).toBeHidden({ timeout: 30_000 });

  // Allowed from the browser while nothing the computer says reaches it: the computer answers the
  // agent as that device did, and records it allowed; the page cannot know, so it says so and does
  // not offer to answer again, which would answer whatever the agent asks next.
  deaf = true;
  await need.locator('[data-answer="allow"]').click();
  await expect(need.locator("[data-unconfirmed]")).toHaveText("Not confirmed: check the chat.", { timeout: 30_000 });
  await expect(need.locator("[data-answer]")).toHaveCount(0);
  await expect.poll(audit, { timeout: 10_000 }).toContainEqual(expect.objectContaining({ verb: "agent.answer", detail: "allow", outcome: "ok", actor: expect.objectContaining({ kind: "peer", device: id }) }));
  // Heard again: it works, and waits on the person no more.
  deaf = false;
  await expect(page.locator(`[data-agent="${tile}"]`)).toHaveAttribute("data-state", "working", { timeout: 60_000 });
  await expect(page.locator("[data-need]")).toHaveCount(0);
  await expect(page.locator("[data-clear]")).toHaveText("Nothing needs you. 1 agent working.");
  await expect(page.locator(`[data-working] [data-working-row="${tile}"]`)).toBeVisible();

  // Another agent, one that keeps a conversation: listed in Home's tree.
  await desktop.evaluate(() => window.hive.settingsSet("agents.defaultAgent", "talker"));
  await desktop.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:shortcut", { detail: "agent" })));
  await expect(desktop.locator(".react-flow__node-terminal")).toHaveCount(2, { timeout: 20_000 });
  const talker = (await desktop.locator(".react-flow__node-terminal").evaluateAll((els) => els.map((e) => e.getAttribute("data-id")))).find((t) => t !== tile)!;
  await expect(page.locator(`[data-agent="${talker}"]`)).toBeVisible({ timeout: 30_000 });
  // Pinned in the desktop's Layers panel: pinned on Home too, and listed there alone.
  const layer = desktop.locator(`aside[aria-label="Layers"] [data-layer-tile="${talker}"]`);
  await layer.hover();
  await layer.locator("[data-layer-tile-menu]").click();
  await desktop.keyboard.press("p");
  await expect(page.locator(`[data-pinned] [data-agent="${talker}"]`)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(`[data-agent="${talker}"]`)).toHaveCount(1);

  // Opened, and sent a message: the computer types it in as that device sent it, the agent hears
  // it, and the chat shows what each said.
  await page.locator(`[data-agent="${talker}"]`).click();
  await page.locator("[data-message] textarea").fill("fix the login redirect");
  await page.locator("[data-message] button[type=submit]").click();
  await expect.poll(audit, { timeout: 20_000 }).toContainEqual(expect.objectContaining({ verb: "agent.send", outcome: "ok", actor: expect.objectContaining({ kind: "peer", device: id }) }));
  const talk = path.join(home, "talk");
  await expect.poll(() => fs.existsSync(talk) && fs.readdirSync(talk).map((f) => fs.readFileSync(path.join(talk, f), "utf8")).join(""), { timeout: 20_000 }).toContain("fix the login redirect");
  await expect(page.locator('[data-chat] [data-who="person"]')).toHaveText(["fix the login redirect"], { timeout: 30_000 });
  await expect(page.locator('[data-chat] [data-who="agent"]')).toHaveText(["You said fix the login redirect"]);
  await expect(page.locator("[data-message] textarea")).toHaveValue("");
  await page.screenshot({ path: testInfo.outputPath("agent.png") });
  // Home's row says what it last said.
  await page.locator('[data-screen="agent"] [data-back]').click();
  await expect(page.locator(`[data-agent="${talker}"] [data-line]`)).toHaveText("You said fix the login redirect", { timeout: 30_000 });
  await page.locator(`[data-agent="${talker}"]`).click();

  // Asked a question, with options to choose from: the browser shows the question and each option,
  // never Allow or Deny, and the agent is answered with the option tapped.
  const say = async (line: string) => {
    await page.locator("[data-message] textarea").fill(line);
    await page.locator("[data-message] button[type=submit]").click();
  };
  const waiting = page.locator('[data-screen="agent"] [data-waiting-card]');
  await say("ask");
  await expect(waiting).toHaveAttribute("data-waiting-card", "question", { timeout: 30_000 });
  await expect(waiting.locator("[data-question]")).toHaveText("Which color?");
  await expect(waiting.locator("[data-choice]")).toHaveText(["Red", "Blue"]);
  await expect(waiting.locator("[data-answer]")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("question.png") });
  await waiting.locator('[data-choice="1"]').click();
  await expect(page.locator("[data-chat]")).toContainText("ask answered 2", { timeout: 30_000 });
  await expect.poll(audit, { timeout: 10_000 }).toContainEqual(expect.objectContaining({ verb: "agent.answer", detail: "choice 2", outcome: "ok", actor: expect.objectContaining({ kind: "peer", device: id }) }));
  await expect(waiting).toHaveCount(0, { timeout: 30_000 });

  // Asked to run a command: the tool, and the command whole, above Allow and Deny.
  await say("run");
  await expect(waiting).toHaveAttribute("data-waiting-card", "permission", { timeout: 30_000 });
  await expect(waiting.locator('[data-tool="Bash"] pre')).toHaveText("rm -rf build\nmake all");
  await page.screenshot({ path: testInfo.outputPath("permission.png") });
  await waiting.locator('[data-answer="allow"]').click();
  await expect(page.locator("[data-chat]")).toContainText("run answered y", { timeout: 30_000 });
  await expect(waiting).toHaveCount(0, { timeout: 30_000 });
  // Its row in the chat unfolds to its input whole, asked of the computer.
  const ran = page.locator(`[data-chat] .tool[data-tool="Bash"]`);
  // Used next to other tools, it is in their fold, unfolded first.
  const fold = page.locator("[data-chat] [data-tools]", { has: ran });
  if (await fold.count()) await fold.locator(":scope > button").click();
  await ran.locator("button").click();
  await expect(ran.locator("[data-input]")).toHaveText(JSON.stringify({ command: "rm -rf build\nmake all" }, null, 2), { timeout: 30_000 });

  // Started from the browser in a folder inside the project, chosen from its heading, the folders
  // in it listed (never a hidden one), with a prompt and a photo: the computer opens a frame there
  // and starts it as that device asked, the photo kept on it, and its screen opens in place of the
  // one that started it.
  await page.locator('[data-screen="agent"] [data-back]').click();
  await page.locator("[data-tree] [data-start-in]").first().click();
  await expect(page.locator("[data-start-summary]")).toContainText(` · ${path.basename(repo)} · `, { timeout: 30_000 });
  await page.locator("[data-start-summary]").click();
  await page.locator("[data-start-look]").click();
  await expect(page.locator("[data-start-inside] .chip")).toHaveText(["web"]);
  await page.locator("[data-start-inside] .chip", { hasText: "web" }).click();
  await expect(page.locator("[data-start-folder]")).toHaveAttribute("data-start-folder", path.join(repo, "web"));
  await expect(page.locator("[data-start-inside] .chip")).toHaveText(["app"]);
  await page.locator("[data-start-programs] .chip", { hasText: "Talker" }).click();
  await page.locator("[data-start-prompt]").fill("write the tests");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  await page.locator("[data-start-photo-input]").setInputFiles({ name: "screen.png", mimeType: "image/png", buffer: png });
  await expect(page.locator("[data-start-photo]")).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("start.png") });
  await page.locator("[data-start-go]").click();
  await expect(desktop.locator(".react-flow__node-terminal")).toHaveCount(3, { timeout: 30_000 });
  await expect.poll(audit, { timeout: 10_000 }).toContainEqual(expect.objectContaining({ verb: "agent.start", outcome: "ok", actor: expect.objectContaining({ kind: "peer", device: id }) }));
  const started = (await desktop.locator(".react-flow__node-terminal").evaluateAll((els) => els.map((e) => e.getAttribute("data-id")))).find((t) => t !== tile && t !== talker)!;
  await expect(page.locator('[data-screen="agent"]')).toBeVisible();
  expect(new URLSearchParams(new URL(page.url()).hash.slice(1)).get("agent")).toBe(started);
  // The prompt, typed in as it starts: the first thing the person said to it, the photo's path after,
  // in the same message, which the agent reads.
  const first = page.locator('[data-chat] [data-who="person"]').first();
  await expect(first).toHaveText(/^write the tests\s+\S+\/photos\/[0-9a-f]{16}\.png$/, { timeout: 30_000 });
  const photo = (await first.innerText()).match(/\S+\/photos\/[0-9a-f]{16}\.png/)![0];
  expect(fs.readFileSync(photo)).toEqual(png);
  await page.screenshot({ path: testInfo.outputPath("started.png") });
  // It runs in a frame opened there, under the project's.
  await page.locator('[data-screen="agent"] [data-back]').click();
  const opened = page.locator("[data-tree] [data-frame]", { hasText: "web" });
  await expect(opened).toHaveAttribute("style", /--depth:\s*1/, { timeout: 30_000 });
  await expect(opened.locator("xpath=following-sibling::*[1]")).toHaveAttribute("data-agent", started);
  await page.locator(`[data-agent="${started}"]`).click();

  // Closed from the browser, once asked and confirmed: the computer closes it, as that device, and
  // Back leads to the list it was started from.
  await page.locator('[data-screen="agent"] [data-more]').click();
  await page.locator('[data-screen="agent"] [data-close]').click();
  await expect(page.locator("[data-close-ask]")).toHaveText(/^Close .+\? It stops, and its tile closes on .+\./);
  await page.locator("[data-close-ask] [data-yes]").click();
  await expect(desktop.locator(".react-flow__node-terminal")).toHaveCount(2, { timeout: 30_000 });
  await expect.poll(audit, { timeout: 10_000 }).toContainEqual(expect.objectContaining({ verb: "agent.close", outcome: "ok", actor: expect.objectContaining({ kind: "peer", device: id }) }));
  await expect(page.locator('[data-screen="home"]')).toBeVisible();
  await expect(page.locator(`[data-agent="${started}"]`)).toHaveCount(0, { timeout: 30_000 });

  // Stopped from its row on Home while it asks: the computer presses its interrupt key, as that
  // device asked, and it waits no more. Then closed from its row, once confirmed.
  await page.locator(`[data-agent="${talker}"]`).click();
  await say("ask");
  await expect(waiting).toHaveAttribute("data-waiting-card", "question", { timeout: 30_000 });
  await page.locator('[data-screen="agent"] [data-back]').click();
  await page.locator(`[data-agent="${talker}"] .open`).click({ button: "right" });
  await page.locator("[data-row-actions] [data-row-stop]").click();
  await expect.poll(audit, { timeout: 10_000 }).toContainEqual(expect.objectContaining({ verb: "agent.interrupt", outcome: "ok", actor: expect.objectContaining({ kind: "peer", device: id }) }));
  await expect(page.locator(`[data-agent="${talker}"]`)).not.toHaveAttribute("data-state", "waiting", { timeout: 30_000 });
  await expect(page.locator("[data-row-actions]")).toBeHidden();
  await page.locator(`[data-agent="${talker}"] .open`).click({ button: "right" });
  await expect(page.locator("[data-row-actions] [data-row-stop]")).toBeHidden();
  await page.locator("[data-row-actions] [data-row-close]").click();
  await expect(page.locator("[data-row-close-ask]")).toHaveText(/^Close .+\? It stops, and its tile closes on .+\./);
  await page.locator("[data-row-close-ask] [data-yes]").click();
  await expect(desktop.locator(".react-flow__node-terminal")).toHaveCount(1, { timeout: 30_000 });
  await expect(page.locator(`[data-agent="${talker}"]`)).toHaveCount(0, { timeout: 30_000 });

  // Unpaired on the computer: turned away while open, and it offers to pair again, the pairing it
  // kept forgotten.
  await desktop.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: "your-devices" } })));
  await desktop.locator(`[data-device="${id}"] [data-unpair]`).click();
  await expect(desktop.locator(`[data-device="${id}"]`)).toHaveCount(0);
  await expect(page.locator("[data-pair-refused]")).toHaveText(/^.+ no longer lets this browser in: it was unpaired there\.$/, { timeout: 30_000 });
  await expect(page.locator('[data-screen="pair"] h1')).toHaveText("Pair again");
  await page.reload();
  await expect(page.locator('[data-screen="pair"] h1')).toHaveText("Pair with hivemind", { timeout: 30_000 });
  await desktop.keyboard.press("Escape");

  // Paired again by scanning the computer's QR code with the camera, read by the page's own wasm:
  // asked first, as an opened link is.
  const again = await inBrowser(await offerPhonePairing(desktop));
  cameraOn(camera, again);
  await page.locator("[data-scan]").click();
  await expect(page.locator('[data-screen="pair"] h1')).toHaveText(/^Pair with .+\?$/, { timeout: 30_000 });
  await expect(page.locator("[data-pair-link]")).toHaveValue(again);
  await expect(page.locator("[data-scan-video]")).toBeHidden();
  await page.locator("[data-pair]").click();
  await expect(page.locator("[data-paired]")).toHaveAttribute("data-paired", me.deviceId, { timeout: 30_000 });
  await expect(desktop.locator(`[data-device="${id}"][data-device-kind="phone"]`)).toHaveCount(1, { timeout: 10_000 });
  await desktop.keyboard.press("Escape");

  // Forgotten from the browser, once confirmed: the computer is told, and lists it no more.
  const listed = () => desktop.evaluate((d) => window.hive.devices().then((all) => all.some((x: { device: string }) => x.device === d)), id);
  expect(await listed()).toBe(true);
  await page.locator('[data-tab="devices"]').click();
  await expect(page.locator("[data-paired] .status")).toHaveText("connected", { timeout: 30_000 });
  await page.locator("[data-forget]").click();
  await page.locator("[data-forget-ask] [data-yes]").click();
  await expect(page.locator('[data-screen="pair"]')).toBeVisible();
  // Told, so nothing to say: no notice comes.
  expect(await page.locator("[data-notice]").isHidden()).toBe(true);
  await expect.poll(listed, { timeout: 20_000 }).toBe(false);
});
