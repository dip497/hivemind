// A view's own colours and the settings vocabulary v2, from its Settings page to the view: a token
// is a colour setting under Colours, following the theme until the person sets it; a field shows
// only while the one it names has its value; several choices and a list are drawn and kept as
// lists; and what the person sets reaches the running view. Design:
// docs/design/customization-2026-10-21.md.
import { test, expect, _electron as electron, type ElectronApplication, type Frame, type Page } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, "../../../cli/src/index.ts");
const VIEW = path.join(__dirname, "fixtures", "views", "looks");
/** Where screenshots go when someone asks for them. */
const OUT = process.env.LOOKS_OUT;

let app: ElectronApplication;
let page: Page;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-looks-"));
const xdg = path.join(root, "config");

test.beforeAll(async () => {
  const env = { ...process.env, XDG_CONFIG_HOME: xdg, HIVEMIND_SHELL_ENV: "0" } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const installed = spawnSync("bun", [CLI, "plugins", "install", VIEW, "--json"], { env, encoding: "utf8" });
  expect(installed.status, installed.stderr).toBe(0);
  execFileSync("git", ["init", "-q", path.join(root, "repo")]);
  app = await electron.launch({ args: [path.resolve(__dirname, "../../out/main/index.js"), "--no-sandbox"], cwd: path.join(root, "repo"), env });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.waitForSelector(".react-flow");
});

test.afterAll(async () => { await app?.close(); fs.rmSync(root, { recursive: true, force: true }); });

const form = () => page.locator('[data-plugin-page="view:looks"] [data-settings-form]');
const field = (id: string) => form().locator(`[data-setting="${id}"]`);
const shot = async (name: string) => { if (OUT) await page.screenshot({ path: path.join(OUT, name) }); };
const stored = () => JSON.parse(fs.readFileSync(path.join(xdg, "hivemind", "settings.json"), "utf8")).plugins?.state?.["view:looks"]?.options ?? {};

test("a view's token and every new kind of setting, from its Settings page to the running view", async () => {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: "plugin:view:looks" } })));
  await expect(form()).toBeVisible();
  // Its fields in their sections: the token's colour under Colours, the hour hidden while the sky
  // follows the clock.
  expect(await form().locator("[data-settings-section]").evaluateAll((s) => s.map((x) => x.getAttribute("data-settings-section")))).toEqual(["Sky", "Colours"]);
  await expect(field("token-sea")).toBeVisible();
  await expect(field("hour")).toHaveCount(0);
  await shot("1-settings.png");

  // The sky set to custom: the hour shows, on a slider.
  await field("sky").getByRole("combobox").click();
  await page.getByRole("option", { name: "custom" }).click();
  await expect(field("hour").locator("[data-slider]")).toBeVisible();
  // Several choices: Wed pressed beside Mon. A list, one per line.
  await field("days").locator('[data-choice="wed"]').click();
  await expect(field("days").locator('[data-choice="wed"]')).toHaveAttribute("aria-pressed", "true");
  await field("harbours").locator("[data-list]").fill("North, east\nSouth");
  // The sea's colour, typed.
  const hex = field("token-sea").locator('input[type="text"]');
  await hex.fill("#00FF88");
  await hex.press("Tab");
  await expect.poll(stored).toEqual({ sky: "custom", days: ["mon", "wed"], harbours: ["North, east", "South"], "token-sea": "#00ff88" });
  await expect(field("token-sea").getByRole("button", { name: "Theme" })).toBeVisible();
  await shot("2-settings-set.png");

  // The view, open: it was given every value as its field keeps it, and paints with the colour set.
  await page.keyboard.press("Escape");
  await page.locator("[data-view-switch]").click();
  await page.locator('[data-view-choice="looks"]').click();
  const view = async (): Promise<Frame> => {
    await expect.poll(() => page.frames().some((f) => f.url().includes("looks"))).toBe(true);
    return page.frames().find((f) => f.url().includes("looks"))!;
  };
  const looks = async () => (await view()).evaluate(() => (window as unknown as { __looks?: unknown }).__looks ?? null);
  await expect.poll(looks).toEqual({ sea: "#00ff88", foam: "#ffffff", tokens: true, fontFaces: true, settings: { sky: "custom", hour: 12, days: ["mon", "wed"], harbours: ["North, east", "South"], "token-sea": "#00ff88", foam: "#ffffff" } });
  await shot("3-view.png");

  // Back to the theme's own: the view paints with its default for this mode again. The foam,
  // whose default is a colour, reaches the theme's own colour too: "" is stored, not its default.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: "plugin:view:looks" } })));
  await field("token-sea").getByRole("button", { name: "Theme" }).click();
  await field("foam").getByRole("button", { name: "Theme" }).click();
  await expect.poll(stored).toMatchObject({ "token-sea": "", foam: "" });
  await expect(field("foam").getByRole("button", { name: "Theme" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  const now = async () => (await looks()) as { sea: string; foam: string; settings: Record<string, unknown> } | null;
  const fg = async () => (await view()).evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--hm-color-fg").trim());
  await expect.poll(async () => (await now())?.settings.foam).toBe("");
  await expect.poll(async () => (await now())?.foam).toBe(await fg());
  // Dark, its own #123a5a.
  expect(await page.evaluate(() => document.documentElement.dataset.themeMode)).toBe("dark");
  await expect.poll(async () => (await now())?.sea).toBe("#123a5a");
  // Light, the theme's info colour.
  await page.evaluate(() => window.hive.settingsPatch([{ path: "appearance.mode", value: "light" }]));
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.themeMode)).toBe("light");
  const info = async () => (await view()).evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--hm-color-info").trim());
  await expect.poll(async () => { const sea = (await now())?.sea; return !!sea && sea !== "#123a5a" && sea === (await info()); }).toBe(true);
  await shot("4-light.png");
});
