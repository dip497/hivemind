// Keys typed into a terminal reach its shell, and what the shell prints reaches the window: the
// terminal's whole path through the workspace API, as the app and, in the harness
// (playwright.harness.config.ts), as a browser tab on it.
import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchWindow, type AppWindow } from "./helpers/window";

let app: AppWindow;
let page: Page;
const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hm-terminal-io-")));

test.beforeAll(async () => {
  execFileSync("git", ["init", "-q"], { cwd: repo });
  app = await launchWindow({ cwd: repo, args: [`--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), "hm-terminal-io-ud-"))}`] });
  page = app.page;
  await page.waitForSelector(".react-flow", { timeout: 30_000 });
});
test.afterAll(async () => {
  await app?.close();
  fs.rmSync(repo, { recursive: true, force: true });
});

test("keys typed into a terminal reach its shell, and what it prints reaches the window", async () => {
  await page.locator('[data-toolbar-action="board"]').click();
  await page.locator('[data-board-choice="tile:shell"]').click();
  const term = page.locator(".react-flow__node-terminal").first();
  await expect(term).toHaveCount(1);
  await term.locator(".xterm-screen").click();
  const marker = path.join(repo, "typed.txt");
  // The shell is up once a line typed into it runs.
  await expect.poll(async () => {
    await page.keyboard.type(`echo from-the-window-$((6*7)) > ${marker}\n`);
    return fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim() : "";
  }, { timeout: 20_000, intervals: [500] }).toBe("from-the-window-42");
  await page.keyboard.type("echo printed-$((20+22))\n");
  // What the terminal shows (it draws on a canvas: its host element reads its screen as text).
  const screen = () => term.evaluate((el) => {
    const host = [el, ...el.querySelectorAll("*")].find((e) => "__hmScreen" in e) as (Element & { __hmScreen(): string }) | undefined;
    return host?.__hmScreen() ?? "";
  });
  await expect.poll(screen, { timeout: 10_000 }).toContain("printed-42");
});

test("a terminal whose renderer is rebuilt leaves focus put elsewhere since where it is", async () => {
  await page.locator('[data-toolbar-action="board"]').click();
  await page.locator('[data-add-menu] [data-board-choice="tile:shell"]').click();
  const term = page.locator(".react-flow__node-terminal").last();
  // Fresh and selected, it draws with WebGL: on a canvas of its own, beside the link layer's.
  const canvas = term.locator('.xterm-screen canvas:not([class$="-layer"])');
  await expect(canvas).toHaveCount(1);
  // The person goes to search the tiles, the terminal still selected.
  await page.locator("[data-layers-search-toggle]").click();
  const search = page.locator("[data-layers-search]");
  await expect(search).toBeFocused();
  // The GPU drops its context: the terminal falls back to the DOM renderer.
  await canvas.evaluate((c: HTMLCanvasElement) => c.getContext("webgl2")!.getExtension("WEBGL_lose_context")!.loseContext());
  await expect(canvas).toHaveCount(0);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await expect(search).toBeFocused();
  await page.keyboard.type("zz");
  await expect(search).toHaveValue("zz");
});

test("a path or address a terminal shows opens on Ctrl+click only: a plain click on it is a click in the terminal", async () => {
  fs.writeFileSync(path.join(repo, "notes.ts"), "export {};\n");
  await page.locator('[data-toolbar-action="board"]').click();
  await page.locator('[data-add-menu] [data-board-choice="tile:shell"]').click();
  const term = page.locator(".react-flow__node-terminal").last();
  const screen = term.locator(".xterm-screen");
  await screen.click();
  // An address goes to the system's browser: here, it is only written down.
  await page.evaluate(() => { const w = window as unknown as { __opened: string[] }; w.__opened = []; window.open = ((u: string) => { w.__opened.push(String(u)); return null; }) as typeof window.open; });
  const opened = () => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);
  const text = () => term.evaluate((el) => ([el, ...el.querySelectorAll("*")].find((e) => "__hmScreen" in e) as (Element & { __hmScreen(): string }) | undefined)?.__hmScreen() ?? "");
  /** `run` cleared the terminal and printed `shows` alone on its first row. */
  const printed = (run: string, shows: string) => expect.poll(async () => {
    await page.keyboard.type(`clear; ${run}\n`);
    return text().then((t) => t.split("\n")[0]!.trim());
  }, { timeout: 20_000, intervals: [1000] }).toBe(shows);
  /** A plain click on what the first row shows does nothing; a Ctrl+click makes `done` true. */
  const follows = async (what: string, done: () => Promise<boolean>) => {
    // Where the terminal is now: the canvas may have moved to show what opened last.
    const box = (await screen.boundingBox())!;
    const onIt = { x: box.x + 20, y: box.y + 6 };
    await page.mouse.click(onIt.x, onIt.y);
    await page.waitForTimeout(500);
    expect(await done(), `${what}: a plain click`).toBe(false);
    // The pointer comes back onto it, as a hand does, for the terminal to find the link again.
    await page.mouse.move(onIt.x + 40, onIt.y + 60);
    await page.keyboard.down("Control");
    await page.mouse.click(onIt.x, onIt.y);
    await page.keyboard.up("Control");
    await expect.poll(done, { message: `${what}: Ctrl+click` }).toBe(true);
    await screen.click({ position: { x: box.width - 10, y: box.height - 10 } });
  };
  const code = page.locator(".react-flow__node-editor, .react-flow__node-workbench");
  await printed("echo ./notes.ts", "./notes.ts");
  await follows("a path", async () => (await code.count()) === 1);
  await printed("echo http://127.0.0.1:9/text", "http://127.0.0.1:9/text");
  await follows("an address", async () => (await opened()).includes("http://127.0.0.1:9/text"));
  // A link a program prints as one (OSC 8), under text of its own.
  await printed(String.raw`printf '\e]8;;http://127.0.0.1:9/osc\e\\osc-link\e]8;;\e\\\n'`, "osc-link");
  await follows("a link printed as one", async () => (await opened()).includes("http://127.0.0.1:9/osc"));
});
