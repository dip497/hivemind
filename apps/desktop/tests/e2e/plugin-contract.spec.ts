// The plugin contract on the built page: every CSS variable tool plugins read has a value, in a
// dark preset and the light one, with glass on and off. The stylesheet declares each (unit
// tool-css-vars.test.ts); the build is where one can still go missing, since Tailwind's @theme
// emits a variable only as the build decides. Removing one is a Breaking change (reference.md).
import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PRESETS } from "@hivemind/core/settings-schema";
import { launchWindow } from "./helpers/window";

/** The 11, as tools read them. The literal is the contract. */
const FROZEN = ["--color-bg", "--color-bg3", "--color-fg", "--color-fg3", "--color-line", "--color-select", "--color-ok", "--color-warn", "--color-err", "--color-info", "--font-mono"];

test("every CSS variable tools read has a value on the page, dark and light, with glass on and off", async () => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hm-contract-")));
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), "hm-contract-xdg-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const env = { ...process.env, XDG_CONFIG_HOME: xdg, HIVEMIND_SHELL_ENV: "0" } as Record<string, string | undefined>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await launchWindow({ cwd: repo, env });
  try {
    const page = app.page;
    await page.waitForSelector(".react-flow", { timeout: 30_000 });
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
      }
    }
  } finally {
    await app.close();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(xdg, { recursive: true, force: true });
  }
});
