// How long the phone page takes to apply what the computer says to its screens (Needs you, Agents,
// one agent), on a CPU 4x slower than this one, as a mid phone's: the first list, then each next
// one with one wait answered. Its built modules (build.sh), served from www by route, no server;
// prints, in ms, as JSON: `apply`, the update and its layout, on the wall clock; `frame`, all the
// main thread did for it, styles, layout, paint and commit too, from a trace in the thread's own
// time; and the elements it styled and the objects it laid out, the median of each. A frame is
// 16.7 ms.
//   node measure-screens.mjs [agents] [rounds] [needs|agents|all: the screen shown, as the app shows one]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const [agents = '40', rounds = '200', shown = 'agents'] = process.argv.slice(2);
const www = new URL('www/', import.meta.url).pathname;
const require = createRequire(
  process.env.PLAYWRIGHT_FROM ?? new URL('../../apps/desktop/package.json', import.meta.url),
);
const { chromium } = require('@playwright/test');

const page = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="app.css"><main id="app"></main>
<script type="module">
import { Needs } from "./js/needs.js";
import { Agents } from "./js/agents.js";
import { AgentScreen } from "./js/agent.js";
const app = { open() {}, back() {}, answer: async () => true, send: async () => true, stop: async () => true, conversation: () => () => {} };
const screens = [new Needs(app), new Agents(app), new AgentScreen(app)];
document.getElementById("app").append(...screens.map((s) => s.el));
screens[2].open("t0", null);
for (const s of screens) s.el.hidden = ${JSON.stringify(shown)} !== "all" && s.el.dataset.screen !== ${JSON.stringify(shown)};
const n = ${Number(agents)};
const overview = (answered) => {
  const all = Array.from({ length: n }, (_, i) => {
    const waits = i % 4 === 0 && i >= answered * 4;
    return { workspace: "w" + (i % 3), name: "api" + (i % 3), tile: "t" + i, agent: "agent " + i, state: waits ? "waiting" : "working",
      since: 1790000000000 + i, machine: "m" + (i % 2), device: "d", interrupt: true, conversation: false,
      ...(waits ? { waiting: { kind: ["permission", "plan", "question"][i % 3], since: 1790000000000 + i, decide: true, plan: "# Plan\\n- one\\n- two" } } : {}) };
  });
  return { agents: all, needs: all.filter((a) => a.waiting), working: all.filter((a) => a.state === "working").length };
};
// Each round one wait answered, as the computer tells it; when none is left, all wait again
// (not counted: many new cards at once is not one update).
const show = (o) => {
  const t = performance.now();
  for (const s of screens) s.show(o);
  document.body.offsetHeight; // layout too, as the frame that shows it pays it
  return performance.now() - t;
};
const first = show(overview(0));
const took = [];
await new Promise((f) => (window.go = f));
for (let r = 1, answered = 1; r <= ${Number(rounds)}; r++, answered++) {
  if (answered > n / 4) { console.timeStamp("reset"); show(overview(0)); answered = 1; await new Promise((f) => requestAnimationFrame(() => setTimeout(f))); }
  console.timeStamp("round");
  took.push(show(overview(answered)));
  await new Promise((f) => requestAnimationFrame(() => setTimeout(f)));
}
took.sort((a, b) => a - b);
const at = (q) => +took[Math.min(took.length - 1, Math.floor(q * took.length))].toFixed(2);
console.timeStamp("end");
window.result = { agents: n, shown: ${JSON.stringify(shown)}, first: +first.toFixed(2), apply: { median: at(0.5), p95: at(0.95), worst: +took.at(-1).toFixed(2) } };
</script>`;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM });
try {
  const tab = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  tab.on('pageerror', (e) => console.error(e.message));
  await tab.route('http://screens.test/**', (route) => {
    const name = new URL(route.request().url()).pathname.slice(1);
    if (name === 'index.html') return route.fulfill({ contentType: 'text/html', body: page });
    const file = path.join(www, name);
    const type = name.endsWith('.css') ? 'text/css' : 'text/javascript';
    return fs.existsSync(file) ? route.fulfill({ contentType: type, body: fs.readFileSync(file) }) : route.fulfill({ status: 404 });
  });
  const cdp = await tab.context().newCDPSession(tab);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await tab.goto('http://screens.test/index.html');
  await tab.waitForFunction(() => window.go);
  await browser.startTracing(tab, { categories: ['devtools.timeline', 'toplevel'] });
  await tab.evaluate(() => window.go());
  await tab.waitForFunction(() => window.result, null, { timeout: 120_000 });
  const events = JSON.parse((await browser.stopTracing()).toString()).traceEvents;
  // The page's main thread: its tasks between one round's mark and the next mark.
  const thread = events.find((e) => e.name === 'thread_name' && e.args?.name === 'CrRendererMain');
  const on = events.filter((e) => e.pid === thread.pid && e.tid === thread.tid);
  const marks = on.filter((e) => e.name === 'TimeStamp').sort((a, b) => a.ts - b.ts);
  const tasks = on.filter((e) => e.name.endsWith('RunTask') && e.ph === 'X');
  const frames = [];
  const touched = [];
  for (let i = 0; i + 1 < marks.length; i++) {
    if (marks[i].args.data.message !== 'round') continue;
    const [from, to] = [marks[i].ts, marks[i + 1].ts];
    // The thread's own time in its tasks, once however they nest: what other processes on this
    // machine do to the wall clock is not counted; the throttling is (it spins the thread).
    let cpu = 0, until = 0;
    for (const t of tasks.filter((t) => t.ts + t.dur > from && t.ts + t.dur <= to).sort((a, b) => a.ts - b.ts)) {
      if (t.ts + t.dur <= until) continue;
      cpu += t.tdur ?? 0;
      until = t.ts + t.dur;
    }
    frames.push(cpu / 1000);
    // What it touched, which no load changes: elements styled and objects laid out.
    let styled = 0, laidOut = 0;
    for (const e of on) {
      if (e.ph !== 'X' || e.ts < from || e.ts >= to) continue;
      if (e.name === 'UpdateLayoutTree') styled += e.args?.elementCount ?? 0;
      if (e.name === 'Layout') laidOut += e.args?.beginData?.dirtyObjects ?? 0;
    }
    touched.push({ styled, laidOut });
  }
  frames.sort((a, b) => a - b);
  const q = (x) => +frames[Math.min(frames.length - 1, Math.floor(x * frames.length))].toFixed(2);
  const result = await tab.evaluate(() => window.result);
  const mid = (k) => touched.map((t) => t[k]).sort((a, b) => a - b)[touched.length >> 1];
  console.log(JSON.stringify({ ...result, frame: { median: q(0.5), p95: q(0.95), worst: q(1) }, styled: mid('styled'), laidOut: mid('laidOut') }));
} finally {
  await browser.close();
}
