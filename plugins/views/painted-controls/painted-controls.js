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

// ../../examples/views/painted-controls/src/main.ts
var canvas = document.querySelector("#scene");
var context = canvas.getContext("2d");
var controls = document.querySelector("#controls");
var status = document.querySelector("#status");
var hm = await connect();
applyThemeVars(hm);
var theme = hm.hello.theme.colors;
var frames = [];
var tiles = [];
var selected = null;
var docked = null;
var { invalidate } = createInvalidator(hm, draw);
function step(direction) {
  if (!frames.length) return;
  const index = frames.findIndex((frame) => frame.id === selected);
  const target = frames[index < 0 ? direction > 0 ? 0 : frames.length - 1 : (index + direction + frames.length) % frames.length].id;
  undock();
  hm.commands.selectFrame(target);
  invalidate();
}
function firstTool() {
  return tiles.find((tile) => tile.frameId === selected);
}
function undock() {
  docked = null;
  hm.setSurfaceRects([]);
  invalidate();
}
function openTool() {
  const tile = firstTool();
  if (!tile) return;
  docked = tile.id;
  hm.commands.selectTile(tile.id);
  invalidate();
}
var actions = [
  { label: "Previous workspace", run: () => step(-1), disabled: () => !frames.length },
  { label: "Next workspace", run: () => step(1), disabled: () => !frames.length },
  { label: "Open first tool", run: openTool, disabled: () => !firstTool() },
  { label: "Undock tool", run: undock, disabled: () => !docked }
].map((action) => {
  const button = document.createElement("button");
  button.type = "button";
  button.disabled = true;
  button.textContent = action.label;
  button.setAttribute("aria-label", action.label);
  button.addEventListener("click", action.run);
  controls.append(button);
  return { ...action, button };
});
function draw() {
  const { w, h } = hm.viewport;
  const dpr = Math.min(devicePixelRatio, 2);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, w, h);
  const style = getComputedStyle(document.body);
  context.fillStyle = theme.bg ?? style.backgroundColor;
  context.fillRect(0, 0, w, h);
  context.font = "14px system-ui";
  context.textAlign = "center";
  context.textBaseline = "middle";
  const width = Math.max(1, Math.min(220, (w - 60) / 2));
  actions.forEach((action, i) => {
    const x = 24 + i % 2 * (width + 12), y = 48 + Math.floor(i / 2) * 64;
    Object.assign(action.button.style, { left: `${x}px`, top: `${y}px`, width: `${width}px`, height: "48px" });
    action.button.disabled = action.disabled();
    context.globalAlpha = action.button.disabled ? 0.45 : 1;
    context.beginPath();
    context.roundRect(x, y, width, 48, 16);
    context.fillStyle = theme.bg3 ?? style.backgroundColor;
    context.fill();
    context.fillStyle = theme.fg ?? style.color;
    context.fillText(action.label, x + width / 2, y + 24, width - 16);
  });
  context.globalAlpha = 1;
  status.textContent = frames.find((frame) => frame.id === selected)?.title ?? "Unassigned tools";
  hm.setSurfaceRects(docked && w > 64 && h > 260 ? [{ tileId: docked, x: 24, y: 184, w: w - 48, h: h - 208 }] : []);
}
hm.on("structure", (message) => {
  frames = message.frames;
  tiles = message.tiles;
  if (selected && !frames.some((frame) => frame.id === selected)) selected = null;
  if (docked && !tiles.some((tile) => tile.id === docked)) undock();
  invalidate();
});
hm.on("selection", (message) => {
  selected = message.frameId ?? tiles.find((tile) => tile.id === message.tileId)?.frameId ?? null;
  invalidate();
});
hm.on("names", (message) => {
  frames = frames.map((frame) => ({ ...frame, title: message.names[frame.id] ?? frame.title }));
  invalidate();
});
hm.on("theme", (next) => {
  theme = next.colors;
  invalidate();
});
hm.on("resize", invalidate);
hm.on("undock", undock);
hm.onReveal((id) => docked === id ? { x: 24, y: 184, w: hm.viewport.w - 48, h: Math.max(0, hm.viewport.h - 208) } : null);
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") undock();
});
invalidate();
