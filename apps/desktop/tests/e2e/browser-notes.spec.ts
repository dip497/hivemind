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
