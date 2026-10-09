// Widgets: a package in the profile's widgets folder is offered in the widget dock every view
// shows, added, run in a worker, drawn from what it renders, and its button reaches its code,
// which keeps state in the workspace.
import { test, expect, _electron as electron } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// It also counts, in what it keeps, how many times its code has started: switching views must
// not start it again.
const COUNTER = `
const draw = () => hive.render({ type: "stack", children: [
  { type: "number", value: (hive.state && hive.state.n) || 0, label: "presses" },
  { type: "text", text: "started " + ((hive.state && hive.state.starts) || 0) },
  { type: "button", label: "Press", action: "inc" },
] });
hive.on("start", () => { hive.setState({ ...(hive.state || {}), starts: ((hive.state && hive.state.starts) || 0) + 1 }); draw(); });
hive.on("action", (a) => { if (a === "inc") { hive.setState({ ...(hive.state || {}), n: ((hive.state && hive.state.n) || 0) + 1 }); draw(); } });
`;

test("a widget is offered, added, drawn in every view, and its button changes what it keeps", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "hm-widget-repo-"));
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), "hm-widget-ud-"));
  execSync("git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init", { cwd: repo });
  // Widgets live beside the views, in the config folder the CLI reads too.
  const counter = path.join(ud, "config", "hivemind", "widgets", "counter");
  fs.mkdirSync(counter, { recursive: true });
  fs.writeFileSync(path.join(counter, "widget.json"), JSON.stringify({ name: "Counter" }));
  fs.writeFileSync(path.join(counter, "widget.js"), COUNTER);
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(ud, "config") };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox", `--user-data-dir=${ud}`], cwd: repo, env });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector(".react-flow", { timeout: 30_000 });
    // Added from the toolbar's Add menu, which offers widgets in every view.
    await page.locator('[data-toolbar-action="board"]').first().click();
    await page.locator('[data-board-choice="widget:counter"]').click();
    const widget = page.locator('[data-widget-layer] [data-widget="counter"]');
    await expect(widget).toContainText("presses", { timeout: 10_000 });
    await expect(widget).toContainText("0");
    await widget.getByRole("button", { name: "Press" }).click();
    await widget.getByRole("button", { name: "Press" }).click();
    await expect(widget).toContainText("2");
    // The same widget, where it was, in another view.
    await page.locator("[data-view-switch]").click();
    await page.locator('[data-view-choice="windows"]').click();
    await expect(widget).toContainText("2");
    await expect(widget).toContainText("started 1");
    await widget.getByRole("button", { name: "Press" }).click();
    await expect(widget).toContainText("3");
    await expect.poll(async () => {
      const objects = await page.evaluate((r) => window.hive.workspaceObjectsSync(r), repo) as Array<{ kind: string; state?: { n?: number } }>;
      return objects.find((o) => o.kind === "widget")?.state?.n;
    }, { timeout: 10_000 }).toBe(3);

    // A view that shows widgets (a phone's way of showing them) draws the counter, and a press
    // there reaches its code, here in this window.
    const viewer = path.join(ud, "config", "hivemind", "views", "widget-viewer");
    fs.cpSync(path.join(process.cwd(), "tests/e2e/fixtures/views/widget-viewer"), viewer, { recursive: true });
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:reload-views")));
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: "widget-viewer" } })));
    const frame = page.frameLocator('[data-community-view="widget-viewer"] iframe');
    const card = frame.locator('[data-widget="counter"]');
    await expect(card).toContainText("Counter", { timeout: 20_000 });
    await card.getByRole("button", { name: "Press" }).click();
    await expect.poll(async () => {
      const objects = await page.evaluate((r) => window.hive.workspaceObjectsSync(r), repo) as Array<{ kind: string; state?: { n?: number } }>;
      return objects.find((o) => o.kind === "widget")?.state?.n;
    }, { timeout: 10_000 }).toBe(4);
  } finally {
    await app.close();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(ud, { recursive: true, force: true });
  }
});

// A widget's `hive.hm` is the client a view has: it reads the workspace (here, its tiles) and
// is held to the permissions its widget.json asks for (here, none: closing a tile is refused).
const TILES = `
let ids = [];
const draw = (why) => hive.render({ type: "stack", children: [
  { type: "number", value: ids.length, label: "tiles" },
  { type: "text", text: why || "-" },
  { type: "button", label: "Close one", action: "close" },
] });
hive.on("start", () => {
  draw();
  hive.hm.on("structure", (s) => { ids = s.tiles.map((t) => t.id); draw(); });
});
hive.on("action", () => {
  hive.hm.commands.closeTile(ids[0]).then(() => draw("closed"), (e) => draw("refused: " + e.message));
});
`;

test("a widget reads the workspace through hive.hm, held to what its widget.json asks for", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "hm-widget-hm-repo-"));
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), "hm-widget-hm-ud-"));
  execSync("git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init", { cwd: repo });
  const dir = path.join(ud, "config", "hivemind", "widgets", "tiles");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "widget.json"), JSON.stringify({ name: "Tiles" }));
  fs.writeFileSync(path.join(dir, "widget.js"), TILES);
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(ud, "config") };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox", `--user-data-dir=${ud}`], cwd: repo, env });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector(".react-flow", { timeout: 30_000 });
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
    await expect(page.locator(".react-flow__node-terminal")).toHaveCount(1, { timeout: 15_000 });
    await page.locator('[data-toolbar-action="board"]').first().click();
    await page.locator('[data-board-choice="widget:tiles"]').click();
    const widget = page.locator('[data-widget-layer] [data-widget="tiles"]');
    await expect(widget).toContainText("tiles", { timeout: 15_000 });
    await expect.poll(() => widget.locator("text=/^\\d+$/").first().textContent(), { timeout: 15_000 }).toBe("1");
    await widget.getByRole("button", { name: "Close one" }).click();
    await expect(widget).toContainText("refused", { timeout: 10_000 });
    await expect(widget).toContainText("workspace:close");
    await expect(page.locator(".react-flow__node-terminal")).toHaveCount(1);
  } finally {
    await app.close();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(ud, { recursive: true, force: true });
  }
});
