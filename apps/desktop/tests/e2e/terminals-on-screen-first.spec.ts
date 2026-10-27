// A workspace reopened with many terminals draws the ones on screen first: building every terminal
// in one task kept the window blank for a second. Those off screen are built after, each when the
// window is idle, without being scrolled to, and on the DOM renderer: a WebGL context is for a
// terminal someone sees.
import { test, expect, _electron as electron, type ElectronApplication } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { stopDaemons } from "./helpers/daemons";

const N = 12;
let root: string;
const apps: ElectronApplication[] = [];
test.beforeEach(() => { root = fs.mkdtempSync("/tmp/hm-on-screen-"); });
test.afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  stopDaemons(root);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test("reopened with many terminals, the window draws those on screen before it builds those off screen, then builds every one", async () => {
  test.setTimeout(120_000);
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  execSync("git init -q", { cwd: repo });
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(root, "config"), HOME: path.join(root, "home"), HIVEMIND_SHELL_ENV: "0" } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.HIVE_SETTINGS;
  fs.mkdirSync(env.HOME);
  const launch = async () => {
    const app = await electron.launch({ args: [path.resolve("out/main/index.js"), "--no-sandbox"], cwd: repo, env });
    apps.push(app);
    return app.firstWindow();
  };

  let page = await launch();
  await page.waitForSelector(".react-flow");
  for (let i = 0; i < N; i++) {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
    await page.waitForTimeout(150);
  }
  await expect.poll(() => page.locator(".react-flow__node-terminal .xterm-screen").count(), { timeout: 30_000 }).toBe(N);
  await page.waitForTimeout(1500);
  await apps.pop()!.close();

  page = await launch();
  // The first frame that shows a terminal built: how many wholly off screen are built by then.
  const first = await page.waitForFunction(() => {
    const pane = document.querySelector(".react-flow")?.getBoundingClientRect();
    const tiles = [...document.querySelectorAll(".react-flow__node-terminal")];
    if (!pane || !tiles.some((t) => t.querySelector(".xterm-screen"))) return false;
    const off = tiles.filter((t) => {
      const r = t.getBoundingClientRect();
      return r.right <= pane.left || r.left >= pane.right || r.bottom <= pane.top || r.top >= pane.bottom;
    });
    return { off: off.length, offBuilt: off.filter((t) => t.querySelector(".xterm-screen")).length };
  }, null, { polling: "raf", timeout: 30_000 }).then((h) => h.jsonValue());
  expect(first.off, "the board holds terminals off screen").toBeGreaterThan(3);
  expect(first.offBuilt, "terminals off screen are built after those on screen").toBeLessThan(first.off);

  await expect.poll(() => page.locator(".react-flow__node-terminal .xterm-screen").count(), { timeout: 20_000 }).toBe(N);
  const offOnWebgl = await page.evaluate(() => {
    const pane = document.querySelector(".react-flow")!.getBoundingClientRect();
    return [...document.querySelectorAll(".react-flow__node-terminal")].filter((t) => {
      const r = t.getBoundingClientRect();
      const off = r.right <= pane.left || r.left >= pane.right || r.bottom <= pane.top || r.top >= pane.bottom;
      return off && t.querySelector(".xterm-screen canvas");
    }).length;
  });
  expect(offOnWebgl, "no terminal off screen holds a WebGL context").toBe(0);
});
