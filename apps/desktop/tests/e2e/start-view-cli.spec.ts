// A package whose manifest opens with a view (`startup.view`), installed by `hive plugins install`
// rather than Settings: the app offers "Open Isle?" once, as a toast, whether the CLI ran while it
// was open or before it started, and Open switches the view. A relaunch does not offer it again.
// (Settings' own offer, under its install, is packages-tab.spec.ts.)
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-start-view-cli-"));
const xdg = path.join(root, "config");
const repo = path.join(root, "repo");
const userData = path.join(xdg, "hivemind-dev");
const env = { ...process.env, HOME: path.join(root, "home"), XDG_CONFIG_HOME: xdg, HIVEMIND_SHELL_ENV: "0" } as Record<string, string>;
delete env.ELECTRON_RUN_AS_NODE;
const cli = path.resolve(process.cwd(), "../cli/src/index.ts");
/** Set to a folder to keep a picture of each step. */
const shots = process.env.START_VIEW_SHOTS;

/** `hive …` as a person or an agent runs it, reaching the app when one is open. */
const hive = (...args: string[]) => {
  const r = spawnSync("bun", [cli, ...args, "--json"], { cwd: repo, env: { ...env, HIVEMIND_APP_DATA: userData }, encoding: "utf8" });
  if (!r.stdout.trim()) throw new Error(r.stderr);
  return { status: r.status, data: JSON.parse(r.stdout) as Record<string, unknown> };
};

/** Package @e2e/<name>, one view that it opens with. */
function opensWith(name: string, label: string, view: string, viewLabel: string): string {
  const dir = path.join(root, name);
  const files: Record<string, string> = {
    "hivemind-package.json": JSON.stringify({ apiVersion: 2, id: `@e2e/${name}`, name: label, version: "1.0.0", views: [{ path: `views/${view}` }], startup: { view: `@e2e/${view}` } }),
    [`views/${view}/hivemind-view.json`]: JSON.stringify({ id: `@e2e/${view}`, name: viewLabel, version: "1.0.0", entry: "index.html" }),
    [`views/${view}/index.html`]: "<!doctype html>",
  };
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
  return dir;
}

let app: ElectronApplication;
let page: Page;
async function launch(): Promise<void> {
  // Never the token of the app before: the CLI waits for this one's.
  fs.rmSync(path.join(userData, "hcp.token"), { force: true });
  app = await electron.launch({ args: [path.resolve("out/main/index.js"), "--no-sandbox"], cwd: repo, env });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForSelector(".react-flow", { timeout: 30_000 });
  await expect.poll(() => fs.existsSync(path.join(userData, "hcp.token"))).toBe(true);
}
const offer = (pkg: string) => page.locator(`[data-start-view-offer="${pkg}"]`);
const shot = async (name: string) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) }); };

test.beforeAll(async () => {
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(path.join(root, "home"));
  await launch();
});
test.afterAll(async () => { await app?.close(); fs.rmSync(root, { recursive: true, force: true }); });

test("installed by the CLI while the app runs: the app offers its start view, and Open switches to it", async () => {
  const installed = hive("plugins", "install", opensWith("harbour", "Harbour", "isle", "Isle"));
  expect(installed).toMatchObject({ status: 0, data: { on: true, rescanned: true, startView: { id: "@e2e/isle", name: "Isle", open: "hive ctl plugin open view:@e2e/isle" } } });
  await expect(offer("@e2e/harbour")).toHaveText("Harbour is installed. Open Isle?Open");
  await shot("1-offer");
  await offer("@e2e/harbour").getByRole("button", { name: "Open" }).click();
  await expect(page.locator('[data-community-view="@e2e/isle"]')).toBeVisible();
  await expect(offer("@e2e/harbour")).toHaveCount(0);
  await shot("2-opened");
});

test("a relaunch does not offer it again; one installed while the app was closed is offered then", async () => {
  // Back on Canvas, where Isle would be offered again if nothing remembered it was.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: "canvas" } })));
  await expect(page.locator('[data-community-view="@e2e/isle"]')).toHaveCount(0);
  // Saved before closing (it is debounced): a relaunch on Isle would record Harbour without asking.
  const settings = path.join(xdg, "hivemind", "settings.json");
  await expect.poll(() => JSON.parse(fs.readFileSync(settings, "utf8")).views?.defaultView).toBe("canvas");
  await app.close();
  expect(hive("plugins", "install", opensWith("cove", "Cove", "bay", "Bay"))).toMatchObject({ status: 0, data: { rescanned: false, startView: { id: "@e2e/bay" } } });
  await launch();
  // Both are asked about in the one ask after the views load: Cove's offer is that ask's answer.
  await expect(offer("@e2e/cove")).toHaveText("Cove is installed. Open Bay?Open");
  await expect(offer("@e2e/harbour")).toHaveCount(0);
  await expect(page.locator('[data-community-view="@e2e/isle"]')).toHaveCount(0);
  await shot("3-relaunch");
});
