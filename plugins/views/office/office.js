// ../../../packages/hive-view-sdk/src/protocol.ts
var PROTOCOL_VERSION = 1;
var STATUSES = ["unknown", "idle", "working", "blocked", "exited"];
var COMMAND_PERMISSION = {
  selectTile: null,
  selectFrame: null,
  focusTile: null,
  closeTile: "workspace:close",
  spawnTile: "workspace:spawn",
  spawnVis: "workspace:spawn",
  spawnClaude: "workspace:spawn",
  addFrame: "workspace:spawn"
};
var LAYOUT_MAX_BYTES = 64 * 1024;
var ID_MAX = 256;
var isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
var isId = (v) => typeof v === "string" && v.length > 0 && v.length <= ID_MAX;
var isIdOrNull = (v) => v === null || isId(v);
var isNum = (v) => typeof v === "number" && Number.isFinite(v);
function parseHostMessage(raw) {
  if (!isObj(raw) || typeof raw.type !== "string") return { ok: false, reason: "not an object with a string type" };
  const bad = (why) => ({ ok: false, reason: `${raw.type}: ${why}` });
  switch (raw.type) {
    case "hello":
      if (!isNum(raw.v) || !isId(raw.pluginId) || !Array.isArray(raw.capabilities) || !isObj(raw.theme) || !isObj(raw.viewport)) return bad("missing fields");
      return { ok: true, msg: raw };
    case "structure":
      if (!Array.isArray(raw.frames) || !Array.isArray(raw.tiles)) return bad("frames and tiles must be arrays");
      return { ok: true, msg: raw };
    case "names":
      return isObj(raw.names) ? { ok: true, msg: raw } : bad("names must be an object");
    case "selection":
      return isIdOrNull(raw.tileId) && isIdOrNull(raw.frameId) && typeof raw.fresh === "boolean" ? { ok: true, msg: raw } : bad("bad fields");
    case "status":
      return isId(raw.tileId) && STATUSES.includes(raw.status) ? { ok: true, msg: raw } : bad("bad fields");
    case "reveal":
      return isNum(raw.requestId) && isId(raw.tileId) ? { ok: true, msg: raw } : bad("bad fields");
    case "resize":
      return isNum(raw.w) && isNum(raw.h) ? { ok: true, msg: raw } : bad("bad fields");
    case "visibility":
      return typeof raw.visible === "boolean" ? { ok: true, msg: raw } : bad("visible must be a boolean");
    case "theme":
      return isObj(raw.theme) ? { ok: true, msg: raw } : bad("theme must be an object");
    case "undock":
      return isId(raw.tileId) ? { ok: true, msg: raw } : bad("tileId must be a string");
    default:
      return { ok: false, reason: `unknown message type ${JSON.stringify(raw.type)}` };
  }
}
var PORT_HANDSHAKE = "hivemind-view:port";

// ../../../packages/hive-view-sdk/src/client.ts
function connect(opts = {}) {
  const target = opts.target ?? window;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      target.removeEventListener("message", onWindow);
      reject(new Error("hivemind: no host handshake"));
    }, opts.timeoutMs ?? 1e4);
    const onWindow = (e) => {
      const port = e.ports?.[0];
      if (!port || !e.data || e.data.type !== PORT_HANDSHAKE) return;
      target.removeEventListener("message", onWindow);
      clearTimeout(timer);
      new Client(port).whenReady().then(resolve, reject);
    };
    target.addEventListener("message", onWindow);
  });
}
var Client = class {
  constructor(port) {
    this.port = port;
    this.commands = Object.fromEntries(
      Object.keys(COMMAND_PERMISSION).map((name) => [name, (...args) => this.command(name, args)])
    );
    this.ready = new Promise((res) => {
      port.onmessage = (e) => {
        const r = parseHostMessage(e.data);
        if (!r.ok) return;
        if (r.msg.type === "hello") {
          this.hello = r.msg;
          this.capabilities = r.msg.capabilities;
          this.viewport = { ...r.msg.viewport };
          this.visible = r.msg.visible;
          res();
          return;
        }
        this.dispatch(r.msg);
      };
    });
    port.start();
    this.send({ type: "ready", v: PROTOCOL_VERSION });
  }
  port;
  hello;
  capabilities = [];
  viewport = { w: 0, h: 0 };
  visible = true;
  framesDrawn = 0;
  commands;
  listeners = /* @__PURE__ */ new Map();
  status = /* @__PURE__ */ new Map();
  revealHandler = null;
  lastRects = "";
  frameTimer = null;
  lastReportedFrames = 0;
  layoutTimer = null;
  ready;
  /** Resolves once hello has arrived (connect() awaits this before handing the client out). */
  whenReady() {
    return this.ready.then(() => this);
  }
  send(msg) {
    this.port.postMessage(msg);
  }
  dispatch(m) {
    switch (m.type) {
      case "structure":
      case "names":
      case "selection":
        this.emit(m.type, m);
        break;
      case "status":
        for (const cb of this.status.get(m.tileId) ?? []) cb(m.status);
        break;
      case "resize":
        this.viewport = { w: m.w, h: m.h };
        this.emit("resize", this.viewport);
        break;
      case "visibility":
        this.visible = m.visible;
        this.emit("visibility", { visible: m.visible });
        break;
      case "theme":
        this.emit("theme", m.theme);
        break;
      case "undock": {
        try {
          const kept = JSON.parse(this.lastRects || "[]").filter((r) => r.tileId !== m.tileId);
          this.lastRects = JSON.stringify(kept);
        } catch {
          this.lastRects = "";
        }
        this.emit("undock", { tileId: m.tileId });
        break;
      }
      case "reveal":
        this.answerReveal(m.requestId, m.tileId);
        break;
      default:
        break;
    }
  }
  emit(event, payload) {
    for (const cb of this.listeners.get(event) ?? []) cb(payload);
  }
  async answerReveal(requestId, tileId) {
    let rect = null;
    try {
      rect = this.revealHandler ? await this.revealHandler(tileId) : null;
    } catch {
      rect = null;
    }
    this.send({ type: "revealed", requestId, rect });
  }
  command(name, args) {
    const need = COMMAND_PERMISSION[name];
    if (need && !this.capabilities.includes(need)) throw new Error(`hivemind: ${name} needs permission "${need}" \u2014 add it to hivemind-view.json`);
    this.send({ type: "command", name, args });
  }
  on(event, cb) {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, set = /* @__PURE__ */ new Set());
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  }
  subscribeStatus(tileId, cb) {
    let set = this.status.get(tileId);
    if (!set) {
      this.status.set(tileId, set = /* @__PURE__ */ new Set());
      this.send({ type: "subscribeStatus", tileId });
    }
    set.add(cb);
    return () => {
      const s = this.status.get(tileId);
      if (!s) return;
      s.delete(cb);
      if (s.size === 0) {
        this.status.delete(tileId);
        this.send({ type: "unsubscribeStatus", tileId });
      }
    };
  }
  setSurfaceRects(rects) {
    const norm = rects.map((r) => ({ tileId: r.tileId, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h), ...r.chrome ? { chrome: r.chrome } : {} }));
    const key = JSON.stringify(norm);
    if (key === this.lastRects) return;
    this.lastRects = key;
    this.send({ type: "surfaceRects", rects: norm });
  }
  onReveal(handler) {
    this.revealHandler = handler;
    return () => {
      if (this.revealHandler === handler) this.revealHandler = null;
    };
  }
  reportFrame() {
    this.framesDrawn++;
    if (this.frameTimer) return;
    this.frameTimer = setTimeout(() => {
      this.frameTimer = null;
      if (this.framesDrawn !== this.lastReportedFrames) {
        this.lastReportedFrames = this.framesDrawn;
        this.send({ type: "framesDrawn", count: this.framesDrawn });
      }
    }, 1e3);
  }
  setLayout(data) {
    if (this.layoutTimer) clearTimeout(this.layoutTimer);
    this.layoutTimer = setTimeout(() => {
      this.layoutTimer = null;
      this.send({ type: "layout", data });
    }, 250);
  }
  error(message) {
    this.send({ type: "error", message });
  }
};
function createInvalidator(client, draw2) {
  let pending = false;
  let dirtyWhileHidden = false;
  const tick = () => {
    pending = false;
    if (!client.visible) {
      dirtyWhileHidden = true;
      return;
    }
    draw2();
    client.reportFrame();
  };
  const invalidate2 = () => {
    if (pending) return;
    if (!client.visible) {
      dirtyWhileHidden = true;
      return;
    }
    pending = true;
    requestAnimationFrame(tick);
  };
  const off = client.on("visibility", ({ visible }) => {
    if (visible && dirtyWhileHidden) {
      dirtyWhileHidden = false;
      invalidate2();
    }
  });
  return { invalidate: invalidate2, dispose: off };
}
function applyThemeVars(client, root = document.documentElement) {
  const apply = (t) => {
    for (const [k, v] of Object.entries(t.colors)) root.style.setProperty(`--hm-color-${k}`, v);
    if (t.accent) root.style.setProperty("--hm-accent", t.accent);
    if (t.radius !== void 0) root.style.setProperty("--hm-radius", `${t.radius}px`);
    if (t.fonts) {
      root.style.setProperty("--hm-font-ui", t.fonts.ui);
      root.style.setProperty("--hm-font-mono", t.fonts.mono);
    }
    if (t.surface) root.style.setProperty("--hm-surface", t.surface);
    if (t.terminalBackground) root.style.setProperty("--hm-terminal-bg", t.terminalBackground);
    if (t.glass !== void 0) root.style.setProperty("--hm-glass", t.glass ? "1" : "0");
    if (t.mode) {
      root.style.setProperty("--hm-mode", t.mode);
      root.dataset.hmMode = t.mode;
    }
  };
  apply(client.hello.theme);
  return client.on("theme", apply);
}

// src/main.ts
var STATUS_COLOR = { unknown: "#6b7280", idle: "#60a5fa", working: "#4ade80", blocked: "#fbbf24", exited: "#f87171" };
var DOCK_FRACTION = 0.5;
var TW = 64;
var TH = 32;
var canvas = document.getElementById("c");
var label = document.getElementById("label");
var hint = document.getElementById("hint");
var ctx = canvas.getContext("2d");
var hm = await connect();
var theme = hm.hello.theme.colors;
var paintChrome = () => {
  label.style.background = theme.bg2 ?? "#222";
  label.style.color = theme.fg ?? "#eee";
  hint.style.color = theme.fg2 ?? "#ddd";
};
paintChrome();
applyThemeVars(hm);
hm.on("theme", (t) => {
  theme = t.colors;
  paintChrome();
  invalidate();
});
var frames = [];
var tiles = [];
var names = /* @__PURE__ */ new Map();
var status = /* @__PURE__ */ new Map();
var unsubscribe = /* @__PURE__ */ new Map();
var rooms = [];
var desks = [];
var hover = null;
var docked = null;
var saved = hm.hello.layout ?? {};
var zoom = saved.z ?? 1;
var ox = saved.ox ?? NaN;
var oy = saved.oy ?? NaN;
var { invalidate } = createInvalidator(hm, draw);
function layout() {
  const loose = tiles.filter((t) => !t.frameId || !frames.some((f) => f.id === t.frameId));
  const list = [...frames];
  if (loose.length || list.length === 0) list.push(null);
  rooms = [];
  desks = [];
  const cols = Math.max(1, Math.round(Math.sqrt(list.length)));
  let cx = 0, cy = 0, rowH = 0, col = 0;
  for (const f of list) {
    const mine = f ? tiles.filter((t) => t.frameId === f.id) : loose;
    const perRow = Math.min(3, Math.max(1, mine.length));
    const nRows = Math.max(1, Math.ceil(mine.length / 3));
    const w = perRow * 2 + 1, h = nRows * 2 + 2;
    const room = { frame: f, x: cx, y: cy, w, h, color: f?.color ?? (theme.fg2 ?? "#9ca3af"), title: f ? f.title : "Lobby" };
    rooms.push(room);
    mine.forEach((t, i) => desks.push({ tile: t, room, x: cx + 1 + i % 3 * 2, y: cy + 2 + Math.floor(i / 3) * 2, pulse: 0 }));
    rowH = Math.max(rowH, h);
    col++;
    cx += w + 2;
    if (col >= cols) {
      col = 0;
      cx = 0;
      cy += rowH + 2;
      rowH = 0;
    }
  }
  if (Number.isNaN(ox)) centre();
}
function centre() {
  const maxX = Math.max(1, ...rooms.map((r) => r.x + r.w)), maxY = Math.max(1, ...rooms.map((r) => r.y + r.h));
  const W = sceneWidth(), H = hm.viewport.h;
  zoom = Math.min(2.5, Math.max(0.5, Math.min(W / ((maxX + maxY) * TW / 2 + 80), H / ((maxX + maxY) * TH / 2 + 160))));
  const c = iso(maxX / 2, maxY / 2, 0, 0);
  ox = W / 2 - c.x;
  oy = H / 2 - c.y + 20;
}
function iso(x, y, px = ox, py = oy) {
  return { x: (x - y) * (TW / 2) * zoom + px, y: (x + y) * (TH / 2) * zoom + py };
}
function sceneWidth() {
  return docked ? Math.round(hm.viewport.w * (1 - DOCK_FRACTION)) : hm.viewport.w;
}
function diamond(x, y, fill, stroke) {
  const a = iso(x, y), b = iso(x + 1, y), c = iso(x + 1, y + 1), d = iso(x, y + 1);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.lineTo(c.x, c.y);
  ctx.lineTo(d.x, d.y);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}
function box(x, y, w, h, hz, top, left, right) {
  const z = hz * zoom;
  const a = iso(x, y), b = iso(x + w, y), c = iso(x + w, y + h), d = iso(x, y + h);
  ctx.fillStyle = left;
  ctx.beginPath();
  ctx.moveTo(d.x, d.y);
  ctx.lineTo(c.x, c.y);
  ctx.lineTo(c.x, c.y - z);
  ctx.lineTo(d.x, d.y - z);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = right;
  ctx.beginPath();
  ctx.moveTo(c.x, c.y);
  ctx.lineTo(b.x, b.y);
  ctx.lineTo(b.x, b.y - z);
  ctx.lineTo(c.x, c.y - z);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = top;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y - z);
  ctx.lineTo(b.x, b.y - z);
  ctx.lineTo(c.x, c.y - z);
  ctx.lineTo(d.x, d.y - z);
  ctx.closePath();
  ctx.fill();
}
function shade(hex, k) {
  const n = parseInt(hex.replace("#", ""), 16);
  if (Number.isNaN(n)) return hex;
  const f = (v) => Math.max(0, Math.min(255, Math.round(v * k)));
  return `rgb(${f(n >> 16 & 255)},${f(n >> 8 & 255)},${f(n & 255)})`;
}
function drawRoom(r) {
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
    const even = (x + y) % 2 === 0;
    diamond(x, y, even ? "#2a2f45" : "#262b3f", "#1c2033");
  }
  const wallH = 46;
  const c1 = shade(r.color, 0.55), c2 = shade(r.color, 0.75);
  const z = wallH * zoom;
  const tl = iso(r.x, r.y), tr = iso(r.x + r.w, r.y), bl = iso(r.x, r.y + r.h);
  ctx.fillStyle = c2;
  ctx.beginPath();
  ctx.moveTo(tl.x, tl.y);
  ctx.lineTo(tr.x, tr.y);
  ctx.lineTo(tr.x, tr.y - z);
  ctx.lineTo(tl.x, tl.y - z);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = c1;
  ctx.beginPath();
  ctx.moveTo(tl.x, tl.y);
  ctx.lineTo(bl.x, bl.y);
  ctx.lineTo(bl.x, bl.y - z);
  ctx.lineTo(tl.x, tl.y - z);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,.12)";
  const m1 = iso(r.x + 0.3, r.y), m2 = iso(r.x + r.w - 0.3, r.y);
  ctx.beginPath();
  ctx.moveTo(m1.x, m1.y - z * 0.55);
  ctx.lineTo(m2.x, m2.y - z * 0.55);
  ctx.lineTo(m2.x, m2.y - z * 0.8);
  ctx.lineTo(m1.x, m1.y - z * 0.8);
  ctx.closePath();
  ctx.fill();
  const top = iso(r.x + r.w / 2, r.y);
  ctx.font = `600 ${Math.round(13 * Math.max(0.8, zoom))}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillStyle = theme.fg ?? "#f5f5f5";
  ctx.shadowColor = "rgba(0,0,0,.8)";
  ctx.shadowBlur = 6;
  ctx.fillText(r.title, top.x, top.y - z - 6);
  ctx.shadowBlur = 0;
}
function drawDesk(d) {
  const s = STATUS_COLOR[status.get(d.tile.id) ?? "unknown"];
  const hot = d.tile.id === docked || d.tile.id === hover;
  const { x, y } = d;
  box(x, y, 1.5, 0.8, 14, "#8b5a2b", "#6b4320", "#7a4c24");
  box(x + 0.35, y + 0.05, 0.8, 0.08, 22 + 14, "#1f2937", "#111827", "#1f2937");
  const sc = iso(x + 0.75, y + 0.1);
  const glow = 10 + d.pulse * 18 + (hot ? 8 : 0);
  ctx.save();
  ctx.shadowColor = s;
  ctx.shadowBlur = glow * zoom;
  ctx.fillStyle = s;
  const sw = 0.62 * TW / 2 * zoom, sh = 13 * zoom;
  ctx.beginPath();
  ctx.moveTo(sc.x - sw / 2, sc.y - 30 * zoom + sh);
  ctx.lineTo(sc.x + sw / 2, sc.y - 30 * zoom + sh - sw / 2 * 0.5);
  ctx.lineTo(sc.x + sw / 2, sc.y - 30 * zoom - sw / 2 * 0.5);
  ctx.lineTo(sc.x - sw / 2, sc.y - 30 * zoom);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  const w = iso(x + 0.75, y + 1.15);
  ctx.fillStyle = "#374151";
  ctx.beginPath();
  ctx.ellipse(w.x, w.y, 9 * zoom, 5 * zoom, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = hot ? theme.brand ?? "#e5e7eb" : "#cbd5e1";
  ctx.fillRect(w.x - 5 * zoom, w.y - 16 * zoom, 10 * zoom, 12 * zoom);
  ctx.fillStyle = "#f5d0a9";
  ctx.beginPath();
  ctx.arc(w.x, w.y - 20 * zoom, 5 * zoom, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = s;
  ctx.beginPath();
  ctx.arc(w.x, w.y - 30 * zoom, 3 * zoom, 0, Math.PI * 2);
  ctx.fill();
  if (hot) {
    ctx.strokeStyle = theme.brand ?? "#fff";
    ctx.lineWidth = 2;
    diamond(x, y, "rgba(0,0,0,0)", theme.brand ?? "#fff");
    ctx.lineWidth = 1;
  }
}
function draw() {
  const dpr = window.devicePixelRatio || 1;
  const W = sceneWidth(), H = hm.viewport.h;
  if (W < 1 || H < 1) return;
  if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
    canvas.width = W * dpr;
    canvas.height = H * dpr;
  }
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#0f1220");
  g.addColorStop(1, "#171a2e");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  for (const r of [...rooms].sort((a, b) => a.x + a.y - (b.x + b.y))) drawRoom(r);
  for (const d of [...desks].sort((a, b) => a.x + a.y - (b.x + b.y))) drawDesk(d);
  if (docked) {
    ctx.fillStyle = theme.line ?? "#333";
    ctx.fillRect(W - 1, 0, 1, H);
  }
}
function world(sx, sy) {
  const a = (sx - ox) / (TW / 2 * zoom), b = (sy - oy) / (TH / 2 * zoom);
  return { x: (a + b) / 2, y: (b - a) / 2 };
}
function pick(sx, sy) {
  if (sx > sceneWidth()) return null;
  const p = world(sx, sy + 12 * zoom);
  for (const d of desks) if (p.x >= d.x - 0.2 && p.x <= d.x + 1.7 && p.y >= d.y - 0.6 && p.y <= d.y + 1.4) return { desk: d };
  const q = world(sx, sy);
  for (const r of rooms) if (q.x >= r.x && q.x < r.x + r.w && q.y >= r.y && q.y < r.y + r.h) return { room: r };
  return null;
}
function dock(tileId) {
  docked = tileId;
  hm.commands.selectTile(tileId);
  hm.setSurfaceRects(tileId ? [{ tileId, x: sceneWidth(), y: 0, w: hm.viewport.w - sceneWidth(), h: hm.viewport.h }] : []);
  hint.textContent = tileId ? "Esc undocks \xB7 drag pans \xB7 wheel zooms" : "Click a desk to open its agent \xB7 click a room floor to select the frame";
  invalidate();
}
function pulse(tileId) {
  const d = desks.find((x) => x.tile.id === tileId);
  if (!d) return;
  let i = 0;
  const step = () => {
    i++;
    d.pulse = Math.sin(i / 14 * Math.PI);
    invalidate();
    if (i < 14) requestAnimationFrame(step);
    else {
      d.pulse = 0;
      invalidate();
    }
  };
  step();
}
function persist() {
  hm.setLayout({ ox, oy, z: zoom });
}
hm.on("structure", (m) => {
  frames = m.frames;
  tiles = m.tiles;
  for (const t of tiles) {
    names.set(t.id, t.name);
    if (!unsubscribe.has(t.id)) unsubscribe.set(t.id, hm.subscribeStatus(t.id, (s) => {
      const prev = status.get(t.id);
      status.set(t.id, s);
      if (prev && prev !== s) pulse(t.id);
      invalidate();
    }));
  }
  for (const [id, off] of unsubscribe) if (!tiles.some((t) => t.id === id)) {
    off();
    unsubscribe.delete(id);
    status.delete(id);
  }
  if (docked && !tiles.some((t) => t.id === docked)) dock(null);
  layout();
  invalidate();
});
hm.on("names", (m) => {
  for (const [id, n] of Object.entries(m.names)) names.set(id, n);
  if (hover) showLabel();
});
hm.on("selection", (m) => {
  if (m.fresh && m.tileId && m.tileId !== docked) dock(m.tileId);
});
hm.on("undock", (m) => {
  if (docked === m.tileId) dock(null);
});
hm.on("resize", () => {
  if (docked) dock(docked);
  else invalidate();
});
hm.on("visibility", ({ visible }) => {
  if (visible) invalidate();
});
hm.onReveal((tileId) => {
  const d = desks.find((x) => x.tile.id === tileId);
  if (!d) return null;
  const p = iso(d.x + 0.75, d.y + 0.5);
  return { x: p.x - 30 * zoom, y: p.y - 40 * zoom, w: 60 * zoom, h: 50 * zoom };
});
var lastPt = { x: 0, y: 0 };
var drag = null;
function showLabel() {
  if (!hover) {
    label.style.display = "none";
    return;
  }
  label.textContent = names.get(hover) ?? hover;
  label.style.left = `${lastPt.x + 14}px`;
  label.style.top = `${lastPt.y + 14}px`;
  label.style.display = "block";
}
canvas.addEventListener("pointerdown", (e) => {
  drag = { x: e.clientX, y: e.clientY, ox, oy, moved: false };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointermove", (e) => {
  lastPt = { x: e.clientX, y: e.clientY };
  if (drag) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.hypot(dx, dy) > 4) drag.moved = true;
    if (drag.moved) {
      ox = drag.ox + dx;
      oy = drag.oy + dy;
      invalidate();
    }
    return;
  }
  const id = pick(e.clientX, e.clientY)?.desk?.tile.id ?? null;
  if (id !== hover) {
    hover = id;
    canvas.style.cursor = id ? "pointer" : "grab";
    invalidate();
  }
  showLabel();
});
canvas.addEventListener("pointerup", (e) => {
  const wasDrag = drag?.moved ?? false;
  drag = null;
  if (wasDrag) {
    persist();
    return;
  }
  if (e.button !== 0) return;
  const hit = pick(e.clientX, e.clientY);
  if (hit?.desk) dock(hit.desk.tile.id);
  else if (hit?.room) hm.commands.selectFrame(hit.room.frame?.id ?? null);
  else if (docked) dock(null);
});
canvas.addEventListener("pointerleave", () => {
  hover = null;
  showLabel();
  invalidate();
});
canvas.addEventListener("wheel", (e) => {
  const k = e.deltaY > 0 ? 0.9 : 1.1;
  const nz = Math.min(2.5, Math.max(0.5, zoom * k));
  const f = nz / zoom;
  ox = e.clientX - (e.clientX - ox) * f;
  oy = e.clientY - (e.clientY - oy) * f;
  zoom = nz;
  persist();
  invalidate();
}, { passive: true });
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && docked) dock(null);
});
layout();
dock(null);
