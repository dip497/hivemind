// Make your own plugin: from the Add menu or Settings ▸ Plugins, say what it should do, then copy
// the prompt for an agent run anywhere or hand it to one here. The prompt points the agent at
// `hive <kind>s new`, whose PROMPT.md is the rest.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-make-plugin-"));
let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(root, "config"), HIVEMIND_PTY_DAEMON: "0", HIVEMIND_SHELL_ENV: "0" } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox"], cwd: repo, env });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 30_000 });
  // What would go to an agent here, as the app hands it on.
  await page.evaluate(() => window.addEventListener("hivemind:deliver-to-agent", (e) => { (window as unknown as { delivered: string }).delivered = (e as CustomEvent<{ text: string }>).detail.text; }));
});
test.afterAll(async () => { await app?.close(); fs.rmSync(root, { recursive: true, force: true }); });

const clipboard = () => app.evaluate(({ clipboard: c }) => c.readText());

test("from the Add menu's Tools: a tool, the idea in its prompt, copied or handed to an agent", async () => {
  await page.locator('[data-toolbar-action="board"]').click();
  await page.locator('[data-add-tab="tool"]').click();
  await page.locator("[data-add-make]").click();
  const dialog = page.locator("[data-make-plugin]");
  await expect(dialog.locator('[data-make-kind="tool"]')).toHaveAttribute("aria-checked", "true");
  await dialog.locator("[data-make-idea]").fill("Lists the open issues assigned to me");
  await dialog.locator("[data-make-copy]").click();
  await expect(dialog.locator("[data-make-copy]")).toHaveText("Copied");
  const copied = await clipboard();
  expect(copied).toContain("Build me a Hivemind tool plugin: Lists the open issues assigned to me");
  expect(copied).toContain("`hive tools new <name>`");
  expect(copied).toContain("PROMPT.md");

  await dialog.locator("[data-make-start]").click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { delivered?: string }).delivered)).toBe(copied);
});

test("from Settings ▸ Plugins: a widget by default, a view when chosen", async () => {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: "plugins" } })));
  await page.locator("[data-make-plugin-open]").click();
  const dialog = page.locator("[data-make-plugin]");
  await expect(dialog.locator('[data-make-kind="widget"]')).toHaveAttribute("aria-checked", "true");
  await dialog.locator('[data-make-kind="view"]').click();
  await dialog.locator("[data-make-copy]").click();
  await expect(dialog.locator("[data-make-copy]")).toHaveText("Copied");
  expect(await clipboard()).toContain("`hive views new <name>`");
});
