// A package's view brings the package's widgets: the first time a workspace shows the view, its
// widgets float down the edge the view keeps for them. One the person closes stays closed, through
// a view switch, the view opened by the CLI and a relaunch, and a widget a later version of the
// package adds comes at once while the view shows. (The start-view offer itself is
// start-view-cli.spec.ts.)
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-view-widgets-"));
const xdg = path.join(root, "config");
const repo = path.join(root, "repo");
const userData = path.join(xdg, "hivemind-dev");
const env = { ...process.env, HOME: path.join(root, "home"), XDG_CONFIG_HOME: xdg, HIVEMIND_SHELL_ENV: "0" } as Record<string, string>;
delete env.ELECTRON_RUN_AS_NODE;
const cli = path.resolve(process.cwd(), "../cli/src/index.ts");
/** Set to a folder to keep a picture of each step. */
const shots = process.env.VIEW_WIDGETS_SHOTS;

/** `hive …` as a person or an agent runs it, reaching the app when one is open. */
const hive = (...args: string[]) => {
  const r = spawnSync("bun", [cli, ...args, "--json"], { cwd: repo, env: { ...env, HIVEMIND_APP_DATA: userData }, encoding: "utf8" });
  if (!r.stdout.trim()) throw new Error(r.stderr);
  return { status: r.status, data: JSON.parse(r.stdout) as Record<string, unknown> };
};

/** Package @e2e/kit at `version`: view Isle, whose widgets go down the left, and the widgets named. */
function kit(version: string, widgets: string[]): string {
  const dir = path.join(root, `kit-${version}`);
  const files: Record<string, string> = {
    "hivemind-package.json": JSON.stringify({ apiVersion: 2, id: "@e2e/kit", name: "Kit", version,
      views: [{ path: "views/isle" }], widgets: widgets.map((w) => ({ path: `widgets/${w}` })), startup: { view: "@e2e/isle" } }),
    "views/isle/hivemind-view.json": JSON.stringify({ id: "@e2e/isle", name: "Isle", version, entry: "index.html", widgets: "left" }),
    "views/isle/index.html": "<!doctype html>",
  };
  for (const w of widgets) {
    files[`widgets/${w}/widget.json`] = JSON.stringify({ id: `@e2e/${w}`, name: w, version, draw: { type: "text", text: `${w} here` } });
  }
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
  return dir;
}

let app: ElectronApplication;
let page: Page;
async function launch(): Promise<void> {
  fs.rmSync(path.join(userData, "hcp.token"), { force: true });
  app = await electron.launch({ args: [path.resolve("out/main/index.js"), "--no-sandbox"], cwd: repo, env });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForSelector(".react-flow, [data-community-view]", { timeout: 30_000 });
  await expect.poll(() => fs.existsSync(path.join(userData, "hcp.token"))).toBe(true);
}
const card = (w: string) => page.locator(`[data-widget-layer] [data-widget="@e2e/${w}"]`);
const isle = () => page.locator('[data-community-view="@e2e/isle"]');
const toView = (mode: string) => page.evaluate((m) => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: m } })), mode);
const shot = async (name: string) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
/** Two frames and a task later: whatever the last render set off has run. */
const settled = () => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 0)))));
/** The widgets the workspace holds, as stored. */
const stored = () => page.evaluate((r) => (window.hive.workspaceObjectsSync(r) as Array<{ kind: string; widget?: string }>)
  .flatMap((o) => (o.kind === "widget" && o.widget ? [o.widget] : [])).sort(), repo);

test.beforeAll(async () => {
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(path.join(root, "home"));
  await launch();
});
test.afterAll(async () => { await app?.close(); fs.rmSync(root, { recursive: true, force: true }); });

test("opening a package's view brings its widgets, down the edge the view keeps for them", async () => {
  expect(hive("plugins", "install", kit("1.0.0", ["bell", "log"]))).toMatchObject({ status: 0, data: { on: true } });
  await page.locator('[data-start-view-offer="@e2e/kit"]').getByRole("button", { name: "Open" }).click();
  await expect(isle()).toBeVisible();
  await expect(card("bell")).toContainText("bell here");
  await expect(card("log")).toContainText("log here");
  // Down the left edge, Isle's choice.
  for (const w of ["bell", "log"]) expect((await card(w).boundingBox())!.x).toBeLessThan(400);
  await shot("1-brought");
});

test("a widget closed stays closed when the view shows again, opened by the CLI", async () => {
  await card("bell").hover();
  await card("bell").getByRole("button", { name: "remove bell" }).click();
  await expect(card("bell")).toHaveCount(0);
  await toView("canvas");
  await expect(isle()).toHaveCount(0);
  // The one left stays on the canvas, as any widget does.
  await expect(card("log")).toHaveCount(1);
  expect(hive("ctl", "plugin", "open", "view:@e2e/isle")).toMatchObject({ status: 0, data: { view: "@e2e/isle" } });
  await expect(isle()).toBeVisible();
  await settled();
  expect(await stored()).toEqual(["@e2e/log"]);
  await expect(card("bell")).toHaveCount(0);
  await shot("2-closed-stays-closed");
});

test("through a relaunch with both closed, only the widget a later version adds comes, at once while the view shows", async () => {
  await card("log").hover();
  await card("log").getByRole("button", { name: "remove log" }).click();
  await expect(card("log")).toHaveCount(0);
  // Saved before closing (debounced): the relaunch opens on Isle with nothing on the board.
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(xdg, "hivemind", "settings.json"), "utf8")).views?.defaultView).toBe("@e2e/isle");
  await expect.poll(stored).toEqual([]);
  await app.close();
  await launch();
  await expect(isle()).toBeVisible();
  // A version with a third widget, installed while Isle shows: it comes, and only it. Had the
  // workspace forgotten what it was brought, all three would.
  expect(hive("plugins", "install", kit("1.1.0", ["bell", "log", "tide"]))).toMatchObject({ status: 0 });
  await expect(card("tide")).toContainText("tide here");
  await settled();
  expect(await stored()).toEqual(["@e2e/tide"]);
  await shot("3-update");
});
