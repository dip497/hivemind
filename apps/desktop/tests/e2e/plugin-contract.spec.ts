// The plugin contract on the built page: every CSS variable tool plugins read has a value, and a
// view is told every frozen colour as #rrggbb, in its hello and in each theme since, in a dark
// preset and the light one, with glass on and off. The stylesheet declares each variable (unit
// tool-css-vars.test.ts); the build is where one can still go missing, since Tailwind's @theme
// emits a variable only as the build decides. Removing one is a Breaking change (reference.md).
import { test, expect, type Frame } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRESETS } from "@hivemind/core/settings-schema";
import { launchWindow } from "./helpers/window";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, "../../../cli/src/index.ts");
const VIEW = path.join(__dirname, "fixtures", "views", "contract");

/** The 11, as tools read them. The literal is the contract. */
const FROZEN = ["--color-bg", "--color-bg3", "--color-fg", "--color-fg3", "--color-line", "--color-select", "--color-ok", "--color-warn", "--color-err", "--color-info", "--font-mono"];
/** The 15 colours a view is told (`VIEW_THEME_COLORS`), as views have been told them since
 *  protocol 1.0. The literal is the contract. */
const COLORS = ["bg", "bg2", "bg3", "bg4", "fg", "fg2", "fg3", "line", "line2", "brand", "err", "ok", "warn", "info", "accent"];
type Told = { colors: Record<string, string>; mode?: string };
/** What a view was told that breaks the contract: each colour missing or not #rrggbb. */
const broken = (t: Told | undefined) => COLORS.filter((k) => !/^#[0-9a-f]{6}$/.test(t?.colors[k] ?? ""));

test("every CSS variable tools read has a value on the page, dark and light, with glass on and off", async () => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hm-contract-")));
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), "hm-contract-xdg-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const env = { ...process.env, XDG_CONFIG_HOME: xdg, HIVEMIND_SHELL_ENV: "0" } as Record<string, string | undefined>;
  delete env.ELECTRON_RUN_AS_NODE;
  const installed = spawnSync("bun", [CLI, "plugins", "install", VIEW, "--json"], { env: env as NodeJS.ProcessEnv, encoding: "utf8" });
  expect(installed.status, installed.stderr).toBe(0);
  const app = await launchWindow({ cwd: repo, env });
  try {
    const page = app.page;
    await page.waitForSelector(".react-flow", { timeout: 30_000 });
    // The fixture view, open: it keeps what it is told of the theme.
    await page.locator("[data-view-switch]").click();
    await page.locator('[data-view-choice="contract"]').click();
    await expect.poll(() => page.frames().some((f) => f.url().includes("contract"))).toBe(true);
    const view = (): Frame => page.frames().find((f) => f.url().includes("contract"))!;
    const told = () => view().evaluate(() => (window as unknown as { __contract?: { hello: Told; theme: Told } }).__contract ?? null).catch(() => null);
    await expect.poll(async () => broken((await told())?.hello)).toEqual([]);
    for (const id of ["signal", "clean-light"]) {
      const p = PRESETS[id]!;
      for (const glass of [true, false]) {
        await page.evaluate((patches) => window.hive.settingsPatch(patches), [
          { path: "appearance.preset", value: p.id }, { path: "appearance.mode", value: p.mode }, { path: "appearance.palette", value: p.palette },
          { path: "appearance.accent", value: p.accent }, { path: "appearance.terminal", value: p.terminal }, { path: "appearance.glass.enabled", value: glass },
        ]);
        await expect.poll(() => page.evaluate(() => document.documentElement.dataset.preset)).toBe(id);
        const empty = await page.evaluate((vars) => vars.filter((v) => !getComputedStyle(document.documentElement).getPropertyValue(v).trim()), FROZEN);
        expect([id, glass, empty]).toEqual([id, glass, []]);
        // The theme the view is told now: this preset's mode, every colour in it.
        await expect.poll(async () => { const t = (await told())?.theme; return [id, glass, t?.mode, broken(t)]; }).toEqual([id, glass, p.mode, []]);
      }
    }
  } finally {
    await app.close();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(xdg, { recursive: true, force: true });
  }
});
