// One agent on the phone page (crates/hive-web/www/app/agent.ts), in a phone-sized Chromium with no
// computer: the page's built modules (crates/hive-web/build.sh) served from www by route, the
// computer's overview given by the test through `window.show(overview)`.
import { test, expect, chromium, type Browser, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const WWW = path.resolve("../../crates/hive-web/www");
const built = () => fs.existsSync(path.join(WWW, "js", "agent.js"));

let browser: Browser | undefined;
test.afterEach(async () => {
  await browser?.close();
  browser = undefined;
});

const agent = (tile: string, name: string, more: object = {}) => ({
  workspace: "w0", name: "project", tile, agent: name, program: { id: "claude", label: "Claude" }, state: "idle", since: 1,
  machine: "desk", conversation: true, interrupt: true, device: "d0", ...more,
});
const overview = (...agents: object[]) => ({ agents, needs: [], working: 0 });

/** The agent screen; `window.open(tile, started)` opens it as the page does, `window.show(o)` tells it
 *  the agents. With `clock`, the page's time starts there and moves only as the test moves it. */
async function screen(clock?: number): Promise<Page> {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  if (clock !== undefined) await page.clock.install({ time: clock - 60_000 });
  page.on("pageerror", (e) => { throw e; });
  await page.route("http://page.test/**", (route) => {
    const name = new URL(route.request().url()).pathname.slice(1);
    if (name === "index.html") {
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="app.css"><main id="app"></main>
<script type="module">
import { AgentScreen } from "./js/agent.js";
window.calls = [];
const app = {
  back() {}, computer: () => "desk",
  conversation: (a, said) => (window.calls.push(["conversation", a.tile]), window.said = said, () => {}),
  terminal: () => null,
  tool: async () => ({}),
  answer: async (a, reply) => (window.calls.push(["answer", a.tile, reply]), true),
  send: async (a, text) => (window.calls.push(["send", a.tile, text]), true),
  stop: async (a) => (window.calls.push(["stop", a.tile]), true),
  close: async (a) => (window.calls.push(["close", a.tile]), true),
};
const screen = new AgentScreen(app);
document.getElementById("app").append(screen.el);
let last = null;
window.open = (tile, started) => { if (started) screen.starting?.(tile); screen.open(tile, last); };
window.show = (o) => { last = o; screen.show(o); };
window.ready = true;
</script>` });
    }
    const file = path.join(WWW, name);
    if (!fs.existsSync(file)) return route.fulfill({ status: 404 });
    return route.fulfill({ contentType: name.endsWith(".css") ? "text/css" : "text/javascript", body: fs.readFileSync(file) });
  });
  await page.goto("http://page.test/index.html");
  await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready);
  if (clock !== undefined) await page.clock.pauseAt(clock);
  return page;
}

type Window_ = { open(tile: string, started?: boolean): void; show(o: object): void };
const open = (page: Page, tile: string, started = false) => page.evaluate(([t, s]) => (window as unknown as Window_).open(t as string, s as boolean), [tile, started] as const);
const show = (page: Page, o: object) => page.evaluate((x) => (window as unknown as Window_).show(x), o);

test("an agent just started shows as starting until the computer lists it, never as the agent shown before it, nor as gone", async () => {
  test.skip(!built(), "no page build: run crates/hive-web/build.sh");
  const page = await screen();
  const title = page.locator("[data-screen=agent] header h1");
  const notice = page.locator("[data-screen=agent] > p.quiet");
  await show(page, overview(agent("t1", "Phone test", { state: "waiting" })));
  await open(page, "t1");
  await expect(title).toHaveText("Phone test");
  // Back to Home, Start, and the new agent opens before the computer lists it.
  await open(page, "t9", true);
  await expect(title).toHaveText("");
  await expect(page.locator("[data-screen=agent] .sub")).toHaveText("");
  await expect(notice).toHaveText("Starting…");
  await expect(notice).toBeVisible();
  await show(page, overview(agent("t1", "Phone test"), agent("t9", "Reply with exactly", { state: "working" })));
  await expect(title).toHaveText("Reply with exactly");
  await expect(notice).toBeHidden();
  // Listed once, it is no longer starting: closed, it is gone.
  await show(page, overview(agent("t1", "Phone test")));
  await expect(notice).toHaveText("No agent runs there now.");
  // Opened from an old link, an agent never started here is gone at once.
  await open(page, "t5");
  await expect(notice).toHaveText("No agent runs there now.");
  await expect(notice).toBeVisible();
});

test("an agent that keeps no conversation the phone can read opens in its terminal; one that does opens in its chat", async () => {
  test.skip(!built(), "no page build: run crates/hive-web/build.sh");
  const page = await screen();
  const flip = page.locator("[data-view-toggle]");
  const { conversation: _, ...unread } = agent("t2", "Gemini", { program: { id: "gemini", label: "Gemini" } }) as { conversation?: boolean };
  await show(page, overview(agent("t1", "Claude"), unread));
  await open(page, "t2");
  await expect(page.locator("[data-screen=agent] [data-terminal]")).toBeVisible();
  await expect(flip).toHaveAttribute("aria-label", "Chat");
  await open(page, "t1");
  await expect(page.locator("[data-screen=agent] [data-terminal]")).toBeHidden();
  await expect(flip).toHaveAttribute("aria-label", "Terminal");
});

test("a question its agent asks shows each option with what it means, chosen by its place, and a line typed for anything else; never Allow or Deny", async () => {
  test.skip(!built(), "no page build: run crates/hive-web/build.sh");
  const page = await screen();
  const waiting = { kind: "question", since: 5, choose: true, asks: [{
    question: "Which line should I add to hello.txt next?",
    options: ["Nothing", "A timestamp", "\"test passed\""],
    descriptions: ["Leave hello.txt as it is", "Add today's date and time as a new line", "Add the line \"test passed\""],
  }] };
  await show(page, overview(agent("t1", "Phone test", { state: "waiting", waiting })));
  await open(page, "t1");
  const card = page.locator("[data-screen=agent] [data-waiting-card]");
  await expect(card.locator("[data-question]")).toHaveText("Which line should I add to hello.txt next?");
  const choices = card.locator("[data-choice]");
  await expect(choices).toHaveCount(3);
  await expect(choices.nth(1).locator(".label")).toHaveText("A timestamp");
  await expect(choices.nth(1).locator(".description")).toHaveText("Add today's date and time as a new line");
  await expect(card.locator("[data-answer=allow], [data-answer=deny]")).toHaveCount(0);
  await expect(card.locator("textarea")).toHaveCount(0);
  await choices.nth(1).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { calls: unknown[] }).calls.filter((c) => (c as string[])[0] === "answer"))).toEqual([["answer", "t1", { answers: [{ chosen: [1] }] }]]);
});

test("two questions, the second of several answers, each show their own options and a line of their own; Send waits for an answer to each and carries both, in order", async () => {
  test.skip(!built(), "no page build: run crates/hive-web/build.sh");
  const page = await screen();
  const waiting = { kind: "question", since: 5, choose: true, asks: [
    { question: "Which fruit?", options: ["Apple", "Banana", "Mango"] },
    { question: "Which colours?", options: ["Red", "Green", "Blue"], many: true },
  ] };
  await show(page, overview(agent("t1", "Phone test", { state: "waiting", waiting })));
  await open(page, "t1");
  const card = page.locator("[data-screen=agent] [data-waiting-card]");
  const fruit = card.locator("[data-question]").nth(0);
  const colour = card.locator("[data-question]").nth(1);
  await expect(card.locator("[data-question] > p:first-child")).toHaveText(["Which fruit?", "Which colours?"]);
  await expect(fruit.locator("[data-choice]")).toHaveText(["Apple", "Banana", "Mango"]);
  await expect(colour.locator("[data-choice]")).toHaveText(["Red", "Green", "Blue"]);
  await expect(card.locator("[data-answer=allow], [data-answer=deny]")).toHaveCount(0);
  const send = card.locator("[data-answer=send]");
  const pressed = (q: typeof fruit) => q.locator("[data-choice][aria-pressed=true]");
  await expect(send).toBeDisabled();
  await fruit.locator("[data-choice]").nth(1).click();
  await expect(send).toBeDisabled();
  // One fruit: a second replaces the first. Several colours: each toggles.
  await fruit.locator("[data-choice]").nth(2).click();
  await expect(pressed(fruit)).toHaveText(["Mango"]);
  for (const n of [0, 1, 2, 1]) await colour.locator("[data-choice]").nth(n).click();
  await expect(pressed(colour)).toHaveText(["Red", "Blue"]);
  await expect(send).toBeEnabled();
  const calls = () => page.evaluate(() => (window as unknown as { calls: unknown[] }).calls.filter((c) => (c as string[])[0] === "answer"));
  expect(await calls()).toEqual([]);
  // A line of its own answers the fruit instead of an option.
  await fruit.locator("[data-own]").fill("Durian");
  await expect(pressed(fruit)).toHaveCount(0);
  await send.click();
  await expect.poll(calls).toEqual([["answer", "t1", { answers: [{ text: "Durian" }, { chosen: [0, 2] }] }]]);
});

test("in its terminal, which shows the chooser itself, a waiting agent's card is put away and its header still says it waits; back in its chat the card is as it was", async () => {
  test.skip(!built(), "no page build: run crates/hive-web/build.sh");
  const page = await screen();
  const waiting = { kind: "question", since: 5, choose: true, asks: [{ question: "Which colour?", options: ["Red", "Green", "Blue"] }] };
  await show(page, overview(agent("t1", "Phone test", { state: "waiting", waiting })));
  await open(page, "t1");
  const card = page.locator("[data-screen=agent] [data-waiting-card]");
  const flip = page.locator("[data-view-toggle]");
  await expect(card.locator("[data-choice]")).toHaveCount(3);
  await flip.click();
  await expect(page.locator("[data-screen=agent] [data-terminal]")).toBeVisible();
  await expect(card).toBeHidden();
  await expect(page.locator("[data-screen=agent] .backbar .waits")).toHaveText(/^waiting/i);
  await flip.click();
  await expect(card).toBeVisible();
  await expect(card.locator("[data-choice]")).toHaveText(["Red", "Green", "Blue"]);
  // Another agent opened from its terminal shows its own card.
  await flip.click();
  await expect(card).toBeHidden();
  await show(page, overview(agent("t1", "Phone test", { state: "waiting", waiting }), agent("t2", "Other", { state: "waiting", waiting })));
  await open(page, "t2");
  await expect(card).toBeVisible();
});

test("one place to type: while a question waits, the message box offers the person's own answer and sends it as the answer; once answered it is a message again", async () => {
  test.skip(!built(), "no page build: run crates/hive-web/build.sh");
  const page = await screen();
  const waiting = { kind: "question", since: 5, choose: true, asks: [{ question: "Which colour?", options: ["Red", "Green"] }] };
  await show(page, overview(agent("t1", "Claude", { state: "waiting", waiting })));
  await open(page, "t1");
  const box = page.locator("[data-screen=agent] textarea");
  await expect(box).toHaveCount(1);
  await expect(box).toHaveAttribute("placeholder", "Or type your own answer");
  await box.fill("Purple");
  await page.locator("[data-message] button[type=submit]").click();
  const said = () => page.evaluate(() => (window as unknown as { calls: string[][] }).calls.filter((c) => c[0] !== "conversation"));
  await expect.poll(said).toEqual([["answer", "t1", { text: "Purple" }]]);
  await expect(box).toHaveValue("");
  await show(page, overview(agent("t1", "Claude", { state: "working" })));
  await expect(box).toHaveAttribute("placeholder", "Message Claude");
  await box.fill("Thanks");
  await page.locator("[data-message] button[type=submit]").click();
  await expect.poll(said).toEqual([["answer", "t1", { text: "Purple" }], ["send", "t1", "Thanks"]]);
});

test("the header is the agent's name and state in plain words, Terminal as an icon and a ⋯ holding Close; Stop is the message box's button while it works and nothing is typed", async () => {
  test.skip(!built(), "no page build: run crates/hive-web/build.sh");
  const page = await screen();
  await show(page, overview(agent("t1", "Claude", { state: "working" })));
  await open(page, "t1");
  const bar = page.locator("[data-screen=agent] .backbar");
  const size = (sel: string) => bar.locator(sel).evaluate((el) => { const r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; });
  expect(await size("[data-back]")).toEqual([44, 44]);
  expect(await size("[data-view-toggle]")).toEqual([44, 44]);
  expect(await size("[data-more]")).toEqual([44, 44]);
  await expect(bar.locator("[data-view-toggle]")).toHaveText("");
  const font = (sel: string) => bar.locator(sel).evaluate((el) => { const c = getComputedStyle(el); return [c.fontSize, c.fontWeight, c.fontFamily.split(",")[0]]; });
  expect(await font("h1")).toEqual(["17px", "600", "Geist"]);
  expect(await font(".status")).toEqual(["13px", "400", "Geist"]);
  expect(await bar.locator(".status").evaluate((el) => getComputedStyle(el).color)).toBe(await page.evaluate(() => { const p = document.createElement("p"); p.style.color = "var(--text3)"; document.body.append(p); return getComputedStyle(p).color; }));
  // Close is in the ⋯, asked before it is done.
  await expect(bar.locator("[data-close]")).toBeHidden();
  await expect(bar.locator("[data-stop]")).toHaveCount(0);
  await bar.locator("[data-more]").click();
  await page.locator("[data-screen=agent] [data-close]").click();
  await page.locator("[data-close-ask] [data-yes]").click();
  const did = () => page.evaluate(() => (window as unknown as { calls: string[][] }).calls.filter((c) => c[0] !== "conversation"));
  await expect.poll(did).toEqual([["close", "t1"]]);
  // At work and nothing typed: the box's button stops it. Typing makes it send again.
  const button = page.locator("[data-message] button");
  await expect(button).toHaveAttribute("aria-label", "Stop");
  await button.click();
  await expect.poll(did).toEqual([["close", "t1"], ["stop", "t1"]]);
  await page.locator("[data-message] textarea").fill("and the docs");
  await expect(button).toHaveAttribute("aria-label", "Send");
  await button.click();
  await expect.poll(did).toEqual([["close", "t1"], ["stop", "t1"], ["send", "t1", "and the docs"]]);
  // Idle, there is nothing to stop.
  await show(page, overview(agent("t1", "Claude", { state: "idle" })));
  await expect(button).toHaveAttribute("aria-label", "Send");
  await expect(button).toBeDisabled();
});

test("while it works, a line above the message box says so and for how long, with a breathing dot; at rest, or in its terminal, it is gone", async () => {
  test.skip(!built(), "no page build: run crates/hive-web/build.sh");
  const T = 1_790_000_000_000;
  const page = await screen(T);
  await show(page, overview(agent("t1", "Claude", { state: "working", since: T - 12_000 })));
  await open(page, "t1");
  const line = page.locator("[data-screen=agent] [data-working-line]");
  await expect(line).toBeVisible();
  await expect(line).toHaveText("working · 12s");
  const style = await line.evaluate((el) => { const c = getComputedStyle(el); return [c.fontSize, c.fontFamily.split(",")[0]]; });
  expect(style).toEqual(["13px", "Geist"]);
  expect(await line.evaluate((el) => getComputedStyle(el).color)).toBe(await page.evaluate(() => { const p = document.createElement("p"); p.style.color = "var(--text3)"; document.body.append(p); return getComputedStyle(p).color; }));
  expect(await line.locator(".dot").evaluate((el) => getComputedStyle(el).animationName)).toBe("breathe");
  // It sits right above the message box.
  const gap = await page.evaluate(() => document.querySelector("[data-message]")!.getBoundingClientRect().top - document.querySelector("[data-working-line]")!.getBoundingClientRect().bottom);
  expect(gap).toBeGreaterThanOrEqual(0);
  expect(gap).toBeLessThan(12);
  await page.clock.runFor(50_000);
  await expect(line).toHaveText("working · 1m 02s");
  await page.locator("[data-view-toggle]").click();
  await expect(line).toBeHidden();
  await page.locator("[data-view-toggle]").click();
  await expect(line).toBeVisible();
  await show(page, overview(agent("t1", "Claude", { state: "idle" })));
  await expect(line).toBeHidden();
});

test("scrolled 200 px up from the newest, a round button above the message box counts what came since and brings the newest back", async () => {
  test.skip(!built(), "no page build: run crates/hive-web/build.sh");
  const page = await screen();
  await show(page, overview(agent("t1", "Claude", { state: "working" })));
  await open(page, "t1");
  const say = (from: number, n: number) => page.evaluate(([f, k]) => (window as unknown as { said(p: unknown): void }).said({ session: "s", cursor: f + k,
    entries: Array.from({ length: k }, (_, i) => ({ id: `e${f + i}`, at: f + i, who: "person", text: `line ${f + i}` })) }), [from, n] as const);
  await say(0, 60);
  const chat = page.locator("[data-screen=agent] [data-chat]");
  const newest = page.locator("[data-screen=agent] [data-newest]");
  const fromEnd = () => chat.evaluate((c) => c.scrollHeight - c.scrollTop - c.clientHeight);
  await expect.poll(fromEnd).toBeLessThan(1);
  await expect(newest).toBeHidden();
  await chat.evaluate((c) => { c.scrollTop = c.scrollHeight - c.clientHeight - 150; c.dispatchEvent(new Event("scroll")); });
  await expect(newest).toBeHidden();
  await chat.evaluate((c) => { c.scrollTop = c.scrollHeight - c.clientHeight - 300; c.dispatchEvent(new Event("scroll")); });
  await expect(newest).toBeVisible();
  const box = await newest.boundingBox();
  expect([Math.round(box!.width), Math.round(box!.height)]).toEqual([36, 36]);
  expect(await newest.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(await page.evaluate(() => { const p = document.createElement("p"); p.style.backgroundColor = "var(--raised)"; document.body.append(p); return getComputedStyle(p).backgroundColor; }));
  const message = await page.locator("[data-message]").boundingBox();
  expect(box!.y + box!.height).toBeLessThanOrEqual(message!.y);
  await expect(newest).toHaveText("");
  await say(60, 3);
  await expect(newest).toHaveText("3");
  await say(63, 2);
  await expect(newest).toHaveText("5");
  await expect.poll(fromEnd).toBeGreaterThan(200);
  await newest.click();
  await expect.poll(fromEnd).toBeLessThan(1);
  await expect(newest).toBeHidden();
  // Back at the newest, what comes is seen: nothing to count the next time.
  await say(65, 1);
  await chat.evaluate((c) => { c.scrollTop = c.scrollHeight - c.clientHeight - 300; c.dispatchEvent(new Event("scroll")); });
  await expect(newest).toHaveText("");
  // Over the terminal there is no chat to go back in.
  await page.locator("[data-view-toggle]").click();
  await expect(newest).toBeHidden();
});

test("a permission names its tool in sans and shows its command in mono on a panel, four lines until tapped; Allow and Deny are full-width 44 px rows, Allow first", async () => {
  test.skip(!built(), "no page build: run crates/hive-web/build.sh");
  const page = await screen();
  const about = ["cd apps/desktop &&", "  unset ELECTRON_RUN_AS_NODE &&", "  xvfb-run -a \\", "  pnpm test:e2e \\", "  --retries=0 \\", "  tests/e2e/phone-open.spec.ts \\", "  tests/e2e/phone-start.spec.ts"].join("\n");
  const waiting = { kind: "permission", since: 5, decide: true, tool: { name: "Bash", about } };
  await show(page, overview(agent("t1", "Claude", { state: "waiting", waiting })));
  await open(page, "t1");
  const card = page.locator("[data-screen=agent] [data-waiting-card]");
  const name = card.locator("[data-tool] .tool-name");
  await expect(name).toHaveText("Bash");
  expect(await name.evaluate((el) => { const c = getComputedStyle(el); return [c.fontSize, c.fontWeight, c.fontFamily.split(",")[0]]; })).toEqual(["14px", "600", "Geist"]);
  const command = card.locator("[data-tool] pre");
  await expect(command).toHaveText(about);
  const look = await command.evaluate((el) => { const c = getComputedStyle(el); return { size: c.fontSize, family: c.fontFamily.split(",")[0], line: parseFloat(c.lineHeight), pad: parseFloat(c.paddingTop) + parseFloat(c.paddingBottom), bg: c.backgroundColor, h: el.clientHeight }; });
  expect([look.size, look.family]).toEqual(["13px", '"JetBrains Mono"']);
  expect(look.bg).toBe(await page.evaluate(() => { const p = document.createElement("p"); p.style.backgroundColor = "var(--panel)"; document.body.append(p); return getComputedStyle(p).backgroundColor; }));
  expect(Math.round((look.h - look.pad) / look.line)).toBe(4);
  // Nothing of its fifth line shows under the fourth.
  expect(await command.evaluate((el) => { const r = document.createRange(); r.selectNodeContents(el); const box = el.getBoundingClientRect();
    const fifth = [...r.getClientRects()].filter((q) => q.height > 0).map((q) => q.top).filter((t, i, all) => all.indexOf(t) === i).sort((x, y) => x - y)[4];
    return fifth === undefined || fifth >= box.bottom - parseFloat(getComputedStyle(el).borderBottomWidth); })).toBe(true);
  await command.click();
  const whole = await command.evaluate((el) => { const c = getComputedStyle(el); return Math.round((el.clientHeight - parseFloat(c.paddingTop) - parseFloat(c.paddingBottom)) / parseFloat(c.lineHeight)); });
  expect(whole).toBe(7);
  // The answers: one row each, the card's width, Allow above Deny.
  const allow = await card.locator("[data-answer=allow]").boundingBox();
  const deny = await card.locator("[data-answer=deny]").boundingBox();
  const inner = await card.locator(".answers").boundingBox();
  expect([Math.round(allow!.width), Math.round(allow!.height)]).toEqual([Math.round(inner!.width), 44]);
  expect([Math.round(deny!.width), Math.round(deny!.height)]).toEqual([Math.round(inner!.width), 44]);
  expect(allow!.y).toBeLessThan(deny!.y);
  await card.locator("[data-answer=allow]").click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { calls: unknown[][] }).calls.filter((c) => c[0] === "answer"))).toEqual([["answer", "t1", { allow: true }]]);
});
