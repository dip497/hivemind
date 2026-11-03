// A file an agent sends the person's phone (spec/sent-files.md), through the real command, the real
// network and the page: `hive ctl send-file` on the computer, a row in the agent's chat, Download,
// then Save; the agent is the scripted stand-in behind the real claude manifest. What can break it
// on a phone's own share sheet is checked on a phone; here the share sheet is a stand-in, and Save
// without one is the browser's download.
import { test, expect, chromium, type Browser, type ElectronApplication, type Page } from "@playwright/test";
import { execSync, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
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
const CLI = path.resolve("../cli/src/index.ts");
const MIB = 1024 * 1024;

let root: string;
let browser: Browser | undefined;
const apps: ElectronApplication[] = [];
const procs: ChildProcess[] = [];
test.beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync("/tmp/hm-files-")); });
test.afterEach(async () => {
  await browser?.close();
  browser = undefined;
  for (const p of procs.splice(0)) p.kill("SIGKILL");
  for (const a of apps.splice(0)) await a.close();
  stopDaemons(root);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** Bytes that never repeat: a piece put in the wrong place shows. */
const noise = (size: number): Buffer => randomBytes(size);

/** The running `hive-net daemon` of this test's app, by its pid. */
function networkProcess(): number | null {
  for (const pid of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    let argv: string[];
    try { argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0"); } catch { continue; }
    if (argv[1] === "daemon" && argv.some((a) => a.startsWith(root + path.sep))) return Number(pid);
  }
  return null;
}

/** Claude Code's stand-in on the person's computer, its phone page paired, with the agent's chat
 *  open; and how to send it a file as `hive ctl` does. */
async function chatWith(script?: (page: Page) => Promise<void>) {
  const net = await ownNetwork(root, procs, "closed", WWW);
  const repo = path.join(root, "api");
  fs.mkdirSync(repo);
  execSync("git init -q", { cwd: repo });
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  for (const d of [home, bin]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(bin, "claude"), `#!/usr/bin/env bash\nexport FAKE_PROMPT="❯ "\nFAKE_STEER=1 exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FIXTURE)} claude "$@"\n`, { mode: 0o755 });
  seedAgents(path.join(root, "desktop"), ["claude"]);
  const desktop = await person(root, "desktop", repo, apps, { HOME: home, PATH: `${bin}:${process.env.PATH}`, HIVEMIND_SHELL_ENV: "0" });
  expect(await desktop.evaluate((l) => window.hive.useNetwork(l), net.link)).toMatchObject({ admission: "enrolled" });
  const me = await desktop.evaluate(() => window.hive.identity());

  const env = { ...process.env, XDG_CONFIG_HOME: path.join(root, "desktop"), HIVE_SETTINGS: path.join(root, "desktop", "settings.json"), HIVEMIND_APP_DATA: path.join(root, "desktop", "hivemind-dev"), HCP_TOKEN: "", HIVEMIND_TILE: "", HIVE_DRIVE_SOCK: "", HIVE_HCP_SOCK: "", HOME: home } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const hive = (...args: string[]) => {
    const r = spawnSync("bun", [CLI, ...args, "--json"], { env, encoding: "utf8", cwd: root });
    return { code: r.status, json: r.stdout ? JSON.parse(r.stdout) as Record<string, unknown> : null, error: r.stderr ? (JSON.parse(r.stderr) as { error: { code: string; fix?: string } }).error : null };
  };

  const link = await offerToConnect(desktop, true);
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, acceptDownloads: true });
  const page = await context.newPage();
  await script?.(page);
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

  /** Write a file on the computer and send it: what the command answered, and its bytes. */
  const send = (name: string, bytes: Buffer) => {
    const at = path.join(root, name);
    fs.writeFileSync(at, bytes);
    const sent = hive("ctl", "send-file", at, "--tile", tile);
    expect(sent.code, JSON.stringify(sent.error)).toBe(0);
    return sent.json as { id: string; name: string; size: number; ready: string };
  };
  const open = () => page.locator(`[data-agent="${tile}"]`).click();
  const row = (id: string) => page.locator(`[data-sent-file="${id}"]`);
  return { desktop, page, tile, hive, send, open, row };
}

const received = async (page: Page, click: () => Promise<void>): Promise<{ name: string; bytes: Buffer }> => {
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 30_000 }), click()]);
  return { name: download.suggestedFilename(), bytes: fs.readFileSync(await download.path()) };
};

test("a file sent while the phone is away waits; opened, it shows in the agent's chat, comes piece by piece on Download, and Save gives it exactly; the agent can take it back", async () => {
  test.skip(!hiveWebBuilt() || !hiveNetBuilt(), "needs the phone page and hive-net built");
  test.setTimeout(300_000);
  const { page, tile, hive, send, open, row } = await chatWith();
  const bytes = noise(5 * MIB + 1234);
  const sent = send("report.pdf", bytes);
  // What it answers never says the person has it.
  expect(sent.ready).toMatch(/not necessarily reached/);
  expect(JSON.stringify(sent)).not.toContain(root);

  await open();
  const action = row(sent.id).locator("[data-sent-file-action]");
  await expect(row(sent.id).locator("[data-sent-file-name]")).toHaveText("report.pdf", { timeout: 30_000 });
  await expect(row(sent.id).locator("[data-sent-file-status]")).toHaveText("5.0 MB");
  await expect(action).toHaveText("Download");
  await page.screenshot({ path: test.info().outputPath("file-to-download.png") });

  await action.click();
  await expect(action).toHaveText("Save", { timeout: 120_000 });
  await page.screenshot({ path: test.info().outputPath("file-to-save.png") });
  const got = await received(page, () => action.click());
  expect(got.name).toBe("report.pdf");
  expect(got.bytes.equals(bytes)).toBe(true);

  // Sent with the chat open, it shows at once; the list stays across a reload.
  const next = send("notes.md", Buffer.from("# Notes\n"));
  await expect(row(next.id)).toBeVisible({ timeout: 15_000 });
  // Loaded again, the page comes back to this chat.
  await page.reload();
  await expect(row(sent.id)).toBeVisible({ timeout: 60_000 });
  await expect(row(next.id)).toBeVisible();

  const listed = hive("ctl", "sent-files", "--tile", tile).json as { files: Array<{ id: string }> };
  expect(listed.files.map((f) => f.id)).toEqual([sent.id, next.id]);
  expect(hive("ctl", "take-back-file", next.id).json).toEqual({ takenBack: true });
  await expect(row(next.id)).toHaveCount(0, { timeout: 15_000 });
  await expect(row(sent.id)).toBeVisible();
});

test("a small picture comes without asking and is drawn; a page or an SVG is never drawn, runs nothing, and Save only downloads it", async () => {
  test.skip(!hiveWebBuilt() || !hiveNetBuilt(), "needs the phone page and hive-net built");
  test.setTimeout(300_000);
  const { page, send, open, row } = await chatWith();
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8DAwMDAxAAGABkzAQOFbOUkAAAAAElFTkSuQmCC", "base64");
  const picture = send("shot.png", png);
  const evil = "<script>top.document.title='ran';top.ran=1</script>";
  const pageFile = send("evil.html", Buffer.from(evil));
  const svg = send("evil.svg", Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" onload="top.ran=1">${evil}</svg>`));

  await open();
  const drawn = row(picture.id).locator("[data-sent-file-picture]");
  await expect(drawn).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => drawn.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(2);
  expect(await drawn.getAttribute("alt")).toBe("shot.png");

  for (const f of [pageFile, svg]) {
    const action = row(f.id).locator("[data-sent-file-action]");
    await expect(action).toHaveText("Save", { timeout: 30_000 });
    await expect(row(f.id).locator("img, iframe, object, embed")).toHaveCount(0);
    const before = page.url();
    const got = await received(page, () => action.click());
    expect(got.name).toBe(f.name);
    expect(page.url()).toBe(before);
    expect(page.context().pages().length).toBe(1);
  }
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (top as unknown as { ran?: number }).ran)).toBeUndefined();
});

test("where the phone has a share sheet, Save hands it the file by name and with its type; closing the sheet downloads nothing", async () => {
  test.skip(!hiveWebBuilt() || !hiveNetBuilt(), "needs the phone page and hive-net built");
  test.setTimeout(300_000);
  const { page, send, open, row } = await chatWith((p) => p.addInitScript(() => {
    const said = ((window as unknown as { shared: unknown[] }).shared = [] as unknown[]);
    (navigator as unknown as { canShare: unknown }).canShare = () => true;
    (navigator as unknown as { share: unknown }).share = async ({ files }: { files: File[] }) => {
      // Called in the tap, as a phone's sheet demands.
      said.push({ active: navigator.userActivation?.isActive ?? null, name: files[0]!.name, type: files[0]!.type, text: await files[0]!.text() });
      if (said.length === 2) throw new DOMException("closed", "AbortError");
    };
  }));
  const sent = send("data.csv", Buffer.from("a,b\n1,2\n"));
  await open();
  const action = row(sent.id).locator("[data-sent-file-action]");
  await expect(action).toHaveText("Save", { timeout: 30_000 });
  await action.click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { shared: unknown[] }).shared.length)).toBe(1);
  expect(await page.evaluate(() => (window as unknown as { shared: unknown[] }).shared[0])).toEqual({ active: true, name: "data.csv", type: "text/csv", text: "a,b\n1,2\n" });
  let downloads = 0;
  page.on("download", () => (downloads += 1));
  await action.click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { shared: unknown[] }).shared.length)).toBe(2);
  await page.waitForTimeout(500);
  expect(downloads).toBe(0);
});

test("hive-net killed part way through a download: the row says so, goes on by itself from where it stopped, and the file comes exactly", async () => {
  test.skip(!hiveWebBuilt() || !hiveNetBuilt(), "needs the phone page and hive-net built");
  test.setTimeout(300_000);
  const { page, send, open, row } = await chatWith();
  const bytes = noise(20 * MIB + 77);
  const sent = send("video.mp4", bytes);
  await open();
  const action = row(sent.id).locator("[data-sent-file-action]");
  await expect(action).toHaveText("Download", { timeout: 30_000 });
  await action.click();
  const status = row(sent.id).locator("[data-sent-file-status]");
  // Part way: 3 MiB and more came, and not all.
  await expect.poll(async () => parseFloat(await status.innerText()), { timeout: 120_000 }).toBeGreaterThan(3);
  process.kill(networkProcess()!, "SIGKILL");
  await expect(action).toHaveText("Save", { timeout: 180_000 });
  const got = await received(page, () => action.click());
  expect(got.bytes.equals(bytes)).toBe(true);
});

test("files stay where their time falls in the chat and in the order sent, as earlier messages load above them", async () => {
  test.skip(!hiveWebBuilt() || !hiveNetBuilt(), "needs the phone page and hive-net built");
  test.setTimeout(300_000);
  const { page, send, open, row } = await chatWith();
  await open();
  await page.locator("[data-message] textarea").fill("echo ready");
  await page.locator("[data-message] button[type=submit]").click();
  await expect(page.locator('[data-chat] [data-who="agent"]')).toHaveText(["ready"], { timeout: 30_000 });
  const transcripts = path.join(root, "home", ".claude", "projects");
  const session = path.join(transcripts, String(fs.readdirSync(transcripts, { recursive: true }).find((f) => String(f).endsWith(".jsonl"))));
  const past = Date.now() - 3_600_000;
  const record = (n: number) => `${JSON.stringify({ type: "user", uuid: `old-${n}`, timestamp: new Date(past + n).toISOString(), message: { role: "user", content: `message ${n}` } })}\n`;
  fs.appendFileSync(session, Array.from({ length: 300 }, (_, n) => record(n)).join(""));
  const sent = send("after.md", Buffer.from("# after"));
  const next = send("next.md", Buffer.from("# next"));
  const last = send("last.md", Buffer.from("# last"));
  await expect(row(last.id)).toBeVisible({ timeout: 30_000 });

  await page.reload();
  await expect(row(sent.id)).toBeVisible({ timeout: 60_000 });
  await page.locator("[data-load-earlier]").evaluate((b) => (b as HTMLButtonElement).click());
  const said = page.locator('[data-chat] [data-who="person"]');
  await expect(said.filter({ hasText: /^message 0$/ })).toHaveCount(1, { timeout: 30_000 });
  // Sent after all of them: every message comes before its row, however late it was drawn.
  const after = await row(sent.id).evaluate((file) => [...document.querySelectorAll('[data-chat] [data-who="person"]')].filter((m) => /^message /.test(m.textContent ?? "") && m.compareDocumentPosition(file) & Node.DOCUMENT_POSITION_PRECEDING).length);
  expect(after).toBe(0);
  // And among themselves, in the order sent.
  await expect(page.locator("[data-sent-file-name]")).toHaveText(["after.md", "next.md", "last.md"]);
});
