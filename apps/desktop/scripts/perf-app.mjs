// How fast the app feels: startup, each screen opening, content loading and scrolling, on a board as a
// person leaves it (shell terminals holding long output, kept by the terminal daemon between launches).
// Each measure is taken RUNS times on a fresh launch; the report gives the median and the spread.
//
//   node scripts/perf-app.mjs [out.json]      (after `pnpm build`; under xvfb-run on a headless box)
//
// Times are main-thread times: what the person waits for while the app's code runs. Under xvfb the
// GPU is software, so frame rates are not reported here; perf-canvas-effects.mjs owns those.
// PERF_RUNS (5), PERF_TERMINALS (6), PERF_LINES (20000), PERF_SESSIONS (600) size it.
import { _electron as electron } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const out = process.argv[2] ?? "/tmp/perf-app.json";
const RUNS = Number(process.env.PERF_RUNS) || 5;
const TERMINALS = Number(process.env.PERF_TERMINALS) || 6;
const LINES = Number(process.env.PERF_LINES) || 20000;
// PERF_ONLY=screens: startup and screens, no scrolling.
const ONLY_SCREENS = process.env.PERF_ONLY === "screens";
const MAIN = path.resolve(process.env.PERF_MAIN ?? path.join(import.meta.dirname, "../out/main/index.js"));

const root = await fs.mkdtemp(path.join(os.tmpdir(), "hm-perf-app-"));
const repo = path.join(root, "repo");
await fs.mkdir(repo);
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
// What each shell runs: its output, then a line saying it ended. Short to type, so no shell mangles it.
await fs.writeFile(path.join(repo, "print.sh"), 'for i in $(seq 1 "$2"); do echo "term $1 line $i of the output, padded to look like a build log ........"; done; echo "DONE-$1"\n');
// A home of its own holding a long agent history: SESSIONS Claude Code sessions over 20 folders
// across two months, every 20th in this repo, each as long at its start as a real one (~200 KB).
const SESSIONS = Number(process.env.PERF_SESSIONS ?? 600);
const home = path.join(root, "home");
{
  const filler = "x".repeat(6000);
  for (let i = 0; i < SESSIONS; i++) {
    const cwd = i % 20 === 0 ? repo : path.join(root, `elsewhere-${i % 19}`);
    const dir = path.join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    await fs.mkdir(dir, { recursive: true });
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    const lines = [
      { type: "permission-mode", permissionMode: "default", sessionId: id },
      { type: "user", cwd, sessionId: id, message: { role: "user", content: `session ${i}: make the build faster` } },
      ...Array.from({ length: 34 }, (_, k) => ({ type: "attachment", cwd, sessionId: id, attachment: { n: k, text: filler } })),
    ];
    const file = path.join(dir, `${id}.jsonl`);
    await fs.writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const at = new Date(Date.now() - (i + 1) * 2.5 * 3600_000);
    await fs.utimes(file, at, at);
  }
}
// The Claude Code agent, as HiveHub lists it, saying where it keeps those sessions.
await fs.mkdir(path.join(root, "config", "hivemind", "agents", "claude"), { recursive: true });
await fs.writeFile(path.join(root, "config", "hivemind", "agents", "claude", "agent.yaml"), `manifestVersion: 2
id: claude
label: Claude
bin: claude
enabled: true
caps: { promptDelivery: argv, turnSignal: false, resume: tile, supervise: human, blockedDetection: false }
session:
  list: { lines: 30, cwdPath: cwd, titlePath: [aiTitle, message.content], promptPath: message.content }
  resume: { args: ["--resume", "{id}"], position: before, exists: "{home}/.claude/projects/*/{id}.jsonl" }
`);
process.on("exit", cleanUp);
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(root, "config"), HIVEMIND_SHELL_ENV: "0" };
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

/** Main-process time its event loop was held past 50 ms (IPC, terminal output and every window
 *  wait on it), since the last `mainStalls`; the first call starts counting. */
const mainStalls = (app) => app.evaluate(() => {
  const g = globalThis;
  if (!g.__perfStall) {
    g.__perfStall = { total: 0, longest: 0 };
    let last = performance.now();
    setInterval(() => {
      const now = performance.now();
      const late = now - last - 20;
      if (late > 50) { g.__perfStall.total += late; g.__perfStall.longest = Math.max(g.__perfStall.longest, late); }
      last = now;
    }, 20).unref();
  }
  const s = g.__perfStall;
  g.__perfStall = { total: 0, longest: 0 };
  return { total: Math.round(s.total), longest: Math.round(s.longest) };
});


/** In the page: when every terminal inside the window shows that its output ended. Terminals off
 *  screen are sent nothing until shown, so they are not waited on. */
const visibleDone = () => {
  const xs = [...document.querySelectorAll(".react-flow__node-terminal")].filter((n) => {
    const r = n.getBoundingClientRect();
    return r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
  });
  const done = xs.length > 0 && xs.every((n) => /DONE-\d/.test(n.querySelector(".xterm")?.parentElement?.__hmScreen?.() ?? ""));
  return done && performance.timeOrigin + performance.now();
};

const screenText = (page) => page.evaluate(() => [...document.querySelectorAll(".xterm")]
  .map((x) => x.parentElement?.__hmScreen?.() ?? "").join("\n"));

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
  await page.waitForFunction(visibleDone, null, { timeout: 180_000, polling: 500 }).catch(async (e) => {
    console.error(JSON.stringify(await page.evaluate(() => [...document.querySelectorAll(".react-flow__node-terminal")].map((n) => {
      const r = n.getBoundingClientRect();
      return { at: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], tail: (n.querySelector(".xterm")?.parentElement?.__hmScreen?.() ?? "<none>").trim().slice(-400) };
    })), null, 1));
    throw e;
  });
  // The shells off screen print as fast; give them the time the shown ones took.
  await page.waitForTimeout(5000);
  await app.close();
}

const result = {
  at: new Date().toISOString(),
  board: { terminals: TERMINALS, lines: LINES },
  os: { cpu: os.cpus()[0]?.model, cpus: os.cpus().length, load: os.loadavg(), display: process.env.DISPLAY ?? null },
  runs: [],
};

for (let run = 0; run < RUNS; run++) {
  const r = {};
  const { app, page } = await launch();
  const created = await app.evaluate(() => process.getCreationTime());
  await mainStalls(app);
  // Startup: the process, the page, the board drawn, every terminal's restored output on screen.
  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType("navigation")[0];
    return { origin: performance.timeOrigin, dcl: n?.domContentLoadedEventEnd ?? 0 };
  });
  const board = await whenTrue(page, (n) => document.querySelectorAll(".react-flow__node-terminal").length === n && performance.timeOrigin + performance.now(), TERMINALS);
  const shown = await whenTrue(page, visibleDone);
  const fcp = await page.evaluate(() => performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null);
  r.startup = {
    toPage: Math.round(nav.origin - created),
    toDomReady: Math.round(nav.origin + nav.dcl - created),
    toFirstPaint: fcp === null ? null : Math.round(nav.origin + fcp - created),
    toBoard: Math.round(board - created),
    toTerminalsShown: Math.round(shown - created),
  };
  // Let startup's own work settle before timing screens; what held main meanwhile counts as startup's.
  await page.waitForTimeout(1500);
  r.startup.mainStalls = (await mainStalls(app)).total;

  // Screens: asked for → drawn, the first time this launch and once more.
  const open = async (name, ask, ready, close) => {
    for (const time of ["first", "again"]) {
      await longTasks(page);
      await mainStalls(app);
      const t0 = await page.evaluate(() => performance.timeOrigin + performance.now());
      await ask();
      const t1 = await whenTrue(page, ready);
      const lt = await longTasksDone(page);
      (r.screens ??= {})[`${name} ${time}`] = { ms: Math.round(t1 - t0), longTasks: lt.total, mainStalls: (await mainStalls(app)).total };
      await close();
      await page.waitForTimeout(300);
    }
  };
  const now = () => performance.timeOrigin + performance.now();
  const settings = (pageId) => () => page.evaluate((p) => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: p } })), pageId);
  /** In the page: the Settings page drawn, with nothing in it still loading. */
  const settingsDrawn = () => {
    const body = document.querySelector("[data-settings-body]");
    return !!body && body.textContent.length > 20 && !body.querySelector("[role=status][aria-live]") && performance.timeOrigin + performance.now();
  };
  const escape = () => page.keyboard.press("Escape");
  /** A click on what `selector` finds, once it is there: no waiting for it to hold still, so the
   *  time is the app's. */
  const press = (selector) => page.waitForSelector(selector).then((el) => el.evaluate((e) => e.click()));
  await open("settings", settings("general"), settingsDrawn, escape);
  for (const p of ["profile", "appearance", "shortcuts", "connect", "api", "browser", "servers", "about"]) await open(`settings ${p}`, settings(p), settingsDrawn, escape);
  await open("plugins", settings("plugins"),
    () => document.querySelectorAll(".plugin-rows > *").length > 3 && performance.timeOrigin + performance.now(),
    escape);
  // HiveHub's catalog, from the Plugins page.
  await open("hivehub",
    async () => { await settings("plugins")(); await press("[data-plugins-scope=hub]"); },
    () => document.querySelectorAll("[data-catalog-plugin]").length > 0 && performance.timeOrigin + performance.now(),
    async () => { await page.locator("[data-plugins-scope=installed]").click(); await escape(); });
  await open("plugin page", settings("plugin:agent:claude"),
    () => !!document.querySelector("[data-plugin-page] [role=tabpanel]") && performance.timeOrigin + performance.now(), escape);
  // A plugin HiveHub lists and this app has not installed: its page and its README.
  await open("hivehub plugin page", settings("plugin:view:@dip497/queue"),
    () => {
      const panel = document.querySelector("[data-plugin-page] [role=tabpanel]");
      return !!panel && panel.textContent.length > 10 && !panel.querySelector("[role=status][aria-live]") && performance.timeOrigin + performance.now();
    }, escape);
  await open("add menu", () => page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-add"))),
    () => document.querySelectorAll("[data-add-menu] [data-board-choice]").length > 0 && performance.timeOrigin + performance.now(), escape);
  await open("machines", () => page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:machines", { detail: { kind: "manage" } }))),
    () => (document.querySelector("[role=dialog]")?.textContent.length ?? 0) > 40 && performance.timeOrigin + performance.now(), escape);
  // The Layers panel, hidden then shown again, and each of its panes.
  const toggleLayers = (shown) => page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:toggle-layers")))
    .then(() => whenTrue(page, (want) => !!document.querySelector("aside[aria-label=Layers] [data-layers-pane]") === want && performance.timeOrigin + performance.now(), shown));
  if (await page.evaluate(() => !!document.querySelector("aside[aria-label=Layers]"))) await toggleLayers(false);
  await open("layers", () => page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:toggle-layers"))),
    () => !!document.querySelector("aside[aria-label=Layers] [data-layers-pane]") && performance.timeOrigin + performance.now(),
    () => toggleLayers(false));
  await toggleLayers(true);
  const pane = (p, ready) => open(`layers ${p}`, () => press(`[data-layers-rail=${p}]`), ready, () => press("[data-layers-rail=tiles]"));
  await pane("recents", () => document.querySelectorAll("[data-layers-recent]").length > 0 && performance.timeOrigin + performance.now());
  await pane("machines", () => !!document.querySelector("[data-layers-pane=machines] [data-machine-group]") && performance.timeOrigin + performance.now());
  // What Recents reads: this repo's past sessions, asked of main as the panel asks.
  for (const time of ["first", "again"]) {
    await mainStalls(app);
    const ms = await page.evaluate(async (dir) => { const t = performance.now(); await window.hive.viewSessions("claude", dir); return Math.round(performance.now() - t); }, repo);
    const shown = await page.evaluate((dir) => window.hive.viewSessions("claude", dir).then((l) => l.length), repo);
    (r.screens ??= {})[`recents read ${time}`] = { ms, sessions: shown, mainStalls: (await mainStalls(app)).total };
  }
  // The Windows view, and the canvas again.
  await open("windows view", () => page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: "windows" } }))),
    () => !!document.querySelector("[data-community-view][data-community-ready='1'] [data-community-slot] .xterm") && performance.timeOrigin + performance.now(),
    async () => {
      await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: "canvas" } })));
      await whenTrue(page, (n) => document.querySelectorAll(".react-flow__node-terminal").length === n && performance.timeOrigin + performance.now(), TERMINALS);
    });
  // A new terminal: asked for → its shell's prompt on screen; then closed from Layers, so the board stays as it was.
  for (const time of ["first", "again"]) {
    await longTasks(page);
    await mainStalls(app);
    const before = await page.evaluate(() => [...document.querySelectorAll(".react-flow__node-terminal")].map((n) => n.getAttribute("data-id")));
    const t0 = await page.evaluate(now);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
    const t1 = await whenTrue(page, (had) => {
      const n = [...document.querySelectorAll(".react-flow__node-terminal")].find((x) => !had.includes(x.getAttribute("data-id")));
      return !!n && !!(n.querySelector(".xterm")?.parentElement?.__hmScreen?.() ?? "").trim() && performance.timeOrigin + performance.now();
    }, before);
    const lt = await longTasksDone(page);
    r.screens[`new terminal ${time}`] = { ms: Math.round(t1 - t0), longTasks: lt.total, mainStalls: (await mainStalls(app)).total };
    const added = await page.evaluate((had) => [...document.querySelectorAll(".react-flow__node-terminal")].map((n) => n.getAttribute("data-id")).find((id) => !had.includes(id)), before);
    await page.locator(`[data-layer-tile="${added}"] [data-layer-tile-menu]`).click({ force: true });
    await page.getByRole("menuitem", { name: /^Close tile/ }).click();
    await whenTrue(page, (n) => document.querySelectorAll(".react-flow__node-terminal").length === n && performance.timeOrigin + performance.now(), TERMINALS);
  }

  // Content: a terminal's older output, scrolled back to its start.
  if (!ONLY_SCREENS) {
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
  if (!ONLY_SCREENS) {
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
// The terminal daemons this run's profile started (each serves a socket under `root`), stopped,
// and its files removed: at the end, or when a step fails.
function cleanUp() {
  for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
    let argv = [];
    try { argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0"); } catch { continue; }
    if (argv.some((a) => /pty-daemon\.(js|ts)$/.test(a)) && argv.some((a) => a.startsWith(root + path.sep))) {
      try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ }
    }
  }
  try { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); } catch { /* a shell still writing there */ }
}
