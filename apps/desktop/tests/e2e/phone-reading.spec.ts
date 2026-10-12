// Reading on the phone page (docs/design/phone-browser-2026-10-03.md §11.5): what an agent says,
// read by the core's wasm (spec/markdown.md), drawn as text nodes only, a link only to an https
// address, each paragraph in its own direction; a tool unfolded to its input and what it gave back
// whole, asked of the computer; and the box a message is typed in. In a
// phone-sized Chromium with no computer: the page's built modules and wasm
// (crates/hive-web/build.sh) served from www by route.
import { test, expect, chromium, type Browser, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const WWW = path.resolve("../../crates/hive-web/www");

let browser: Browser | undefined;
let page: Page;
test.beforeEach(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page.on("pageerror", (e) => { throw e; });
  await page.route("http://page.test/**", (route) => {
    const name = new URL(route.request().url()).pathname.slice(1);
    if (name === "index.html") {
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="app.css"><main id="app"><div class="said-agent md" data-said></div></main>
<script type="module">
import init from "./pkg/hive_web.js";
import { markdown } from "./js/markdown.js";
import { composer } from "./js/dom.js";
import { Chat } from "./js/chat.js";
await init();
window.draw = (text) => document.querySelector("[data-said]").replaceChildren(...markdown(text));
let chat;
window.say = (piece) => {
  if (!chat) {
    chat = new Chat();
    chat.el.style.height = "400px";
    document.getElementById("app").append(chat.el);
  }
  chat.said(piece);
  return chat.el.querySelectorAll("[data-entry]").length;
};
// A chat whose tools unfold: \`answers\` is what the computer answers for each use (\`{ error }\`: it
// fails), \`asked\` each use asked for.
window.asked = [];
window.answers = {};
let unfolding;
window.sayUnfolding = (piece) => {
  if (!unfolding) {
    unfolding = new Chat((use) => {
      window.asked.push(use);
      const a = window.answers[use];
      return a?.error ? Promise.reject(new Error(a.error)) : Promise.resolve(a);
    });
    document.getElementById("app").append(unfolding.el);
  }
  unfolding.said(piece);
};
window.composer = (hint) => document.getElementById("app").append(composer(hint, async () => true, { "data-composer": hint }));
window.ready = true;
</script>` });
    }
    const file = path.join(WWW, name);
    if (!fs.existsSync(file)) return route.fulfill({ status: 404 });
    const type = name.endsWith(".css") ? "text/css" : name.endsWith(".wasm") ? "application/wasm" : "text/javascript";
    return route.fulfill({ contentType: type, body: fs.readFileSync(file) });
  });
  // Anything the page would fetch from elsewhere, an image's address included, is refused and seen.
  await page.route((url) => url.host !== "page.test", (route) => { fetched.push(route.request().url()); return route.abort(); });
  fetched = [];
  await page.goto("http://page.test/index.html");
  await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready);
});
test.afterEach(async () => {
  await browser?.close();
  browser = undefined;
});
let fetched: string[] = [];

const said = () => page.locator("[data-said]");
const draw = (text: string) => page.evaluate((t) => (window as unknown as { draw(t: string): void }).draw(t), text);

test("emphasis is italic, strikethrough struck, strong bold, code monospace; a mark not closed is a character written", async () => {
  await draw("a *it* ~~gone~~ **bold** `x()` 2*3");
  await expect(said().locator("em")).toHaveText("it");
  await expect(said().locator("s")).toHaveText("gone");
  await expect(said().locator("strong")).toHaveText("bold");
  await expect(said().locator("code")).toHaveText("x()");
  await expect(said()).toHaveText("a it gone bold x() 2*3");
  expect(await said().locator("em").evaluate((e) => getComputedStyle(e).fontStyle)).toBe("italic");
  expect(await said().locator("s").evaluate((e) => getComputedStyle(e).textDecorationLine)).toBe("line-through");
});

test("a heading is drawn at its level, larger than the text, the higher the larger", async () => {
  await draw("# One\n\n### Three\n\ntext");
  await expect(said().locator("h1")).toHaveText("One");
  await expect(said().locator("h3")).toHaveText("Three");
  const size = (sel: string) => said().locator(sel).evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
  const [one, three, text] = [await size("h1"), await size("h3"), await size("p")];
  expect(one).toBeGreaterThan(three);
  expect(three).toBeGreaterThanOrEqual(text);
});

test("fenced code is drawn as written, under its language", async () => {
  await draw("```rust\nlet x = **1**;\n```");
  await expect(said().locator("pre code")).toHaveText("let x = **1**;");
  await expect(said().locator("[data-language]")).toHaveText("rust");
});

test("a table is drawn as one: its head's cells, then each row's, aligned as its columns say", async () => {
  await draw("| name | n |\n|:--|--:|\n| a | **1** |\n| b | 22 |");
  await expect(said().locator("table th")).toHaveText(["name", "n"]);
  await expect(said().locator("table tr:has(td)")).toHaveText(["a1", "b22"]);
  await expect(said().locator("table td strong")).toHaveText("1");
  expect(await said().locator("table td").nth(1).evaluate((e) => getComputedStyle(e).textAlign)).toBe("right");
});

test("a link to an https address, written or bare, opens it in another tab; any other stays text with nothing to tap", async () => {
  await draw("[site](https://example.com/a) and https://b.io/c. [x](javascript:alert(1)) [y](http://plain.io) <data:text/html,hi>");
  const links = said().locator("a");
  await expect(links).toHaveText(["site", "https://b.io/c"]);
  expect(await links.evaluateAll((as) => as.map((a) => [a.getAttribute("href"), a.getAttribute("target"), a.getAttribute("rel")]))).toEqual([
    ["https://example.com/a", "_blank", "noopener noreferrer"],
    ["https://b.io/c", "_blank", "noopener noreferrer"],
  ]);
  await expect(said()).toHaveText("site and https://b.io/c. x y data:text/html,hi");
});

test("a nested list's items are drawn further in, each with its bullet or number", async () => {
  await draw("- outer\n  - inner\n\n3. three\n4. four");
  const items = said().locator("[data-marker]");
  await expect(items).toHaveText(["•", "•", "3.", "4."]);
  const left = (text: string) => said().getByText(text, { exact: true }).evaluate((e) => e.getBoundingClientRect().left);
  expect(await left("inner")).toBeGreaterThan(await left("outer"));
  expect(await left("three")).toBe(await left("outer"));
});

test("a task list's items show whether each is done, and cannot be ticked here", async () => {
  await draw("- [ ] todo\n- [x] done");
  const boxes = said().locator("input[type=checkbox]");
  expect(await boxes.evaluateAll((bs) => bs.map((b) => [(b as HTMLInputElement).checked, (b as HTMLInputElement).disabled]))).toEqual([[false, true], [true, true]]);
  await expect(said()).toHaveText("tododone");
});

test("a quote is drawn set in, a quote in it further, and a rule as a line", async () => {
  await draw("> said\n>\n> > deeper\n\n---\n\nafter");
  await expect(said().locator("blockquote")).toHaveCount(2);
  await expect(said().locator("blockquote blockquote")).toHaveText("deeper");
  await expect(said().locator("hr")).toHaveCount(1);
  const left = (text: string) => said().getByText(text, { exact: true }).evaluate((e) => e.getBoundingClientRect().left);
  expect(await left("deeper")).toBeGreaterThan(await left("said"));
  expect(await left("said")).toBeGreaterThan(await left("after"));
});

test("an image is shown by its words, opened only when tapped and only when https; nothing is fetched to draw it", async () => {
  await draw("![a cat](https://e.com/c.png) ![x](http://e.com/d.png)");
  const image = said().locator("[data-image]");
  await expect(image).toHaveText(["a cat", "x"]);
  expect(await image.evaluateAll((is) => is.map((i) => i.getAttribute("href")))).toEqual(["https://e.com/c.png", null]);
  await expect(said().locator("img")).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(fetched).toEqual([]);
});

test("raw HTML is drawn as the text it is", async () => {
  await draw("<b>hi</b> <img src=x onerror=alert(1)>\n\n<script>alert(2)</script>");
  await expect(said().locator("b, img, script")).toHaveCount(0);
  await expect(said()).toHaveText("<b>hi</b> <img src=x onerror=alert(1)><script>alert(2)</script>");
});

test("each paragraph, heading and cell runs in the direction of its own first letter: Arabic from the right, English from the left", async () => {
  await draw("## مرحبا\n\nهذا نص عربي.\n\nThis is English.\n\n| a | عنوان طويل للعمود |\n|--|--|\n| x | نعم |");
  /** How far the text sits from its box's right edge, and from its left. */
  const gaps = (text: string) => said().getByText(text, { exact: true }).evaluate((e) => {
    const range = document.createRange();
    range.selectNodeContents(e);
    const text = range.getBoundingClientRect();
    const box = e.getBoundingClientRect();
    const style = getComputedStyle(e);
    const inset = (side: "Left" | "Right") => parseFloat(style[`padding${side}`]) + parseFloat(style[`border${side}Width`]);
    return { right: Math.round(box.right - inset("Right") - text.right) + 0, left: Math.round(text.left - box.left - inset("Left")) + 0 };
  });
  expect(await gaps("هذا نص عربي.")).toMatchObject({ right: 0 });
  expect((await gaps("هذا نص عربي.")).left).toBeGreaterThan(0);
  expect(await gaps("مرحبا")).toMatchObject({ right: 0 });
  expect(await gaps("This is English.")).toMatchObject({ left: 0 });
  expect((await gaps("This is English.")).right).toBeGreaterThan(0);
  expect(await gaps("نعم")).toMatchObject({ right: 0 });
  expect((await gaps("نعم")).left).toBeGreaterThan(0);
});

test("a message box's hint, however long the agent's name, stays on one line, before anything is typed and once it is cleared", async () => {
  const long = "Message claude-refactor-the-login-redirect-flow-and-its-tests";
  await page.evaluate((h) => { const w = window as unknown as { composer(h: string): void }; w.composer("Message"); w.composer(h); }, long);
  const field = (hint: string) => page.locator(`[data-composer="${hint}"] textarea`);
  const height = (hint: string) => field(hint).evaluate((t) => t.getBoundingClientRect().height);
  const one = await height("Message");
  expect(await height(long)).toBe(one);
  await field(long).fill("x");
  await field(long).fill("");
  expect(await height(long)).toBe(one);
});

test("a long conversation shows its newest at once, then what was said before above it, in order, the screen staying on the newest", async () => {
  const n = 600;
  // A tool used early, what it gave back near the end: on one row, however far apart they are drawn.
  const entries = Array.from({ length: n }, (_, i) =>
    i === 5 ? { id: "e5", at: i, who: "agent", tool: { id: "u", name: "Bash", about: "npm test" } }
    : i === n - 2 ? { id: `e${i}`, at: i, who: "tool", result: { of: "u", text: "passed" } }
    : { id: `e${i}`, at: i, who: i % 2 ? "agent" : "person", text: i % 2 ? `**${i}**, with \`code\` and [a link](https://a.b/${i})` : `${i}` });
  const atOnce = await page.evaluate((p) => (window as unknown as { say(p: unknown): number }).say(p), { entries, cursor: n, session: "s" });
  expect(atOnce).toBeGreaterThan(0);
  expect(atOnce).toBeLessThan(n - 1);
  const chat = page.locator("[data-chat]");
  await expect(chat.locator("[data-entry]")).toHaveCount(n - 1);
  expect(await chat.locator("[data-entry]").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-entry")))).toEqual(
    entries.filter((e) => !e.result).map((e) => e.id));
  await expect(chat.locator('[data-entry="e5"]')).toHaveAttribute("data-ended", "ok");
  await expect(chat.locator('[data-entry="e5"] pre')).toHaveText("passed");
  expect(await chat.evaluate((c) => c.scrollHeight - c.scrollTop - c.clientHeight)).toBeLessThan(1);
});

type Unfolding = { asked: string[]; answers: Record<string, unknown>; sayUnfolding(p: unknown): void };
const unfolding = (piece: unknown) => page.evaluate((p) => (window as unknown as Unfolding).sayUnfolding(p), piece);
const answer = (use: string, a: unknown) => page.evaluate(([u, x]) => { (window as unknown as Unfolding).answers[u as string] = x; }, [use, a] as const);
const asked = () => page.evaluate(() => (window as unknown as Unfolding).asked);

test("a tool unfolds to its input and what it gave back, whole, asked of the computer when first opened: before it gave back, its input; after, asked again for the rest; cut short, it says so; once whole, not asked again", async () => {
  const input = JSON.stringify({ command: "npm test", description: "Run the tests" }, null, 2);
  await answer("u1", { name: "Bash", about: "npm test", input });
  await unfolding({ entries: [{ id: "e1", at: 1, who: "agent", tool: { id: "u1", name: "Bash", about: "npm test" } }], cursor: 1, session: "s" });
  const row = page.locator('[data-entry="e1"]');
  const open = row.locator("button");
  // Still running, it unfolds all the same: to its input.
  await open.click();
  await expect(row.locator("[data-input]")).toHaveText(input);
  await expect(row.locator("[data-gave]")).toHaveCount(0);
  expect(await asked()).toEqual(["u1"]);
  // What it gave back comes while it is open, as sent: the row shows it under its input until the
  // whole of it is asked for.
  const whole = `passed\n${"ok\n".repeat(2000)}`;
  await unfolding({ entries: [{ id: "e2", at: 2, who: "tool", result: { of: "u1", text: whole.slice(0, 2000) } }], cursor: 2, session: "s" });
  await expect(row.locator(":scope > pre")).toHaveText(whole.slice(0, 2000));
  await expect(row.locator(":scope > pre")).toBeVisible();
  await open.click();
  await expect(row.locator("[data-unfolded]")).toBeHidden();
  await answer("u1", { name: "Bash", about: "npm test", input, result: { text: whole }, truncated: true });
  await open.click();
  await expect(row.locator("[data-gave]")).toHaveText(whole);
  await expect(row.locator(":scope > pre")).toBeHidden();
  await expect(row.locator("[data-truncated]")).toBeVisible();
  expect(await asked()).toEqual(["u1", "u1"]);
  await open.click();
  await open.click();
  await expect(row.locator("[data-gave]")).toHaveText(whole);
  expect(await asked()).toEqual(["u1", "u1"]);
});

test("a tool the computer cannot unfold says why, and shows what it gave back as sent", async () => {
  await answer("u2", { error: "no such tool use in what this agent said" });
  await unfolding({ entries: [
    { id: "e3", at: 3, who: "agent", tool: { id: "u2", name: "Read", about: "a.ts" } },
    { id: "e4", at: 4, who: "tool", result: { of: "u2", text: "the file", error: true } },
  ], cursor: 4, session: "s" });
  const row = page.locator('[data-entry="e3"]');
  await row.locator("button").click();
  await expect(row.locator("[data-unfold-error]")).toHaveText("It could not be unfolded: no such tool use in what this agent said");
  await expect(row.locator(":scope > pre")).toHaveText("the file");
  await expect(row.locator(":scope > pre")).toBeVisible();
  await expect(row).toHaveAttribute("data-ended", "failed");
});
