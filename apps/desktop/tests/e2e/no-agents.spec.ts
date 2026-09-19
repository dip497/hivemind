// The empty world: nothing is compiled in, nothing is installed, and the HiveHub
// index is unreachable (playwright.config.ts points HIVEMIND_PLUGIN_INDEX at a dead
// file: URL). Starting an agent must say so and open Settings ▸ Plugins — the one
// place an agent can be gotten — instead of spawning or failing silently. Plain
// shells are not held hostage by the empty catalog.
import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("with no agent installed, starting one opens Settings ▸ Plugins, and a plain shell still works", async () => {
  // Own profile: the suite's shared one is seeded with the usual six; this spec needs none.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-no-agents-"));
  const env = {
    ...process.env, XDG_CONFIG_HOME: path.join(root, "config"),
    HIVEMIND_SHELL_ENV: "0", // the catalog must be empty, not whatever CLIs this machine has
  } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.resolve("out/main/index.js"), "--no-sandbox"], cwd: root, env });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector(".react-flow");
    // No spawnable agent → no agent control on the toolbar at all.
    await expect(page.getByRole("button", { name: "switch agent" })).toHaveCount(0);

    const nodes = () => page.locator(".react-flow__node-terminal").count();
    const before = await nodes();
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:spawn-claude")));
    await expect(page.getByText("No agent installed — install one from Settings ▸ Plugins.")).toBeVisible();
    await expect(page.locator(".settings-dialog")).toBeVisible();
    await expect(page.locator('[data-settings-page="plugins"]')).toHaveAttribute("aria-current", "page");
    // The reason nothing auto-installed is said out loud, not swallowed.
    await expect(page.getByText(/Could not load the plugin catalog/)).toBeVisible();
    // Nothing spawned behind the dialog.
    expect(await nodes()).toBe(before);

    // Terminals are agent-independent.
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByTitle(/^Terminal  /).click();
    await page.waitForSelector(".xterm");
    await expect(page.locator(".react-flow__node-terminal")).toHaveCount(before + 1);
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
