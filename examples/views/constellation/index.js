// The workspace as a constellation in 3D: each frame a star, its agents lights on orbits around it,
// coloured by what they are doing, with a line from each agent to the ones it started. Drag to
// turn it, scroll to come closer, click an agent to dock its live terminal beside it. Drawn with
// three.js, which ships in this folder; the app gives the view nothing but the SDK.
import { applyThemeVars, connect } from "@hivemind/view-sdk";
import * as THREE from "./three-0.186.0.min.js";
import { TONE, census, layout, lightOf, orbitPoint } from "./lib.js";

const hm = await connect();
applyThemeVars(hm);

const css = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
const style = document.createElement("style");
style.textContent = `
  html, body { margin: 0; height: 100%; overflow: hidden; background: transparent; color: var(--hm-color-fg); font: 13px var(--hm-font-ui, system-ui); }
  canvas { position: fixed; inset: 0; display: block; cursor: grab; }
  canvas:active { cursor: grabbing; }
  .head { position: fixed; left: 20px; top: 16px; pointer-events: none; }
  .head h1 { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
  .head p { margin: 2px 0 0; color: var(--hm-color-fg3); font-size: 12px; font-variant-numeric: tabular-nums; }
  .legend { position: fixed; left: 20px; bottom: 64px; display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; color: var(--hm-color-fg2); pointer-events: none; }
  .legend i { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 8px; box-shadow: 0 0 8px currentColor; }
  .label { position: fixed; transform: translate(-50%, 0); white-space: nowrap; pointer-events: none; font-size: 11px; color: var(--hm-color-fg2); text-shadow: 0 1px 3px rgba(0,0,0,.8); }
  .label.frame { font-size: 12.5px; font-weight: 600; color: var(--hm-color-fg); }
  .label.frame small { display: block; font-weight: 400; font-size: 10.5px; color: var(--hm-color-fg3); text-align: center; }
  .label.waiting { color: var(--hm-status-attention); font-weight: 600; }
  .dock { position: fixed; top: 52px; right: 16px; bottom: 16px; width: min(46vw, 640px); border-radius: 12px; border: 1px solid var(--hm-color-line); background: color-mix(in srgb, var(--hm-color-bg) 70%, transparent); display: none; }
  .dock[data-open] { display: block; }
  .tip { position: fixed; padding: 4px 8px; border-radius: 6px; background: var(--hm-color-bg3); font-size: 11.5px; pointer-events: none; display: none; }
`;
document.head.append(style);
document.body.innerHTML = `<div class="head"><h1>Constellation</h1><p class="sum"></p></div><div class="legend"></div><div class="dock"></div><div class="tip"></div>`;
const $ = (s) => document.querySelector(s);

// ── the scene ────────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
renderer.setClearColor(0x000000, 0);
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 400);

function glowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.18, "rgba(255,255,255,.75)");
  grad.addColorStop(0.45, "rgba(255,255,255,.18)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}
const GLOW = glowTexture();
const glow = (color, size) => {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  s.scale.setScalar(size);
  return s;
};

// Far stars, so turning it reads as turning.
{
  const pts = [];
  for (let i = 0; i < 900; i++) {
    const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, r = 120 + Math.random() * 120;
    pts.push(Math.sqrt(1 - u * u) * Math.cos(a) * r, u * r, Math.sqrt(1 - u * u) * Math.sin(a) * r);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({ size: 0.6, color: 0xffffff, transparent: true, opacity: 0.45, depthWrite: false })));
}

let colors = {};
function readColors() {
  colors = {
    working: css("--hm-status-working", "#4ade80"), attention: css("--hm-status-attention", "#f59e0b"),
    idle: css("--hm-status-idle", "#94a3b8"), exited: css("--hm-status-exited", "#64748b"), failed: css("--hm-status-failed", "#ef4444"),
    line: css("--hm-color-fg3", "#888888"),
  };
  $(".legend").innerHTML = [["working", "working"], ["attention", "waiting on you"], ["idle", "idle"], ["failed", "stopped on an error"]]
    .map(([t, l]) => `<span><i style="color:${colors[t]};background:${colors[t]}"></i>${l}</span>`).join("");
}
readColors();

// ── the workspace ────────────────────────────────────────────────────────────
let frames = [], tiles = [], links = { pipes: [], spawns: [] };
const names = new Map();
const lights = new Map();
const watching = new Map();
let world = null;
let docked = null;
const LIGHT_SIZE = { working: 0.42, waiting: 0.55, idle: 0.32, exited: 0.22, failed: 0.42 };

function build() {
  if (world) { scene.remove(world.root); world.labels.forEach((l) => l.el.remove()); }
  const { frames: place, orbits } = layout(frames, tiles);
  const root = new THREE.Group();
  const labels = [];
  const hubs = new Map();
  for (const f of frames) {
    const p = place.get(f.id);
    if (!p) continue;
    const hub = new THREE.Group();
    hub.position.set(p.x, p.y, p.z);
    const color = new THREE.Color(f.color || "#8888ff");
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.55 * p.size, 1), new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.9 }));
    hub.add(core, glow(color, 4.5 * p.size));
    root.add(hub);
    hubs.set(f.id, { hub, core, p });
    const el = document.createElement("div");
    el.className = "label frame";
    el.innerHTML = `<span></span><small></small>`;
    el.firstChild.textContent = f.title;
    el.lastChild.textContent = [f.branch, f.machine && f.machine.name].filter(Boolean).join(" · ");
    document.body.append(el);
    labels.push({ el, at: () => hub.position, lift: 1.4 * p.size });
    if (f.parentId && place.get(f.parentId)) {
      const q = place.get(f.parentId);
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(q.x, q.y, q.z), new THREE.Vector3(p.x, p.y, p.z)]);
      root.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.35 })));
    }
  }
  const bodies = new Map();
  for (const t of tiles) {
    const o = orbits.get(t.id);
    const hub = hubs.get(o && o.frameId);
    if (!o || !hub) continue;
    const g = new THREE.Group();
    const light = lights.get(t.id) ?? "idle";
    const color = new THREE.Color(o.agent ? colors[TONE[light]] : colors.line);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(o.agent ? 0.2 : 0.09, 20, 14), new THREE.MeshBasicMaterial({ color }));
    ball.userData.tileId = t.id;
    g.add(ball);
    const halo = o.agent ? glow(color, 1.6) : null;
    if (halo) g.add(halo);
    root.add(g);
    // The orbit itself, faint.
    const ring = [];
    for (let k = 0; k <= 64; k++) {
      const pt = orbitPoint({ ...o, phase: (k / 64) * Math.PI * 2, speed: 0 }, { x: 0, y: 0, z: 0 }, 0);
      ring.push(new THREE.Vector3(pt.x, pt.y, pt.z));
    }
    const orbitLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(ring), new THREE.LineBasicMaterial({ color: colors.line, transparent: true, opacity: o.agent ? 0.14 : 0.07 }));
    hub.hub.add(orbitLine);
    bodies.set(t.id, { g, ball, halo, o, hub, agent: !!t.agent });
    if (t.agent) {
      const el = document.createElement("div");
      el.className = "label";
      document.body.append(el);
      labels.push({ el, at: () => g.position, lift: 0.45, tileId: t.id });
    }
  }
  // Which agent started which, and which feeds which: curves between them, redrawn each frame.
  const ties = [...links.spawns.map((s) => [s.parent, s.child]), ...links.pipes.map((p) => [p.src, p.dst])]
    .filter(([a, b]) => bodies.has(a) && bodies.has(b))
    .map(([a, b]) => {
      const line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: colors.attention, transparent: true, opacity: 0.55 }));
      root.add(line);
      return { a, b, line };
    });
  scene.add(root);
  world = { root, hubs, bodies, labels, ties };
  paintLights();
}

function paintLights() {
  if (!world) return;
  for (const [id, b] of world.bodies) {
    if (!b.agent) continue;
    const l = lights.get(id) ?? "idle";
    const c = new THREE.Color(colors[TONE[l]]);
    b.ball.material.color = c;
    b.halo.material.color = c;
    b.ball.scale.setScalar(LIGHT_SIZE[l] / 0.32);
  }
  for (const lab of world.labels) {
    if (!lab.tileId) continue;
    const l = lights.get(lab.tileId) ?? "idle";
    lab.el.textContent = `${names.get(lab.tileId) ?? tiles.find((t) => t.id === lab.tileId)?.name ?? "agent"}${l === "waiting" ? " · waiting on you" : ""}`;
    lab.el.classList.toggle("waiting", l === "waiting");
  }
  const agents = tiles.filter((t) => t.agent);
  const c = census(agents.map((t) => lights.get(t.id) ?? "idle"));
  $(".sum").textContent = `${frames.length} frames · ${agents.length} agents · ${c.working} working · ${c.waiting} waiting on you`;
}

// ── the camera: drag to turn, scroll to come closer ──────────────────────────
const saved = hm.hello.layout && typeof hm.hello.layout === "object" ? hm.hello.layout : {};
const cam = { yaw: saved.yaw ?? 0.6, pitch: saved.pitch ?? 0.42, dist: saved.dist ?? 30, auto: true };
let drag = null;
renderer.domElement.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, moved: false }; renderer.domElement.setPointerCapture(e.pointerId); });
renderer.domElement.addEventListener("pointermove", (e) => {
  if (!drag) { hover(e); return; }
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
  cam.yaw -= dx * 0.005; cam.pitch = Math.min(1.35, Math.max(-0.2, cam.pitch + dy * 0.004));
  drag.x = e.clientX; drag.y = e.clientY; cam.auto = false;
  wake();
});
renderer.domElement.addEventListener("pointerup", (e) => {
  const was = drag;
  drag = null;
  if (was && !was.moved) pick(e);
  else hm.setLayout({ yaw: cam.yaw, pitch: cam.pitch, dist: cam.dist });
});
renderer.domElement.addEventListener("wheel", (e) => { cam.dist = Math.min(90, Math.max(8, cam.dist * (1 + e.deltaY * 0.001))); hm.setLayout({ yaw: cam.yaw, pitch: cam.pitch, dist: cam.dist }); wake(); }, { passive: true });

const ray = new THREE.Raycaster();
function hit(e) {
  if (!world) return null;
  const v = new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(v, camera);
  ray.params.Points = { threshold: 0 };
  const found = ray.intersectObjects([...world.bodies.values()].map((b) => b.ball), false)[0];
  return found ? found.object.userData.tileId : null;
}
function hover(e) {
  const id = hit(e);
  const tip = $(".tip");
  if (!id) { tip.style.display = "none"; renderer.domElement.style.cursor = ""; return; }
  const t = tiles.find((x) => x.id === id);
  tip.textContent = `${names.get(id) ?? t?.name ?? id}${t?.agent ? ` · ${t.agent} · ${lights.get(id) ?? "idle"}` : ` · ${t?.kind ?? ""}`}`;
  tip.style.display = "block";
  tip.style.left = `${e.clientX + 12}px`; tip.style.top = `${e.clientY + 12}px`;
  renderer.domElement.style.cursor = "pointer";
}
function pick(e) {
  const id = hit(e);
  dock(id && tiles.find((t) => t.id === id)?.agent ? id : null);
}

// ── a live terminal beside the stars ────────────────────────────────────────
function dockRect() {
  const el = $(".dock");
  const b = el.getBoundingClientRect();
  return { tileId: docked, x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height), chrome: "bar", radius: 12 };
}
function dock(id) {
  docked = id;
  $(".dock").toggleAttribute("data-open", !!id);
  if (id) hm.commands.selectTile(id);
  hm.setSurfaceRects(id && hm.supports("surfaces") ? [dockRect()] : []);
  wake();
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && docked) dock(null); });
hm.on("undock", ({ tileId }) => { if (tileId === docked) { docked = null; $(".dock").removeAttribute("data-open"); } });
hm.onReveal((tileId) => {
  if (!tiles.some((t) => t.id === tileId && t.agent)) return null;
  dock(tileId);
  const r = dockRect();
  return { x: r.x, y: r.y, w: r.w, h: r.h };
});

// ── drawing: at the frame rate set, and not at all while hidden ─────────────
const clock = new THREE.Clock();
let last = 0, frameCount = 0, lastReport = 0, running = false;
const P = new THREE.Vector3();
function frame(now) {
  running = false;
  if (document.hidden || !hm.visible) return;
  const fps = Number(hm.settings?.frameRate ?? 30);
  if (now - last < 1000 / fps - 2) { wake(); return; }
  last = now;
  const t = clock.getElapsedTime();
  const w = innerWidth, h = innerHeight;
  if (renderer.domElement.width !== Math.round(w * renderer.getPixelRatio())) { renderer.setSize(w, h, false); renderer.domElement.style.width = `${w}px`; renderer.domElement.style.height = `${h}px`; camera.aspect = w / h; camera.updateProjectionMatrix(); }
  if (cam.auto && hm.settings?.turn !== false) cam.yaw += 0.0016 * (60 / fps);
  camera.position.set(Math.cos(cam.yaw) * Math.cos(cam.pitch) * cam.dist, Math.sin(cam.pitch) * cam.dist, Math.sin(cam.yaw) * Math.cos(cam.pitch) * cam.dist);
  camera.lookAt(docked ? -cam.dist * 0.18 * Math.sin(cam.yaw) : 0, 0, docked ? cam.dist * 0.18 * Math.cos(cam.yaw) : 0);
  if (world) {
    for (const { hub, core } of world.hubs.values()) { core.rotation.y = t * 0.25; core.rotation.x = t * 0.1; void hub; }
    for (const [id, b] of world.bodies) {
      const c = b.hub.hub.position;
      const p = orbitPoint(b.o, c, t);
      b.g.position.set(p.x, p.y, p.z);
      if (!b.agent) continue;
      const l = lights.get(id) ?? "idle";
      const pulse = l === "working" ? 1 + Math.sin(t * 4 + b.o.phase) * 0.18 : l === "waiting" ? 1 + (Math.sin(t * 6) > 0 ? 0.45 : 0) : 1;
      b.halo.scale.setScalar(1.6 * pulse * (LIGHT_SIZE[l] / 0.32));
    }
    for (const tie of world.ties) {
      const a = world.bodies.get(tie.a).g.position, b = world.bodies.get(tie.b).g.position;
      const mid = a.clone().add(b).multiplyScalar(0.5).add(new THREE.Vector3(0, 2.5, 0));
      tie.line.geometry.setFromPoints(new THREE.QuadraticBezierCurve3(a, mid, b).getPoints(24));
    }
    for (const lab of world.labels) {
      P.copy(lab.at()).add(new THREE.Vector3(0, lab.lift, 0)).project(camera);
      const visible = P.z < 1 && Math.abs(P.x) < 1.1 && Math.abs(P.y) < 1.1;
      lab.el.style.display = visible ? "block" : "none";
      if (visible) { lab.el.style.left = `${((P.x + 1) / 2) * w}px`; lab.el.style.top = `${((1 - P.y) / 2) * h - 14}px`; }
    }
  }
  renderer.render(scene, camera);
  frameCount++;
  if (now - lastReport > 1000) { lastReport = now; hm.reportFrame(); }
  wake();
}
function wake() { if (!running) { running = true; requestAnimationFrame(frame); } }

// ── the host ─────────────────────────────────────────────────────────────────
hm.on("structure", (s) => {
  frames = s.frames; tiles = s.tiles; links = s.links ?? { pipes: [], spawns: [] };
  for (const t of tiles) {
    names.set(t.id, t.name);
    if (!watching.has(t.id) && t.agent) watching.set(t.id, hm.subscribeStatus(t.id, (st, info) => { lights.set(t.id, lightOf(st, info && info.agent)); paintLights(); }));
  }
  for (const [id, stop] of watching) if (!tiles.some((t) => t.id === id)) { stop(); watching.delete(id); lights.delete(id); }
  if (docked && !tiles.some((t) => t.id === docked)) dock(null);
  build();
  wake();
});
hm.on("names", ({ names: n }) => { for (const [id, v] of Object.entries(n)) names.set(id, v); paintLights(); });
hm.on("theme", () => { applyThemeVars(hm); readColors(); build(); });
hm.on("resize", () => { if (docked) hm.setSurfaceRects([dockRect()]); wake(); });
hm.on("visibility", () => wake());
document.addEventListener("visibilitychange", wake);

hm.onCommand("census", () => census(tiles.filter((t) => t.agent).map((t) => lights.get(t.id) ?? "idle")));
hm.onCommand("show", (a) => {
  const want = String((a && a.name) || "").toLowerCase();
  const t = tiles.find((x) => x.agent && (names.get(x.id) ?? x.name).toLowerCase().includes(want));
  if (!want || !t) throw new Error(`no agent is called ${JSON.stringify(a && a.name)}`);
  dock(t.id);
  return { docked: names.get(t.id) ?? t.name };
});
hm.onCommand("release", () => { dock(null); return { docked: null }; });

wake();
