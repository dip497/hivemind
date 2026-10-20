// `hive ctl tile look`: an agent sees a tool's tile as the person does. The tile is brought into
// view, waited for until its code drew, and pictured; what its code logged comes back with it.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { seedAgents } from "./helpers/agents";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-tile-look-"));
const xdg = path.join(root, "config");
seedAgents(xdg, ["claude"]);
const repo = path.join(root, "repo");
const env = { ...process.env, XDG_CONFIG_HOME: xdg, HIVEMIND_SHELL_ENV: "0" } as Record<string, string>;
delete env.ELECTRON_RUN_AS_NODE;
const cli = path.resolve(process.cwd(), "../cli/src/index.ts");
const fixture = path.resolve(process.cwd(), "tests/e2e/fixtures/tools/look");
let hcp: Record<string, string> = {};
const hive = (...args: string[]) => {
  const result = spawnSync("bun", [cli, ...args, "--json"], { cwd: repo, env: { ...env, ...hcp }, encoding: "utf8" });
  // What it answers on stdout; a failure, `{ error: { code, message } }`, on stderr.
  if (result.stdout.trim()) return { status: result.status, data: JSON.parse(result.stdout) };
  try { return { status: result.status, data: JSON.parse(result.stderr).error }; } catch { throw new Error(result.stderr); }
};

let app: ElectronApplication;
let page: Page;
let tile = "";

test.beforeAll(async () => {
  fs.mkdirSync(repo, { recursive: true });
  expect(hive("plugins", "install", fixture).status).toBe(0);
  expect(hive("plugins", "enable", "tool:@example/look").status).toBe(0);
  app = await electron.launch({ args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox"], cwd: repo, env });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 30_000 });
  const userData = path.join(xdg, "hivemind-dev");
  await expect.poll(() => fs.existsSync(path.join(userData, "hcp.token"))).toBe(true);
  hcp = { HIVEMIND_APP_DATA: userData };
});
test.afterAll(async () => { await app?.close(); fs.rmSync(root, { recursive: true, force: true }); });

test("look at a tool's tile: a picture of what it drew, its state, and the line its code logged", async () => {
  await expect.poll(() => { const r = hive("ctl", "open-tool", "@example/look"); tile = r.data.tile ?? ""; return r.status; }).toBe(0);
  const out = path.join(root, "look.png");
  const look = hive("ctl", "tile", "look", tile, "--out", out);
  expect(look.status).toBe(0);
  expect(look.data).toMatchObject({ tile, state: "ready", drew: true, png: out });
  expect(look.data.console.map((l: { text: string }) => l.text)).toContain("look: drawn");
  // Not blank: the tile's red box is in the picture.
  const png = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const g = c.getContext("2d")!;
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let red = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i]! > 180 && d[i + 1]! < 90 && d[i + 2]! < 90) red++;
    return { width: c.width, height: c.height, red };
  }, fs.readFileSync(out).toString("base64"));
  expect(png.width).toBeGreaterThan(100);
  expect(png.red).toBeGreaterThan(1000);
});

test("look refuses, naming it, when something is drawn over the tile, and pictures nothing", async () => {
  // Half the window: a dialog over the left half, where the tile is brought into view.
  await page.evaluate(() => {
    const cover = document.createElement("div");
    cover.id = "cover";
    cover.setAttribute("role", "dialog");
    cover.setAttribute("aria-label", "Something private");
    cover.style.cssText = "position:fixed;left:0;top:0;bottom:0;width:60%;z-index:99999;background:#123";
    document.body.appendChild(cover);
  });
  const out = path.join(root, "covered.png");
  const r = spawnSync("bun", [cli, "ctl", "tile", "look", tile, "--out", out, "--json"], { cwd: repo, env: { ...env, ...hcp }, encoding: "utf8" });
  expect(r.status).toBe(7);
  expect(JSON.parse(r.stderr).error).toMatchObject({ code: "OCCLUDED", message: expect.stringContaining("a dialog (Something private)") });
  expect(fs.existsSync(out)).toBe(false);
  await page.evaluate(() => document.getElementById("cover")?.remove());
  expect(hive("ctl", "tile", "look", tile, "--out", out).status).toBe(0);
});

test("a notification over the tile is named, not hidden: the person keeps seeing it", async () => {
  await page.evaluate(() => {
    const list = document.createElement("ol");
    list.id = "toast";
    list.setAttribute("data-sonner-toaster", "");
    list.style.cssText = "position:fixed;left:0;top:0;bottom:0;width:60%;z-index:99999;background:#321;margin:0";
    list.appendChild(document.createElement("li")).textContent = "Approve: rm -rf dist";
    document.body.appendChild(list);
  });
  const r = spawnSync("bun", [cli, "ctl", "tile", "look", tile, "--json"], { cwd: repo, env: { ...env, ...hcp }, encoding: "utf8" });
  expect(JSON.parse(r.stderr).error).toMatchObject({ code: "OCCLUDED", message: expect.stringContaining("a notification") });
  expect(await page.evaluate(() => getComputedStyle(document.getElementById("toast")!).visibility)).toBe("visible");
  await page.evaluate(() => document.getElementById("toast")?.remove());
});
