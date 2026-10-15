// How fast the app feels: startup, each screen opening, content loading and scrolling, on a board as a
// person leaves it (shell terminals holding long output, kept by the terminal daemon between launches).
// Each measure is taken RUNS times on a fresh launch; the report gives the median and the spread.
//
//   node scripts/perf-app.mjs [out.json]      (after `pnpm build`; under xvfb-run on a headless box)
//
// Times are main-thread times: what the person waits for while the app's code runs. Under xvfb the
// GPU is software, so frame rates are not reported here; perf-canvas-effects.mjs owns those.
// PERF_RUNS (5), PERF_TERMINALS (6), PERF_LINES (20000) size it; PERF_FRAMES and PERF_WIDGETS (0) add
// frames holding tool tiles and the Add menu's widgets, for a bigger board. PERF_APP_OUT (out) picks the build.
import { _electron as electron } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const out = process.argv[2] ?? "/tmp/perf-app.json";
const RUNS = Number(process.env.PERF_RUNS) || 5;
const TERMINALS = Number(process.env.PERF_TERMINALS) || 6;
const LINES = Number(process.env.PERF_LINES) || 20000;
const FRAMES = Number(process.env.PERF_FRAMES) || 0;
const WIDGETS = Number(process.env.PERF_WIDGETS) || 0;
const MAIN = path.resolve(process.env.PERF_APP_OUT ?? path.resolve(import.meta.dirname, "../out"), "main/index.js");

const root = await fs.mkdtemp(path.join(os.tmpdir(), "hm-perf-app-"));
const repo = path.join(root, "repo");
await fs.mkdir(repo);
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
// What each shell runs: its output, then a line saying it ended. Short to type, so no shell mangles it.
await fs.writeFile(path.join(repo, "print.sh"), 'for i in $(seq 1 "$2"); do echo "term $1 line $i of the output, padded to look like a build log ........"; done; echo "DONE-$1"\n');
const env = { ...process.env, XDG_CONFIG_HOME: path.join(root, "config"), HIVEMIND_SHELL_ENV: "0" };
delete env.ELECTRON_RUN_AS_NODE;
delete env.HIVE_SETTINGS;

const launch = async () => {
  const app = await electron.launch({ args: [MAIN, "--no-sandbox"], cwd: repo, env });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1600, 1000));
  return { app, page };
};

/** Epoch ms in the page, at the first animation frame where `test` (a page function, given `arg`)
 *  returns the time; each test returns `stamp()`'s time when it holds, else false. */
const whenTrue = (page, test, arg) =>
  page.waitForFunction(test, arg ?? null, { polling: "raf", timeout: 60_000 }).then((h) => h.jsonValue());

/** On a wait that timed out: where each terminal is and the end of its screen, then the error. */
const showTerminals = (page) => async (e) => {
  console.error(JSON.stringify(await page.evaluate(() => [...document.querySelectorAll(".react-flow__node-terminal")].map((n) => {
    const r = n.getBoundingClientRect();
    return { at: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], tail: (n.querySelector(".xterm")?.parentElement?.__hmScreen?.() ?? "<none>").trim().slice(-400) };
  })), null, 1));
  throw e;
};

/** Main-thread time spent in tasks over 50 ms and the longest, from now until `stop()`. */
const longTasks = (page) => page.evaluate(() => {
  const w = window;
  w.__perfLong = [];
  w.__perfObs?.disconnect();
  w.__perfObs = new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__perfLong.push(e.duration); });
  w.__perfObs.observe({ type: "longtask" });
});
const longTasksDone = (page) => page.evaluate(() => {
  const l = window.__perfLong ?? [];
  window.__perfObs?.disconnect();
  return { count: l.length, total: Math.round(l.reduce((a, b) => a + b, 0)), longest: Math.round(Math.max(0, ...l)) };
});


/** In the page: when every terminal shown in the canvas shows that its output ended. Terminals off
 *  screen, or with only a sliver in view (one under the Layers panel), are sent nothing until shown,
 *  so they are not waited on. */
const visibleDone = () => {
  const pane = document.querySelector(".react-flow")?.getBoundingClientRect();
  if (!pane) return false;
  const xs = [...document.querySelectorAll(".react-flow__node-terminal")].filter((n) => {
    const r = n.getBoundingClientRect();
    const w = Math.min(r.right, pane.right) - Math.max(r.left, pane.left);
    const h = Math.min(r.bottom, pane.bottom) - Math.max(r.top, pane.top);
    return w > 0 && h > 0 && w * h >= 0.05 * r.width * r.height;
  });
  const done = xs.length > 0 && xs.every((n) => /DONE-\d/.test(n.querySelector(".xterm")?.parentElement?.__hmScreen?.() ?? ""));
  return done && performance.timeOrigin + performance.now();
};

/** The renderer main thread's CPU time while `act` runs, from a trace: thread time, so a loaded machine
 *  inflates it less than the clock. With the frames that took over 16 ms of it and the tiles rastered. */
const mainThreadCpu = async (app, page, act) => {
  const cdp = await app.context().newCDPSession(page);
  const events = [];
  cdp.on("Tracing.dataCollected", (d) => events.push(...d.value));
  const done = new Promise((r) => cdp.once("Tracing.tracingComplete", r));
  await cdp.send("Tracing.start", { traceConfig: { includedCategories: ["toplevel", "cc", "devtools.timeline", "disabled-by-default-devtools.timeline", "__metadata"] }, transferMode: "ReportEvents" });
  await act();
  await cdp.send("Tracing.end");
  await done;
  await cdp.detach();
  const mains = new Set(events.filter((e) => e.name === "thread_name" && e.args?.name === "CrRendererMain").map((e) => `${e.pid}:${e.tid}`));
  const work = {};
  for (const e of events) if (e.ph === "X" && e.name === "ThreadControllerImpl::RunTask" && mains.has(`${e.pid}:${e.tid}`)) work[`${e.pid}:${e.tid}`] = (work[`${e.pid}:${e.tid}`] ?? 0) + (e.tdur ?? 0);
  // The page's renderer is the main thread that did the most.
  const renderer = Object.entries(work).sort((a, b) => b[1] - a[1])[0]?.[0];
  const mine = events.filter((e) => e.ph === "X" && `${e.pid}:${e.tid}` === renderer);
  return {
    cpu: Math.round((work[renderer] ?? 0) / 1000),
    framesOver16: mine.filter((e) => e.name === "ProxyMain::BeginMainFrame" && (e.tdur ?? 0) > 16_000).length,
    rasterTasks: events.filter((e) => e.ph === "X" && e.name === "RasterTask").length,
  };
};

const screenText = (page) => page.evaluate(() => [...document.querySelectorAll(".xterm")]
  .map((x) => x.parentElement?.__hmScreen?.() ?? "").join("\n"));

let terminalsOnBoard = TERMINALS;
// The board: TERMINALS shells, each having printed LINES lines, and a note.
{
  const { app, page } = await launch();
  await page.waitForSelector(".react-flow", { timeout: 60_000 });
  for (let i = 0; i < TERMINALS; i++) {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  }
  await page.waitForFunction((n) => document.querySelectorAll(".react-flow__node-terminal").length === n, TERMINALS, { timeout: 60_000 });
  const ids = await page.locator(".react-flow__node-terminal").evaluateAll((ns) => ns.map((n) => n.getAttribute("data-id")));
  // Each shell at its prompt before it is typed into.
  await page.waitForFunction((n) => [...document.querySelectorAll(".xterm")].filter((x) => (x.parentElement?.__hmScreen?.() ?? "").trim()).length === n, TERMINALS, { timeout: 60_000, polling: 250 });
  for (const [i, id] of ids.entries()) {
    await page.evaluate(([t, n, k]) => window.hive.ptyWrite(`hm:${t}`, `bash print.sh ${k} ${n}\r`), [id, LINES, i]);
  }
  await page.waitForFunction(visibleDone, null, { timeout: 180_000, polling: 500 }).catch(showTerminals(page));
  // The shells off screen print as fast; give them the time the shown ones took.
  await page.waitForTimeout(5000);
  // A bigger board: frames each holding tool tiles, and widgets from the Add menu.
  for (let f = 0; f < FRAMES; f++) {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:add-frame")));
    await page.waitForTimeout(200);
  }
  const frameIds = await page.locator(".react-flow__node-frame").evaluateAll((ns) => ns.map((n) => n.getAttribute("data-id")));
  for (const [i, frameId] of (FRAMES ? frameIds.slice(-FRAMES) : []).entries()) for (const kind of ["editor", "issues", "diff"].slice(0, 1 + (i % 3))) {
    await page.evaluate(([f, k]) => window.dispatchEvent(new CustomEvent("hivemind:frame-open", { detail: { frameId: f, kind: k } })), [frameId, kind]);
    await page.waitForTimeout(150);
  }
  for (let w = 0; w < WIDGETS; w++) {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-add")));
    const choices = page.locator('[data-board-choice^="widget:"]');
    await choices.first().waitFor();
    await choices.nth(w % await choices.count()).click();
    await page.waitForTimeout(150);
    await page.keyboard.press("Escape");
  }
  if (FRAMES || WIDGETS) await page.waitForTimeout(3000);
  // The camera back on the shells, where the standard board leaves it.
  if (FRAMES || WIDGETS) {
    await page.evaluate((id) => window.dispatchEvent(new CustomEvent("hivemind:focus-tile", { detail: id })), ids.at(-1));
    await page.waitForTimeout(2000);
  }
  // A frame's tools can bring a terminal of their own.
  terminalsOnBoard = await page.locator(".react-flow__node-terminal").count();
  await app.close();
}

const result = {
  at: new Date().toISOString(),
  board: { terminals: terminalsOnBoard, lines: LINES, frames: FRAMES, widgets: WIDGETS },
  os: { cpu: os.cpus()[0]?.model, cpus: os.cpus().length, load: os.loadavg(), display: process.env.DISPLAY ?? null },
  runs: [],
};

for (let run = 0; run < RUNS; run++) {
  const r = {};
  const { app, page } = await launch();
  const created = await app.evaluate(() => process.getCreationTime());
  // Startup: the process, the page, the board drawn, every terminal's restored output on screen.
  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType("navigation")[0];
    return { origin: performance.timeOrigin, dcl: n?.domContentLoadedEventEnd ?? 0 };
  });
  const board = await whenTrue(page, (n) => document.querySelectorAll(".react-flow__node-terminal").length === n && performance.timeOrigin + performance.now(), terminalsOnBoard);
  const shown = await whenTrue(page, visibleDone).catch(showTerminals(page));
  const fcp = await page.evaluate(() => performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null);
  r.startup = {
    toPage: Math.round(nav.origin - created),
    toDomReady: Math.round(nav.origin + nav.dcl - created),
    toFirstPaint: fcp === null ? null : Math.round(nav.origin + fcp - created),
    toBoard: Math.round(board - created),
    toTerminalsShown: Math.round(shown - created),
  };
  // Let startup's own work settle before timing screens.
  await page.waitForTimeout(1500);

  // Screens: asked for → drawn, the first time this launch and once more.
  const open = async (name, ask, ready, close) => {
    for (const time of ["first", "again"]) {
      await longTasks(page);
      const t0 = await page.evaluate(() => performance.timeOrigin + performance.now());
      await ask();
      const t1 = await whenTrue(page, ready);
      const lt = await longTasksDone(page);
      (r.screens ??= {})[`${name} ${time}`] = { ms: Math.round(t1 - t0), longTasks: lt.total };
      await close();
      await page.waitForTimeout(300);
    }
  };
  await open("settings",
    () => page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: "general" } }))),
    () => (document.querySelector("[data-settings-body]")?.textContent.length ?? 0) > 20 && performance.timeOrigin + performance.now(),
    () => page.keyboard.press("Escape"));
  await open("plugins",
    () => page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: "plugins" } }))),
    () => document.querySelectorAll(".plugin-rows > *").length > 3 && performance.timeOrigin + performance.now(),
    () => page.keyboard.press("Escape"));

  // Content: a terminal's older output, scrolled back to its start.
  {
    // The terminal fully inside the window, selected with a click as a person selects it.
    const index = await page.evaluate(() => [...document.querySelectorAll(".react-flow__node-terminal")].findIndex((n) => {
      const r = n.getBoundingClientRect();
      return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
    }));
    const term = page.locator(".react-flow__node-terminal .xterm").nth(Math.max(0, index));
    const tb = await term.boundingBox();
    await page.mouse.click(tb.x + tb.width / 2, tb.y + tb.height / 2);
    await page.mouse.click(tb.x + tb.width / 2, tb.y + tb.height / 2);
    await longTasks(page);
    // Wheel up through the output: 60 notches, as a person flicks back through it.
    const box = await term.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const w0 = await page.evaluate(() => performance.timeOrigin + performance.now());
    for (let i = 0; i < 60; i++) await page.mouse.wheel(0, -400);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const w1 = await page.evaluate(() => performance.timeOrigin + performance.now());
    const lt = await longTasksDone(page);
    r.terminalScroll = { wheel60ms: Math.round(w1 - w0), longTasks: lt.total, longest: lt.longest };
  }

  // Canvas: wheel-pan across the board.
  {
    const pane = page.locator(".react-flow__pane");
    const box = await pane.boundingBox();
    await page.mouse.move(box.x + 20, box.y + box.height - 20);
    await longTasks(page);
    const w0 = await page.evaluate(() => performance.timeOrigin + performance.now());
    for (let i = 0; i < 60; i++) await page.mouse.wheel(i % 2 ? 300 : -300, 120);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const w1 = await page.evaluate(() => performance.timeOrigin + performance.now());
    const lt = await longTasksDone(page);
    r.canvasPan = { wheel60ms: Math.round(w1 - w0), longTasks: lt.total, longest: lt.longest };
  }

  // Canvas, at a person's pace: one wheel notch, then a rest, so each notch is a whole pan that starts and ends.
  {
    // Over bare canvas: a wheel over a tile or the chrome does not pan.
    const at = await page.evaluate(() => {
      for (const y of [0.8, 0.65, 0.4, 0.2]) for (const x of [0.9, 0.75, 0.5, 0.35]) {
        const p = { x: Math.round(innerWidth * x), y: Math.round(innerHeight * y) };
        if (document.elementFromPoint(p.x, p.y)?.classList.contains("react-flow__pane")) return p;
      }
      return null;
    });
    if (!at) throw new Error("no bare canvas to wheel over");
    await page.mouse.move(at.x, at.y);
    await page.waitForTimeout(500);
    const NOTCHES = 10;
    const t = await mainThreadCpu(app, page, async () => {
      for (let i = 0; i < NOTCHES; i++) {
        await page.mouse.wheel(i % 2 ? 120 : -120, 60);
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        await page.waitForTimeout(700);
      }
    });
    r.canvasNotch = { cpuPerNotch: Math.round(t.cpu / NOTCHES), framesOver16: t.framesOver16, rasterTasks: t.rasterTasks };
  }

  r.heapMB = await page.evaluate(() => Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1e6));
  result.runs.push(r);
  console.log(JSON.stringify(r));
  await app.close();
}

// Median and spread of every number, by its path.
const paths = new Map();
const walk = (o, at) => {
  for (const [k, v] of Object.entries(o)) {
    const p = at ? `${at}.${k}` : k;
    if (typeof v === "number") (paths.get(p) ?? paths.set(p, []).get(p)).push(v);
    else if (v && typeof v === "object") walk(v, p);
  }
};
for (const r of result.runs) walk(r, "");
result.summary = Object.fromEntries([...paths].map(([p, vs]) => {
  const s = [...vs].sort((a, b) => a - b);
  return [p, { median: s[Math.floor(s.length / 2)], min: s[0], max: s[s.length - 1] }];
}));
await fs.writeFile(out, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result.summary, null, 1));
// The terminal daemons this run's profile started (each serves a socket under `root`), stopped.
for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
  let argv = [];
  try { argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0"); } catch { continue; }
  if (argv.some((a) => /pty-daemon\.(js|ts)$/.test(a)) && argv.some((a) => a.startsWith(root + path.sep))) {
    try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ }
  }
}
await fs.rm(root, { recursive: true, force: true }).catch(() => {});
