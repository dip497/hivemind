// The phone page's Home (docs/design/phone-browser-2026-10-03.md, B5 §2), in a phone-sized Chromium
// with no computer and no network: its built modules and wasm (crates/hive-web/build.sh) served
// from www by route. A 200-tile canvas opens in budget; an update touches only what changed; rows
// away from the screen are skipped; past a few working agents, their dots stop breathing; a search
// and a machine chosen narrow it; the View menu regroups it; a fold is kept; each agent has its mark.
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
      // The fonts in hand before the first layout, as index.html has them.
      const fonts = ["geist-400", "geist-500", "geist-600", "mono-400", "mono-500"].map((f) => `<link rel="preload" href="fonts/${f}.woff2" as="font" type="font/woff2" crossorigin>`).join("");
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="app.css">${fonts}<main id="app"></main>
<script type="module">
import init, { HomeView } from "./pkg/hive_web.js";
import { Home } from "./js/home.js";
await init();
const view = new HomeView(null);
window.opened = [];
window.calls = [];
const app = { open: (t) => window.calls.push(["open", t]), openTerminal: (...at) => window.opened.push(at), answer: async () => true, computer: () => "desk",
  stop: async (a) => { window.calls.push(["stop", a.tile]); return true; }, close: async (a) => { window.calls.push(["close", a.tile]); return true; } };
const screen = new Home(app, () => show());
document.getElementById("app").append(screen.el);
const show = () => screen.show(view.shown(screen.filter.query, screen.filter.machine ?? undefined, "desk", { ...screen.choices.view(), now: Date.now(), offset: 0 }), view.overview("d", "desk"));
const T = 1790000000000;
window.snapshot = (n, answered) => {
  const rows = [["w:w0", { of: "workspace", workspace: "w0", name: "api" }],
    ["a:claude", { of: "agent", id: "claude", label: "Claude", icon: { viewBox: "0 0 24 24", shapes: [{ path: { d: "m4 4h16v16h-16z" } }, { circle: { cx: 12, cy: 12, r: 3, fill: "none", stroke: "currentColor", "stroke-width": "2" } }, { rect: { x: 1, y: 1, width: 2, height: 2, fill: "#D97757" } }] } }]];
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
    const type = name.endsWith(".css") ? "text/css" : name.endsWith(".wasm") ? "application/wasm" : name.endsWith(".woff2") ? "font/woff2" : "text/javascript";
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

test("Home opens on 200 tiles without moving anything once drawn: no layout shift", async () => {
  test.skip(!built(), "build the page first (crates/hive-web/build.sh)");
  const page = await home();
  const shifted = await page.evaluate(async () => {
    let sum = 0;
    new PerformanceObserver((list) => { for (const e of list.getEntries()) sum += (e as unknown as { value: number }).value; }).observe({ type: "layout-shift", buffered: true });
    (window as unknown as Driven).load(200, 0);
    await document.fonts.ready;
    for (let i = 0; i < 30; i++) await new Promise(requestAnimationFrame);
    return sum;
  });
  expect(shifted).toBe(0);
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

test("a working agent's spinner turns while a few work; past 40 working, every one is still", async () => {
  test.skip(!built(), "build the page first (crates/hive-web/build.sh)");
  const page = await home();
  const breathing = () => page.locator('[data-tree] [data-agent][data-state="working"] .dot').first().evaluate((el) => el.getAnimations().length);
  await page.evaluate(() => (window as unknown as Driven).load(40, 0));
  expect(await breathing()).toBe(1);
  await page.evaluate(() => (window as unknown as Driven).load(200, 0));
  expect(await breathing()).toBe(0);
});

test("searched, Home keeps the tiles whose name holds the words; a machine chosen keeps what is on it, All every machine's; chips show with more than one machine", async () => {
  test.skip(!built(), "build the page first (crates/hive-web/build.sh)");
  const page = await home();
  await page.evaluate(() => (window as unknown as Driven).load(20, 0));
  await expect(page.locator("[data-machines] .chip")).toHaveText(["All", "desk", "box"]);
  await expect(page.locator("[data-machines] .chip", { hasText: "All" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("[data-tree] [data-machine]")).toHaveText(["desk", "box"]);
  await page.locator("[data-search]").fill("AGENT 1");
  // Each frame's in order, the computer's first: agent 10 is in frame 0.
  await expect(page.locator("[data-tree] [data-agent] .name")).toHaveText(["agent 10", "agent 1", "agent 11", "agent 12", "agent 13", "agent 14", "agent 15", "agent 16", "agent 17", "agent 18", "agent 19"]);
  await page.locator("[data-machines] .chip", { hasText: "box" }).click();
  await expect(page.locator("[data-machines] .chip", { hasText: "box" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("[data-tree] [data-machine]")).toHaveCount(0);
  await expect(page.locator("[data-tree] [data-agent] .name")).toHaveText(["agent 15", "agent 16", "agent 17", "agent 18", "agent 19"]);
  await page.locator("[data-search]").fill("");
  await page.locator("[data-machines] .chip", { hasText: "All" }).click();
  await expect(page.locator("[data-machines] .chip", { hasText: "All" })).toHaveAttribute("aria-pressed", "true");
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
  await expect(page.locator("[data-tree] [data-project] .name")).toHaveText(["api", "web"]);
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

test("a row has no ⋯: a tap opens it, held it offers what can be done to it, swiped left Stop and Close; Start is a 44 px +, the search a borderless --panel field 36 px high", async () => {
  test.skip(!built(), "build the page first (crates/hive-web/build.sh)");
  const page = await home();
  await page.evaluate(() => {
    const w = window as unknown as Driven;
    w.load(20, 5);
    w.change({ t: "changes", layout: { seq: 2, changes: [{ seq: 2, key: "t:w0/i1", row: { of: "tile", workspace: "w0", id: "i1", frameId: "f0", kind: "claude", name: "idle one", agent: "claude", order: 99, state: "idle", since: 1790000000000, machine: "desk", interrupt: true } }] } });
  });
  const calls = () => page.evaluate(() => (window as unknown as { calls: unknown[] }).calls);
  await expect(page.locator("[data-row-more]")).toHaveCount(0);
  await expect(page.locator(".agent", { hasText: "⋯" })).toHaveCount(0);
  const row = page.locator('[data-working-row="t0"]');
  await row.locator(".open").click();
  expect(await calls()).toEqual([["open", "t0"]]);
  await expect(page.locator("[data-row-actions]")).toBeHidden();
  // Held still: what can be done to it, and it is not opened.
  const at = (await row.locator(".open").boundingBox())!;
  await page.mouse.move(at.x + 40, at.y + at.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  await expect(page.locator("[data-row-actions] [data-row-stop]")).toBeVisible();
  expect(await calls()).toEqual([["open", "t0"]]);
  await page.locator("[data-row-actions] [data-row-cancel]").click();
  // A right click, as Android's own long press: the same.
  await page.locator('[data-working-row="t1"] .open').click({ button: "right" });
  await expect(page.locator("[data-row-actions] [data-row-stop]")).toBeVisible();
  expect(await calls()).toEqual([["open", "t0"]]);
  await page.locator("[data-row-actions] [data-row-cancel]").click();
  // Swiped left by touch: Stop and Close come out from under it; acted on, the row goes back.
  const cdp = await page.context().newCDPSession(page);
  const swipe = async (r: typeof row, by: number) => {
    await r.scrollIntoViewIfNeeded();
    const b = (await r.boundingBox())!;
    const y = Math.round(b.y + b.height / 2);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 360, y }] });
    for (let i = 1; i <= 12; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 360 - Math.round((i * by) / 12), y }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  // Seen: what is under the middle of a button is that button, not the row over it.
  const seen = (b: ReturnType<typeof row.locator>) => b.evaluate((el) => { const r = el.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest("button") === el; });
  const stop = row.locator("[data-swipe-stop]");
  await expect(row.locator(".behind")).toHaveCount(0);
  // Mid-drag, the face covers what it has not yet uncovered.
  const rb = (await row.boundingBox())!;
  const ry = Math.round(rb.y + rb.height / 2);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 360, y: ry }] });
  for (const x of [350, 340, 330, 320]) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: ry }] });
  expect(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest(".open"), [300, ry])).toBe(true);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(row.locator(".behind")).toHaveCount(0);
  await swipe(row, 40);
  await expect(row.locator(".behind")).toHaveCount(0);
  await swipe(row, 260);
  await expect.poll(() => seen(stop)).toBe(true);
  await expect.poll(() => seen(row.locator("[data-swipe-close]"))).toBe(true);
  await stop.click();
  expect(await calls()).toEqual([["open", "t0"], ["stop", "t0"]]);
  await expect(row.locator(".behind")).toHaveCount(0);
  // Open, a press on the row shuts it and opens nothing (a mouse's, whose click always comes).
  const idle = page.locator('[data-tree] [data-row="t:w0/i1"]');
  await swipe(idle, 260);
  await expect.poll(() => seen(idle.locator("[data-swipe-close]"))).toBe(true);
  const ib = (await idle.boundingBox())!;
  // The tap's click, counted first on its way down, so all it does is done before looking.
  const clicks = () => page.evaluate(() => (window as unknown as { clicks: number }).clicks);
  await page.evaluate(() => {
    const w = window as unknown as { clicks: number };
    w.clicks = 0;
    window.addEventListener("click", () => w.clicks++, { capture: true });
  });
  await page.mouse.click(ib.x + 100, ib.y + ib.height / 2);
  await expect.poll(clicks).toBe(1);
  await expect(idle.locator(".behind")).toHaveCount(0);
  expect(await calls()).toEqual([["open", "t0"], ["stop", "t0"]]);
  // One that is not at work has only Close, which asks first.
  await swipe(idle, 260);
  await expect.poll(() => seen(idle.locator("[data-swipe-close]"))).toBe(true);
  await expect(idle.locator("[data-swipe-stop]")).toHaveCount(0);
  await idle.locator("[data-swipe-close]").click();
  await expect(page.locator("[data-row-close-ask]")).toBeVisible();
  await page.locator("[data-row-close-ask] [data-yes]").click();
  await expect.poll(calls).toEqual([["open", "t0"], ["stop", "t0"], ["close", "i1"]]);
  // Start: a + of 44 px; the search: no border, --panel, 36 px, corners of 10.
  const start = page.locator("[data-start]");
  await expect(start).toHaveAttribute("aria-label", "Start an agent");
  expect(await start.evaluate((b) => [b.getBoundingClientRect().width, b.getBoundingClientRect().height, b.textContent, !!b.querySelector("svg")])).toEqual([44, 44, "", true]);
  const search = await page.locator("[data-search]").evaluate((el) => {
    const c = getComputedStyle(el);
    const p = document.createElement("p"); p.style.backgroundColor = "var(--panel)"; document.body.append(p);
    return { border: c.borderTopWidth, bg: c.backgroundColor, panel: getComputedStyle(p).backgroundColor, h: el.getBoundingClientRect().height, radius: c.borderTopLeftRadius };
  });
  expect(search).toEqual({ border: "0px", bg: search.panel, panel: search.panel, h: 36, radius: "10px" });
});

test("the View menu changes what Home lists: grouped by status, a heading for each with how many under it; the View button carries a dot while a choice is not its first", async () => {
  test.skip(!built(), "build the page first (crates/hive-web/build.sh)");
  const page = await home();
  await page.evaluate(() => (window as unknown as Driven).load(20, 0));
  const chosen = page.locator("[data-view-open] [data-view-chosen]");
  await expect(page.locator("[data-tree] [data-section]")).toHaveCount(0);
  await expect(chosen).toBeHidden();
  await page.locator("[data-view-open]").click();
  const sheet = page.locator("[data-view-sheet]");
  await expect(sheet.locator("[data-view] .label-small")).toHaveText(["Status", "Last activity", "Group by", "Sort by"]);
  await expect(sheet.locator('[data-view="groupBy"] .chip')).toHaveText(["Project", "Machine", "Date", "Status", "Agent", "None"]);
  await sheet.locator('[data-view="groupBy"] .chip', { hasText: "Status" }).click();
  await expect(sheet.locator('[data-view="groupBy"] .chip', { hasText: "Status" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("[data-tree] [data-section] .name")).toHaveText(["Needs you", "Working"]);
  await expect(page.locator("[data-tree] [data-section] [data-rows]")).toHaveText(["5", "15"]);
  await expect(page.locator("[data-tree] [data-machine], [data-tree] [data-project], [data-tree] [data-frame]")).toHaveCount(0);
  await expect(page.locator("[data-tree] [data-agent]")).toHaveCount(20);
  await page.locator("[data-view-done]").click();
  await expect(sheet).toBeHidden();
  await expect(chosen).toBeVisible();
  // Needs you alone: the five waiting, under their one heading.
  await page.locator("[data-view-open]").click();
  await sheet.locator('[data-view="status"] .chip', { hasText: "Needs you" }).click();
  await expect(page.locator("[data-tree] [data-section] .name")).toHaveText(["Needs you"]);
  await expect(page.locator("[data-tree] [data-agent] .name")).toHaveText(["agent 0", "agent 4", "agent 8", "agent 12", "agent 16"]);
  // Reset to defaults: every choice its first again, the tree back.
  const reset = sheet.locator("[data-view-reset]");
  await reset.click();
  await expect(page.locator("[data-tree] [data-section]")).toHaveCount(0);
  await expect(page.locator("[data-tree] [data-machine]")).toHaveText(["desk", "box"]);
  await expect(sheet.locator('[data-view="status"] .chip', { hasText: "All" })).toHaveAttribute("aria-pressed", "true");
  await expect(reset).toBeDisabled();
  await expect(chosen).toBeHidden();
});

test("a frame tapped folds its tiles away and says how many it holds; folded, it stays so when the page opens again", async () => {
  test.skip(!built(), "build the page first (crates/hive-web/build.sh)");
  const page = await home();
  await page.evaluate(() => (window as unknown as Driven).load(20, 0));
  const frame = page.locator('[data-tree] [data-frame="f:w0/f0"]');
  const tiles = page.locator('[data-tree] [data-row="t:w0/t0"], [data-tree] [data-row="t:w0/t10"]');
  await expect(tiles).toHaveCount(2);
  await expect(frame.locator("[data-rows]")).toHaveText("2");
  // Waiting under it: its heading says so.
  await expect(frame.locator(".needs-you")).toHaveText("Needs you");
  await frame.locator("[data-fold]").click();
  await expect(frame.locator("[data-fold]")).toHaveAttribute("aria-expanded", "false");
  await expect(tiles).toHaveCount(0);
  await expect(frame.locator("[data-rows]")).toHaveText("2");
  await expect(page.locator('[data-tree] [data-row="t:w0/t1"]')).toHaveCount(1);
  await page.reload();
  await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready);
  await page.evaluate(() => (window as unknown as Driven).load(20, 0));
  await expect(page.locator('[data-tree] [data-frame="f:w0/f0"] [data-fold]')).toHaveAttribute("aria-expanded", "false");
  await expect(tiles).toHaveCount(0);
  await expect(page.locator('[data-tree] [data-row="t:w0/t1"]')).toHaveCount(1);
  // Tapped again, its tiles are back.
  await page.locator('[data-tree] [data-frame="f:w0/f0"] [data-fold]').click();
  await expect(tiles).toHaveCount(2);
});

test("a tile's row draws its agent's own mark in its own colours, as the computer gives it; a shell's a terminal, any other kind's a window", async () => {
  test.skip(!built(), "build the page first (crates/hive-web/build.sh)");
  const page = await home();
  await page.evaluate(() => {
    const w = window as unknown as Driven;
    w.load(2, 1);
    const tile = (id: string, kind: string, more: object) => ({ seq: 2, key: `t:w0/${id}`, row: { of: "tile", workspace: "w0", id, frameId: "f0", kind, name: id, order: 9, ...more } });
    w.change({ t: "changes", layout: { seq: 3, changes: [tile("s1", "shell", { terminal: true }), { ...tile("n1", "note", {}), seq: 3 }] } });
  });
  const drawn = await page.locator('[data-tree] [data-row="t:w0/t1"] .avatar svg').evaluate((svg) => ({
    box: svg.getAttribute("viewBox"),
    paths: [...svg.querySelectorAll("path")].map((p) => [p.getAttribute("d"), p.getAttribute("fill"), p.getAttribute("stroke")]),
    color: getComputedStyle(svg).color,
    text: (() => { const p = document.createElement("p"); p.style.color = "var(--text)"; document.body.append(p); return getComputedStyle(p).color; })(),
  }));
  expect(drawn.box).toBe("0 0 24 24");
  expect(drawn.paths).toHaveLength(3);
  expect(drawn.paths[0]![1]).toBe("currentColor");
  // A shape in the brand's own colour is drawn in it.
  expect(drawn.paths[2]![1]).toBe("#d97757");
  expect(drawn.paths[0]![0]).toMatch(/^M\s*4[ ,]4/);
  expect(drawn.paths[1]!.slice(1)).toEqual(["none", "currentColor"]);
  expect(drawn.color).toBe(drawn.text);
  await expect(page.locator('[data-tree] [data-row="t:w0/t1"] .avatar')).toHaveAttribute("data-mark", "claude");
  await expect(page.locator('[data-tree] [data-row="t:w0/s1"] .avatar')).toHaveAttribute("data-mark", "terminal");
  await expect(page.locator('[data-tree] [data-row="t:w0/n1"] .avatar')).toHaveAttribute("data-mark", "window");
});
