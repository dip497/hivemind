// One agent on the phone page (crates/hive-web/www/app/agent.ts), in a phone-sized Chromium with no
// computer: the page's built modules (crates/hive-web/build.sh) served from www by route, the
// computer's overview given by the test through `window.show(overview)`.
import { test, expect, chromium, devices, type Browser, type BrowserContextOptions, type Page } from "@playwright/test";
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
async function screen(clock?: number, phone: BrowserContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }): Promise<Page> {
  browser = await chromium.launch();
  const page = await browser.newPage(phone);
  if (clock !== undefined) await page.clock.install({ time: clock - 60_000 });
  page.on("pageerror", (e) => { throw e; });
  await page.route("http://page.test/**", (route) => {
    const name = new URL(route.request().url()).pathname.slice(1);
    if (name === "index.html") {
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="app.css"><main id="app"></main>
<script type="module">
import { AgentScreen } from "./js/agent.js";
import { followViewport } from "./js/viewport.js";
followViewport();
window.calls = [];
const app = {
  back() {}, computer: () => "desk",
  conversation: (a, said) => (window.calls.push(["conversation", a.tile]), window.said = said, () => {}),
  terminal: () => null,
  tool: async () => ({}),
  commands: async (a) => (window.calls.push(["commands", a.tile]), window.commands ?? []),
  answer: async (a, reply) => (window.calls.push(["answer", a.tile, reply]), true),
  send: async (a, text, _photos, going) => {
    window.calls.push(["send", a.tile, text]);
    if (window.going !== undefined) going(window.going);
    if (window.gate) await window.gate;
    if (window.refused) throw new Error(window.refused);
    return window.sent === undefined ? { held: false } : window.sent;
  },
  stop: async (a) => (window.calls.push(["stop", a.tile]), !window.stopFails),
  close: async (a) => (window.calls.push(["close", a.tile]), true),
  notes: async (a) => (window.calls.push(["notes", a.workspace]), window.notes ?? []),
  changeNote: async (a, id, to, reason) => (window.calls.push(["changeNote", id, to, reason ?? null]), true),
  sendNotes: async (a, ids) => (window.calls.push(["sendNotes", a.tile, ids]), true),
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

test("a message held until the agent's turn ends shows as queued, with Send now, which stops the turn", async () => {
  test.skip(!built(), "no page build: run crates/hive-web/build.sh");
  const page = await screen();
  await show(page, overview(agent("t1", "Phone test", { state: "working" })));
  await open(page, "t1");
  const box = page.locator("[data-message] textarea");
  const did = () => page.evaluate(() => (window as unknown as { calls: string[][] }).calls.filter((c) => c[0] !== "conversation"));
  await page.evaluate(() => ((window as unknown as { sent: unknown }).sent = { held: true }));
  await box.fill("and the docs");
  await page.locator("[data-message] button[type=submit]").click();
  const held = page.locator('[data-chat] [data-pending="held"]');
  await expect(held.locator('[data-who="person"]')).toHaveText("and the docs");
  await expect(held.locator("[data-pending-state]")).toContainText("Queued · sends when it finishes");
  await expect(box).toHaveValue("");
  await held.locator("[data-send-now]").click();
  await expect.poll(did).toEqual([["send", "t1", "and the docs"], ["stop", "t1"]]);
  await expect(held.locator("[data-send-now]")).toHaveCount(0);
  // The session file has it: shown once, as said.
  await page.evaluate(() => (window as unknown as { said: (p: object) => void }).said({ session: "s1", cursor: 1, entries: [{ id: "u1", at: Date.now(), who: "person", text: "and the docs" }] }));
  await expect(page.locator('[data-chat] [data-who="person"]')).toHaveText(["and the docs"]);
  await expect(page.locator("[data-chat] [data-pending]")).toHaveCount(0);
});

/** What the test does to what `send` answers. */
type Sending = { sent?: unknown; refused?: string; going?: number; gate?: Promise<void>; openGate?: () => void };
const sending = (page: Page, set: Sending) => page.evaluate((s) => Object.assign(window, s), set as object);
const gateSends = (page: Page) => page.evaluate(() => {
  (window as unknown as Sending).gate = new Promise((open) => ((window as unknown as Sending).openGate = open));
});
const openGate = (page: Page) => page.evaluate(() => {
  const w = window as unknown as Sending;
  w.gate = undefined;
  w.openGate!();
});
const onePhoto = { name: "shot.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPjPAAAEAgEAPT4sMAAAAABJRU5ErkJggg==", "base64") };

test("a message leaves the box as it is sent and goes into the chat, its photos with it; with photos it says how far it got, without them a plain Sending…", async () => {
  test.skip(!built(), "no page build: run crates/hive-web/build.sh");
  const page = await screen();
  await show(page, overview(agent("t1", "Phone test")));
  await open(page, "t1");
  const box = page.locator("[data-message] textarea");
  await gateSends(page);
  await sending(page, { going: 0.4 });
  await page.locator("[data-photo-picker]").setInputFiles([onePhoto, { ...onePhoto, name: "two.png" }]);
  await expect(page.locator("[data-message] [data-photo]")).toHaveCount(2);
  await box.fill("look at these");
  await page.locator("[data-message] button[type=submit]").click();
  // At once, while the computer has not answered.
  await expect(box).toHaveValue("");
  await expect(page.locator("[data-message] [data-photo]")).toHaveCount(0);
  await expect(page.locator("[data-message] button[type=submit]")).toBeDisabled();
  const going = page.locator('[data-chat] [data-pending="going"]');
  await expect(going.locator('[data-who="person"]')).toHaveText("look at these");
  await expect(going.locator("[data-pending-photos] img")).toHaveCount(2);
  await expect(going.locator("[data-pending-state]")).toHaveText("Sending… 40%");
  await expect(going.locator("[data-pending-bar]")).toBeVisible();
  await openGate(page);
  await expect(page.locator('[data-chat] [data-pending="sent"] [data-pending-state]')).toHaveText("Sent");
  await expect(page.locator("[data-chat] [data-pending-bar]")).toBeHidden();

  await gateSends(page);
  await box.fill("just words");
  await page.locator("[data-message] button[type=submit]").click();
  await expect(page.locator('[data-chat] [data-pending="going"] [data-pending-state]')).toHaveText("Sending…");
  await openGate(page);
});

test("messages go one at a time, in the order sent: the next waits for the computer to answer the last, whatever becomes of it", async () => {
  test.skip(!built(), "no page build: run crates/hive-web/build.sh");
  const page = await screen();
  await show(page, overview(agent("t1", "Phone test")));
  await open(page, "t1");
  const box = page.locator("[data-message] textarea");
  const sends = () => page.evaluate(() => (window as unknown as { calls: string[][] }).calls.filter((c) => c[0] === "send").map((c) => c[2]));
  await gateSends(page);
  for (const text of ["first", "second", "third"]) {
    await box.fill(text);
    await page.locator("[data-message] button[type=submit]").click();
    await expect(box).toHaveValue("");
  }
  await expect(page.locator("[data-chat] [data-pending]")).toHaveCount(3);
  expect(await sends()).toEqual(["first"]);
  await sending(page, { refused: "It broke" });
  await openGate(page);
  await expect.poll(sends).toEqual(["first", "second", "third"]);
  await expect(page.locator('[data-chat] [data-pending="failed"]')).toHaveCount(3);
});

test("a message that did not go stays in the chat and says why: Try again sends it again, Put back returns its words and photos to the box, and it is still there after looking away", async () => {
  test.skip(!built(), "no page build: run crates/hive-web/build.sh");
  const page = await screen();
  await show(page, overview(agent("t1", "Phone test"), agent("t2", "Other")));
  await open(page, "t1");
  const box = page.locator("[data-message] textarea");
  const failed = page.locator('[data-chat] [data-pending="failed"]');
  const sends = () => page.evaluate(() => (window as unknown as { calls: string[][] }).calls.filter((c) => c[0] === "send").length);

  // Thrown, or refused by the computer: each said, nothing lost.
  await sending(page, { refused: "Not connected to desk right now" });
  await page.locator("[data-photo-picker]").setInputFiles([onePhoto]);
  await expect(page.locator("[data-message] [data-photo]")).toHaveCount(1);
  await box.fill("and the changelog");
  await page.locator("[data-message] button[type=submit]").click();
  await expect(failed.locator("[data-pending-state]")).toContainText("Not sent. Not connected to desk right now");
  await expect(failed.locator('[data-who="person"]')).toHaveText("and the changelog");
  await expect(failed.locator("[data-pending-photos] img")).toHaveCount(1);
  await expect(box).toHaveValue("");
  await expect(page.locator("[data-message] [data-photo]")).toHaveCount(0);

  await page.evaluate(() => { const w = window as unknown as Sending; w.refused = undefined; w.sent = false; });
  await failed.locator("[data-try-again]").click();
  await expect.poll(sends).toBe(2);
  await expect(failed.locator("[data-pending-state]")).toContainText("Not sent. It was not taken");

  // Looked away from, and back.
  await open(page, "t2");
  await expect(failed).toHaveCount(0);
  await open(page, "t1");
  await expect(failed.locator('[data-who="person"]')).toHaveText("and the changelog");
  await expect(failed.locator("[data-pending-photos] img")).toHaveCount(1);

  // With the box holding a draft, it comes back ahead of it.
  await box.fill("a draft");
  await failed.locator("[data-put-back]").click();
  await expect(page.locator("[data-chat] [data-pending]")).toHaveCount(0);
  await expect(box).toHaveValue("and the changelog\na draft");
  await expect(page.locator("[data-message] [data-photo]")).toHaveCount(1);
  expect(await sends()).toBe(2);

  // Tried again, it goes.
  await sending(page, { sent: { held: false } });
  await page.locator("[data-message] button[type=submit]").click();
  await expect(page.locator('[data-chat] [data-pending="sent"]')).toHaveCount(1);
  await expect.poll(sends).toBe(3);

  // A box whose photos would not fit keeps what it holds, and the message stays in the chat.
  await sending(page, { sent: false });
  await page.locator("[data-photo-picker]").setInputFiles([onePhoto, onePhoto]);
  await expect(page.locator("[data-message] [data-photo]")).toHaveCount(2);
  await page.locator("[data-message] button[type=submit]").click();
  await expect(failed).toHaveCount(1);
  await page.locator("[data-photo-picker]").setInputFiles([onePhoto, onePhoto, onePhoto]);
  await expect(page.locator("[data-message] [data-photo]")).toHaveCount(3);
  await failed.locator("[data-put-back]").click();
  await expect(failed).toHaveCount(1);
  await expect(page.locator("[data-message] [data-photo]")).toHaveCount(3);
  await expect(page.locator("[data-photo-problem]")).toContainText("at most 4 photos");
});

test("with nothing moving for 45 seconds a message says it may not have gone, and an answer after that still counts", async () => {
  test.skip(!built(), "no page build: run crates/hive-web/build.sh");
  const now = Date.parse("2026-10-01T10:00:00Z");
  const page = await screen(now);
  await show(page, overview(agent("t1", "Phone test")));
  await open(page, "t1");
  await gateSends(page);
  await page.locator("[data-message] textarea").fill("over a bad link");
  await page.locator("[data-message] button[type=submit]").click();
  await expect(page.locator('[data-chat] [data-pending="going"]')).toHaveCount(1);
  await page.clock.runFor(44_000);
  await expect(page.locator('[data-chat] [data-pending="going"]')).toHaveCount(1);
  await page.clock.runFor(2_000);
  await expect(page.locator('[data-chat] [data-pending="failed"] [data-pending-state]')).toContainText("may not have gone");
  await openGate(page);
  await expect(page.locator('[data-chat] [data-pending="sent"]')).toHaveCount(1);
});

test("the second tap of a double tap on send stops nothing: the button becomes Stop only a moment later", async () => {
  test.skip(!built(), "no page build: run crates/hive-web/build.sh");
  const page = await screen();
  await show(page, overview(agent("t1", "Phone test", { state: "working" })));
  await open(page, "t1");
  const stops = () => page.evaluate(() => (window as unknown as { calls: string[][] }).calls.filter((c) => c[0] === "stop").length);
  await page.locator("[data-message] textarea").fill("and one more thing");
  const button = page.locator("[data-message] button.send");
  await page.evaluate(() => {
    const b = document.querySelector<HTMLButtonElement>("[data-message] button.send")!;
    b.click();
    b.click();
  });
  expect(await stops()).toBe(0);
  await expect(button).toHaveAttribute("data-stop", "", { timeout: 3_000 });
  await button.click();
  await expect.poll(stops).toBe(1);
});

test("a message queued for an agent that cannot be stopped offers no Send now; when stopping fails, Send now comes back", async () => {
  test.skip(!built(), "no page build: run crates/hive-web/build.sh");
  const page = await screen();
  await show(page, overview(agent("t1", "Phone test", { state: "working", interrupt: undefined }), agent("t2", "Other", { state: "working" })));
  await open(page, "t1");
  await sending(page, { sent: { held: true } });
  await page.locator("[data-message] textarea").fill("when you can");
  await page.locator("[data-message] button[type=submit]").click();
  const held = page.locator('[data-chat] [data-pending="held"]');
  await expect(held).toHaveCount(1);
  await expect(held.locator("[data-send-now]")).toHaveCount(0);

  await open(page, "t2");
  await page.evaluate(() => {
    (window as unknown as { stopFails: boolean }).stopFails = true;
  });
  await page.locator("[data-message] textarea").fill("when you can");
  await page.locator("[data-message] button[type=submit]").click();
  await held.locator("[data-send-now]").click();
  await expect(held.locator("[data-send-now]")).toBeVisible();
  await expect(held.locator("[data-pending-state]")).toContainText("Queued");
});

test("what the agent's program wrote is one quiet line, told as new to no one scrolled up; a run folds as it grows, words in between ending it", async () => {
  test.skip(!built(), "no page build: run crates/hive-web/build.sh");
  const page = await screen();
  await show(page, overview(agent("t1", "Phone test")));
  await open(page, "t1");
  const said = (entries: object[]) => page.evaluate((e) => (window as unknown as { said: (p: object) => void }).said({ session: "s1", cursor: 1, entries: e }), entries);
  const note = (id: string, text: string, more: object = {}) => ({ id, at: 1, who: "program", notice: { text, ...more } });
  await said([{ id: "p0", at: 1, who: "person", text: "x\n".repeat(200) }]);

  // Read from further up, a notice is not counted as new.
  await page.locator("[data-chat]").evaluate((el) => (el.scrollTop = 0));
  await said([note("n0", "Helper finished: Tidy")]);
  await expect(page.locator('[data-entry="n0"]')).toBeAttached();
  await expect(page.locator("[data-newest]")).not.toContainText("1");

  // One alone says itself; another next to it folds both; one more joins, the fold staying one.
  await expect(page.locator('[data-entry="n0"]')).toHaveText("Helper finished: Tidy");
  await said([note("n1", "Helper is waiting", { quiet: true })]);
  const fold = page.locator("[data-notices]");
  await expect(fold).toHaveCount(1);
  await expect(fold.locator("[data-notices-summary]")).toHaveText("Helper finished: Tidy");
  await said([note("n2", "Background command finished: Lint"), note("n3", "Helper finished: Check")]);
  await expect(fold).toHaveCount(1);
  await expect(fold.locator("[data-notices-summary]")).toHaveText("3 background updates");
  await expect(fold).not.toHaveAttribute("data-quiet", "");
  await expect(fold.locator('[data-entry="n3"]')).toBeHidden();
  await fold.locator("> button").click();
  await expect(fold.locator('[data-entry="n1"]')).toBeVisible();
  await expect(fold.locator('[data-entry="n3"]')).toBeVisible();

  // Words in between end a run.
  await said([{ id: "p1", at: 1, who: "person", text: "and now?" }, note("n4", "Helper is waiting", { quiet: true }), note("n5", "Helper is waiting", { quiet: true })]);
  await expect(fold).toHaveCount(2);
  await expect(fold.nth(1).locator("[data-notices-summary]")).toHaveText("2 background updates");
  await expect(fold.nth(1)).toHaveAttribute("data-quiet", "");
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

test("a chat says it is loading, with a spinner, until the computer first answers; an agent that is not running loads nothing", async () => {
  test.skip(!built(), "no page build: run crates/hive-web/build.sh");
  const page = await screen();
  const loading = page.locator("[data-chat] [data-loading]");
  await show(page, overview(agent("t1", "Claude")));
  await open(page, "t1");
  await expect(loading).toBeVisible();
  await expect(loading).toHaveText("Loading chat…");
  await expect(loading.locator(".dot[data-state=working]")).toBeVisible();
  await page.evaluate(() => (window as unknown as { said(p: object): void }).said({ entries: [], cursor: 0, session: "s1" }));
  await expect(loading).toHaveCount(0);
  await expect(page.locator("[data-chat]")).toContainText("Nothing said yet");
  await open(page, "t9");
  await expect(page.locator("[data-gone]")).toBeVisible();
  await expect(page.locator("[data-chat] [data-loading]")).toBeHidden();
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

test("several questions are asked one at a time, as Claude Code asks them: choosing goes on to the next, the answers are checked, any changed, and Send carries each in order", async () => {
  test.skip(!built(), "no page build: run crates/hive-web/build.sh");
  const page = await screen();
  const waiting = { kind: "question", since: 5, choose: true, asks: [
    { question: "Which fruit?", options: ["Apple", "Banana", "Mango"] },
    { question: "Which colours?", options: ["Red", "Green", "Blue"], many: true },
  ] };
  await show(page, overview(agent("t1", "Phone test", { state: "waiting", waiting })));
  await open(page, "t1");
  const card = page.locator("[data-screen=agent] [data-waiting-card]");
  const shown = card.locator("[data-question] > p:not(.status)");
  const choices = card.locator("[data-question] [data-choice]");
  const calls = () => page.evaluate(() => (window as unknown as { calls: unknown[] }).calls.filter((c) => (c as string[])[0] === "answer"));
  // One question in sight, a chip for each, and nothing to send yet.
  await expect(shown).toHaveText(["Which fruit?"]);
  await expect(card.locator("[data-step]")).toHaveText(["1", "2", "Review"]);
  await expect(card.locator("[data-step=check]")).toBeDisabled();
  await expect(card.locator("[data-answer=allow], [data-answer=deny], [data-answer=send]")).toHaveCount(0);
  // Choosing the one fruit goes on to the colours, several of which toggle.
  await choices.nth(1).click();
  await expect(shown).toHaveText(["Which colours?"]);
  await expect(card.locator("[data-step=\"0\"]")).toHaveText("✓ 1");
  const next = card.locator("[data-answer=next]");
  await expect(next).toBeDisabled();
  for (const n of [0, 1, 2, 1]) await choices.nth(n).click();
  await expect(card.locator("[data-question] [data-choice][aria-pressed=true]")).toHaveText(["Red", "Blue"]);
  await next.click();
  // Every answer to check; one tapped is asked again, and a line of its own answers it instead.
  await expect(card.locator("[data-change] .label")).toHaveText(["Banana", "Red, Blue"]);
  await card.locator("[data-change=\"0\"]").click();
  await expect(card.locator("[data-question] [data-choice][aria-pressed=true]")).toHaveText(["Banana"]);
  await card.locator("[data-own]").fill("Durian");
  await card.locator("[data-own]").press("Enter");
  await expect(shown).toHaveText(["Which colours?"]);
  await next.click();
  await expect(card.locator("[data-change] .label")).toHaveText(["Durian", "Red, Blue"]);
  expect(await calls()).toEqual([]);
  await card.locator("[data-answer=send]").click();
  await expect.poll(calls).toEqual([["answer", "t1", { answers: [{ text: "Durian" }, { chosen: [0, 2] }] }]]);
});

test("typing / offers the agent's commands, those that start as typed first, each with what it does; a tap puts one in the box, and they are asked of the computer once", async () => {
  test.skip(!built(), "no page build: run crates/hive-web/build.sh");
  const page = await screen();
  await page.evaluate(() => { (window as unknown as { commands: unknown }).commands = [
    { name: "clear", description: "Start over", from: "built-in" },
    { name: "pr-review", from: "yours" },
    { name: "release", description: "Cut a release", from: "project" },
    { name: "review", description: "Review the diff", from: "built-in" },
  ]; });
  await show(page, overview(agent("t1", "Phone test")));
  await open(page, "t1");
  const box = page.locator("[data-message] textarea");
  const offered = page.locator("[data-commands] [data-command]");
  await box.fill("hello /");
  await expect(page.locator("[data-commands]")).toBeHidden();
  await box.fill("/");
  await expect(offered.locator(".label")).toHaveText(["/clear", "/pr-review", "/release", "/review"]);
  await box.fill("/re");
  await expect(offered.locator(".label")).toHaveText(["/release", "/review", "/pr-review"]);
  await expect(offered.nth(1).locator(".description")).toHaveText("Review the diff");
  await offered.nth(1).click();
  await expect(box).toHaveValue("/review ");
  await expect(box).toBeFocused();
  await expect(page.locator("[data-commands]")).toBeHidden();
  await box.fill("/zzz");
  await expect(page.locator("[data-commands]")).toBeHidden();
  const asked = await page.evaluate(() => (window as unknown as { calls: unknown[][] }).calls.filter((c) => c[0] === "commands"));
  expect(asked).toEqual([["commands", "t1"]]);
});

test("commands with long descriptions, more than the list has room for: each row holds its own words, two lines of what it does at most, and the list scrolls", async () => {
  test.skip(!built(), "no page build: run crates/hive-web/build.sh");
  const page = await screen();
  const long = "Add a new coding agent end to end, from research on the real binary to one manifest published to the registry, with its hooks, its sessions and its tests";
  await page.evaluate((d) => { (window as unknown as { commands: unknown }).commands = Array.from({ length: 8 }, (_, i) => ({ name: `step-${i}`, description: d, from: "yours" })); }, long);
  await show(page, overview(agent("t1", "Phone test")));
  await open(page, "t1");
  await page.locator("[data-message] textarea").fill("/");
  const offered = page.locator("[data-commands] [data-command]");
  await expect(offered).toHaveCount(8);
  const rows = await offered.evaluateAll((els) => els.map((el) => {
    const r = el.getBoundingClientRect();
    const d = el.querySelector(".description")!.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, words: d.bottom, lines: Math.round(d.height / 18) };
  }));
  for (const [i, r] of rows.entries()) {
    expect(r.words).toBeLessThanOrEqual(r.bottom);
    expect(r.lines).toBe(2);
    if (i > 0) expect(r.top).toBeGreaterThanOrEqual(rows[i - 1]!.bottom - 1);
  }
  const list = await page.locator("[data-commands]").evaluate((el) => ({ scrolls: el.scrollHeight > el.clientHeight }));
  expect(list.scrolls).toBe(true);
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
  const button = page.locator("[data-message] button.send");
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

test("while it works, a line above the message box says so and for how long, with a spinner; at rest, or in its terminal, it is gone", async () => {
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
  expect(await line.locator(".dot").evaluate((el) => getComputedStyle(el).animationName)).toBe("spin");
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

test("with the keyboard up, as Chrome on Android and Safari on iOS each report it, the message box's bar sits right on it and the newest message stays in sight; scrolled up, the same lines stay", async () => {
  test.skip(!built(), "no page build: run crates/hive-web/build.sh");
  const { defaultBrowserType: _, ...pixel } = devices["Pixel 7"];
  const page = await screen(undefined, pixel);
  await show(page, overview(agent("t1", "Claude")));
  await open(page, "t1");
  await page.evaluate(() => (window as unknown as { said(p: unknown): void }).said({ session: "s", cursor: 60,
    entries: Array.from({ length: 60 }, (_, i) => ({ id: `e${i}`, at: i, who: "person", text: `line ${i}` })) }));
  const box = page.locator("[data-screen=agent] [data-message]");
  const newest = page.locator("[data-screen=agent] [data-chat]").getByText("line 59", { exact: true });
  await expect(newest).toBeInViewport();
  await box.locator("textarea").tap();
  await expect(box.locator("textarea")).toBeFocused();
  /** The bottom of the message box's bar against what is seen, and whether the newest shows above the box. */
  const placed = () => page.evaluate(() => {
    const box = document.querySelector("[data-screen=agent] [data-message]")!;
    const b = { bottom: box.closest(".dock")!.getBoundingClientRect().bottom, top: box.getBoundingClientRect().top };
    const chat = document.querySelector("[data-screen=agent] [data-chat]")!.getBoundingClientRect();
    const last = [...document.querySelectorAll("[data-screen=agent] [data-chat] *")].find((e) => e.textContent === "line 59")!.getBoundingClientRect();
    const v = visualViewport!;
    return { off: Math.round(b.bottom - (v.offsetTop + v.height)), seen: last.top >= Math.max(chat.top, v.offsetTop) && last.bottom <= b.top };
  });
  // Chrome on Android (index.html's interactive-widget): the page is what is left above the keyboard.
  await page.setViewportSize({ width: 412, height: 500 });
  await expect.poll(placed).toEqual({ off: 0, seen: true });
  // Read 300 px up from the newest, the keyboard going down leaves the same lines in sight.
  const chat = page.locator("[data-screen=agent] [data-chat]");
  const fromEnd = () => chat.evaluate((c) => Math.round(c.scrollHeight - c.scrollTop - c.clientHeight));
  /** Scrolled to `away` px above the newest, once the chat has seen the scroll. */
  const scrolled = (away: number) => chat.evaluate((c, a) => new Promise((done) => {
    c.addEventListener("scroll", done, { once: true });
    c.scrollTop = c.scrollHeight - c.clientHeight - a;
  }), away);
  await scrolled(300);
  await page.setViewportSize({ width: 412, height: 839 });
  await expect.poll(() => chat.evaluate((c) => c.clientHeight)).toBeGreaterThan(500);
  await expect.poll(fromEnd).toBe(300);
  await scrolled(0);
  // Safari on iOS: the page stays whole; what is seen gets shorter, then moves down over it to the box.
  await page.evaluate(() => {
    const v = visualViewport!;
    Object.defineProperty(v, "height", { configurable: true, get: () => 480 });
    v.dispatchEvent(new Event("resize"));
    Object.defineProperty(v, "offsetTop", { configurable: true, get: () => 300 });
    v.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(placed).toEqual({ off: 0, seen: true });
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

test("the notes left on pages in the agent's workspace: open ones sent to it, each done, dismissed with a reason, or reopened", async () => {
  const page = await screen();
  await page.evaluate(() => {
    (window as unknown as { notes: object[] }).notes = [
      { id: "c-1", body: "make it bigger", status: "open", what: 'button "Start trial"', url: "http://x/" },
      { id: "c-2", body: "crowded", status: "seen", what: "Area", url: "http://x/" },
      { id: "c-3", body: "old", status: "resolved", what: 'link "Docs"', url: "http://x/", summary: "renamed" },
    ];
  });
  await open(page, "t1");
  await show(page, overview(agent("t1", "Claude")));
  await page.locator("[data-more]").click();
  await page.locator("[data-open-notes]").click();
  const card = page.locator("[data-page-notes]");
  await expect(card).toBeVisible();
  await expect(card.locator("[data-note]")).toHaveCount(3);
  await expect(card.locator('[data-note="c-3"]')).toContainText("renamed");
  const calls = () => page.evaluate(() => (window as unknown as { calls: unknown[][] }).calls.filter((c) => c[0] !== "conversation" && c[0] !== "notes"));

  await card.locator("[data-send-notes]").click();
  await expect(card.locator("[data-send-notes]")).toHaveText("Send 2 to Claude");
  await expect.poll(calls).toEqual([["sendNotes", "t1", ["c-1", "c-2"]]]);

  // Dismissing asks why first: an empty reason sends nothing.
  await card.locator('[data-note="c-2"] [data-note-dismiss]').click();
  await card.locator('[data-note="c-2"] [data-note-dismiss]').click();
  expect(await calls()).toHaveLength(1);
  await card.locator('[data-note="c-2"] [data-note-reason]').fill("by design");
  await card.locator('[data-note="c-2"] [data-note-dismiss]').click();
  await card.locator('[data-note="c-1"] [data-note-done]').click();
  await card.locator('[data-note="c-3"] [data-note-reopen]').click();
  await expect.poll(calls).toEqual([
    ["sendNotes", "t1", ["c-1", "c-2"]],
    ["changeNote", "c-2", "dismiss", "by design"],
    ["changeNote", "c-1", "done", null],
    ["changeNote", "c-3", "reopen", null],
  ]);
});

