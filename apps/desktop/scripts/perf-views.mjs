// Reproducible renderer perf harness (workspace views). Run from apps/desktop
// AFTER `pnpm run build`, headless so nothing lands on your desktop:
//
//   unset ELECTRON_RUN_AS_NODE
//   xvfb-run -a --server-args="-screen 0 1600x1000x24" node scripts/perf-views.mjs after /tmp/perf-after.json 4
//   node scripts/perf-views-compare.mjs /tmp/perf-base.json /tmp/perf-after.json
//
// Workload: N shell tiles in a throwaway git repo, each running a bash loop that
// prints ~50 lines/s (a stand-in for N streaming agents). Scenes: quiet canvas,
// canvas streaming, typing into the selected terminal while streaming, wheel
// pan, tile drag, 8 canvas<->windows switches, windows view streaming. Per scene:
// rAF frame intervals (fps / p95 / >50ms), `longtask` entries, a 16 ms timer's
// drift (event-loop lag = input-latency proxy); CPU/RSS via app.getAppMetrics().
// The Electron profile is isolated (XDG_CONFIG_HOME) and PTYs run in-process.
// xvfb has no GPU: absolute numbers are pessimistic; compare deltas only.
import { _electron as electron } from "@playwright/test";
import fs from "node:fs/promises"; import os from "node:os"; import path from "node:path"; import { execFileSync } from "node:child_process";

const [label = "run", outFile = "/tmp/perf.json", tilesArg = "6"] = process.argv.slice(2);
const N = Number(tilesArg);
const repo = await fs.mkdtemp(path.join(os.tmpdir(), "hm-perf-"));
await fs.writeFile(path.join(repo, "a.ts"), "export const a = 1;\n");
const git = (...a) => execFileSync("git", a, { cwd: repo });
git("init", "-q"); git("config", "user.email", "e@e"); git("config", "user.name", "e"); git("add", "-A"); git("commit", "-q", "-m", "seed");
process.env.HIVEMIND_PTY_DAEMON = "0";
process.env.XDG_CONFIG_HOME = await fs.mkdtemp(path.join(os.tmpdir(), "hm-xdg-"));
const app = await electron.launch({
  args: [path.resolve(import.meta.dirname, "../out/main/index.js"), "--no-sandbox", `--user-data-dir=/tmp/hm-perf-ud-${Date.now()}`],
  cwd: repo,
});
const page = await app.firstWindow();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.setViewportSize({ width: 1600, height: 1000 });
await page.waitForSelector(".react-flow", { timeout: 30000 });
await page.waitForTimeout(500);

// ── in-page collector ────────────────────────────────────────────────────────
await page.evaluate(() => {
  const w = window;
  w.__perf = {
    start() {
      const s = { frames: [], long: [], lag: [], on: true };
      let last = performance.now();
      const raf = () => { if (!s.on) return; const t = performance.now(); s.frames.push(t - last); last = t; requestAnimationFrame(raf); };
      requestAnimationFrame(raf);
      try {
        s.po = new PerformanceObserver((l) => { for (const e of l.getEntries()) s.long.push(e.duration); });
        s.po.observe({ entryTypes: ["longtask"] });
      } catch {}
      // Event-loop lag: a 16ms timer's drift is a proxy for how long an input
      // event would wait before its handler runs.
      let exp = performance.now() + 16;
      s.iv = setInterval(() => { const now = performance.now(); s.lag.push(Math.max(0, now - exp)); exp = now + 16; }, 16);
      w.__perfS = s;
    },
    stop() {
      const s = w.__perfS; s.on = false; clearInterval(s.iv); s.po?.disconnect();
      const q = (a, p) => { if (!a.length) return 0; const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(p * b.length))]; };
      const f = s.frames.slice(1);
      const total = f.reduce((a, b) => a + b, 0);
      return {
        seconds: +(total / 1000).toFixed(2), frames: f.length, fps: +((f.length / (total / 1000)) || 0).toFixed(1),
        frame_p50_ms: +q(f, 0.5).toFixed(1), frame_p95_ms: +q(f, 0.95).toFixed(1), frame_max_ms: +(Math.max(0, ...f)).toFixed(1),
        frames_over_50ms: f.filter((x) => x > 50).length, frames_over_100ms: f.filter((x) => x > 100).length,
        longtasks: s.long.length, longtask_total_ms: +s.long.reduce((a, b) => a + b, 0).toFixed(0), longtask_max_ms: +(Math.max(0, ...s.long)).toFixed(0),
        lag_p50_ms: +q(s.lag, 0.5).toFixed(1), lag_p95_ms: +q(s.lag, 0.95).toFixed(1), lag_max_ms: +(Math.max(0, ...s.lag)).toFixed(1),
      };
    },
  };
});
const sample = async (ms) => { await page.evaluate(() => window.__perf.start()); await page.waitForTimeout(ms); return page.evaluate(() => window.__perf.stop()); };
const metrics = async () => {
  await app.evaluate(({ app }) => app.getAppMetrics()); // prime the cpu delta
  await page.waitForTimeout(1500);
  const m = await app.evaluate(({ app }) => app.getAppMetrics());
  const r = m.filter((p) => p.type === "Tab" || p.type === "Browser" || p.type === "GPU").map((p) => ({ type: p.type, cpu: +p.cpu.percentCPUUsage.toFixed(1), rssMB: +((p.memory?.workingSetSize ?? 0) / 1024).toFixed(0) }));
  return { total_cpu_pct: +r.reduce((a, b) => a + b.cpu, 0).toFixed(1), renderer_rss_mb: r.find((x) => x.type === "Tab")?.rssMB ?? null, procs: r };
};
const out = { label, tiles: N, at: new Date().toISOString() };
const log = (m) => console.error(`[perf ${label}] ${new Date().toISOString().slice(11,19)} ${m}`);

log("spawning");
// ── spawn N shells, start streaming in each ─────────────────────────────────
for (let i = 0; i < N; i++) {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await page.waitForTimeout(250);
}
await page.waitForFunction((n) => document.querySelectorAll(".xterm").length >= n, N, { timeout: 30000 });
await page.waitForTimeout(1500);
out.idle_after_spawn = await metrics();
// Quiet canvas (no streaming yet) — separates the view's own cost from the workload.
// Settle first: WebGL atlas warm-up + the spawn camera flights landed inside a
// 3 s sample once and read as 20 fps on an idle board.
await page.mouse.click(1500, 950); // pane: deselect
await page.waitForTimeout(5000);
out.canvas_quiet = await sample(3000);
// Start the stream in EVERY tile. Focus each terminal deterministically: select
// via the runtime's focus-tile event (pans + selects), click its screen, and
// only type once xterm's textarea is the active element — never type into
// nothing (the number-row keys are spawn hotkeys when no input is focused).
const CMD = 'i=0; while :; do i=$((i+1)); echo "agent line $i $RANDOM lorem ipsum dolor sit amet consectetur adipiscing elit sed do"; sleep 0.02; done';
const ids = await page.$$eval(".react-flow__node-terminal", (els) => els.map((e) => e.getAttribute("data-id")));
out.typed_into = 0;
for (const id of ids) {
  await page.evaluate((tid) => window.dispatchEvent(new CustomEvent("hivemind:focus-tile", { detail: tid })), id);
  await page.waitForTimeout(600);
  const screen = page.locator(`.react-flow__node-terminal[data-id="${id}"] .xterm-screen`);
  await screen.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(200);
  const focused = await page.evaluate(() => document.activeElement?.classList.contains("xterm-helper-textarea") ?? false);
  if (!focused) { console.log("[perf] could not focus", id); continue; }
  await page.keyboard.type(CMD);
  await page.keyboard.press("Enter");
  out.typed_into++;
  await page.waitForTimeout(150);
}
await page.waitForTimeout(1500);
out.node_count = await page.locator(".react-flow__node").count();
out.xterm_count_streaming = await page.locator(".xterm").count();
// Deselect so no tile is in the "selected" (DOM-renderer boost) state.
await page.mouse.click(1500, 950);
await page.waitForTimeout(300);

log(`streaming: typed_into=${out.typed_into} xterms=${out.xterm_count_streaming}`);
// ── canvas, streaming, no interaction ───────────────────────────────────────
out.canvas_streaming_idle = await sample(5000);
out.streaming_cpu = await metrics();

// ── typing into the selected terminal while everything streams ──────────────
{
  await page.evaluate((tid) => window.dispatchEvent(new CustomEvent("hivemind:focus-tile", { detail: tid })), ids[0]);
  await page.waitForTimeout(600);
  await page.locator(`.react-flow__node-terminal[data-id="${ids[0]}"] .xterm-screen`).click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(200);
  await page.evaluate(() => window.__perf.start());
  for (let k = 0; k < 40; k++) { await page.keyboard.type("x"); await page.waitForTimeout(40); }
  out.canvas_streaming_typing = await page.evaluate(() => window.__perf.stop());
}

log("pan");
// ── wheel pan ───────────────────────────────────────────────────────────────
{
  const box = await page.locator(".react-flow__pane").boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.9);
  await page.evaluate(() => window.__perf.start());
  for (let k = 0; k < 60; k++) { await page.mouse.wheel(k < 30 ? 40 : -40, k < 30 ? 30 : -30); await page.waitForTimeout(16); }
  await page.waitForTimeout(300);
  out.canvas_pan = await page.evaluate(() => window.__perf.stop());
}

log("drag");
// ── drag a tile ─────────────────────────────────────────────────────────────
{
  const handle = page.locator(".react-flow__node-terminal .tile-drag-handle").first();
  const hb = await handle.boundingBox();
  if (hb) {
    await page.mouse.move(hb.x + 40, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.evaluate(() => window.__perf.start());
    for (let k = 1; k <= 40; k++) { await page.mouse.move(hb.x + 40 + k * 6, hb.y + hb.height / 2 + k * 3); await page.waitForTimeout(16); }
    await page.mouse.up();
    await page.waitForTimeout(400);
    out.canvas_drag = await page.evaluate(() => window.__perf.stop());
  }
}

log("switches");
// ── view switches ───────────────────────────────────────────────────────────
const switchTo = (sel) => page.evaluate((s) => new Promise((res) => {
  const t0 = performance.now();
  const long = []; let po;
  try { po = new PerformanceObserver((l) => { for (const e of l.getEntries()) long.push(e.duration); }); po.observe({ entryTypes: ["longtask"] }); } catch {}
  window.dispatchEvent(new CustomEvent("hivemind:toggle-view-mode"));
  const check = () => {
    if (document.querySelector(s)) requestAnimationFrame(() => requestAnimationFrame(() => { po?.disconnect(); res({ ms: +(performance.now() - t0).toFixed(0), longtask_ms: +long.reduce((a, b) => a + b, 0).toFixed(0), xterms: document.querySelectorAll(".xterm").length }); }));
    else requestAnimationFrame(check);
  };
  check();
}), sel);
out.switches = [];
for (let k = 0; k < 4; k++) {
  await page.waitForTimeout(700);
  out.switches.push({ to: "windows", ...(await switchTo('[role="tablist"]')) });
  await page.waitForTimeout(700);
  out.switches.push({ to: "canvas", ...(await switchTo(".react-flow__node-terminal")) });
}
const med = (a) => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)] ?? 0; };
out.switch_to_windows_median_ms = med(out.switches.filter((s) => s.to === "windows").map((s) => s.ms));
out.switch_to_canvas_median_ms = med(out.switches.filter((s) => s.to === "canvas").map((s) => s.ms));
out.xterm_instances_after_switches = await page.locator(".xterm").count();

log("windows");
// ── windows view, streaming ─────────────────────────────────────────────────
await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:toggle-view-mode")));
await page.waitForSelector('[role="tablist"]');
await page.waitForTimeout(700);
out.windows_streaming_idle = await sample(4000);
out.windows_cpu = await metrics();

await fs.writeFile(outFile, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
await app.close();
