// The phone page's Home (docs/design/phone-browser-2026-10-03.md, B5 §2), in a phone-sized Chromium
// with no computer and no network: its built modules and wasm (crates/hive-web/build.sh) served
// from www by route. A 200-tile canvas opens in budget; an update touches only what changed; rows
// away from the screen are skipped; past a few working agents, their dots stop breathing; a search
// and a machine chosen narrow it.
import { test, expect, chromium, type Browser, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const WWW = path.resolve("../../crates/hive-web/www");
const built = () => fs.existsSync(path.join(WWW, "js", "home.js"));

let browser: Browser | undefined;
test.afterEach(async () => {
  await browser?.close();
  browser = undefined;
});

/** Home, with `window.load(n, answered)`: a canvas of `n` tiles in ten frames, half of them on a
 *  machine of their own, every fourth waiting on the person but the first `answered` of those,
 *  the rest working, as the computer sends it whole; `window.change(message)` takes in what the
 *  computer sends after. Each is applied by the page's wasm and shown, as the page does. */
async function home(): Promise<Page> {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page.on("pageerror", (e) => { throw e; });
  await page.route("http://page.test/**", (route) => {
    const name = new URL(route.request().url()).pathname.slice(1);
    if (name === "index.html") {
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="app.css"><main id="app"></main>
<script type="module">
import init, { HomeView } from "./pkg/hive_web.js";
import { Home } from "./js/home.js";
await init();
const view = new HomeView(null);
window.opened = [];
const app = { open() {}, openTerminal: (...at) => window.opened.push(at), answer: async () => true };
const screen = new Home(app, () => show());
document.getElementById("app").append(screen.el);
const show = () => screen.show(view.shown(screen.filter.query, screen.filter.machine ?? undefined, "desk"), view.overview("d", "desk"));
const T = 1790000000000;
window.snapshot = (n, answered) => {
  const rows = [["w:w0", { of: "workspace", workspace: "w0", name: "api" }]];
  for (let f = 0; f < 10; f++) rows.push(["f:w0/f" + f, { of: "frame", workspace: "w0", id: "f" + f, title: "frame " + f, color: "#336699", order: f, ...(f >= 5 ? { machine: { name: "box" } } : {}) }]);
  const lines = [];
  for (let i = 0; i < n; i++) {
    const waits = i % 4 === 0 && i >= answered * 4;
    rows.push(["t:w0/t" + i, { of: "tile", workspace: "w0", id: "t" + i, frameId: "f" + (i % 10), kind: "claude", name: "agent " + i, agent: "claude", order: i,
      state: waits ? "waiting" : "working", since: T + i, machine: i % 10 >= 5 ? "box" : "desk", interrupt: true,
      ...(waits ? { waiting: { kind: "permission", since: T + i, decide: true, tool: { name: "Bash", about: "npm test" } } } : {}) }]);
    lines.push(["t:w0/t" + i, "line " + i]);
  }
  return { t: "home", layout: { seq: 1, rows }, lines: { seq: 1, rows: lines } };
};
window.load = (n, answered) => { view.apply(JSON.stringify(window.snapshot(n, answered))); show(); };
window.change = (m) => { if (view.apply(JSON.stringify(m))) show(); };
window.ready = true;
</script>` });
    }
    const file = path.join(WWW, name);
    if (!fs.existsSync(file)) return route.fulfill({ status: 404 });
    const type = name.endsWith(".css") ? "text/css" : name.endsWith(".wasm") ? "application/wasm" : "text/javascript";
    return route.fulfill({ contentType: type, body: fs.readFileSync(file) });
  });
  await page.goto("http://page.test/index.html");
  await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready);
  return page;
}

type Driven = { load(n: number, answered: number): void; change(m: unknown): void; snapshot(n: number, answered: number): { layout: { rows: Array<[string, Record<string, unknown>]> } } };

test("a canvas of 200 tiles opens Home in under 500 ms on a CPU a quarter as fast: taken in whole, grouped and drawn to the next frame", async () => {
  test.skip(!built(), "build the page first (crates/hive-web/build.sh)");
  const page = await home();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const ms = await page.evaluate(() => new Promise<number>((done) => {
    const t0 = performance.now();
    (window as unknown as Driven).load(200, 0);
    requestAnimationFrame(() => setTimeout(() => done(performance.now() - t0)));
  }));
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  console.log(`Home of 200 tiles, CPU 4x slower: ${ms.toFixed(0)} ms`);
  await expect(page.locator("[data-tree] [data-agent]")).toHaveCount(200);
  await expect(page.locator("[data-need]")).toHaveCount(50);
  expect(ms).toBeLessThan(500);
});

test("among 200 tiles, one tile's new last line redraws its rows alone, and one wait answered removes its card, redraws its row and adds it to Working; nothing else on any list moves", async () => {
  test.skip(!built(), "build the page first (crates/hive-web/build.sh)");
  const page = await home();
  const changes = await page.evaluate(async () => {
    const w = window as unknown as Driven;
    w.load(200, 0);
    const lists = ["needs", "working", "tree"];
    let seen: Record<string, { added: number; removed: number }> = {};
    const reset = () => (seen = Object.fromEntries(lists.map((l) => [l, { added: 0, removed: 0 }])));
    reset();
    for (const list of lists) {
      new MutationObserver((records) => {
        for (const r of records) {
          seen[list]!.added += r.addedNodes.length;
          seen[list]!.removed += r.removedNodes.length;
        }
      }).observe(document.querySelector(`[data-${list}]`)!, { childList: true });
    }
    const settled = () => new Promise((r) => setTimeout(r));
    w.change({ t: "changes", lines: { seq: 2, changes: [{ seq: 2, key: "t:w0/t1", row: "compiling" }] } });
    await settled();
    const line = { ...seen };
    reset();
    const t0 = w.snapshot(200, 0).layout.rows.find(([k]) => k === "t:w0/t0")![1];
    const { waiting: _, ...answered } = { ...t0, state: "working", since: 1790000009000 };
    w.change({ t: "changes", layout: { seq: 2, changes: [{ seq: 2, key: "t:w0/t0", row: answered }] } });
    await settled();
    return { line, answered: seen };
  });
  expect(changes).toEqual({
    line: { needs: { added: 0, removed: 0 }, working: { added: 1, removed: 1 }, tree: { added: 1, removed: 1 } },
    answered: { needs: { added: 0, removed: 1 }, working: { added: 1, removed: 0 }, tree: { added: 1, removed: 1 } },
  });
  await expect(page.locator('[data-tree] [data-row="t:w0/t1"] [data-line]')).toHaveText("compiling");
});

test("of 200 tiles, the rows far below the screen are not rendered until scrolled near, and come in when they are", async () => {
  test.skip(!built(), "build the page first (crates/hive-web/build.sh)");
  const page = await home();
  // None waiting: the first row on screen is the first at work.
  await page.evaluate(() => (window as unknown as Driven).load(200, 50));
  const [first, last] = [page.locator("[data-working] [data-working-row]").first(), page.locator("[data-tree] [data-agent]").last()];
  const rendered = (row: typeof first) => row.locator(".name").evaluate((el) => el.checkVisibility({ contentVisibilityAuto: true }));
  // Which rows are near the screen is found as the next frame renders.
  await expect.poll(() => rendered(first)).toBe(true);
  expect(await rendered(last)).toBe(false);
  await last.scrollIntoViewIfNeeded();
  await expect.poll(() => rendered(last)).toBe(true);
});

test("a working agent's dot breathes, as on Android, while a few work; past 40 working, every dot is still", async () => {
  test.skip(!built(), "build the page first (crates/hive-web/build.sh)");
  const page = await home();
  const breathing = () => page.locator('[data-tree] [data-agent][data-state="working"] .dot').first().evaluate((el) => el.getAnimations().length);
  await page.evaluate(() => (window as unknown as Driven).load(40, 0));
  expect(await breathing()).toBe(1);
  await page.evaluate(() => (window as unknown as Driven).load(200, 0));
  expect(await breathing()).toBe(0);
});

test("searched, Home keeps the tiles whose name holds the words; a machine chosen keeps what is on it; chips show with more than one machine", async () => {
  test.skip(!built(), "build the page first (crates/hive-web/build.sh)");
  const page = await home();
  await page.evaluate(() => (window as unknown as Driven).load(20, 0));
  await expect(page.locator("[data-machines] .chip")).toHaveText(["desk", "box"]);
  await expect(page.locator("[data-tree] [data-machine]")).toHaveText(["desk", "box"]);
  await page.locator("[data-search]").fill("AGENT 1");
  // Each frame's in order, the computer's first: agent 10 is in frame 0.
  await expect(page.locator("[data-tree] [data-agent] .name")).toHaveText(["agent 10", "agent 1", "agent 11", "agent 12", "agent 13", "agent 14", "agent 15", "agent 16", "agent 17", "agent 18", "agent 19"]);
  await page.locator("[data-machines] .chip", { hasText: "box" }).click();
  await expect(page.locator("[data-machines] .chip", { hasText: "box" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("[data-tree] [data-machine]")).toHaveCount(0);
  await expect(page.locator("[data-tree] [data-agent] .name")).toHaveText(["agent 15", "agent 16", "agent 17", "agent 18", "agent 19"]);
  await page.locator("[data-search]").fill("");
  await page.locator("[data-machines] .chip", { hasText: "box" }).click();
  await expect(page.locator("[data-tree] [data-agent]")).toHaveCount(20);
});

test("a project's + starts an agent in that project's first frame, on its machine", async () => {
  test.skip(!built(), "build the page first (crates/hive-web/build.sh)");
  const page = await home();
  await page.evaluate(() => (window as unknown as Driven).load(20, 0));
  const plus = page.locator("[data-tree] [data-start-in]");
  await expect(plus).toHaveCount(2);
  await plus.nth(1).click();
  expect(await page.evaluate(() => location.hash)).toBe("#start&workspace=w0&frame=f5");
  await plus.nth(0).click();
  expect(await page.evaluate(() => location.hash)).toBe("#start&workspace=w0&frame=f0");
});

test("a tile that runs a terminal opens it from its row, as the computer marks it; one that does not is no button", async () => {
  test.skip(!built(), "build the page first (crates/hive-web/build.sh)");
  const page = await home();
  await page.evaluate(() => {
    const w = window as unknown as Driven;
    w.load(2, 1);
    const tile = (id: string, kind: string, more: object) => ({ seq: 2, key: `t:w0/${id}`, row: { of: "tile", workspace: "w0", id, frameId: "f0", kind, name: id, order: 9, ...more } });
    w.change({ t: "changes", layout: { seq: 3, changes: [tile("s1", "shell", { terminal: true }), { ...tile("n1", "note", {}), seq: 3 }] } });
  });
  await expect(page.locator('[data-tree] [data-row="t:w0/n1"]')).toHaveCount(1);
  await expect(page.locator('[data-tree] [data-row="t:w0/n1"] button')).toHaveCount(0);
  await page.locator('[data-tree] [data-row="t:w0/s1"]').click();
  expect(await page.evaluate(() => (window as unknown as { opened: unknown[] }).opened)).toEqual([["w0", "s1", "s1"]]);
});

test("a row says what it last said in sans 14/20, code in mono; its time in sans 13 with even digits; it is at least 56 px, a hairline between rows from where the text starts", async () => {
  test.skip(!built(), "build the page first (crates/hive-web/build.sh)");
  const page = await home();
  await page.evaluate(() => {
    const w = window as unknown as Driven;
    w.change({ ...w.snapshot(20, 0), lines: { seq: 1, rows: [["t:w0/t1", "`pnpm test` passes: 631 tests"], ["t:w0/t2", "Writing the notes"]] } });
  });
  const token = (name: string) => page.evaluate((n) => { const p = document.createElement("p"); p.style.color = `var(${n})`; document.body.append(p); return getComputedStyle(p).color; }, name);
  const style = (sel: string) => page.locator(sel).first().evaluate((el) => { const c = getComputedStyle(el); return { font: [c.fontSize, c.lineHeight, c.fontFamily.split(",")[0]], color: c.color, nums: c.fontVariantNumeric }; });
  const said = await style('[data-tree] [data-row="t:w0/t2"] [data-line]');
  expect(said.font).toEqual(["14px", "20px", "Geist"]);
  expect(said.color).toBe(await token("--text2"));
  await expect(page.locator('[data-tree] [data-row="t:w0/t1"] [data-line] code')).toHaveText("pnpm test");
  expect((await style('[data-tree] [data-row="t:w0/t1"] [data-line] code')).font[2]).toBe('"JetBrains Mono"');
  // What waits on the person: the tool in sans, its command in mono, in amber.
  await expect(page.locator('[data-tree] [data-row="t:w0/t0"] [data-line] code')).toHaveText("npm test");
  expect((await style('[data-tree] [data-row="t:w0/t0"] [data-line]')).color).toBe(await token("--warn"));
  const time = await style('[data-tree] [data-row="t:w0/t2"] [data-since]');
  expect(time.font.slice(0, 1).concat(time.font.slice(2))).toEqual(["13px", "Geist"]);
  expect(time.color).toBe(await token("--text3"));
  expect(time.nums).toBe("tabular-nums");
  // Measured on screen: a row away from it keeps a size of its own until scrolled near.
  const rows = page.locator("[data-tree] [data-agent]");
  for (const i of [0, 1, 2]) {
    await rows.nth(i).scrollIntoViewIfNeeded();
    expect(await rows.nth(i).evaluate((r) => r.getBoundingClientRect().height)).toBeGreaterThanOrEqual(56);
  }
  // The hairline over the second of two rows (frame 0's) starts where the text does.
  const line = await page.locator('[data-tree] [data-row="t:w0/t10"]').evaluate((row) => {
    const c = getComputedStyle(row, "::before");
    return { drawn: c.content !== "none", h: c.height, bg: c.backgroundColor, left: Math.round(parseFloat(c.left)), text: Math.round(row.querySelector(".col")!.getBoundingClientRect().left - row.getBoundingClientRect().left) };
  });
  expect(line.drawn).toBe(true);
  expect(line.h).toBe("1px");
  expect(line.left).toBe(line.text);
  expect(line.bg).toBe(await page.evaluate(() => { const p = document.createElement("p"); p.style.backgroundColor = "var(--line)"; document.body.append(p); return getComputedStyle(p).backgroundColor; }));
});

test("a project whose only frame carries its name shows no frame row, its tiles one level up; its heading, 13/600 in --text2, stays on top while its rows scroll under it", async () => {
  test.skip(!built(), "build the page first (crates/hive-web/build.sh)");
  const page = await home();
  await page.evaluate(() => {
    const tile = (id: string, frameId: string, order: number) => [`t:w0/${id}`, { of: "tile", workspace: "w0", id, frameId, kind: "claude", name: id, agent: "claude", order, state: "idle", since: 1790000000000, machine: "desk" }];
    const rows: unknown[] = [["w:w0", { of: "workspace", workspace: "w0", name: "api" }],
      ["f:w0/f0", { of: "frame", workspace: "w0", id: "f0", title: "API", color: "#336699", order: 0 }],
      ["f:w0/f1", { of: "frame", workspace: "w0", id: "f1", title: "web", color: "#336699", order: 1, project: "web" }],
      ["f:w0/f2", { of: "frame", workspace: "w0", id: "f2", title: "fix", color: "#336699", order: 2, project: "web" }]];
    for (let i = 0; i < 30; i++) rows.push(tile("a" + i, "f0", i));
    rows.push(tile("b0", "f1", 30), tile("c0", "f2", 31));
    (window as unknown as Driven).change({ t: "home", layout: { seq: 1, rows }, lines: { seq: 1, rows: [] } });
  });
  await expect(page.locator("[data-tree] [data-project]")).toHaveText(["api+", "web+"]);
  // "api" then "API" no more; a project of two frames keeps both.
  await expect(page.locator("[data-tree] [data-frame] .name")).toHaveText(["web", "fix"]);
  expect(await page.locator('[data-tree] [data-row="t:w0/a0"]').getAttribute("style")).toBe("--depth:0");
  const heading = page.locator("[data-tree] [data-project]").first();
  const look = await heading.evaluate((el) => {
    const c = getComputedStyle(el);
    const p = document.createElement("p"); p.style.color = "var(--text2)"; p.style.backgroundColor = "var(--canvas)"; document.body.append(p);
    const t = getComputedStyle(p);
    return { font: [c.fontSize, c.fontWeight], color: c.color, bg: c.backgroundColor, text2: t.color, canvas: t.backgroundColor };
  });
  expect(look.font).toEqual(["13px", "600"]);
  expect(look.color).toBe(look.text2);
  expect(look.bg).toBe(look.canvas);
  const top = await heading.evaluate((el) => {
    const screen = el.closest(".screen")!;
    screen.scrollTop = el.getBoundingClientRect().top - screen.getBoundingClientRect().top + 600;
    return Math.round(el.getBoundingClientRect().top - screen.getBoundingClientRect().top);
  });
  expect(top).toBe(0);
  // Opaque, and over the rows passing under it.
  const over = await heading.evaluate((el) => { const r = el.getBoundingClientRect(); return document.elementFromPoint(r.left + 4, r.top + r.height / 2)?.closest("[data-project]") === el; });
  expect(over).toBe(true);
});
