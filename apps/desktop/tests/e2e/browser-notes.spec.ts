// Notes on a Browser tile's page: what is at a point is named as a person would name it, found
// again by a selector that matches it alone, and kept with a picture, in the review an agent reads.
import { seedAgents } from "./helpers/agents";
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { tileToken } from "@hivemind/agent-host/hooks/token";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stopDaemons } from "./helpers/daemons";

// One app and one page, each test on from the last.
test.describe.configure({ mode: "serial" });

let app: ElectronApplication;
let page: Page;
let tileId: string;
const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hm-notes-")));
const ud = `${repo}-ud`;
const home = `${repo}-home`;
const bin = `${repo}-bin`;
const FAKE_AGENT = path.resolve("tests/e2e/fixtures/fake-agent.cjs");
const CLI = path.resolve("../cli/src/index.ts");

const FIXTURE = `<!doctype html><title>Pricing</title><style>
  body { margin: 0; font: 16px sans-serif } .row { display: flex; gap: 12px; padding: 20px }
  #veil { position: fixed; inset: 0; pointer-events: none; background: transparent }
</style>
<div class="row"><h1>Plans</h1></div>
<div class="row">
  <button id="trial">Start trial</button>
  <a href="/docs">Read the docs</a>
  <input placeholder="Your email">
</div>
<div class="row"><button class="Button_root__a8Xk2 css-1q2w3e4">Buy now</button></div>
<ul class="plans"><li>Free</li><li>Team</li><li>Business</li></ul>
<div class="row"><button>Under the veil</button></div>
<div id="veil"></div>`;

test.beforeAll(async () => {
  seedAgents(process.env.XDG_CONFIG_HOME!, ["claude"]);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  fs.mkdirSync(path.join(repo, ".hivemind"));
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "claude"), `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_AGENT)} claude "$@"\n`, { mode: 0o755 });
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, HIVEMIND_SHELL_ENV: "0" } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.resolve("out/main/index.js"), "--no-sandbox", `--user-data-dir=${ud}`], cwd: repo, env });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 20_000 });
  await page.evaluate(() => window.hive.settingsSet("plugins.state.tool:@hivemind/web", { enabled: true }));
  await page.keyboard.press("6");
  await page.waitForSelector(".react-flow__node-frame");
  const frameId = await page.locator(".react-flow__node-frame").first().getAttribute("data-id");
  await page.evaluate((fid) => window.dispatchEvent(new CustomEvent("hivemind:frame-open", { detail: { frameId: fid, kind: "browser" } })), frameId);
  tileId = (await page.locator(".react-flow__node-browser").first().getAttribute("data-id"))!;
  await expect.poll(() => page.evaluate(async (id) => {
    try { await window.hive.browserCdp(id, "Runtime.evaluate", { expression: "1" }); return true; } catch { return false; }
  }, tileId), { timeout: 25_000 }).toBe(true);
  await page.evaluate(([id, html]) => window.hive.browserCdp(id, "Page.navigate", { url: `data:text/html,${encodeURIComponent(html)}` }), [tileId, FIXTURE]);
  await expect.poll(() => run<string>("document.title")).toBe("Pricing");
});
test.afterAll(async () => {
  await app?.close();
  stopDaemons(ud);
  for (const dir of [repo, ud, home, bin]) fs.rmSync(dir, { recursive: true, force: true });
});

async function run<T>(expression: string): Promise<T> {
  return page.evaluate(async ([id, expr]) => ((await window.hive.browserCdp(id, "Runtime.evaluate", { expression: expr, returnByValue: true })) as { result: { value: T } }).result.value, [tileId, expression] as const) as Promise<T>;
}
/** Call a function in the page with these values as its arguments. */
async function callOnPage<T>(fn: string, ...args: string[]): Promise<T> {
  return page.evaluate(async ([id, fnText, values]) => {
    const page = (await window.hive.browserCdp(id, "Runtime.evaluate", { expression: "window" })) as { result: { objectId: string } };
    const done = (await window.hive.browserCdp(id, "Runtime.callFunctionOn", {
      objectId: page.result.objectId, functionDeclaration: fnText, arguments: values.map((value) => ({ value })), returnByValue: true,
    })) as { result: { value: T } };
    return done.result.value;
  }, [tileId, fn, args] as const);
}
/** The middle of an element, as fractions of the page's view. */
async function middleOf(selector: string): Promise<[number, number]> {
  return callOnPage<[number, number]>("(selector) => { const r = document.querySelector(selector).getBoundingClientRect(); return [(r.left + r.width / 2) / innerWidth, (r.top + r.height / 2) / innerHeight]; }", selector);
}
const pick = async (selector: string) => {
  const [fx, fy] = await middleOf(selector);
  return page.evaluate(([id, x, y]) => window.hive.browserPick(id, x, y), [tileId, fx, fy] as const);
};
/** Whether `selector` finds exactly the element `original` finds. */
const findsAlone = (selector: string, original: string) =>
  callOnPage<boolean>("(selector, original) => { const m = document.querySelectorAll(selector); return m.length === 1 && m[0] === document.querySelector(original); }", selector, original);

test("what is at a point is named by its role and name, and found again by a selector that matches it alone", async () => {
  const cases: [string, string][] = [
    ["#trial", 'button "Start trial"'],
    ["a[href='/docs']", 'link "Read the docs"'],
    ["input", 'textbox "Your email"'],
    [".Button_root__a8Xk2", 'button "Buy now"'],
    ["ul.plans li:nth-of-type(2)", "Team"],
    ["body > div:nth-of-type(4) > button", 'button "Under the veil"'],
  ];
  for (const [original, name] of cases) {
    const el = await pick(original);
    expect(el, original).not.toBeNull();
    expect(el!.name, original).toContain(name);
    expect(await findsAlone(el!.selector, original), `${original} → ${el!.selector}`).toBe(true);
    expect(el!.box.width, original).toBeGreaterThan(0);
  }
  // A generated class name is no handle to find it by: it changes with every build.
  expect((await pick(".Button_root__a8Xk2"))!.selector).not.toMatch(/a8Xk2|1q2w3e4/);
});

test("an area names the elements inside it", async () => {
  const r = await run<[number, number, number, number]>(`(() => { const r = document.querySelector("ul.plans").getBoundingClientRect(); return [r.left / innerWidth, r.top / innerHeight, r.width / innerWidth, r.height / innerHeight]; })()`);
  const got = await page.evaluate(([id, x, y, w, h]) => window.hive.browserPickArea(id, x, y, w, h), [tileId, ...r] as const);
  expect(got.elements.map((e) => e.text)).toEqual(["Free", "Team", "Business"]);
  expect(got.area.width).toBeGreaterThan(0);
});

test("a note is kept in the workspace's review with a picture of what it points at", async () => {
  const el = (await pick("#trial"))!;
  const note = await page.evaluate(([id, root, e]) => window.hive.browserNote(id, root, { body: "make it bigger", intent: "fix", elements: [e] }), [tileId, repo, el] as const);
  const kept = JSON.parse(fs.readFileSync(path.join(repo, ".hivemind", "review.json"), "utf8")) as { id: string; body: string; page: { url: string; picture: string; elements: { name: string }[] } }[];
  const back = kept.find((c) => c.id === note.id)!;
  expect(back.body).toBe("make it bigger");
  expect(back.page.elements[0]!.name).toContain('button "Start trial"');
  const png = fs.readFileSync(path.join(repo, ".hivemind", "pages", back.page.picture));
  expect(png.subarray(1, 4).toString()).toBe("PNG");
});

/** Where an element of the page is on screen, through the annotate layer over it. */
async function onScreen(selector: string): Promise<{ x: number; y: number }> {
  const [fx, fy] = await middleOf(selector);
  const box = (await page.locator("[data-annotate-layer]").boundingBox())!;
  return { x: box.x + fx * box.width, y: box.y + fy * box.height };
}
const notesOnDisk = () => (JSON.parse(fs.existsSync(path.join(repo, ".hivemind", "review.json")) ? fs.readFileSync(path.join(repo, ".hivemind", "review.json"), "utf8") : "[]") as { id: string; body: string; resolved?: boolean; page: { elements: { name: string }[]; area?: unknown } }[]);
const pinsOnPage = () => run<string[]>(`[...(document.querySelector("hivemind-page-notes")?.shadowRoot?.children ?? [])].map((p) => p.className + ":" + p.textContent)`);

test("in the tile: a click notes what it is on, Ctrl and a click gather several, a drag notes an area, and each shows as a pin", async () => {
  fs.rmSync(path.join(repo, ".hivemind", "review.json"), { force: true });
  await page.locator(".react-flow__node-browser [aria-label='annotate']").click();
  await expect(page.locator("[data-annotate-layer]")).toBeVisible();

  const at = await onScreen("a[href='/docs']");
  await page.mouse.move(at.x, at.y);
  await page.mouse.click(at.x, at.y);
  const box = page.locator("[data-note-box]");
  await expect(box).toContainText('link "Read the docs"');
  await box.locator("textarea").fill("link to the new docs");
  await box.locator("textarea").press("Enter");
  await expect.poll(() => notesOnDisk().map((c) => c.body)).toEqual(["link to the new docs"]);
  await expect.poll(pinsOnPage).toEqual(["pin open:1"]);

  for (const sel of ["ul.plans li:nth-of-type(1)", "ul.plans li:nth-of-type(2)"]) {
    const p = await onScreen(sel);
    await page.keyboard.down("Control");
    await page.mouse.click(p.x, p.y);
    await page.keyboard.up("Control");
  }
  await expect(page.locator("[data-annotate-gathered]")).toContainText("2 picked");
  const third = await onScreen("ul.plans li:nth-of-type(3)");
  await page.mouse.click(third.x, third.y);
  await page.locator("[data-note-box] textarea").fill("same price layout for all three");
  await page.locator("[data-note-box] textarea").press("Enter");
  await expect.poll(() => notesOnDisk().at(-1)?.page.elements.map((e) => e.name)).toEqual(['listitem "Free"', 'listitem "Team"', 'listitem "Business"']);

  const a = await onScreen("#trial"), b = await onScreen("input");
  await page.mouse.move(a.x - 30, a.y - 20);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y + 20, { steps: 5 });
  await page.mouse.up();
  await page.locator("[data-note-box] textarea").fill("this row is crowded");
  await page.locator("[data-note-box] textarea").press("Enter");
  await expect.poll(() => notesOnDisk().at(-1)?.page.area).toBeTruthy();
  await expect.poll(async () => (await pinsOnPage()).length).toBe(3);

  // Done from the list: its pin says so.
  await page.locator("[data-page-note]").first().getByRole("button", { name: "Done" }).click();
  await expect.poll(pinsOnPage).toEqual(["pin resolved:✓", "pin open:2", "pin open:3"]);
});

test("Send gives an agent the open notes and how to answer them; its answers show on the pins", async () => {
  // Hold what Send hands the agent picker instead of starting an agent.
  await page.evaluate(() => {
    window.addEventListener("hivemind:deliver-to-agent", (e) => {
      (window as unknown as { delivered: string }).delivered = (e as CustomEvent<{ text: string }>).detail.text;
      e.stopImmediatePropagation();
    }, { capture: true });
  });
  await page.locator("[data-send-notes]").click();
  const text = await page.waitForFunction(() => (window as unknown as { delivered?: string }).delivered).then((h) => h.jsonValue());
  const open = notesOnDisk().filter((c) => !c.resolved);
  expect(open).toHaveLength(2);
  for (const c of open) expect(text).toContain(`${c.id} (fix): ${c.body}`);
  expect(text).toContain(path.join(repo, ".hivemind", "pages"));
  expect(text).toContain("hive ctl notes done <id>");

  // The agent answers, with the command the message names.
  const cli = path.resolve("../cli/src/index.ts");
  const env = { ...process.env, HIVEMIND_TILE: "", HIVE_HCP_SOCK: "" } as Record<string, string>;
  execFileSync("bun", [cli, "ctl", "notes", "seen", open[0]!.id], { cwd: repo, env });
  execFileSync("bun", [cli, "ctl", "notes", "done", open[1]!.id, "--summary", "one column now"], { cwd: repo, env });
  await expect.poll(pinsOnPage, { timeout: 10_000 }).toEqual(["pin resolved:✓", "pin seen:2", "pin resolved:✓"]);
});

test("Hold still stops the page's animations where they are, and Let go starts them again", async () => {
  // Send starts an agent when it can, and a page out of view does not animate.
  await showTheBrowser();
  await run<void>(`(() => { const d = document.createElement("div"); d.id = "spin"; d.style.cssText = "width:20px;height:20px;background:red"; document.body.append(d);
    d.animate([{ transform: "rotate(0)" }, { transform: "rotate(360deg)" }], { duration: 2000, iterations: Infinity }); })()`);
  const time = () => run<number>(`document.getElementById("spin").getAnimations()[0].currentTime`);
  const moves = async () => { const a = await time(); await page.waitForTimeout(400); return (await time()) - a; };
  expect(await moves()).toBeGreaterThan(100);
  await page.getByRole("button", { name: "Hold still" }).dispatchEvent("click");
  await page.waitForTimeout(200);
  expect(await moves()).toBe(0);
  await page.getByRole("button", { name: "Let go" }).dispatchEvent("click");
  await page.waitForTimeout(200);
  expect(await moves()).toBeGreaterThan(100);
});

/** `hive` as a subprocess, on this app's sockets, not holding up the page it asks about. */
function hive(args: string[], as: Record<string, string> = {}): Promise<{ code: number | null; json: any; stderr: string }> {
  return new Promise((resolve) => {
    const env = { ...process.env, HIVEMIND_APP_DATA: ud, HIVEMIND_TILE: "", HCP_TOKEN: "", HIVE_HCP_SOCK: "", HIVE_DRIVE_SOCK: "", ...as };
    const run = spawn("bun", [CLI, ...args, "--json"], { cwd: repo, env });
    let out = "", err = "";
    run.stdout.setEncoding("utf8").on("data", (d: string) => { out += d; });
    run.stderr.setEncoding("utf8").on("data", (d: string) => { err += d; });
    run.on("close", (code) => {
      const last = (code === 0 ? out : err).trim().split("\n").pop() ?? "";
      let json: unknown;
      try { json = JSON.parse(last); } catch { /* not JSON */ }
      resolve({ code, json, stderr: err });
    });
  });
}
const asAgent = (tile: string) => ({ HIVEMIND_TILE: `hm:${tile}`, HCP_TOKEN: tileToken(fs.readFileSync(path.join(ud, "hcp.token"), "utf8").trim(), `hm:${tile}`) });
const pagesDir = path.join(repo, ".hivemind", "pages");

/** Bring the Browser tile back into view: starting a tile moves the canvas to it. */
async function showTheBrowser(): Promise<void> {
  await expect(async () => {
    await hive(["ctl", "focus", tileId]);
    await expect(page.locator("[data-annotate-layer]")).toBeInViewport({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
}

let scout: Record<string, string>;
let frameId: string;

test("an agent's note goes through the control plane to a pin that says so, holds what a person's holds, and is sent with the rest", async () => {
  frameId = (await page.locator(".react-flow__node-frame").first().getAttribute("data-id"))!;
  const spawned = await hive(["ctl", "spawn", "--agent", "claude", "--name", "scout", "--frame", frameId]);
  expect(spawned.code, spawned.stderr).toBe(0);
  scout = asAgent(spawned.json.tile);
  await showTheBrowser();
  for (let left = await page.locator("[data-page-note]").count(); left > 0; left--) {
    await page.locator("[data-page-note] [aria-label='delete note']").first().click();
    await expect(page.locator("[data-page-note]")).toHaveCount(left - 1);
  }
  await expect.poll(pinsOnPage).toEqual([]);

  const made = await hive(["ctl", "notes", "add", "--selector", "#trial", "--body", "too small on phones", "--intent", "fix"], scout);
  expect(made.code, made.stderr).toBe(0);
  expect(made.json).toMatchObject({ author: "scout", body: "too small on phones", intent: "fix" });
  const anchor = made.json.page;
  expect(anchor.url).toContain("data:text/html");
  expect(anchor.title).toBe("Pricing");
  expect(anchor.viewport.width).toBeGreaterThan(0);
  expect(anchor.elements).toHaveLength(1);
  expect(anchor.elements[0].name).toContain('button "Start trial"');
  expect(anchor.elements[0].text).toBe("Start trial");
  expect(anchor.elements[0].nearby).toContain("Read the docs");
  expect(anchor.elements[0].box.width).toBeGreaterThan(0);
  expect(await findsAlone(anchor.elements[0].selector, "#trial")).toBe(true);
  expect(fs.readFileSync(path.join(pagesDir, anchor.picture)).subarray(1, 4).toString()).toBe("PNG");
  await expect.poll(pinsOnPage).toEqual(["pin open agent:1"]);
  const row = page.locator(`[data-page-note="${made.json.id}"]`);
  await expect(row.locator("[data-note-author]")).toHaveText("scout");

  const area = await hive(["ctl", "notes", "add", "--area", "0,0,400,120", "--body", "this part is cut off"], scout);
  expect(area.code, area.stderr).toBe(0);
  expect(area.json.page.area).toEqual({ x: 0, y: 0, width: 400, height: 120 });
  expect(area.json.page.elements.map((e: { text?: string }) => e.text)).toContain("Plans");
  expect(fs.existsSync(path.join(pagesDir, area.json.page.picture))).toBe(true);
  await expect.poll(async () => (await pinsOnPage()).length).toBe(2);

  // A person's note beside them is still a person's.
  const at = await onScreen("a[href='/docs']");
  await page.mouse.click(at.x, at.y);
  await page.locator("[data-note-box] textarea").fill("link to the new docs");
  await page.locator("[data-note-box] textarea").press("Enter");
  await expect.poll(pinsOnPage).toEqual(["pin open agent:1", "pin open agent:2", "pin open:3"]);
  await expect(page.locator("[data-page-note]").nth(2).locator("[data-note-author]")).toHaveCount(0);

  await page.evaluate(() => { delete (window as unknown as { delivered?: string }).delivered; });
  await page.locator("[data-send-notes]").click();
  const text = await page.waitForFunction(() => (window as unknown as { delivered?: string }).delivered).then((h) => h.jsonValue());
  expect(text).toContain(`${made.json.id} (fix): too small on phones`);
  expect(text).toContain("left by an agent: scout");
  expect(text).toContain("link to the new docs");
  // The picker opens a moment after: left open, it would lie over the list.
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("a note an agent cannot place is refused with a code, an exit, a fix and no note", async () => {
  await run<void>(`(() => { const d = document.createElement("div"); d.id = "unseen"; d.style.display = "none"; document.body.append(d); })()`);
  const before = notesOnDisk().length;
  const rows: [string[], string, number, string][] = [
    [["--selector", "#nothing-here"], "NO_ELEMENT", 5, "--area"],
    [["--selector", "#unseen"], "NO_ELEMENT", 5, "--area"],
    [["--selector", "ul.plans li"], "SEVERAL_ELEMENTS", 7, "one element"],
    [["--selector", "::not a selector"], "BAD_REQUEST", 2, "--help"],
    [["--selector", "#trial", "--intent", "shout"], "BAD_REQUEST", 2, "--help"],
    [["--selector", "#trial", "--area", "0,0,5,5"], "BAD_REQUEST", 2, "--help"],
    [["--selector", "#trial", "--tile", "no-such-tile"], "NOT_FOUND", 5, "hive ctl tiles"],
  ];
  for (const [args, code, exit, fix] of rows) {
    const r = await hive(["ctl", "notes", "add", "--body", "x", ...args], scout);
    expect([args.join(" "), r.code, r.json?.error?.code], r.stderr).toEqual([args.join(" "), exit, code]);
    expect(r.json.error.fix).toContain(fix);
  }
  expect(notesOnDisk()).toHaveLength(before);
});

test("the Browser tile an agent means: --tile, else the one in its frame; none there, or several, is refused", async () => {
  const before = notesOnDisk().length;
  // A second frame, with no Browser tile.
  fs.mkdirSync(path.join(repo, "away"));
  const made = await hive(["ctl", "frame", "add", "--name", "elsewhere", "--folder", path.join(repo, "away")]);
  expect(made.code, made.stderr).toBe(0);
  const away = await hive(["ctl", "spawn", "--agent", "claude", "--name", "away", "--frame", made.json.frame]);
  expect(away.code, away.stderr).toBe(0);
  const lost = await hive(["ctl", "notes", "add", "--selector", "#trial", "--body", "x"], asAgent(away.json.tile));
  expect([lost.code, lost.json?.error?.code], lost.stderr).toEqual([5, "NO_BROWSER_TILE"]);
  expect(lost.json.error.fix).toContain("--tile");
  // In another frame: named, it is still not this agent's until the person shares it.
  const refused = await hive(["ctl", "notes", "add", "--selector", "#trial", "--body", "named", "--tile", tileId], asAgent(away.json.tile));
  expect(refused.code).toBe(5);
  await page.evaluate((id) => window.hive.settingsSet("agentBrowser.tiles", { [id]: "all" }), tileId);
  const named = await hive(["ctl", "notes", "add", "--selector", "#trial", "--body", "named", "--tile", tileId], asAgent(away.json.tile));
  await page.evaluate(() => window.hive.settingsSet("agentBrowser.tiles", {}));
  expect(named.code, named.stderr).toBe(0);
  expect(named.json.author).toBe("away");
  // Starting that agent moved the canvas to it: the page is out of view, and still gives a picture.
  await expect(page.locator("[data-annotate-layer]")).not.toBeInViewport();
  expect(fs.readFileSync(path.join(pagesDir, named.json.page.picture)).subarray(1, 4).toString()).toBe("PNG");
  expect(notesOnDisk()).toHaveLength(before + 1);

  const second = await hive(["ctl", "open-tool", "@hivemind/web/browser", "--frame", frameId, "--url", "about:blank"]);
  expect(second.code, second.stderr).toBe(0);
  await expect.poll(async () => {
    const r = await hive(["ctl", "notes", "add", "--selector", "#trial", "--body", "x"], scout);
    return r.json?.error?.code;
  }, { timeout: 20_000 }).toBe("SEVERAL_BROWSER_TILES");
  await hive(["ctl", "close", second.json.tile]);
  await expect.poll(async () => (await hive(["ctl", "tiles"])).json.tiles.some((t: { tile: string }) => t.tile === second.json.tile)).toBe(false);
});

test("in a folder with no workspace, where no watch sees its review, an agent's note still shows as a pin at once", async () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "hm-plain-"));
  const frame = await hive(["ctl", "frame", "add", "--name", "plain", "--folder", plain]);
  expect(frame.code, frame.stderr).toBe(0);
  const browser = await hive(["ctl", "open-tool", "@hivemind/web/browser", "--frame", frame.json.frame, "--url", "about:blank"]);
  expect(browser.code, browser.stderr).toBe(0);
  const onTheDisk = notesOnDisk().length;
  await expect(async () => {
    const r = await hive(["ctl", "notes", "add", "--area", "0,0,200,100", "--body", "nothing here", "--tile", browser.json.tile], scout);
    expect(r.code, r.stderr).toBe(0);
  }).toPass({ timeout: 20_000 });
  const pins = () => page.evaluate(async (id) => ((await window.hive.browserCdp(id, "Runtime.evaluate", {
    expression: `[...(document.querySelector("hivemind-page-notes")?.shadowRoot?.children ?? [])].map((p) => p.className)`, returnByValue: true,
  })) as { result: { value: string[] } }).result.value, browser.json.tile);
  await expect.poll(pins).toEqual(["pin open agent"]);
  expect(notesOnDisk()).toHaveLength(onTheDisk);
  expect(fs.existsSync(path.join(plain, ".hivemind"))).toBe(false);
  await hive(["ctl", "close", browser.json.tile]);
  fs.rmSync(plain, { recursive: true, force: true });
});

/** A short real video, as the window records one. */
async function realVideo(file: string): Promise<void> {
  const base64 = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 320; canvas.height = 180;
    const draw = canvas.getContext("2d")!;
    const rec = new MediaRecorder(canvas.captureStream(15), { mimeType: "video/webm" });
    const parts: Blob[] = [];
    rec.ondataavailable = (e) => parts.push(e.data);
    const stopped = new Promise((r) => { rec.onstop = r; });
    rec.start();
    for (let i = 0; i < 30; i++) {
      draw.fillStyle = `hsl(${i * 12} 80% 50%)`;
      draw.fillRect(0, 0, 320, 180);
      await new Promise((r) => setTimeout(r, 50));
    }
    rec.stop();
    await stopped;
    const bytes = new Uint8Array(await new Blob(parts).arrayBuffer());
    return btoa(String.fromCharCode(...bytes));
  });
  fs.writeFileSync(file, Buffer.from(base64, "base64"));
}

test("proof on a note plays or shows in the list; a file of a repo no tile shows does not; deleting the note deletes its files", async ({}, info) => {
  await showTheBrowser();
  const video = path.join(repo, "proof.webm");
  await realVideo(video);
  const note = notesOnDisk().find((c) => c.body === "too small on phones")!;
  const shot = fs.readdirSync(pagesDir).find((f) => f.endsWith(".png"))!;
  const image = path.join(repo, "after.png");
  fs.copyFileSync(path.join(pagesDir, shot), image);
  const done = await hive(["ctl", "notes", "done", note.id, "--summary", "bigger now, see the video", "--attach", video, "--attach", image], scout);
  expect(done.code, done.stderr).toBe(0);
  expect(done.json.attachments).toEqual([`${note.id}-1.webm`, `${note.id}-2.png`]);

  const row = page.locator(`[data-page-note="${note.id}"]`);
  const player = row.locator("video");
  await expect(player).toHaveCount(1, { timeout: 10_000 });
  await expect.poll(() => player.evaluate((v: HTMLVideoElement) => v.readyState >= 1 && v.error === null)).toBe(true);
  const played = await player.evaluate(async (v: HTMLVideoElement) => {
    v.muted = true;
    await v.play();
    await new Promise((r) => setTimeout(r, 500));
    return v.currentTime;
  });
  expect(played).toBeGreaterThan(0);
  await expect.poll(() => row.locator("img").evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
  await row.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("notes-list-with-agent-note-and-video.png") });

  // A file like it, in a repo no Browser tile here keeps its notes in.
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "hm-other-"));
  fs.mkdirSync(path.join(other, ".hivemind", "pages"), { recursive: true });
  fs.copyFileSync(image, path.join(other, ".hivemind", "pages", "c-x.png"));
  const loads = (src: string) => page.evaluate((s) => new Promise<boolean>((done) => { const i = new Image(); i.onload = () => done(true); i.onerror = () => done(false); i.src = s; }), src);
  const url = (root: string, name: string) => `hivemedia://note/${encodeURIComponent(root)}/${encodeURIComponent(name)}`;
  expect(await loads(url(repo, `${note.id}-2.png`))).toBe(true);
  expect(await loads(url(other, "c-x.png"))).toBe(false);
  fs.rmSync(other, { recursive: true, force: true });

  await row.locator("[aria-label='delete note']").click();
  await expect.poll(() => notesOnDisk().some((c) => c.id === note.id)).toBe(false);
  expect(fs.readdirSync(pagesDir).filter((f) => f.startsWith(note.id))).toEqual([]);
});
