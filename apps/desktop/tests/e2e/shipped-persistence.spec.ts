// Regression: "resume where you left off" — open tiles (vis/extras/fileTiles)
// must persist across an app restart for the same repo. Uses two launches that
// share one user-data-dir + repo cwd.
import { test, expect, _electron as electron, type ElectronApplication } from "@playwright/test";
import { execSync } from "node:child_process";
import fs, { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("open tiles restore after restart (same repo)", async () => {
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
  // Main's workspace store owns the layout (docs/design/multiplayer-2026-09-28.md, R1): the
  // window's debounced save reaches it, then the store's own debounce writes the file.
  const stored = () => {
    const d = path.join(ud, "workspaces");
    return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => fs.readFileSync(path.join(d, f), "utf8")).join("\n") : "";
  };
  await expect.poll(stored, { timeout: 5_000 }).toMatch(/"kind":"shell"/);
  await app.close();

  // ── session 2: relaunch same ud + repo → terminal tile restored, no clicks ──
  app = await launch();
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForSelector(".react-flow", { timeout: 15_000 });
  await page.waitForSelector(".react-flow__node-terminal", { timeout: 6_000 });
  expect(await page.locator(".react-flow__node-terminal").count()).toBeGreaterThan(0);
  await app.close();

  try { execSync(`rm -rf ${repo} ${ud}`); } catch { /* ignore */ }
});
