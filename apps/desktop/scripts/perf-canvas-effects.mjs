// PERF_EXTRA_ARGS appends Electron switches; A/B uncapped on a live desktop ("--disable-gpu-vsync --disable-frame-rate-limit").
import { _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const output = process.argv[2] ?? '/tmp/canvas-effects.json';
// How many shell terminals the scene holds. Node scope only: the page context
// cannot see process.env, so this is passed into every page callback that
// needs it (see the waitForFunction below).
const NTERM = Math.max(1, Number(process.env.PERF_TERMINALS) || 3);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hm-canvas-effects-'));
const env = { ...process.env, XDG_CONFIG_HOME: path.join(root, 'config'), HIVEMIND_PTY_DAEMON: '0' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.HIVE_SETTINGS;
const result = { version: 2, completed: false, at: new Date().toISOString(), workload: `${NTERM} shell terminals, 50 lines/sec each; 1920x1200 viewport; quiet and wheel pan; forward/reverse effect order`, terminals: NTERM, os: { platform: os.platform(), release: os.release(), cpu: os.cpus()[0]?.model, cpus: os.cpus().length, load: os.loadavg() }, session: { type: process.env.XDG_SESSION_TYPE ?? null, display: process.env.DISPLAY ?? null, wayland: process.env.WAYLAND_DISPLAY ?? null, extraArgs: (process.env.PERF_EXTRA_ARGS ?? '').split(' ').filter(Boolean) }, samples: [] };
let app;
try {
  const extraArgs = (process.env.PERF_EXTRA_ARGS ?? '').split(' ').filter(Boolean);
  app = await electron.launch({ args: [path.resolve(import.meta.dirname, '../out/main/index.js'), '--no-sandbox', ...extraArgs], cwd: root, env });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1920, 1200); window.setPosition(0,0); window.focus(); });
  await page.waitForSelector('.react-flow');
  result.webgl = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) return { available: false };
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const info = { available: true, vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR), renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) };
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return info;
  });
  result.gpu = await app.evaluate(async ({ app }) => ({ features: app.getGPUFeatureStatus(), info: await app.getGPUInfo('complete') }));
  result.display = await page.evaluate(() => ({ dpr: devicePixelRatio, width: innerWidth, height: innerHeight, focused: document.hasFocus() }));
  result.windowBounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentBounds());
  async function pointAtPane() {
    const point = await page.evaluate(() => {
      for (const y of [.65,.8,.4,.2]) for (const x of [.9,.75,.5,.35]) {
        const point = { x: Math.round(innerWidth*x), y: Math.round(innerHeight*y) };
        if (document.elementFromPoint(point.x, point.y)?.classList.contains('react-flow__pane')) return point;
      }
      return null;
    });
    if (!point) throw new Error('No uncovered canvas pane for input');
    await page.mouse.move(point.x,point.y);
    return point;
  }
  const settings = await page.evaluate(() => window.hive.settingsGet());
  const base = { ...settings.appearance, glass: { ...settings.appearance.glass, enabled: true, animate: true }, wallpaper: { ...settings.appearance.wallpaper, kind: 'aurora' } };
  await page.evaluate(async base => window.hive.settingsSet('appearance', { ...base, glass: { ...base.glass, enabled: false, animate: false } }), base);
  for (let n = 0; n < NTERM; n++) {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('hivemind:canvas-toggle', { detail: 'shell' })));
    await page.waitForTimeout(300);
  }
  await page.waitForFunction(n => document.querySelectorAll('.xterm').length === n, NTERM);
  { const p = await pointAtPane(); await page.mouse.click(p.x,p.y); }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(2500);
  await page.evaluate(() => {
    window.__effectProbe = {
      start() {
        const s = { frames: [], lag: [], long: [], active: true, last: performance.now() };
        const frame = t => { if (!s.active) return; s.frames.push(t - s.last); s.last = t; requestAnimationFrame(frame); };
        requestAnimationFrame(frame);
        let expected = performance.now() + 16;
        s.timer = setInterval(() => { const now = performance.now(); s.lag.push(Math.max(0, now - expected)); expected = now + 16; }, 16);
        s.observer = new PerformanceObserver(entries => s.long.push(...entries.getEntries().map(entry => entry.duration)));
        s.observer.observe({ entryTypes: ['longtask'] });
        window.__effectSample = s;
      },
      stop() {
        const s = window.__effectSample; s.active = false; clearInterval(s.timer); s.observer.disconnect();
        const frames = s.frames.slice(1); const sum = frames.reduce((a,b) => a+b, 0);
        const p = (a, q) => [...a].sort((a,b) => a-b)[Math.min(a.length-1, Math.floor(a.length*q))] ?? 0;
        return { fps: frames.length * 1000 / sum, frames: frames.length, seconds: sum/1000, frameP95: p(frames,.95), frameMax: Math.max(0,...frames), lagP95: p(s.lag,.95), longTaskMs: s.long.reduce((a,b)=>a+b,0), domTerminals: document.querySelectorAll('.xterm-rows').length, webglCanvases: document.querySelectorAll('.xterm-screen canvas').length, wallpaperPaused: document.querySelector('.hm-wallpaper')?.classList.contains('paused') ?? null, focused: document.hasFocus(), viewport: document.querySelector('.react-flow__viewport')?.getAttribute('style') };
      }
    };
  });
  const effects = (process.env.PERF_EFFECTS ?? 'default,static,no-backdrop,off').split(',');
  const workloads = (process.env.PERF_WORKLOADS ?? 'quiet,streaming').split(',');
  const rounds = Number(process.env.PERF_ROUNDS ?? 2);
  const knownEffects = ['default','static','no-backdrop','off','no-bloom-filter','no-bloom-blend','pause-motion'];
  if (effects.some(effect => !knownEffects.includes(effect)) || workloads.some(workload => !['quiet','streaming'].includes(workload)) || !Number.isInteger(rounds) || rounds < 1 || rounds > 5) throw new Error('Invalid benchmark effects, workloads, or rounds');
  result.effects = effects; result.rounds = rounds; result.workloads = workloads;
  async function configure(effect) {
    await page.evaluate(async ({ base, effect }) => {
      const appearance = structuredClone(base);
      if (effect === 'static') appearance.glass.animate = false;
      if (effect === 'off') { appearance.glass.enabled = false; appearance.glass.animate = false; appearance.wallpaper.kind = 'none'; }
      await window.hive.settingsSet('appearance', appearance);
      document.getElementById('perf-effect-override')?.remove();
      if (['no-backdrop', 'no-bloom-filter', 'no-bloom-blend', 'pause-motion'].includes(effect)) {
        const style = document.createElement('style'); style.id = 'perf-effect-override';
        style.textContent = {
          'no-backdrop': '* { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }',
          'no-bloom-filter': '.hm-wp-bloom { filter: none !important; }',
          'no-bloom-blend': '.hm-wp-bloom { mix-blend-mode: normal !important; }',
          'pause-motion': 'html:has(.canvas-moving, .canvas-dragging, .canvas-resizing) .hm-wp-bloom { animation-play-state: paused !important; }',
        }[effect]; document.head.appendChild(style);
      }
    }, { base, effect });
    await pointAtPane();
    await page.waitForTimeout(2500);
  }
  async function measure(workload, effect, round, pan) {
    const pointer = await pointAtPane();
    await page.evaluate(() => window.__effectProbe.start());
    const transform = () => page.locator('.react-flow__viewport').getAttribute('style');
    const before = await transform(); let midpoint = before;
    if (pan) {
      result.pointerTarget = await page.evaluate(p => document.elementFromPoint(p.x,p.y)?.className, pointer);
      for (let k=0;k<32;k++) { await page.mouse.wheel(k<16 ? 24 : -24, k<16 ? 16 : -16); await page.waitForTimeout(60); if (k === 15) midpoint = await transform(); }
      await page.waitForTimeout(300);
    } else await page.waitForTimeout(3000);
    const metrics = await page.evaluate(() => window.__effectProbe.stop());
    const row = { workload, effect, round, scene: pan ? 'pan' : 'idle', panVerified: pan ? midpoint !== before : null, ...metrics, load: os.loadavg() };
    result.samples.push(row); console.log(JSON.stringify(row));
    await fs.writeFile(output, JSON.stringify(result,null,2));
    if (pan && !row.panVerified) throw new Error('Wheel input did not move the viewport; do not use this as a pan result');
  }
  for (const workload of workloads) {
    if (workload === 'streaming') {
      await configure('off'); // Setup speed must not depend on the effect under test.
      const ids = await page.locator('.react-flow__node-terminal').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-id')));
      for (const id of ids) {
        await page.evaluate(id => window.dispatchEvent(new CustomEvent('hivemind:focus-tile', { detail: id })), id);
        await page.waitForTimeout(600);
        await page.locator(`[data-surface="${id}"] .xterm-screen`).click();
        if (!await page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea'))) throw new Error('Terminal focus failed');
        await page.keyboard.insertText('i=0; while :; do i=$((i+1)); echo "line $i lorem ipsum dolor sit amet consectetur adipiscing elit"; sleep 0.02; done');
        await page.keyboard.press('Enter');
      }
      { const p = await pointAtPane(); await page.mouse.click(p.x,p.y); } await page.keyboard.press('Escape'); await page.waitForTimeout(1500);
    }
    for (let round=0;round<rounds;round++) for (const effect of round ? [...effects].reverse() : effects) {
      await configure(effect);
      await measure(workload,effect,round,false);
      await measure(workload,effect,round,true);
    }
  }
  // Profiling is deliberately outside timed comparisons.
  await configure(process.env.PERF_PROFILE_EFFECT ?? 'default');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable'); await cdp.send('Profiler.start');
  await page.waitForTimeout(5000);
  const { profile } = await cdp.send('Profiler.stop');
  await fs.writeFile(`${output}.cpuprofile`, JSON.stringify(profile));
  await cdp.detach();
  result.completed = true;
  result.os.loadEnd = os.loadavg();
  await fs.writeFile(output, JSON.stringify(result,null,2));
} catch (error) {
  result.error = String(error);
  await fs.writeFile(output, JSON.stringify(result,null,2));
  throw error;
} finally {
  await app?.close();
  await fs.rm(root,{recursive:true,force:true});
}
