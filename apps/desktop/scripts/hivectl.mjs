#!/usr/bin/env node
// hivectl — desktop controller for hivemind AppImage.
//
// Combines:
//   - xdotool: real X11 mouse/keyboard (resize drags, hover, clicks, typing)
//   - CDP   : DOM inspection via --remote-debugging-port (state queries)
//
// Usage:
//   node scripts/hivectl.mjs launch                 # start AppImage + CDP
//   node scripts/hivectl.mjs eval '<js>'            # run expr in renderer
//   node scripts/hivectl.mjs key <combo>            # xdotool keypress (Ctrl+k)
//   node scripts/hivectl.mjs type '<text>'          # xdotool type
//   node scripts/hivectl.mjs click <sel>            # click DOM element center
//   node scripts/hivectl.mjs drag <sel> dx dy       # drag from element center
//   node scripts/hivectl.mjs view <board|list|canvas>
//   node scripts/hivectl.mjs palette                # open ⌘K palette (via IPC)
//   node scripts/hivectl.mjs newissue               # ⌘N
//   node scripts/hivectl.mjs toggle <tree|shell|diff>
//   node scripts/hivectl.mjs canvas-state           # tile/frame counts + sizes
//   node scripts/hivectl.mjs resize-test            # drag-resize a tile corner
//   node scripts/hivectl.mjs console                # tail renderer console
//   node scripts/hivectl.mjs kill
//
// Notes:
//   - AppImage path: dist-electron/hivemind-0.0.1-x86_64.AppImage
//   - Spawned with --remote-debugging-port=9222
//   - Window title contains "hivemind"; xdotool targets it by name.

import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(__dirname, "../dist-electron/hivemind-0.0.1-x86_64.AppImage");
const CDP_PORT = 9222;
const LOG = "/tmp/hivectl.log";

const cmd = process.argv[2];
const args = process.argv.slice(3);

// ── CDP helpers ────────────────────────────────────────────────────────────
async function cdpTarget() {
  const r = await fetch(`http://localhost:${CDP_PORT}/json`);
  const targets = await r.json();
  const page = targets.find((t) => t.url.endsWith("index.html"));
  if (!page) throw new Error("hivemind renderer not found on CDP — is it running?");
  return page;
}

async function cdpCall(method, params = {}) {
  const target = await cdpTarget();
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const id = 1;
    ws.onopen = () => ws.send(JSON.stringify({ id, method, params }));
    ws.onmessage = (m) => {
      const e = JSON.parse(m.data);
      if (e.id === id) {
        ws.close();
        if (e.error) reject(new Error(e.error.message));
        else resolve(e.result);
      }
    };
    ws.onerror = (e) => reject(e);
    setTimeout(() => reject(new Error("CDP timeout")), 5000);
  });
}

async function evaluate(expr) {
  const r = await cdpCall("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.text + ": " + (r.exceptionDetails.exception?.description ?? ""));
  }
  return r.result?.value;
}

// ── xdotool helpers ────────────────────────────────────────────────────────
function sh(c) {
  return execSync(c, { encoding: "utf8" }).trim();
}

function focusWindow() {
  // Match only visible windows whose title is exactly "hivemind". Multiple
  // stale wids (from previous instances or X11's hidden tracking windows) can
  // otherwise hand us a wid that's already gone, and the next xdotool call
  // crashes with `BadWindow`.
  try {
    const list = sh(`xdotool search --onlyvisible --name '^hivemind$'`).split("\n").filter(Boolean);
    for (const wid of list) {
      try {
        sh(`xdotool getwindowname ${wid}`);
        sh(`xdotool windowactivate --sync ${wid}`);
        return wid;
      } catch { /* stale wid */ }
    }
    throw new Error("no live hivemind window");
  } catch {
    throw new Error("hivemind window not found — run `launch` first");
  }
}

function windowGeometry(wid) {
  // Returns absolute screen offset of the window's client origin.
  const out = sh(`xdotool getwindowgeometry --shell ${wid}`);
  const obj = Object.fromEntries(
    out.split("\n").map((l) => l.split("=").map((s) => s.trim()))
  );
  return { x: Number(obj.X), y: Number(obj.Y), w: Number(obj.WIDTH), h: Number(obj.HEIGHT) };
}

async function selectorRect(selector) {
  const r = await evaluate(`
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    })()
  `);
  if (!r) throw new Error(`selector not found: ${selector}`);
  return r;
}

async function absoluteCenter(selector) {
  const wid = focusWindow();
  const win = windowGeometry(wid);
  const rect = await selectorRect(selector);
  return {
    x: Math.round(win.x + rect.x + rect.w / 2),
    y: Math.round(win.y + rect.y + rect.h / 2),
    wid,
  };
}

// ── commands ───────────────────────────────────────────────────────────────
const commands = {
  async launch() {
    if (!existsSync(APP)) throw new Error(`AppImage missing at ${APP} — run pnpm dist`);
    // Kill any stale instance first.
    try { sh("pkill -f hivemind-0.0 || true"); } catch { /* */ }
    await new Promise((r) => setTimeout(r, 500));
    const p = spawn(
      "bash",
      ["-c", `nohup "${APP}" --no-sandbox --remote-debugging-port=${CDP_PORT} >${LOG} 2>&1 &`],
      { detached: true, stdio: "ignore" }
    );
    p.unref();
    // Wait for CDP to come up.
    for (let i = 0; i < 30; i++) {
      try { await cdpTarget(); console.log("up on CDP", CDP_PORT); return; } catch { }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("AppImage didn't expose CDP in 15s");
  },

  async kill() {
    sh("pkill -f hivemind-0.0 || true");
    console.log("killed");
  },

  async eval([...rest]) {
    const v = await evaluate(rest.join(" "));
    console.log(JSON.stringify(v, null, 2));
  },

  async key([combo]) {
    focusWindow();
    sh(`xdotool key --clearmodifiers '${combo}'`);
    console.log("sent", combo);
  },

  async type([...rest]) {
    focusWindow();
    const text = rest.join(" ");
    sh(`xdotool type --clearmodifiers --delay 12 -- ${JSON.stringify(text)}`);
    console.log("typed", text.length, "chars");
  },

  async click([selector]) {
    const c = await absoluteCenter(selector);
    sh(`xdotool mousemove --sync ${c.x} ${c.y} click 1`);
    console.log("clicked", selector, "at", c.x, c.y);
  },

  async drag([selector, dx, dy]) {
    const c = await absoluteCenter(selector);
    const tx = c.x + Number(dx);
    const ty = c.y + Number(dy);
    // Press, move in a few steps, release. xdotool's mousedrag isn't great
    // for react-flow which listens to pointermove deltas — chunk it.
    sh(`xdotool mousemove --sync ${c.x} ${c.y}`);
    sh(`xdotool mousedown 1`);
    const steps = 10;
    for (let i = 1; i <= steps; i++) {
      const ix = Math.round(c.x + ((tx - c.x) * i) / steps);
      const iy = Math.round(c.y + ((ty - c.y) * i) / steps);
      sh(`xdotool mousemove --sync ${ix} ${iy}`);
      await new Promise((r) => setTimeout(r, 18));
    }
    sh(`xdotool mouseup 1`);
    console.log(`dragged ${selector} by (${dx},${dy})`);
  },

  async view([kind]) {
    if (!["board", "list", "canvas"].includes(kind)) throw new Error("kind must be board|list|canvas");
    // ViewSwitcher renders buttons with capitalized labels.
    const label = kind[0].toUpperCase() + kind.slice(1);
    await evaluate(`
      [...document.querySelectorAll('button')]
        .find(b => b.textContent.trim() === ${JSON.stringify(label)})?.click();
      true;
    `);
    await new Promise((r) => setTimeout(r, 300));
    console.log("view →", kind);
  },

  async palette() {
    focusWindow();
    sh("xdotool key --clearmodifiers ctrl+k");
    await new Promise((r) => setTimeout(r, 350));
    const open = await evaluate(`!!document.querySelector('[role="dialog"]')`);
    console.log("palette open:", open);
  },

  async newissue() {
    focusWindow();
    sh("xdotool key --clearmodifiers ctrl+n");
    await new Promise((r) => setTimeout(r, 350));
    const open = await evaluate(`!!document.querySelector('[role="dialog"]')`);
    console.log("new-issue modal open:", open);
  },

  async toggle([what]) {
    if (!["tree", "shell", "diff"].includes(what)) throw new Error("tree|shell|diff");
    await evaluate(
      `window.dispatchEvent(new CustomEvent('hivemind:canvas-toggle',{detail:${JSON.stringify(what)}}));true;`
    );
    console.log("toggled", what);
  },

  async "canvas-state"() {
    const s = await evaluate(`
      (() => {
        const nodes = [...document.querySelectorAll('.react-flow__node')].map(n => {
          const r = n.getBoundingClientRect();
          return {
            id: n.getAttribute('data-id'),
            type: n.className.match(/react-flow__node-(\\w+)/)?.[1],
            x: Math.round(r.x), y: Math.round(r.y),
            w: Math.round(r.width), h: Math.round(r.height),
            selected: n.classList.contains('selected'),
          };
        });
        const resizers = document.querySelectorAll('.react-flow__resize-control').length;
        return { nodes, resizers };
      })()
    `);
    console.log(JSON.stringify(s, null, 2));
  },

  async "resize-test"() {
    await commands.view(["canvas"]);
    await new Promise((r) => setTimeout(r, 400));
    const hasTerm = await evaluate(`!!document.querySelector('.react-flow__node-terminal')`);
    if (!hasTerm) {
      await commands.toggle(["shell"]);
      await new Promise((r) => setTimeout(r, 800));
    }

    // 2. Capture initial size.
    const before = await evaluate(`
      (() => {
        const n = document.querySelector('.react-flow__node-terminal');
        if (!n) return null;
        const r = n.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
      })()
    `);
    if (!before) { console.log("no terminal node mounted"); return; }
    console.log("before:", before);

    // 3. Click the node first (so resize handles activate even though
    //    isVisible={true} keeps them present), then drag bottom-right handle.
    //    react-flow puts handles at .react-flow__resize-control with
    //    data-position like 'right', 'bottom-right', etc.
    await commands.click([".react-flow__node-terminal"]);
    await new Promise((r) => setTimeout(r, 200));

    const handleSel = `.react-flow__node-terminal .react-flow__resize-control.bottom.right, ` +
                      `.react-flow__node-terminal .react-flow__resize-control[data-position="bottom-right"]`;
    let handleRect;
    try {
      handleRect = await selectorRect(handleSel);
    } catch {
      // Fallback: query all and pick the bottom-right by max(x+y).
      const r = await evaluate(`
        (() => {
          const ctrls = [...document.querySelectorAll('.react-flow__node-terminal .react-flow__resize-control')];
          if (!ctrls.length) return null;
          const w = ctrls.map(c => {
            const r = c.getBoundingClientRect();
            return { score: r.x + r.y, x: r.x + r.width/2, y: r.y + r.height/2 };
          }).sort((a,b) => b.score - a.score)[0];
          return w;
        })()
      `);
      if (!r) { console.log("no resize controls on terminal node"); return; }
      handleRect = { x: r.x - 4, y: r.y - 4, w: 8, h: 8 };
    }
    console.log("handle rect:", handleRect);

    // Drag the handle by +120, +80 using CDP Input.dispatchMouseEvent.
    // viewport-relative coords (no window-offset math), and CDP synthesizes
    // proper pointerdown/pointermove/pointerup that react-flow's drag
    // gesture listens for.
    const sx = handleRect.x + handleRect.w / 2;
    const sy = handleRect.y + handleRect.h / 2;
    await cdpCall("Input.dispatchMouseEvent", { type: "mouseMoved", x: sx, y: sy, button: "none" });
    await cdpCall("Input.dispatchMouseEvent", { type: "mousePressed", x: sx, y: sy, button: "left", clickCount: 1, buttons: 1 });
    for (let i = 1; i <= 12; i++) {
      const ix = sx + (120 * i) / 12;
      const iy = sy + (80 * i) / 12;
      await cdpCall("Input.dispatchMouseEvent", { type: "mouseMoved", x: ix, y: iy, button: "left", buttons: 1 });
      await new Promise((r) => setTimeout(r, 30));
    }
    await cdpCall("Input.dispatchMouseEvent", { type: "mouseReleased", x: sx + 120, y: sy + 80, button: "left", clickCount: 1, buttons: 0 });
    await new Promise((r) => setTimeout(r, 400));

    const after = await evaluate(`
      (() => {
        const n = document.querySelector('.react-flow__node-terminal');
        const r = n.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
      })()
    `);
    console.log("after :", after);
    const dw = after.w - before.w;
    const dh = after.h - before.h;
    console.log("delta :", { dw, dh });
    if (dw > 50 && dh > 30) console.log("✓ RESIZE WORKS");
    else console.log("✗ RESIZE BROKEN — drag did not change node dimensions");
  },

  async console() {
    sh(`tail -n 200 ${LOG}`, { stdio: "inherit" });
  },

  async "cdp-drag"([selector, dxs, dys]) {
    const rect = await selectorRect(selector);
    const sx = rect.x + rect.w / 2;
    const sy = rect.y + rect.h / 2;
    const dx = Number(dxs), dy = Number(dys);
    await cdpCall("Input.dispatchMouseEvent", { type: "mouseMoved", x: sx, y: sy, button: "none" });
    await cdpCall("Input.dispatchMouseEvent", { type: "mousePressed", x: sx, y: sy, button: "left", clickCount: 1, buttons: 1 });
    await new Promise((r) => setTimeout(r, 60));
    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      await cdpCall("Input.dispatchMouseEvent", { type: "mouseMoved", x: sx + (dx * i) / steps, y: sy + (dy * i) / steps, button: "left", buttons: 1 });
      await new Promise((r) => setTimeout(r, 30));
    }
    await cdpCall("Input.dispatchMouseEvent", { type: "mouseReleased", x: sx + dx, y: sy + dy, button: "left", clickCount: 1, buttons: 0 });
    console.log(`cdp-dragged ${selector} by (${dx},${dy})`);
  },
};

if (!commands[cmd]) {
  console.error(`unknown command: ${cmd || "(none)"}`);
  console.error("commands:", Object.keys(commands).join(", "));
  process.exit(1);
}

try {
  await commands[cmd](args);
} catch (e) {
  console.error("error:", e.message);
  process.exit(1);
}
