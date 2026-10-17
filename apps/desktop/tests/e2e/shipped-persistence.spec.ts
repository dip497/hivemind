// Regression: "resume where you left off" — open tiles (vis/extras/fileTiles)
// must persist across an app restart for the same repo. Uses two launches that
// share one user-data-dir + repo cwd. Main's workspace store is where the layout
// lives (docs/design/multiplayer-2026-09-28.md, R1), so the window's own storage
// is deleted between the launches.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execSync } from "node:child_process";
import fs, { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** What the page's terminal shows (it draws on a canvas: its host element reads its screen). */
const screenOf = (page: Page) => page.locator(".react-flow__node-terminal").first().evaluate((el) => {
  const host = [el, ...el.querySelectorAll("*")].find((e) => "__hmScreen" in e) as (Element & { __hmScreen(): string }) | undefined;
  return host?.__hmScreen() ?? "";
});

test("open tiles restore after restart (same repo), the terminal showing what it printed", async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "hm-persist-"));
  const sh = (c: string) => execSync(c, { cwd: repo, stdio: "pipe" });
  sh("git init -q -b main"); sh('git config user.email t@t.t'); sh('git config user.name t');
  writeFileSync(path.join(repo, "a.txt"), "x\n");
  sh("git add -A"); sh('git commit -qm i');
  const ud = `/tmp/hm-persist-ud-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const main = path.join(process.cwd(), "out/main/index.js");

  const launch = async (): Promise<ElectronApplication> =>
    electron.launch({ args: [main, "--no-sandbox", `--user-data-dir=${ud}`], cwd: repo });

  // ── session 1: open Files + Terminal, let it persist ──
  let app = await launch();
  let page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForSelector(".react-flow", { timeout: 15_000 });
  await page.waitForTimeout(400);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await page.waitForSelector(".react-flow__node-terminal", { timeout: 6_000 });
  const terminal = page.locator(".react-flow__node-terminal").first();
  await terminal.click();
  await terminal.locator(".xterm-screen").click();
  await expect.poll(async () => {
    const shown = await screenOf(page);
    if (!shown.includes("persist-42")) await page.keyboard.type("echo persist-$((6*7))\n");
    return shown;
  }, { timeout: 20_000, intervals: [1_000] }).toContain("persist-42");
  // The window's debounced save reaches main's store, which writes it to disk before answering.
  await expect.poll(() => page.evaluate((r) => {
    const saved = (window.hive.workspaceCoreSync(r) ?? {}) as { tiles?: { kind: string }[] };
    return saved.tiles?.some((tile) => tile.kind === "shell") ?? false;
  }, repo), { timeout: 5_000 }).toBe(true);
  await app.close();
  const windowStorage = path.join(ud, "Local Storage");
  expect(fs.existsSync(windowStorage)).toBe(true);
  fs.rmSync(windowStorage, { recursive: true, force: true });

  // ── session 2: relaunch same ud + repo → terminal tile restored, no clicks ──
  app = await launch();
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForSelector(".react-flow", { timeout: 15_000 });
  await page.waitForSelector(".react-flow__node-terminal", { timeout: 6_000 });
  await expect.poll(() => screenOf(page), { timeout: 15_000 }).toContain("persist-42");
  await app.close();

  try { execSync(`rm -rf ${repo} ${ud}`); } catch { /* ignore */ }
});

test("a camera moved by the wheel, one notch at a time, is where it was left after a restart", async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "hm-camera-"));
  execSync("git init -q -b main", { cwd: repo, stdio: "pipe" });
  const ud = mkdtempSync(path.join(tmpdir(), "hm-camera-ud-"));
  const launch = async () => {
    const app = await electron.launch({ args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox", `--user-data-dir=${ud}`], cwd: repo });
    const page = await app.firstWindow();
    await page.waitForSelector(".react-flow__viewport", { timeout: 15_000 });
    return { app, page };
  };
  const cameraOf = (page: import("@playwright/test").Page) =>
    page.locator(".react-flow__viewport").evaluate((el) => (el as HTMLElement).style.transform);

  let { app, page } = await launch();
  // A tile, so the board is not the empty one; the wheel goes to the bare pane below it.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await page.waitForSelector(".react-flow__node-terminal", { timeout: 15_000 });
  await expect.poll(async () => { const a = await cameraOf(page); await page.waitForTimeout(400); return a === await cameraOf(page); }).toBe(true);
  const launched = await cameraOf(page);
  const box = (await page.locator(".react-flow__pane").boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.97);
  // Wheel delivery is async under xvfb: nudge until the camera moves.
  await expect.poll(async () => { await page.mouse.wheel(80, 60); await page.waitForTimeout(120); return cameraOf(page); },
    { timeout: 8_000, intervals: [50] }).not.toBe(launched);
  await expect.poll(async () => { const a = await cameraOf(page); await page.waitForTimeout(400); return a === await cameraOf(page); }).toBe(true);
  const panned = await cameraOf(page);
  await page.waitForTimeout(600); // the camera's debounced save
  await app.close();

  ({ app, page } = await launch());
  await expect.poll(() => cameraOf(page), { timeout: 8_000 }).toBe(panned);
  await app.close();
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(ud, { recursive: true, force: true });
});
