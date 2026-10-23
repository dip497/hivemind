// The look settings that are drawn, in the real app: the corner setting rounds tiles and controls,
// the font settings change the interface and the terminals, and the Clean Light preset makes a
// light app (page, terminals, native chrome and the window behind them), flat, with no wallpaper.
// A look that is no built-in preset reads as Custom, not as another preset's name.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { seedAgents } from "./helpers/agents";
import { MONO_FONT, UI_FONT } from "@hivemind/core/settings-schema";

test.use({ trace: "off" });

let app: ElectronApplication;
let page: Page;
let repo: string;
const APP_DIR = process.cwd();
const XDG = fs.mkdtempSync(path.join(os.tmpdir(), "hm-clean-xdg-"));
seedAgents(XDG, ["claude"]);
// A Claude that writes down each size its terminal is given: a wider font gives fewer columns.
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), "hm-clean-bin-"));
const SIZES = path.join(BIN, "sizes");
fs.writeFileSync(path.join(BIN, "claude"), `#!/usr/bin/env node
if (process.argv[2] === "--version") { console.log("2.0.0 (Claude Code)"); process.exit(0); }
const fs = require("fs");
const note = () => fs.appendFileSync(${JSON.stringify(SIZES)}, process.stdout.columns + "\\n");
note();
process.stdout.on("resize", note);
setInterval(() => {}, 1000);
`, { mode: 0o755 });
const ENV = { ...process.env, XDG_CONFIG_HOME: XDG, HIVEMIND_SHELL_ENV: "0", PATH: `${BIN}${path.delimiter}${process.env.PATH}` } as Record<string, string>;
delete ENV.ELECTRON_RUN_AS_NODE;
const columns = () => (fs.existsSync(SIZES) ? fs.readFileSync(SIZES, "utf8").trim().split("\n").filter(Boolean).map(Number) : []);
const onDisk = () => JSON.parse(fs.readFileSync(path.join(XDG, "hivemind", "settings.json"), "utf8"));
/** Where screenshots go for a person to look at, when CLEAN_SHOTS names a folder. */
const SHOTS = process.env.CLEAN_SHOTS ?? "";

const set = (p: string, v: unknown) => page.evaluate(([p, v]) => window.hive.settingsSet(p as string, v), [p, v] as const);
const style = (selector: string, prop: string) =>
  page.evaluate(([s, p]) => { const el = document.querySelector(s as string); return el ? getComputedStyle(el).getPropertyValue(p as string) : null; }, [selector, prop] as const);
const shot = async (name: string) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };

test.beforeAll(async () => {
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  repo = await fs.promises.mkdtemp(path.join(os.tmpdir(), "hm-clean-"));
  fs.writeFileSync(path.join(repo, "a.ts"), "export const a = 1;\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q"); git("config", "user.email", "e2e@test.dev"); git("config", "user.name", "e2e"); git("add", "-A"); git("commit", "-q", "-m", "seed");
  app = await electron.launch({ args: [path.join(APP_DIR, "out/main/index.js"), "--no-sandbox"], cwd: repo, env: ENV });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForSelector(".react-flow", { timeout: 30_000 });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await page.waitForSelector(".react-flow__node-terminal .xterm", { timeout: 15_000 });
});

test.afterAll(async () => {
  await app?.close();
  await fs.promises.rm(repo, { recursive: true, force: true }).catch(() => {});
  await fs.promises.rm(XDG, { recursive: true, force: true }).catch(() => {});
  await fs.promises.rm(BIN, { recursive: true, force: true }).catch(() => {});
});

test("the corner setting rounds tiles and controls", async () => {
  expect(await style(".hm-term-root", "border-top-left-radius")).toBe("12px");
  await set("appearance.radius", 4);
  await expect.poll(() => style(".hm-term-root", "border-top-left-radius")).toBe("4px");
  await set("appearance.radius", 0);
  await expect.poll(() => style(".hm-term-root", "border-top-left-radius")).toBe("0px");
  await set("appearance.radius", 12);
  await expect.poll(() => style(".hm-term-root", "border-top-left-radius")).toBe("12px");
});

test("the font settings change the interface and the terminals", async () => {
  await set("appearance.uiFont", '"Clean Test Sans", serif');
  await expect.poll(() => style("body", "font-family")).toContain("Clean Test Sans");
  // An agent's terminal, told its width: a serif face's cells are wider than JetBrains Mono's, so
  // the same tile holds fewer columns once the terminal font changes, and the program is told.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:spawn-agent")));
  await expect.poll(() => columns().length, { timeout: 20_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(800);
  const before = columns().at(-1)!;
  await set("appearance.monoFont", '"DejaVu Serif", serif');
  await expect.poll(() => columns().at(-1)!, { timeout: 15_000 }).toBeLessThan(before * 0.85);
  await set("appearance.uiFont", UI_FONT);
  await set("appearance.monoFont", MONO_FONT);
  await expect.poll(() => style("body", "font-family")).toContain("Geist Sans");
});

test("Clean Light: a light, flat app with no wallpaper, terminals and native chrome included", async () => {
  await page.locator('[aria-label="settings"]').click();
  await page.locator('[data-settings-page="appearance"]').click();
  await page.locator("[data-preset-select]").click();
  await page.locator('[data-preset-option="clean-light"]').click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.themeMode)).toBe("light");
  await shot("clean-light-settings");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(false);
  expect(await page.evaluate(() => document.documentElement.classList.contains("glass-on"))).toBe(false);
  expect(await style("body", "background-color")).toBe("rgb(250, 250, 250)");
  await expect.poll(() => page.getAttribute(".react-flow__node-terminal [data-term-bg]", "data-term-bg")).toBe("#ffffff");
  const a = onDisk().appearance;
  expect([a.preset, a.mode, a.glass.enabled, a.wallpaper.kind, a.radius]).toEqual(["clean-light", "light", false, "none", 8]);
  // What the operating system draws: native controls in light, and the window behind the page.
  await expect.poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe("light");
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBackgroundColor().toLowerCase())).toBe("#fafafa");
  await shot("clean-light-canvas");
});

test("Clean, its dark twin, and back: the window follows", async () => {
  await set("appearance", { ...onDisk().appearance, preset: "clean", mode: "dark", palette: { ...onDisk().appearance.palette, bg: "#0b0b0c" } });
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(true);
  await expect.poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe("dark");
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBackgroundColor().toLowerCase())).toBe("#0b0b0c");
});

test("a look that is no built-in preset reads as Custom", async () => {
  await set("appearance.preset", "harbour-dusk");
  await page.locator('[aria-label="settings"]').click();
  await page.locator('[data-settings-page="appearance"]').click();
  await expect(page.locator("[data-preset-select]")).toHaveText(/Custom/);
  await page.getByRole("button", { name: "Close", exact: true }).click();
});
