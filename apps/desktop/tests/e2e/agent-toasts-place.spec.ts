// Where an agent's toast stands and how it reads, with an agent waiting on the person. It slides in
// inside its own stack (overflowing it gave the stack a sideways scrollbar for the slide, and lifted
// every card by its height). It is solid, glass or not, since it lands on whatever is open, a view's
// bright scene included. It stands left of a widget column floating along the window's right edge,
// whose width the widget layer publishes as --widgets-right-inset, as far as the window has room for
// it (a band of cards as wide as the window leaves it on screen), and it publishes its own height,
// as --agent-toasts-height, for what stands above it: the app's other notices in the same column,
// and the widgets' Hide toggle. And the Layers chips that ask for the person hold their words still:
// pulsing, a chip's 10px word fell under 3:1 for as long as the agent waited.
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { person } from "./helpers/multiplayer";
import { chooserAgent } from "./helpers/chooser";
import { stopDaemons } from "./helpers/daemons";

test.describe.configure({ mode: "serial" });

let root: string;
const apps: ElectronApplication[] = [];
let page: Page;
const card = () => page.locator("[data-notifications] .hm-toast").filter({ hasText: "needs your input" });
/** One of the app's own notices (sonner): an error main reports. */
const notice = async (text: string) => {
  await apps[0]!.evaluate(({ BrowserWindow }, message) => BrowserWindow.getAllWindows()[0]!.webContents.send("app:error", { message, source: "test" }), text);
  return page.locator("[data-sonner-toast]").filter({ hasText: text });
};

/** The screen's alpha for a computed colour, 0 to 255. */
const alphaOf = (el: Element): number => {
  const c = document.createElement("canvas").getContext("2d")!;
  c.fillStyle = getComputedStyle(el).backgroundColor;
  c.fillRect(0, 0, 1, 1);
  return c.getImageData(0, 0, 1, 1).data[3]!;
};

test.beforeAll(async () => {
  test.setTimeout(120_000);
  root = fs.mkdtempSync("/tmp/hm-toasts-place-");
  const repo = path.join(root, "api");
  fs.mkdirSync(repo);
  execSync("git init -q", { cwd: repo });
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  page = await person(root, "desktop", repo, apps, { ...chooserAgent(root), HIVEMIND_SHELL_ENV: "0", HOME: home });
  // The slide is what is measured, not its reduced-motion cross-fade.
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(() => window.hive.settingsSet("agents.defaultAgent", "chooser"));
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:shortcut", { detail: "agent" })));
  const terminal = page.locator(".react-flow__node-terminal");
  await expect(terminal).toHaveCount(1, { timeout: 20_000 });
  const tile = (await terminal.getAttribute("data-id"))!;
  const state = async () => (await page.evaluate((r) => window.hive.agentList(r), repo)).agents.find((a) => a.tile === tile)?.state;
  await expect.poll(state, { timeout: 30_000 }).toBe("idle");

  // The first card's slide, held at its first frame as it is put on the page: the stack's scrollbars
  // then (offset less client size, across and down).
  await page.evaluate(() => {
    const w = window as unknown as { slide?: number[] };
    const seen = new MutationObserver(() => {
      const el = document.querySelector<HTMLElement>("[data-notifications] .hm-toast-in");
      const slide = el?.getAnimations().find((a) => (a as CSSAnimation).animationName === "hm-toast-in");
      if (!el || !slide) return;
      seen.disconnect();
      const stack = el.parentElement!;
      slide.pause();
      slide.currentTime = 0;
      w.slide = [stack.offsetWidth - stack.clientWidth, stack.offsetHeight - stack.clientHeight];
      slide.play();
    });
    seen.observe(document.body, { childList: true, subtree: true });
  });
  // Nothing selected: the agent's ask comes as a toast.
  await page.locator(".react-flow__pane").click({ position: { x: 5, y: 5 } });
  await page.evaluate((t) => window.hive.ptyWrite(`hm:${t}`, "perm\r"), tile);
  await expect(card()).toBeVisible({ timeout: 20_000 });
  // Under the pointer it stays, however long the tests take.
  await card().hover();
});

test.afterAll(async () => {
  for (const a of apps.splice(0)) await a.close();
  stopDaemons(root);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test("a toast slides in inside its stack: no scrollbar shows, which lifted the stack by its height", async () => {
  expect(await page.evaluate(() => (window as unknown as { slide?: number[] }).slide)).toEqual([0, 0]);
});

test("under glass, the agent's toast and the app's own notice are solid", async () => {
  // The default look has glass on: a frosted toast let what is under it through.
  expect(await page.evaluate(() => document.documentElement.classList.contains("glass-on"))).toBe(true);
  expect(await card().evaluate(alphaOf)).toBe(255);
  await expect(card()).toHaveCSS("backdrop-filter", "none");

  const told = await notice("the daemon is stale");
  await expect(told).toBeVisible();
  expect(await told.evaluate(alphaOf)).toBe(255);
  await expect(told).toHaveCSS("backdrop-filter", "none");
});

test("the Layers chips that ask for you hold their words still; only their needs-you mark pulses", async () => {
  const panel = page.locator('aside[aria-label="Layers"]');
  const chips = [panel.locator('[data-layer-status="needs"]'), panel.locator('[data-layers-frame-status="needs"]')];
  await expect(chips[0]!).toHaveText("approve?", { timeout: 20_000 });
  await expect(chips[1]!).toHaveText("needs you");
  for (const chip of chips) {
    expect(await chip.evaluate((el) => ({ moving: el.getAnimations().length, opacity: getComputedStyle(el).opacity }))).toEqual({ moving: 0, opacity: "1" });
    const mark = chip.locator('[data-status-look="needs"]');
    await expect(mark).toHaveCount(1);
    expect(await mark.evaluate((el) => el.getAnimations().length)).toBeGreaterThan(0);
  }
});

test("the toasts stand left of a right-edge widget column; the agent stack's height lifts the app's notices above it, and is 0px once it is gone", async () => {
  const told = await notice("the hooks are not set up");
  const stack = page.locator("[data-notifications]");
  const right = (box: { x: number; width: number } | null) => Math.round(box!.x + box!.width);
  const width = await page.evaluate(() => window.innerWidth);
  // Its cards 14px in from the window's edge, the app's notices 12px.
  await expect.poll(async () => [right(await card().boundingBox()), right(await told.boundingBox())]).toEqual([width - 14, width - 12]);

  // What the widget layer publishes while a column floats along the right edge.
  await page.evaluate(() => document.documentElement.style.setProperty("--widgets-right-inset", "268px"));
  await expect.poll(async () => [right(await card().boundingBox()), right(await told.boundingBox())]).toEqual([width - 268 - 14, width - 268 - 12]);
  // Cards in columns across the whole window (a small one): the notices stay on screen, over them.
  await page.evaluate((w) => document.documentElement.style.setProperty("--widgets-right-inset", `${w}px`), width);
  await expect.poll(async () => [(await card().boundingBox())!.x >= 0, (await told.boundingBox())!.x >= 0]).toEqual([true, true]);
  await page.evaluate(() => document.documentElement.style.setProperty("--widgets-right-inset", "268px"));

  // The stack's height and the 8px gap over it: the app's notice sits that gap above the stack.
  const height = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--agent-toasts-height").trim());
  const top = (await stack.boundingBox())!.y;
  expect(await height()).toBe(`${Math.ceil((await stack.boundingBox())!.height) + 8}px`);
  await expect.poll(async () => { const b = (await told.boundingBox())!; return Math.abs(b.y + b.height - (top - 8)) <= 1; }).toBe(true);

  await card().hover();
  await card().getByRole("button", { name: "Dismiss notification" }).click();
  await expect(page.locator("[data-notifications]")).toHaveCount(0);
  expect(await height()).toBe("0px");
});
