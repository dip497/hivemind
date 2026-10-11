// How long the phone page takes to apply what the computer says to its screens (Needs you, Agents,
// one agent), on a CPU 4x slower than this one, as a mid phone's: the first list, then each next
// one with one wait answered. Its built modules (build.sh), served from www by route, no server;
// prints the median and worst, in ms, as JSON. A frame is 16.7 ms.
//   node measure-screens.mjs [agents] [rounds]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const [agents = '40', rounds = '200'] = process.argv.slice(2);
const www = new URL('www/', import.meta.url).pathname;
const require = createRequire(
  process.env.PLAYWRIGHT_FROM ?? new URL('../../apps/desktop/package.json', import.meta.url),
);
const { chromium } = require('@playwright/test');

const page = `<!doctype html><link rel="stylesheet" href="app.css"><main id="app"></main>
<script type="module">
import { Needs } from "./js/needs.js";
import { Agents } from "./js/agents.js";
import { AgentScreen } from "./js/agent.js";
const app = { open() {}, back() {}, answer: async () => true, send: async () => true, stop: async () => true, conversation: () => () => {} };
const screens = [new Needs(app), new Agents(app), new AgentScreen(app)];
document.getElementById("app").append(...screens.map((s) => s.el));
screens[2].open("t0", null);
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
for (let r = 1, answered = 1; r <= ${Number(rounds)}; r++, answered++) {
  if (answered > n / 4) { show(overview(0)); answered = 1; }
  took.push(show(overview(answered)));
  await new Promise((f) => requestAnimationFrame(() => setTimeout(f)));
}
took.sort((a, b) => a - b);
const at = (q) => +took[Math.min(took.length - 1, Math.floor(q * took.length))].toFixed(2);
window.result = { agents: n, first: +first.toFixed(2), median: at(0.5), p95: at(0.95), worst: +took.at(-1).toFixed(2) };
</script>`;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM });
try {
  const tab = await browser.newPage({ viewport: { width: 390, height: 844 } });
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
  await tab.waitForFunction(() => window.result, null, { timeout: 120_000 });
  console.log(JSON.stringify(await tab.evaluate(() => window.result)));
} finally {
  await browser.close();
}
