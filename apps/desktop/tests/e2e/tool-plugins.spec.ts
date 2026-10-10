// Tool plugins added to the app: installed by the CLI, off until switched on, then loaded into the
// app as a kind of tile, drawn by the plugin's own code with the app's React. A tile's `hm` is the
// client a view has, so its settings reach it live; switched off, its code is not served and its
// tiles show what they need. In safe mode none loads.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { seedAgents } from "./helpers/agents";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-tool-plugins-"));
const xdg = path.join(root, "config");
seedAgents(xdg);
const repo = path.join(root, "repo");
const env = { ...process.env, XDG_CONFIG_HOME: xdg } as Record<string, string>;
delete env.ELECTRON_RUN_AS_NODE;
const cli = path.resolve(process.cwd(), "../cli/src/index.ts");
const examples = path.resolve(process.cwd(), "../../examples/tools");
let hcp: Record<string, string> = {};
const hive = (...args: string[]) => {
  const result = spawnSync("bun", [cli, ...args, "--json"], { cwd: repo, env: { ...env, ...hcp }, encoding: "utf8" });
  if (!result.stdout.trim()) throw new Error(result.stderr);
  return { status: result.status, data: JSON.parse(result.stdout) };
};

let app: ElectronApplication;
let page: Page;

async function launch(extra: Record<string, string> = {}): Promise<void> {
  app = await electron.launch({ args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox"], cwd: repo, env: { ...env, ...extra } });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 30_000 });
  const userData = path.join(xdg, "hivemind-dev");
  await expect.poll(() => fs.existsSync(path.join(userData, "hcp.token"))).toBe(true);
  hcp = { HIVE_HCP_SOCK: path.join(userData, "hcp.sock"), HCP_TOKEN: fs.readFileSync(path.join(userData, "hcp.token"), "utf8").trim() };
}

test.beforeAll(async () => {
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  const git = (cmd: string) => execSync(`git -c user.email=t@t -c user.name=t ${cmd}`, { cwd: repo });
  execSync("git init -q -b main", { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 1; // TODO: make it fast\n");
  git("add -A && git -c user.email=t@t -c user.name=t commit -q -m 'first change'");
  fs.appendFileSync(path.join(repo, "src", "a.ts"), "export const b = 2; // FIXME: it leaks\n");
  git("add -A && git -c user.email=t@t -c user.name=t commit -q -m 'second change'");
  for (const name of ["todo-finder", "git-history"]) {
    const r = hive("tools", "install", path.join(examples, name));
    expect(r.status).toBe(0);
  }
  expect(hive("plugins", "enable", "tool:dip497/todo-finder").status).toBe(0);
  await launch();
});
test.afterAll(async () => { await app?.close(); fs.rmSync(root, { recursive: true, force: true }); });

const tile = (id: string) => page.locator(`[data-tool-plugin="${id}"]`);

test("an added tool opens as a tile drawn by its own code, and its settings reach it live", async () => {
  const opened = hive("ctl", "open-tool", "dip497/todo-finder/todos");
  expect(opened.status).toBe(0);
  await expect(tile("dip497/todo-finder")).toContainText("make it fast", { timeout: 20_000 });
  await expect(tile("dip497/todo-finder")).toContainText("it leaks");
  await expect(tile("dip497/todo-finder").locator('[data-marker="FIXME"]')).toHaveText("FIXME 1");
  // Its `hm` is linked with the permissions its manifest declares: it offers to start an agent.
  await expect(tile("dip497/todo-finder").getByRole("button", { name: "Hand to an agent" }).first()).toBeVisible();

  expect(hive("plugins", "set", "tool:dip497/todo-finder", "pattern", "FIXME").status).toBe(0);
  await expect(tile("dip497/todo-finder")).not.toContainText("make it fast");
  await expect(tile("dip497/todo-finder")).toContainText("it leaks");
});

test("a tool that is off cannot be opened and its code is not served; switched on, it runs", async () => {
  expect(hive("ctl", "open-tool", "dip497/git-history/history").data.code).toBe("FORBIDDEN");
  // Whether the window can import its module: a fresh URL each time, as a failed import is remembered.
  const served = (url: string) => page.evaluate((u) => import(/* @vite-ignore */ `${u}?probe=${Math.random()}`).then(() => "served", () => "refused"), url);
  expect(await served("hm-plugin://dip497--git-history/index.js")).toBe("refused");

  expect(hive("plugins", "enable", "tool:dip497/git-history").status).toBe(0);
  await expect.poll(() => served("hm-plugin://dip497--git-history/index.js")).toBe("served");
  expect(hive("ctl", "open-tool", "dip497/git-history/history").status).toBe(0);
  const history = tile("dip497/git-history");
  await expect(history).toContainText("second change", { timeout: 20_000 });
  await history.locator("[data-commit]").first().click();
  // The commit's diff, drawn by the app's own diff view.
  await expect(history).toContainText("Ask an agent to explain");
  // The diff view draws inside shadow roots: read the text through them.
  const deepText = () => history.evaluate((el) => {
    const walk = (n: Element | ShadowRoot): string => [...n.children].map((c) => (c.shadowRoot ? walk(c.shadowRoot) : "") + (c.children.length ? walk(c) : c.textContent ?? "")).join(" ");
    return walk(el);
  });
  await expect.poll(deepText, { timeout: 15_000 }).toContain("it leaks");
  await page.screenshot({ path: "/tmp/hivemind-tool-plugins.png" });
  // The app draws its bar on a tool's tile, as on its own: closing it there closes the tile.
  await expect(history.locator(".tile-drag-handle")).toContainText("Git history");
  await history.getByRole("button", { name: "close tile" }).click();
  await expect(history).toHaveCount(0);
  const kinds = () => (hive("ctl", "list").data.frames as Array<{ tiles: Array<{ kind: string }> }>).flatMap((f) => f.tiles.map((t) => t.kind));
  await expect.poll(kinds).not.toContain("git-history");
});

test("switched off, its open tiles stay on the board and say what they need", async () => {
  expect(hive("plugins", "disable", "tool:dip497/todo-finder").status).toBe(0);
  await expect(page.locator('[data-missing-plugin="todo-finder"]')).toBeVisible({ timeout: 10_000 });
  await expect(tile("dip497/todo-finder")).toHaveCount(0);
});

test("in safe mode no added tool loads, even one switched on", async () => {
  await app.close();
  expect(hive("plugins", "enable", "tool:dip497/todo-finder").status).toBe(0);
  await launch({ HIVEMIND_SAFE_MODE: "1" });
  await expect(page.locator('[data-missing-plugin="todo-finder"]')).toBeVisible({ timeout: 20_000 });
  expect(hive("ctl", "open-tool", "dip497/todo-finder/todos").data.code).toBe("UNSUPPORTED");
  expect(await page.evaluate(() => import(/* @vite-ignore */ `hm-plugin://dip497--todo-finder/index.js?probe=${Math.random()}`).then(() => "served", () => "refused"))).toBe("refused");
});
