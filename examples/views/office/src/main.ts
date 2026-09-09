/**
 * Hive HQ — an isometric pixel office as a hivemind community view.
 *
 * Every frame is a room (walls in the frame's colour, label on the back
 * wall); every tile is a desk with a monitor that glows the agent's live
 * status and a worker sitting at it. Loose tiles are in the lobby. Hover names
 * a desk, click docks its LIVE terminal in a pane on the right (the host
 * punches the hole), click a room floor selects the frame, drag pans, wheel
 * zooms, Esc undocks. Pan/zoom persist through the host's layout blob.
 *
 * Pure canvas 2D. Draws only on change (`createInvalidator`); the single
 * requestAnimationFrame chain is a bounded 14-frame glow pulse on a status
 * change.
 */
import { applyThemeVars, connect, createInvalidator, type ViewFrame, type ViewStatus, type ViewTile } from "@hivemind/view-sdk";

const STATUS_COLOR: Record<ViewStatus, string> = { unknown: "#6b7280", idle: "#60a5fa", working: "#4ade80", blocked: "#fbbf24", exited: "#f87171" };
const DOCK_FRACTION = 0.5;
const TW = 64, TH = 32; // iso tile footprint at zoom 1

const canvas = document.getElementById("c") as HTMLCanvasElement;
const label = document.getElementById("label") as HTMLDivElement;
const hint = document.getElementById("hint") as HTMLDivElement;
const ctx = canvas.getContext("2d")!;

const hm = await connect();
// The user's theme, live (the host re-sends `theme` on every settings change).
let theme = hm.hello.theme.colors;
const paintChrome = () => {
  label.style.background = theme.bg2 ?? "#222";
  label.style.color = theme.fg ?? "#eee";
  hint.style.color = theme.fg2 ?? "#ddd";
};
paintChrome();
applyThemeVars(hm);
hm.on("theme", (t) => { theme = t.colors; paintChrome(); invalidate(); });

// ── state ───────────────────────────────────────────────────────────────────
interface Room { frame: ViewFrame | null; x: number; y: number; w: number; h: number; color: string; title: string }
interface Desk { tile: ViewTile; room: Room; x: number; y: number; pulse: number }

let frames: ViewFrame[] = [];
let tiles: ViewTile[] = [];
const names = new Map<string, string>();
const status = new Map<string, ViewStatus>();
const unsubscribe = new Map<string, () => void>();
let rooms: Room[] = [];
let desks: Desk[] = [];
let hover: string | null = null;
let docked: string | null = null;
const saved = (hm.hello.layout as { ox?: number; oy?: number; z?: number } | null) ?? {};
let zoom = saved.z ?? 1;
let ox = saved.ox ?? NaN, oy = saved.oy ?? NaN; // NaN = centre on first layout

const { invalidate } = createInvalidator(hm, draw);

// ── layout: rooms on a grid, desks in rows ──────────────────────────────────
function layout() {
  const loose = tiles.filter((t) => !t.frameId || !frames.some((f) => f.id === t.frameId));
  const list: (ViewFrame | null)[] = [...frames];
  if (loose.length || list.length === 0) list.push(null);
  rooms = []; desks = [];
  const cols = Math.max(1, Math.round(Math.sqrt(list.length)));
  let cx = 0, cy = 0, rowH = 0, col = 0;
  for (const f of list) {
    const mine = f ? tiles.filter((t) => t.frameId === f.id) : loose;
    const perRow = Math.min(3, Math.max(1, mine.length));
    const nRows = Math.max(1, Math.ceil(mine.length / 3));
    const w = perRow * 2 + 1, h = nRows * 2 + 2;
    const room: Room = { frame: f, x: cx, y: cy, w, h, color: f?.color ?? (theme.fg2 ?? "#9ca3af"), title: f ? f.title : "Lobby" };
    rooms.push(room);
    mine.forEach((t, i) => desks.push({ tile: t, room, x: cx + 1 + (i % 3) * 2, y: cy + 2 + Math.floor(i / 3) * 2, pulse: 0 }));
    rowH = Math.max(rowH, h);
    col++; cx += w + 2;
    if (col >= cols) { col = 0; cx = 0; cy += rowH + 2; rowH = 0; }
  }
  if (Number.isNaN(ox)) centre();
}

function centre() {
  const maxX = Math.max(1, ...rooms.map((r) => r.x + r.w)), maxY = Math.max(1, ...rooms.map((r) => r.y + r.h));
  const W = sceneWidth(), H = hm.viewport.h;
  zoom = Math.min(2.5, Math.max(0.5, Math.min(W / ((maxX + maxY) * TW / 2 + 80), H / ((maxX + maxY) * TH / 2 + 160))));
  const c = iso(maxX / 2, maxY / 2, 0, 0);
  ox = W / 2 - c.x; oy = H / 2 - c.y + 20;
}

// world (x,y) → screen, with the current pan/zoom unless overridden
function iso(x: number, y: number, px = ox, py = oy) {
  return { x: (x - y) * (TW / 2) * zoom + px, y: (x + y) * (TH / 2) * zoom + py };
}

// ── drawing ─────────────────────────────────────────────────────────────────
function sceneWidth() { return docked ? Math.round(hm.viewport.w * (1 - DOCK_FRACTION)) : hm.viewport.w; }

function diamond(x: number, y: number, fill: string, stroke?: string) {
  const a = iso(x, y), b = iso(x + 1, y), c = iso(x + 1, y + 1), d = iso(x, y + 1);
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.lineTo(d.x, d.y); ctx.closePath();
  ctx.fillStyle = fill; ctx.fill();
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
}

/** An iso box with its base at world (x,y) of size (w,h) tiles and height hz px (at zoom 1). */
function box(x: number, y: number, w: number, h: number, hz: number, top: string, left: string, right: string) {
  const z = hz * zoom;
  const a = iso(x, y), b = iso(x + w, y), c = iso(x + w, y + h), d = iso(x, y + h);
  ctx.fillStyle = left; ctx.beginPath(); ctx.moveTo(d.x, d.y); ctx.lineTo(c.x, c.y); ctx.lineTo(c.x, c.y - z); ctx.lineTo(d.x, d.y - z); ctx.closePath(); ctx.fill();
  ctx.fillStyle = right; ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(b.x, b.y); ctx.lineTo(b.x, b.y - z); ctx.lineTo(c.x, c.y - z); ctx.closePath(); ctx.fill();
  ctx.fillStyle = top; ctx.beginPath(); ctx.moveTo(a.x, a.y - z); ctx.lineTo(b.x, b.y - z); ctx.lineTo(c.x, c.y - z); ctx.lineTo(d.x, d.y - z); ctx.closePath(); ctx.fill();
}

function shade(hex: string, k: number): string {
  const n = parseInt(hex.replace("#", ""), 16);
  if (Number.isNaN(n)) return hex;
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(v * k)));
  return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

function drawRoom(r: Room) {
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
    const even = (x + y) % 2 === 0;
    diamond(x, y, even ? "#2a2f45" : "#262b3f", "#1c2033");
  }
  // back walls: along the top edge (y = r.y) and the left edge (x = r.x)
  const wallH = 46;
  const c1 = shade(r.color, 0.55), c2 = shade(r.color, 0.75);
  const z = wallH * zoom;
  const tl = iso(r.x, r.y), tr = iso(r.x + r.w, r.y), bl = iso(r.x, r.y + r.h);
  ctx.fillStyle = c2; ctx.beginPath(); ctx.moveTo(tl.x, tl.y); ctx.lineTo(tr.x, tr.y); ctx.lineTo(tr.x, tr.y - z); ctx.lineTo(tl.x, tl.y - z); ctx.closePath(); ctx.fill();
  ctx.fillStyle = c1; ctx.beginPath(); ctx.moveTo(tl.x, tl.y); ctx.lineTo(bl.x, bl.y); ctx.lineTo(bl.x, bl.y - z); ctx.lineTo(tl.x, tl.y - z); ctx.closePath(); ctx.fill();
  // a window strip on the back wall
  ctx.fillStyle = "rgba(255,255,255,.12)";
  const m1 = iso(r.x + 0.3, r.y), m2 = iso(r.x + r.w - 0.3, r.y);
  ctx.beginPath(); ctx.moveTo(m1.x, m1.y - z * 0.55); ctx.lineTo(m2.x, m2.y - z * 0.55); ctx.lineTo(m2.x, m2.y - z * 0.8); ctx.lineTo(m1.x, m1.y - z * 0.8); ctx.closePath(); ctx.fill();
  // label above the back corner
  const top = iso(r.x + r.w / 2, r.y);
  ctx.font = `600 ${Math.round(13 * Math.max(0.8, zoom))}px system-ui, sans-serif`;
  ctx.textAlign = "center"; ctx.textBaseline = "bottom";
  ctx.fillStyle = theme.fg ?? "#f5f5f5";
  ctx.shadowColor = "rgba(0,0,0,.8)"; ctx.shadowBlur = 6;
  ctx.fillText(r.title, top.x, top.y - z - 6);
  ctx.shadowBlur = 0;
}

function drawDesk(d: Desk) {
  const s = STATUS_COLOR[status.get(d.tile.id) ?? "unknown"];
  const hot = d.tile.id === docked || d.tile.id === hover;
  const { x, y } = d;
  // desk
  box(x, y, 1.5, 0.8, 14, "#8b5a2b", "#6b4320", "#7a4c24");
  // monitor on the desk (a thin box) with a glowing screen
  box(x + 0.35, y + 0.05, 0.8, 0.08, 22 + 14, "#1f2937", "#111827", "#1f2937");
  const sc = iso(x + 0.75, y + 0.1);
  const glow = 10 + d.pulse * 18 + (hot ? 8 : 0);
  ctx.save();
  ctx.shadowColor = s; ctx.shadowBlur = glow * zoom;
  ctx.fillStyle = s;
  const sw = 0.62 * TW / 2 * zoom, sh = 13 * zoom;
  ctx.beginPath(); ctx.moveTo(sc.x - sw / 2, sc.y - 30 * zoom + sh); ctx.lineTo(sc.x + sw / 2, sc.y - 30 * zoom + sh - sw / 2 * 0.5); ctx.lineTo(sc.x + sw / 2, sc.y - 30 * zoom - sw / 2 * 0.5); ctx.lineTo(sc.x - sw / 2, sc.y - 30 * zoom); ctx.closePath(); ctx.fill();
  ctx.restore();
  // chair + worker in front (toward the viewer)
  const w = iso(x + 0.75, y + 1.15);
  ctx.fillStyle = "#374151"; ctx.beginPath(); ctx.ellipse(w.x, w.y, 9 * zoom, 5 * zoom, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = hot ? (theme.brand ?? "#e5e7eb") : "#cbd5e1"; ctx.fillRect(w.x - 5 * zoom, w.y - 16 * zoom, 10 * zoom, 12 * zoom); // body
  ctx.fillStyle = "#f5d0a9"; ctx.beginPath(); ctx.arc(w.x, w.y - 20 * zoom, 5 * zoom, 0, Math.PI * 2); ctx.fill(); // head
  // status dot above the head
  ctx.fillStyle = s; ctx.beginPath(); ctx.arc(w.x, w.y - 30 * zoom, 3 * zoom, 0, Math.PI * 2); ctx.fill();
  if (hot) { ctx.strokeStyle = theme.brand ?? "#fff"; ctx.lineWidth = 2; diamond(x, y, "rgba(0,0,0,0)", theme.brand ?? "#fff"); ctx.lineWidth = 1; }
}

function draw() {
  const dpr = window.devicePixelRatio || 1;
  const W = sceneWidth(), H = hm.viewport.h;
  if (W < 1 || H < 1) return;
  if (canvas.width !== W * dpr || canvas.height !== H * dpr) { canvas.width = W * dpr; canvas.height = H * dpr; }
  canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, "#0f1220"); g.addColorStop(1, "#171a2e");
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  // painter's order: floors + walls per room (back to front), then desks back to front
  for (const r of [...rooms].sort((a, b) => a.x + a.y - (b.x + b.y))) drawRoom(r);
  for (const d of [...desks].sort((a, b) => a.x + a.y - (b.x + b.y))) drawDesk(d);
  if (docked) { ctx.fillStyle = theme.line ?? "#333"; ctx.fillRect(W - 1, 0, 1, H); }
}

// ── picking (screen → world diamond) ────────────────────────────────────────
function world(sx: number, sy: number) {
  const a = (sx - ox) / ((TW / 2) * zoom), b = (sy - oy) / ((TH / 2) * zoom);
  return { x: (a + b) / 2, y: (b - a) / 2 };
}
function pick(sx: number, sy: number): { desk?: Desk; room?: Room } | null {
  if (sx > sceneWidth()) return null;
  const p = world(sx, sy + 12 * zoom); // bias towards the desk's body which sits above its footprint
  for (const d of desks) if (p.x >= d.x - 0.2 && p.x <= d.x + 1.7 && p.y >= d.y - 0.6 && p.y <= d.y + 1.4) return { desk: d };
  const q = world(sx, sy);
  for (const r of rooms) if (q.x >= r.x && q.x < r.x + r.w && q.y >= r.y && q.y < r.y + r.h) return { room: r };
  return null;
}

// ── docking, pulses ─────────────────────────────────────────────────────────
function dock(tileId: string | null) {
  docked = tileId;
  hm.commands.selectTile(tileId);
  hm.setSurfaceRects(tileId ? [{ tileId, x: sceneWidth(), y: 0, w: hm.viewport.w - sceneWidth(), h: hm.viewport.h }] : []);
  hint.textContent = tileId ? "Esc undocks · drag pans · wheel zooms" : "Click a desk to open its agent · click a room floor to select the frame";
  invalidate();
}
/** Bounded 14-frame glow pulse when a desk's status changes. */
function pulse(tileId: string) {
  const d = desks.find((x) => x.tile.id === tileId);
  if (!d) return;
  let i = 0;
  const step = () => { i++; d.pulse = Math.sin((i / 14) * Math.PI); invalidate(); if (i < 14) requestAnimationFrame(step); else { d.pulse = 0; invalidate(); } };
  step();
}
function persist() { hm.setLayout({ ox, oy, z: zoom }); }

// ── host events ─────────────────────────────────────────────────────────────
hm.on("structure", (m) => {
  frames = m.frames; tiles = m.tiles;
  for (const t of tiles) {
    names.set(t.id, t.name);
    if (!unsubscribe.has(t.id)) unsubscribe.set(t.id, hm.subscribeStatus(t.id, (s) => { const prev = status.get(t.id); status.set(t.id, s); if (prev && prev !== s) pulse(t.id); invalidate(); }));
  }
  for (const [id, off] of unsubscribe) if (!tiles.some((t) => t.id === id)) { off(); unsubscribe.delete(id); status.delete(id); }
  if (docked && !tiles.some((t) => t.id === docked)) dock(null);
  layout(); invalidate();
});
hm.on("names", (m) => { for (const [id, n] of Object.entries(m.names)) names.set(id, n); if (hover) showLabel(); });
hm.on("selection", (m) => { if (m.fresh && m.tileId && m.tileId !== docked) dock(m.tileId); });
hm.on("undock", (m) => { if (docked === m.tileId) dock(null); }); // the host bar or Shift+Esc undocked it
hm.on("resize", () => { if (docked) dock(docked); else invalidate(); });
hm.on("visibility", ({ visible }) => { if (visible) invalidate(); });
hm.onReveal((tileId) => {
  const d = desks.find((x) => x.tile.id === tileId);
  if (!d) return null;
  const p = iso(d.x + 0.75, d.y + 0.5);
  return { x: p.x - 30 * zoom, y: p.y - 40 * zoom, w: 60 * zoom, h: 50 * zoom };
});

// ── input ───────────────────────────────────────────────────────────────────
let lastPt = { x: 0, y: 0 };
let drag: { x: number; y: number; ox: number; oy: number; moved: boolean } | null = null;
function showLabel() {
  if (!hover) { label.style.display = "none"; return; }
  label.textContent = names.get(hover) ?? hover;
  label.style.left = `${lastPt.x + 14}px`; label.style.top = `${lastPt.y + 14}px`; label.style.display = "block";
}
canvas.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, ox, oy, moved: false }; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener("pointermove", (e) => {
  lastPt = { x: e.clientX, y: e.clientY };
  if (drag) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.hypot(dx, dy) > 4) drag.moved = true;
    if (drag.moved) { ox = drag.ox + dx; oy = drag.oy + dy; invalidate(); }
    return;
  }
  const id = pick(e.clientX, e.clientY)?.desk?.tile.id ?? null;
  if (id !== hover) { hover = id; canvas.style.cursor = id ? "pointer" : "grab"; invalidate(); }
  showLabel();
});
canvas.addEventListener("pointerup", (e) => {
  const wasDrag = drag?.moved ?? false;
  drag = null;
  if (wasDrag) { persist(); return; }
  if (e.button !== 0) return;
  const hit = pick(e.clientX, e.clientY);
  if (hit?.desk) dock(hit.desk.tile.id);
  else if (hit?.room) hm.commands.selectFrame(hit.room.frame?.id ?? null);
  else if (docked) dock(null);
});
canvas.addEventListener("pointerleave", () => { hover = null; showLabel(); invalidate(); });
canvas.addEventListener("wheel", (e) => {
  const k = e.deltaY > 0 ? 0.9 : 1.1;
  const nz = Math.min(2.5, Math.max(0.5, zoom * k));
  const f = nz / zoom;
  ox = e.clientX - (e.clientX - ox) * f; oy = e.clientY - (e.clientY - oy) * f; zoom = nz;
  persist(); invalidate();
}, { passive: true });
window.addEventListener("keydown", (e) => { if (e.key === "Escape" && docked) dock(null); });

// ── init ────────────────────────────────────────────────────────────────────
layout();
dock(null);
