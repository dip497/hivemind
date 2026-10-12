// How fast the phone page opens, and what opening a chat costs, on a CPU 4x slower than this one,
// as a mid phone's. Its built page (build.sh), served from www by a server of its own; prints, in
// ms, as JSON, the median and worst of `runs` opens:
//   kept: reopened offline, its files from the service worker, until Home shows what it kept;
//   first: a fresh browser over a phone's network (200 ms a request, 9 Mbit/s), until it asks to pair;
//   with the requests each made and the longest task in each;
//   chat: an agent's screen opened on `said` messages of markdown: when the newest shows, when all
//   do, and the long tasks (over 50 ms) till then.
//   node measure-open.mjs [runs] [said]
// WWW=<dir> measures another build of the page; TRACE=<file> keeps a trace of the last kept open.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const [runs = '7', said = '60'] = process.argv.slice(2).map(Number);
const www = path.resolve(process.env.WWW ?? new URL('www/', import.meta.url).pathname) + '/';
const require = createRequire(
  process.env.PLAYWRIGHT_FROM ?? new URL('../../apps/desktop/package.json', import.meta.url),
);
const { chromium } = require('@playwright/test');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/$/, '/index.html');
  const file = path.join(www, path.normalize(name));
  if (!file.startsWith(www) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
  const stat = fs.statSync(file);
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', etag: `"${stat.size}-${stat.mtimeMs}"`, 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;

// What a paired page keeps: the computer, and Home as it last showed, 40 agents, 10 of them waiting.
const since = 1790000000000;
const agents = Array.from({ length: 40 }, (_, i) => {
  const waits = i % 4 === 0;
  return { workspace: `w${i % 3}`, name: `api${i % 3}`, tile: `t${i}`, agent: `agent ${i}`, program: { id: 'claude', label: 'Claude' },
    state: waits ? 'waiting' : 'working', since: since + i, machine: 'laptop', device: 'd', interrupt: true, conversation: true,
    ...(waits ? { waiting: { kind: 'permission', since: since + i, decide: true, tool: { name: 'Bash', about: `npm test -- part ${i}` } } } : {}) };
});
const tileOf = (a, i) => ({ workspace: a.workspace, id: a.tile, frameId: null, kind: 'agent', name: a.agent, agent: a.agent, order: i,
  state: a.state, since: a.since, ...(a.waiting ? { waiting: a.waiting } : {}), program: a.program, machine: a.machine, interrupt: true, conversation: true });
const tree = [{ of: 'machine', key: 'm:laptop', name: 'laptop' }];
for (const w of ['w0', 'w1', 'w2']) {
  tree.push({ of: 'project', key: `p:${w}`, name: `api${w.slice(1)}`, workspace: w });
  agents.forEach((a, i) => a.workspace === w && tree.push({ of: 'tile', key: `t:${w}/${a.tile}`, depth: 0, tile: tileOf(a, i), line: `working on part ${i}` }));
}
const needs = agents.filter((a) => a.waiting);
const first = {
  shown: { needs: needs.map((a) => `t:${a.workspace}/${a.tile}`), working: [], pinned: [], machines: ['laptop'], tree },
  overview: { agents, needs, working: agents.length - needs.length },
};
const paired = { with: { device: 'c'.repeat(64), name: 'laptop', relay: null, kind: 'desktop' }, certificate: {}, network: {}, admission: 'enrolled' };

// Into what the page keeps (store.ts), as it keeps it.
const keep = (entries) => new Promise((done, failed) => {
  const open = indexedDB.open('hive-web', 1);
  open.onupgradeneeded = () => open.result.createObjectStore('kept');
  open.onerror = () => failed(open.error);
  open.onsuccess = () => {
    const tx = open.result.transaction('kept', 'readwrite');
    for (const [key, value] of entries) tx.objectStore('kept').put(value, key);
    tx.oncomplete = () => { open.result.close(); done(); };
    tx.onerror = () => failed(tx.error);
  };
});

const browser = await chromium.launch();
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
// When `selector` is first on screen, and every task over 50 ms, from the page's start.
const watch = (selector) => {
  window.taken = [];
  new PerformanceObserver((l) => window.taken.push(...l.getEntries().map((e) => e.duration))).observe({ type: 'longtask', buffered: true });
  new MutationObserver((_, o) => {
    if (!document.querySelector(selector)?.checkVisibility()) return;
    window.shown = performance.now();
    console.debug('measure: shown');
    o.disconnect();
  }).observe(document, { childList: true, subtree: true, attributes: true });
};

async function open(context, selector, network, kept) {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  if (network) {
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 200, downloadThroughput: 9e6 / 8, uploadThroughput: 3e6 / 8 });
  }
  let requests = 0;
  page.on('request', () => requests++);
  page.on('pageerror', (e) => console.error(`page: ${e.message}`));
  await page.addInitScript(watch, selector);
  // Told by the page, not asked: asking runs a script of the browser driver's on the page while it opens.
  const shown = page.waitForEvent('console', { predicate: (m) => m.text() === 'measure: shown', timeout: 60_000 });
  await page.goto(origin);
  await shown.catch(async (e) => {
    const at = await page.evaluate((s) => ({ ready: document.readyState, there: !!document.querySelector(s), screens: [...document.querySelectorAll('[data-screen]')].map((el) => `${el.dataset.screen}${el.hidden ? '' : '*'}`).join(' '), error: document.querySelector('[data-error]')?.textContent }), selector).catch(() => 'no page');
    throw new Error(`${selector} never shown: ${JSON.stringify(at)}; ${e.message}`);
  });
  await page.waitForTimeout(1500);
  const r = await page.evaluate(() => ({ shown: window.shown, longest: Math.max(0, ...window.taken) }));
  // Its core, up and reaching nothing, kept an empty Home: what it showed is kept again.
  if (kept) await page.evaluate(keep, [['first', kept]]);
  await page.close();
  return { ...r, requests };
}

const summary = (all, key) => {
  const v = all.map((r) => r[key]).sort((a, b) => a - b);
  return { median: +v[Math.floor(v.length / 2)].toFixed(0), worst: +v.at(-1).toFixed(0) };
};
const result = { runs };

// Kept: paired once, its Home kept and its files in the service worker, then reopened offline.
{
  const context = await browser.newContext(phone);
  const page = await context.newPage();
  await page.goto(origin);
  await page.evaluate(keep, [['paired', paired], ['first', first]]);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(async () => (await caches.open('hive-web').then((c) => c.keys())).length > 10);
  await page.close();
  await context.setOffline(true);
  const all = [];
  for (let i = 0; i < runs; i++) {
    const traced = process.env.TRACE && i === runs - 1;
    if (traced) await browser.startTracing(undefined, { path: process.env.TRACE, categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8.execute', 'loading'] });
    all.push(await open(context, '[data-need]', false, first));
    if (traced) await browser.stopTracing();
  }
  result.kept = { shown: summary(all, 'shown'), longest: summary(all, 'longest') };
  await context.close();
}

// First: nothing kept, nothing cached, every file over the network.
{
  const all = [];
  for (let i = 0; i < runs; i++) {
    const context = await browser.newContext({ ...phone, serviceWorkers: 'block' });
    all.push(await open(context, '[data-screen="pair"]', true));
    await context.close();
  }
  result.first = { shown: summary(all, 'shown'), requests: all[0].requests, longest: summary(all, 'longest') };
}

// Chat: an agent's screen opened on `said` messages, once the wasm is up, as when the computer is.
{
  const context = await browser.newContext(phone);
  const page = await context.newPage();
  // As the app is when a chat opens: its styles applied and its fonts in hand.
  await page.goto(`${origin}/none`);
  await page.setContent('<link rel="stylesheet" href="app.css"><main id="app"></main>');
  await page.evaluate(() => Promise.all(['400 1em Geist', '500 1em Geist', '600 1em Geist', '400 1em "JetBrains Mono"', '500 1em "JetBrains Mono"'].map((f) => document.fonts.load(f))));
  const body = '## Plan\n\nThe **login** redirect drops the `next` parameter. See https://example.com/issue/42.\n\n| file | lines |\n|:--|--:|\n| `auth.ts` | 12 |\n| `redirect.ts` | 40 |\n\n- [x] read the flow\n- [ ] fix it\n  - keep the tests\n\n```ts\nconst next = url.searchParams.get("next");\n```\n\n> Asked before, in the last review.';
  const all = [];
  for (let i = 0; i < runs; i++) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    all.push(await page.evaluate(async ([n, text]) => {
      const { default: init } = await import('./pkg/hive_web.js');
      await init();
      // As the app does once its core is up.
      (await import('./js/markdown.js')).warm?.();
      await new Promise((f) => setTimeout(f, 500));
      const { AgentScreen } = await import('./js/agent.js');
      const entries = Array.from({ length: n }, (_, i) => ({ id: `e${i}`, at: 1790000000000 + i, who: i % 3 === 0 ? 'person' : 'agent', text: i % 3 === 0 ? 'go on' : text }));
      const app = { open() {}, back() {}, answer: async () => true, send: async () => true, stop: async () => true, close: async () => true, computer: () => 'laptop',
        conversation: (_a, said) => { setTimeout(() => said({ entries, cursor: n, session: 's' })); return () => {}; } };
      const screen = new AgentScreen(app);
      document.getElementById('app').replaceChildren(screen.el);
      const taken = [];
      const seen = new PerformanceObserver((l) => taken.push(...l.getEntries().map((e) => e.duration)));
      seen.observe({ type: 'longtask' });
      const agent = { workspace: 'w0', name: 'api0', tile: 't0', agent: 'agent 0', state: 'working', since: 1790000000000, machine: 'laptop', device: 'd', conversation: true };
      const t = performance.now();
      screen.open('t0', { agents: [agent], needs: [], working: 1 });
      screen.show({ agents: [agent], needs: [], working: 1 });
      const frame = () => new Promise((f) => requestAnimationFrame(() => setTimeout(f)));
      while (!screen.el.querySelector(`[data-entry="e${n - 1}"]`)) await frame();
      await frame();
      const drawn = performance.now() - t;
      while (screen.el.querySelectorAll('[data-entry]').length < n) await frame();
      const all = performance.now() - t;
      await new Promise((f) => setTimeout(f, 100));
      seen.disconnect();
      return { drawn, all, longest: Math.max(0, ...taken), over50: taken.filter((d) => d > 50).length };
    }, [said, body]));
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await cdp.detach();
  }
  result.chat = { said, drawn: summary(all, 'drawn'), all: summary(all, 'all'), longest: summary(all, 'longest'), over50: Math.max(...all.map((r) => r.over50)) };
}

await browser.close();
server.close();
console.log(JSON.stringify(result));
