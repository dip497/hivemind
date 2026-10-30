// Notes on a Browser tile's page: what is at a point is named as a person would name it, found
// again by a selector that matches it alone, and kept with a picture, in the review an agent reads.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let app: ElectronApplication;
let page: Page;
let tileId: string;
const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hm-notes-")));
const ud = `${repo}-ud`;

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
  execFileSync("git", ["init", "-q"], { cwd: repo });
  fs.mkdirSync(path.join(repo, ".hivemind"));
  const env = { ...process.env } as Record<string, string>;
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
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(ud, { recursive: true, force: true });
});

async function run<T>(expression: string): Promise<T> {
  return page.evaluate(async ([id, expr]) => ((await window.hive.browserCdp(id, "Runtime.evaluate", { expression: expr, returnByValue: true })) as { result: { value: T } }).result.value, [tileId, expression] as const) as Promise<T>;
}
/** The middle of an element, as fractions of the page's view. */
async function middleOf(selector: string): Promise<[number, number]> {
  return run<[number, number]>(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [(r.left + r.width / 2) / innerWidth, (r.top + r.height / 2) / innerHeight]; })()`);
}
const pick = async (selector: string) => {
  const [fx, fy] = await middleOf(selector);
  return page.evaluate(([id, x, y]) => window.hive.browserPick(id, x, y), [tileId, fx, fy] as const);
};
/** Whether `selector` finds exactly the element `original` finds. */
const findsAlone = (selector: string, original: string) =>
  run<boolean>(`(() => { const m = document.querySelectorAll(${JSON.stringify(selector)}); return m.length === 1 && m[0] === document.querySelector(${JSON.stringify(original)}); })()`);

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
