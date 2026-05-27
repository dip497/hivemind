// Regression coverage for the 2026-05 work: diff tile (CodeView migration),
// agent status indicator, perf motion-aware compositing, MiniMap opt-in, and
// the CommandDialog a11y fix. Launches against a throwaway git repo fixture so
// diff content is deterministic (real changes + a branch base).
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let app: ElectronApplication;
let page: Page;
let repo: string;
const consoleErrors: string[] = [];

const sh = (c: string) => execSync(c, { cwd: repo, stdio: "pipe" });

test.beforeAll(async () => {
  repo = mkdtempSync(path.join(tmpdir(), "hm-shipped-"));
  sh("git init -q -b main");
  sh('git config user.email t@t.t'); sh('git config user.name t');
  mkdirSync(path.join(repo, "src"));
  writeFileSync(path.join(repo, "src/app.ts"), Array.from({ length: 40 }, (_, i) => `export const fn${i} = () => ${i};`).join("\n") + "\n");
  sh("git add -A"); sh('git commit -qm init');
  sh("git update-ref refs/remotes/origin/main HEAD"); // branch-mode base
  sh('git commit -qm c2 --allow-empty');
  // working-tree changes: modify + add + delete-equivalent
  writeFileSync(path.join(repo, "src/app.ts"), Array.from({ length: 40 }, (_, i) => `export const fn${i} = () => ${i === 3 ? 999 : i};`).join("\n") + "\n");
  writeFileSync(path.join(repo, "src/new.ts"), "export const fresh = true;\n");

  app = await electron.launch({
    args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox", `--user-data-dir=/tmp/hm-ud-${Date.now()}-${Math.random().toString(36).slice(2)}`],
    cwd: repo,
  });
  page = await app.firstWindow();
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
  page.on("pageerror", (e) => consoleErrors.push("PAGEERROR: " + e.message));
  await page.waitForLoadState("domcontentloaded");
  await page.waitForSelector(".react-flow", { timeout: 15_000 });
  await page.waitForTimeout(400);
});

test.afterAll(async () => {
  await app?.close();
  try { execSync(`rm -rf ${repo}`); } catch { /* ignore */ }
});

async function openDiff() {
  if ((await page.locator(".react-flow__node-diff").count()) === 0) {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "diff" })));
    await page.waitForSelector(".react-flow__node-diff", { timeout: 6_000 });
  }
  // Poll for actual diff content — git status + per-file content fetch + parse
  // + CodeView render takes a beat (longer under xvfb than a fixed sleep covers).
  await page.waitForFunction(
    () => (document.querySelector("[data-pierre-tile]")?.textContent || "").includes("src/app.ts"),
    undefined,
    { timeout: 12_000 },
  ).catch(() => {});
}

test("diff tile renders per-file headers with +/- counts and review controls", async () => {
  await openDiff();
  const body = await page.evaluate(() => document.querySelector("[data-pierre-tile]")?.textContent || "");
  expect(body).toContain("src/app.ts"); // first file's header (rendered)
  // header controls from the CodeView migration (on the rendered file)
  expect(body).toMatch(/viewed/);
  expect(body).toMatch(/open/);
  expect(await page.locator('input[placeholder="search diff…"]').count()).toBeGreaterThan(0);
  // both changed files counted in the tile chrome (CodeView virtualizes the
  // off-screen file out of the DOM, so assert the count chip, not its header).
  const chrome = await page.evaluate(() => document.querySelector(".react-flow__node-diff")?.textContent || "");
  expect(chrome).toMatch(/2f/);
});

test("in-diff search finds line matches and navigates", async () => {
  await openDiff();
  await page.fill('input[placeholder="search diff…"]', "fn3");
  await page.waitForTimeout(800);
  const counter = () => page.evaluate(() => {
    const e = [...document.querySelectorAll("span")].find((s) => /^\d+\/\d+$/.test((s.textContent || "").trim()));
    return e?.textContent?.trim() || "none";
  });
  const c1 = await counter();
  expect(c1).toMatch(/^\d+\/\d+$/);
  const total = Number(c1.split("/")[1]);
  expect(total).toBeGreaterThan(0);
  await page.click('button[title^="next match"]');
  await page.waitForTimeout(400);
  await page.fill('input[placeholder="search diff…"]', "");
});

test("diff body scrolls (CodeView overflow-y-auto)", async () => {
  await openDiff();
  const res = await page.evaluate(async () => {
    const el = document.querySelector("[data-pierre-tile] .overflow-y-auto") as HTMLElement | null;
    if (!el) return "no-el";
    const before = el.scrollTop;
    el.scrollTop = 300;
    await new Promise((r) => setTimeout(r, 200));
    return el.scrollTop > before ? "scrolls" : "stuck";
  });
  expect(res).toBe("scrolls");
});

test("commit bar stages and commits from the diff", async () => {
  await openDiff();
  // working mode commit bar present
  const stageAll = page.locator('button[title="stage all changes"]');
  await expect(stageAll).toBeVisible({ timeout: 4_000 });
  await stageAll.click();
  await page.waitForTimeout(800);
  // message + commit
  const msg = page.locator('input[placeholder*="commit message"]');
  await expect(msg).toBeEnabled({ timeout: 4_000 });
  await msg.fill("test: commit from diff bar");
  const commitBtn = page.locator('button', { hasText: /^commit$/ });
  await commitBtn.click();
  // after commit the working tree is clean (no changed files) -> empty state
  await page.waitForFunction(
    () => (document.querySelector(".react-flow__node-diff")?.textContent || "").includes("working tree clean"),
    undefined,
    { timeout: 8_000 },
  );
  expect(await page.evaluate(() => (document.querySelector(".react-flow__node-diff")?.textContent || "").includes("working tree clean"))).toBe(true);
});

test("branch mode renders against origin/main", async () => {
  await openDiff();
  await page.locator('button', { hasText: /^branch$/ }).first().click();
  await page.waitForTimeout(2500);
  const body = await page.evaluate(() => document.querySelector("[data-pierre-tile]")?.textContent || "");
  expect(body).not.toContain("loading diff");
  await page.locator('button', { hasText: /^working$/ }).first().click();
  await page.waitForTimeout(800);
});

test("agent status indicator transitions idle -> working on PTY output", async () => {
  if ((await page.locator(".react-flow__node-terminal .xterm").count()) === 0) {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
    await page.waitForSelector(".react-flow__node-terminal .xterm", { timeout: 6_000 });
    await page.waitForTimeout(1500);
  }
  const label = () => page.evaluate(() => {
    const t = [...document.querySelectorAll("span")].find((s) => ["working", "idle", "exited", "starting"].includes((s.textContent || "").trim()));
    return t?.textContent?.trim() || "?";
  });
  expect(["idle", "working", "starting"]).toContain(await label());
  await page.locator(".react-flow__node-terminal .xterm").first().click();
  await page.keyboard.type("echo hello; ls\n");
  await page.waitForTimeout(150);
  expect(await label()).toBe("working");
  await page.waitForTimeout(1800);
  expect(await label()).toBe("idle");
});

test("MiniMap is opt-in and toggles", async () => {
  expect(await page.evaluate(() => document.querySelectorAll(".react-flow__minimap").length)).toBe(0); // off by default
  await page.click('button[title$="minimap"]');
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => document.querySelectorAll(".react-flow__minimap").length)).toBe(1);
  await page.click('button[title$="minimap"]');
  await page.waitForTimeout(200);
});

test("motion-aware class toggles during canvas pan", async () => {
  // Pan via right-button drag (panOnDrag=[1,2]) over an empty canvas region —
  // wheeling over a tile is swallowed by `nowheel`, so target bare pane.
  const pane = await page.locator(".react-flow__pane").boundingBox();
  const ex = pane ? pane.x + pane.width - 60 : 1200;
  const ey = pane ? pane.y + pane.height - 60 : 700;
  await page.mouse.move(ex, ey);
  await page.mouse.down({ button: "right" });
  let during = false;
  for (let i = 0; i < 8; i++) {
    await page.mouse.move(ex - i * 20, ey - i * 15, { steps: 1 });
    if (await page.evaluate(() => !!document.querySelector(".canvas-moving"))) during = true;
  }
  await page.mouse.up({ button: "right" });
  await page.waitForTimeout(400); // > 120ms debounce
  const after = await page.evaluate(() => !!document.querySelector(".canvas-moving"));
  expect(during).toBe(true);
  expect(after).toBe(false);
});

test("Issues tile opens on the canvas", async () => {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "issues" })));
  await page.waitForSelector(".react-flow__node-issues", { timeout: 6_000 });
  const txt = await page.evaluate(() => document.querySelector(".react-flow__node-issues")?.textContent || "");
  expect(txt).toContain("Issues"); // header renders (fixture has no .hivemind → shows empty/no-workspace body)
});

test("no console errors across the session (incl. CommandDialog a11y)", async () => {
  await page.keyboard.press("Control+k");
  await page.waitForTimeout(300);
  await page.keyboard.press("Escape");
  expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
});
