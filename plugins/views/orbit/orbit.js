// ../../packages/hive-view-sdk/src/protocol.ts
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

// ../../packages/hive-view-sdk/src/client.ts
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

// ../../examples/views/orbit/src/main.ts
var STATUS_COLOR = { unknown: "#6b7280", idle: "#3b82f6", working: "#22c55e", blocked: "#f59e0b", exited: "#ef4444" };
var DOCK_FRACTION = 0.5;
var canvas = document.getElementById("c");
var label = document.getElementById("label");
var ctx = canvas.getContext("2d");
var hm = await connect();
var frames = [];
var tiles = [];
var names = /* @__PURE__ */ new Map();
var status = /* @__PURE__ */ new Map();
var unsubscribe = /* @__PURE__ */ new Map();
var bodies = [];
var hover = null;
var docked = null;
var spread = hm.hello.layout?.spread ?? 1;
var theme = hm.hello.theme.colors;
var paintChrome = () => {
  label.style.background = theme.bg2 ?? "#222";
  label.style.color = theme.fg ?? "#eee";
};
paintChrome();
applyThemeVars(hm);
hm.on("theme", (t) => {
  theme = t.colors;
  paintChrome();
  invalidate();
});
var { invalidate } = createInvalidator(hm, draw);
function sceneWidth() {
  return docked ? hm.viewport.w * (1 - DOCK_FRACTION) : hm.viewport.w;
}
function layout() {
  const W = sceneWidth(), H = hm.viewport.h;
  const suns = /* @__PURE__ */ new Map();
  const ringR = Math.min(W, H) * 0.3 * spread;
  frames.forEach((f, i) => {
    const a = i / Math.max(1, frames.length) * Math.PI * 2 - Math.PI / 2;
    suns.set(f.id, { x: W / 2 + Math.cos(a) * (frames.length > 1 ? ringR : 0), y: H / 2 + Math.sin(a) * (frames.length > 1 ? ringR : 0) });
  });
  suns.set(null, { x: W / 2, y: H / 2 });
  const byFrame = /* @__PURE__ */ new Map();
  for (const t of tiles) {
    const k = t.frameId && suns.has(t.frameId) ? t.frameId : null;
    byFrame.set(k, [...byFrame.get(k) ?? [], t]);
  }
  bodies = [];
  for (const [fid, list] of byFrame) {
    const s = suns.get(fid);
    const orbit = (fid === null ? Math.min(W, H) * 0.42 : Math.min(W, H) * 0.12) * spread;
    list.forEach((t, i) => {
      const a = i / list.length * Math.PI * 2;
      bodies.push({ tile: t, x: s.x + Math.cos(a) * orbit, y: s.y + Math.sin(a) * orbit, r: 14 });
    });
  }
  return suns;
}
function draw() {
  const dpr = window.devicePixelRatio || 1;
  const W = hm.viewport.w, H = hm.viewport.h;
  if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
    canvas.width = W * dpr;
    canvas.height = H * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const suns = layout();
  ctx.font = "12px system-ui, sans-serif";
  ctx.textAlign = "center";
  for (const f of frames) {
    const s = suns.get(f.id);
    const orbit = Math.min(sceneWidth(), H) * 0.12 * spread;
    ctx.beginPath();
    ctx.arc(s.x, s.y, orbit, 0, Math.PI * 2);
    ctx.strokeStyle = theme.line ?? "#333";
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(s.x, s.y, 22, 0, Math.PI * 2);
    ctx.fillStyle = f.color;
    ctx.fill();
    ctx.fillStyle = theme.fg2 ?? "#ccc";
    ctx.fillText(f.title, s.x, s.y + 38);
  }
  for (const b of bodies) {
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    ctx.fillStyle = STATUS_COLOR[status.get(b.tile.id) ?? "unknown"];
    ctx.fill();
    if (b.tile.id === docked || b.tile.id === hover) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = theme.brand ?? "#fff";
      ctx.stroke();
      ctx.lineWidth = 1;
    }
  }
  if (docked) {
    const x = sceneWidth();
    ctx.fillStyle = theme.line ?? "#333";
    ctx.fillRect(x, 0, 1, H);
  }
}
function at(x, y) {
  for (const b of bodies) if ((b.x - x) ** 2 + (b.y - y) ** 2 <= (b.r + 2) ** 2) return b;
  return null;
}
function dock(tileId) {
  docked = tileId;
  hm.commands.selectTile(tileId);
  hm.setSurfaceRects(tileId ? [{ tileId, x: sceneWidth(), y: 0, w: hm.viewport.w - sceneWidth(), h: hm.viewport.h }] : []);
  invalidate();
}
hm.on("structure", (m) => {
  frames = m.frames;
  tiles = m.tiles;
  for (const t of tiles) {
    names.set(t.id, t.name);
    if (!unsubscribe.has(t.id)) unsubscribe.set(t.id, hm.subscribeStatus(t.id, (s) => {
      status.set(t.id, s);
      invalidate();
    }));
  }
  for (const [id, off] of unsubscribe) if (!tiles.some((t) => t.id === id)) {
    off();
    unsubscribe.delete(id);
    status.delete(id);
  }
  if (docked && !tiles.some((t) => t.id === docked)) dock(null);
  invalidate();
});
hm.on("names", (m) => {
  for (const [id, n] of Object.entries(m.names)) names.set(id, n);
  if (hover) showLabel();
});
hm.on("selection", (m) => {
  if (m.fresh && m.tileId && m.tileId !== docked) dock(m.tileId);
});
hm.on("resize", () => {
  if (docked) dock(docked);
  else invalidate();
});
hm.on("undock", () => {
  docked = null;
  hm.commands.selectTile(null);
  invalidate();
});
hm.onReveal((tileId) => {
  layout();
  const b = bodies.find((x) => x.tile.id === tileId);
  return b ? { x: b.x - b.r, y: b.y - b.r, w: b.r * 2, h: b.r * 2 } : null;
});
var lastPt = { x: 0, y: 0 };
function showLabel() {
  if (!hover) {
    label.style.display = "none";
    return;
  }
  label.textContent = names.get(hover) ?? hover;
  label.style.left = `${lastPt.x + 12}px`;
  label.style.top = `${lastPt.y + 12}px`;
  label.style.display = "block";
}
canvas.addEventListener("pointermove", (e) => {
  lastPt = { x: e.clientX, y: e.clientY };
  const id = at(e.clientX, e.clientY)?.tile.id ?? null;
  if (id !== hover) {
    hover = id;
    invalidate();
  }
  showLabel();
});
canvas.addEventListener("pointerleave", () => {
  hover = null;
  showLabel();
  invalidate();
});
canvas.addEventListener("click", (e) => {
  const b = at(e.clientX, e.clientY);
  if (b) dock(b.tile.id);
  else if (docked) dock(null);
});
canvas.addEventListener("wheel", (e) => {
  spread = Math.min(2, Math.max(0.5, spread * (e.deltaY > 0 ? 0.92 : 1.08)));
  hm.setLayout({ spread });
  if (docked) dock(docked);
  else invalidate();
}, { passive: true });
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && docked) dock(null);
});
invalidate();
