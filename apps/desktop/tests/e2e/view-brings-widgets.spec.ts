// A package's view brings the package's widgets: the first time a workspace shows the view, its
// widgets float down the edge the view keeps for them, over that view alone, and the view is told
// how much room they take. One the person closes stays closed, through a view switch, the view
// opened by the CLI and a relaunch (unless they press Undo, offered while that workspace is shown),
// and a widget a later version of the package adds comes at once while the view shows. One shown on
// every view, from its pin by pointer or keyboard or by an agent, floats over the canvas too, where a
// tile the camera flies to is framed clear of it. (The start-view offer itself is
// start-view-cli.spec.ts.)
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-view-widgets-"));
const xdg = path.join(root, "config");
const repo = path.join(root, "repo");
/** Another workspace the window can switch to. */
const other = path.join(root, "other");
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

/** The view's own code: it writes on its page the band of widget cards the app says it has. */
const ISLE = `
window.addEventListener("message", (e) => {
  const port = e.ports && e.ports[0];
  if (!port || !e.data || e.data.type !== "hivemind-view:port") return;
  port.start();
  port.postMessage({ type: "ready", v: 1 });
  port.onmessage = (m) => { if (m.data && m.data.type === "widgetBand") document.body.dataset.band = m.data.edge + ":" + m.data.width; };
});
`;
/** The bell counts its starts in what it keeps, and says its step option: a bell put back as it
 *  was says the step it was set to and a count past the one it had. */
const BELL = `
hive.on("start", () => {
  const n = ((hive.state && hive.state.n) || 0) + 1;
  hive.setState({ n });
  hive.render({ type: "text", text: "bell here, start " + n + ", step " + hive.options.step });
});
`;

/** Package @e2e/kit at `version`: view Isle, whose widgets go down the left, and the widgets named. */
function kit(version: string, widgets: string[]): string {
  const dir = path.join(root, `kit-${version}`);
  const files: Record<string, string> = {
    "hivemind-package.json": JSON.stringify({ apiVersion: 2, id: "@e2e/kit", name: "Kit", version,
      views: [{ path: "views/isle" }], widgets: widgets.map((w) => ({ path: `widgets/${w}` })), startup: { view: "@e2e/isle" } }),
    "views/isle/hivemind-view.json": JSON.stringify({ id: "@e2e/isle", name: "Isle", version, entry: "index.html", widgets: "left" }),
    "views/isle/index.html": `<!doctype html><body><script src="isle.js"></script></body>`,
    "views/isle/isle.js": ISLE,
  };
  for (const w of widgets) {
    if (w === "bell") {
      files["widgets/bell/widget.json"] = JSON.stringify({ id: "@e2e/bell", name: "bell", version, options: [{ id: "step", label: "Step", type: "number", default: 1 }] });
      files["widgets/bell/widget.js"] = BELL;
      continue;
    }
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
/** One stored widget, as the workspace holds it. */
const storedWidget = (w: string) => page.evaluate(([r, id]) => (window.hive.workspaceObjectsSync(r) as Array<Record<string, unknown>>)
  .find((o) => o.kind === "widget" && o.widget === id), [repo, `@e2e/${w}`] as const);
/** The band of widget cards Isle was last told of, as `edge:width`. */
const band = () => page.frameLocator('[data-community-view="@e2e/isle"] iframe').locator("body").getAttribute("data-band");
const rightInset = () => page.evaluate(() => document.documentElement.style.getPropertyValue("--widgets-right-inset"));
const toggle = () => page.locator("[data-widgets-toggle]");

test.beforeAll(async () => {
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(other, { recursive: true });
  fs.mkdirSync(path.join(root, "home"));
  await launch();
});
test.afterAll(async () => { await app?.close(); fs.rmSync(root, { recursive: true, force: true }); });

test("opening a package's view brings its widgets, down the edge the view keeps for them, and tells the view the room they take", async () => {
  expect(hive("plugins", "install", kit("1.0.0", ["bell", "log"]))).toMatchObject({ status: 0, data: { on: true } });
  await page.locator('[data-start-view-offer="@e2e/kit"]').getByRole("button", { name: "Open" }).click();
  await expect(isle()).toBeVisible();
  await expect(card("bell")).toContainText("bell here, start 1, step 1");
  await expect(card("log")).toContainText("log here");
  // Down the left edge, Isle's choice; each says it came with Isle.
  for (const w of ["bell", "log"]) expect((await card(w).boundingBox())!.x).toBeLessThan(400);
  for (const w of ["bell", "log"]) expect((await storedWidget(w))?.view).toBe("@e2e/isle");
  // One column of cards from the left edge, with the gap beside it; the window's right corner is clear.
  await expect.poll(band).toBe("left:268");
  expect(await rightInset()).toBe("0px");
  // The card's buttons sit on its top edge, on a backing: never over its first line.
  await card("log").hover();
  const strip = (await card("log").locator("[data-widget-strip]").boundingBox())!;
  const line = (await card("log").getByText("log here").boundingBox())!;
  expect(strip.y + strip.height).toBeLessThanOrEqual(line.y + 0.5);
  expect(await card("log").locator("[data-widget-strip]").evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
  await shot("1-brought");
});

test("× takes a widget away with an Undo that puts it back as it was; one closed stays closed, and one a view brought waits for that view", async () => {
  // Set to step 5 first: Undo puts back what it was set to and what its code kept.
  await card("bell").hover();
  await card("bell").getByRole("button", { name: "bell options" }).click();
  await card("bell").getByLabel("Step").fill("5");
  await card("bell").getByLabel("Step").blur();
  await expect.poll(async () => (await storedWidget("bell"))?.options).toEqual({ step: 5 });
  await card("bell").getByRole("button", { name: "bell options" }).click();
  await card("bell").getByRole("button", { name: "remove bell" }).click();
  await expect(card("bell")).toHaveCount(0);
  const removed = page.locator("[data-sonner-toast]").filter({ hasText: "bell removed" });
  // Still there after the 4 s a notice usually stays: there is time to reach it.
  await page.waitForTimeout(5_000);
  await removed.getByRole("button", { name: "Undo" }).click({ timeout: 1_000 });
  // Started again on what it kept (its second start) and the step it was set to, where it was.
  await expect(card("bell")).toContainText("bell here, start 2, step 5");
  await expect.poll(() => storedWidget("bell")).toMatchObject({ options: { step: 5 }, view: "@e2e/isle" });
  await card("bell").hover();
  await card("bell").getByRole("button", { name: "remove bell" }).click();
  await expect(card("bell")).toHaveCount(0);
  // Its Undo puts it back on the workspace shown: switched to another, the offer goes, even while
  // the pointer holds it open.
  await removed.hover();
  const showWorkspace = (folder: string) => page.evaluate((r) => window.dispatchEvent(new CustomEvent("hivemind:open-workspace", { detail: { repo: r } })), folder);
  await showWorkspace(other);
  await expect(removed).toHaveCount(0);
  await showWorkspace(repo);
  await expect(card("log")).toContainText("log here");
  await toView("canvas");
  await expect(isle()).toHaveCount(0);
  // The one left came with Isle: it waits for Isle, kept and not drawn over the canvas.
  await expect(card("log")).toHaveCount(0);
  await expect(toggle()).toHaveCount(0);
  expect(await rightInset()).toBe("0px");
  expect(hive("ctl", "plugin", "open", "view:@e2e/isle")).toMatchObject({ status: 0, data: { view: "@e2e/isle" } });
  await expect(isle()).toBeVisible();
  await settled();
  expect(await stored()).toEqual(["@e2e/log"]);
  await expect(card("bell")).toHaveCount(0);
  await expect(card("log")).toContainText("log here");
  await shot("2-closed-stays-closed");
});

test("one shown on every view floats over the canvas too, hidden over each view on its own, and a frame flown to is framed clear of it", async () => {
  // From the keyboard, the pointer nowhere near the card: Tab reaches its pin, which shows.
  await page.mouse.move(900, 450);
  const pin = card("log").getByRole("button", { name: "show log on every view" });
  const keysOn = () => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? null);
  for (let i = 0; i < 60 && (await keysOn()) !== "show log on every view"; i++) await page.keyboard.press("Tab");
  await expect(pin).toBeFocused();
  expect(await card("log").locator("[data-widget-strip]").evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
  await shot("3a-pin-from-keyboard");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await storedWidget("log"))?.view).toBeUndefined();
  await toView("canvas");
  await expect(card("log")).toContainText("log here");
  // Down the canvas's right edge: the app's corners keep clear of the column by its width.
  expect((await card("log").boundingBox())!.x).toBeGreaterThan(1000);
  await expect.poll(rightInset).toBe("268px");
  // The agents' notices stand left of the column, out of the toggle's corner: it stays where it is
  // however tall they stand, off the column's cards.
  const bottom = async () => { const b = (await toggle().boundingBox())!; return Math.round(900 - b.y - b.height); };
  const alone = await bottom();
  await page.evaluate(() => document.documentElement.style.setProperty("--agent-toasts-height", "120px"));
  expect(await bottom()).toBe(alone);
  // Hidden over the canvas, shown over Isle: what the person chose for each view.
  await toggle().click();
  await expect(card("log")).toHaveCount(0);
  await expect.poll(rightInset).toBe("0px");
  // With no column the notices are in its corner: it rises above them by however tall they stand.
  await expect.poll(bottom).toBe(alone + 120);
  await page.evaluate(() => document.documentElement.style.setProperty("--agent-toasts-height", "0px"));
  await toView("@e2e/isle");
  await expect(card("log")).toContainText("log here");
  await expect.poll(band).toBe("left:268");
  await toView("canvas");
  await expect(card("log")).toHaveCount(0);
  await toggle().click();
  await expect(card("log")).toContainText("log here");
  // A narrower window: a new frame is flown to and framed in the room left of the column.
  await page.setViewportSize({ width: 1200, height: 800 });
  await expect.poll(rightInset).toBe("268px");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:add-frame")));
  const column = (await card("log").boundingBox())!.x;
  const lastFrame = () => page.evaluate(() => {
    const all = [...document.querySelectorAll(".react-flow__node-frame")];
    const r = all.at(-1)?.getBoundingClientRect();
    return r ? { left: r.left, right: r.right } : null;
  });
  await expect.poll(async () => { const f = await lastFrame(); return !!f && f.left > 0 && f.right <= column; }, { timeout: 10_000 }).toBe(true);
  await shot("3-every-view");
  await page.setViewportSize({ width: 1440, height: 900 });
  await toView("@e2e/isle");
  await expect(isle()).toBeVisible();
});

test("through a relaunch with both closed, only the widget a later version adds comes, at once while the view shows", async () => {
  await card("log").hover();
  await card("log").getByRole("button", { name: "remove log" }).click();
  await expect(card("log")).toHaveCount(0);
  // The cards went: the view is told it has the room back.
  await expect.poll(band).toBe("left:0");
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
  await shot("4-update");
});
