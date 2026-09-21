// New frames on a busy canvas must bring the camera to them at a working zoom. Two faults
// used to ratchet it down to a fraction of 100%: focus took its target zoom from the live
// zoom (mid-flight, a long pan is zoomed out), and a new frame's focus could miss the frame
// entirely because it looked it up before the frame was committed.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let app: ElectronApplication;
let page: Page;
let dir = "";

const zoom = () => page.evaluate(() =>
  Number(/scale\(([\d.]+)\)/.exec((document.querySelector(".react-flow__viewport") as HTMLElement).style.transform)?.[1] ?? NaN));
const lastFrameOnScreen = () => page.evaluate(() => {
  const pane = document.querySelector(".react-flow")!.getBoundingClientRect();
  const all = [...document.querySelectorAll(".react-flow__node-frame")];
  const r = all[all.length - 1]!.getBoundingClientRect();
  return r.left >= pane.left && r.right <= pane.right && r.top >= pane.top && r.bottom <= pane.bottom;
});
const lastFrameId = () => page.evaluate(() => {
  const all = [...document.querySelectorAll(".react-flow__node-frame")];
  return all[all.length - 1]!.getAttribute("data-id");
});

test.beforeAll(async () => {
  dir = fs.mkdtempSync("/tmp/hm-ff-");
  for (const d of ["home", "xdg"]) fs.mkdirSync(path.join(dir, d));
  app = await electron.launch({
    args: [path.join(APP_DIR, "out/main/index.js"), "--no-sandbox", `--user-data-dir=${dir}/ud`],
    cwd: APP_DIR,
    env: { ...process.env, HOME: path.join(dir, "home"), XDG_CONFIG_HOME: path.join(dir, "xdg"), HIVEMIND_PTY_DAEMON: "0" },
  });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 15_000 });
});
test.afterAll(async () => {
  try { await Promise.race([app?.close(), new Promise((r) => setTimeout(r, 8_000))]); } catch { /* gone */ }
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test("frames added one after another, each given a shell, keep the camera near 100%", async () => {
  test.setTimeout(90_000);
  // The timing a person hits: a frame, a shell in it a moment later, the next frame. The
  // old focus read the live zoom while the previous flight was still zoomed out mid-pan
  // and kept it: 1 → 0.81 → 0.53 → 0.38.
  const seen: number[] = [];
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:add-frame")));
    await page.waitForTimeout(1200);
    seen.push(await zoom());
    const id = await lastFrameId();
    await page.evaluate((frameId) => window.dispatchEvent(new CustomEvent("hivemind:frame-open", { detail: { frameId, kind: "shell" } })), id);
    await page.waitForTimeout(1500);
    seen.push(await zoom());
  }
  // A flight may be caught mid-pan (zoomed out) on a slow renderer; what must not happen is
  // the camera STAYING there. At rest it is back near 100%.
  await expect.poll(zoom, { timeout: 15_000, message: `zoom after each step: ${seen.map((z) => z.toFixed(2)).join(" ")}` }).toBeGreaterThan(0.9);
  // A new frame is the camera's target and the next spawn's.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:add-frame")));
  await expect.poll(async () => (await zoom()) > 0.9 && (await lastFrameOnScreen()), { timeout: 15_000 }).toBe(true);
});
