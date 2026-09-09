/**
 * Orbit — an example hivemind community view, small enough to read in one
 * sitting. Every frame is a sun; its tiles orbit it, coloured by live agent
 * status; loose tiles orbit the workspace centre. Hover names a tile, a click
 * docks its LIVE terminal in a pane on the right (the host punches the hole
 * and puts a real tile there — this page only says where), Esc undocks, the
 * wheel changes the spread (persisted through the host's layout blob).
 *
 * Rules the SDK makes easy to keep: draw only when something changed
 * (`createInvalidator`), nothing while hidden, one status subscription per
 * tile, names separate from structure.
 */
import { applyThemeVars, connect, createInvalidator, type ViewFrame, type ViewStatus, type ViewTile } from "@hivemind/view-sdk";

const STATUS_COLOR: Record<ViewStatus, string> = { unknown: "#6b7280", idle: "#3b82f6", working: "#22c55e", blocked: "#f59e0b", exited: "#ef4444" };
const DOCK_FRACTION = 0.5;

const canvas = document.getElementById("c") as HTMLCanvasElement;
const label = document.getElementById("label") as HTMLDivElement;
const ctx = canvas.getContext("2d")!;

interface Body { tile: ViewTile; x: number; y: number; r: number }

const hm = await connect();
let frames: ViewFrame[] = [];
let tiles: ViewTile[] = [];
const names = new Map<string, string>();
const status = new Map<string, ViewStatus>();
const unsubscribe = new Map<string, () => void>();
let bodies: Body[] = [];
let hover: string | null = null;
let docked: string | null = null;
let spread = (hm.hello.layout as { spread?: number } | null)?.spread ?? 1;
// The user's theme, live: the host re-sends `theme` on every settings change,
// and applyThemeVars keeps the --hm-* custom properties in sync for the CSS.
let theme = hm.hello.theme.colors;
const paintChrome = () => {
  label.style.background = theme.bg2 ?? "#222";
  label.style.color = theme.fg ?? "#eee";
};
paintChrome();
applyThemeVars(hm);
hm.on("theme", (t) => { theme = t.colors; paintChrome(); invalidate(); });

const { invalidate } = createInvalidator(hm, draw);

// ── layout: suns on a ring, planets on orbits ───────────────────────────────
function sceneWidth() { return docked ? hm.viewport.w * (1 - DOCK_FRACTION) : hm.viewport.w; }
function layout() {
  const W = sceneWidth(), H = hm.viewport.h;
  const suns = new Map<string | null, { x: number; y: number }>();
  const ringR = Math.min(W, H) * 0.3 * spread;
  frames.forEach((f, i) => {
    const a = (i / Math.max(1, frames.length)) * Math.PI * 2 - Math.PI / 2;
    suns.set(f.id, { x: W / 2 + Math.cos(a) * (frames.length > 1 ? ringR : 0), y: H / 2 + Math.sin(a) * (frames.length > 1 ? ringR : 0) });
  });
  suns.set(null, { x: W / 2, y: H / 2 });
  const byFrame = new Map<string | null, ViewTile[]>();
  for (const t of tiles) { const k = t.frameId && suns.has(t.frameId) ? t.frameId : null; byFrame.set(k, [...(byFrame.get(k) ?? []), t]); }
  bodies = [];
  for (const [fid, list] of byFrame) {
    const s = suns.get(fid)!;
    const orbit = (fid === null ? Math.min(W, H) * 0.42 : Math.min(W, H) * 0.12) * spread;
    list.forEach((t, i) => {
      const a = (i / list.length) * Math.PI * 2;
      bodies.push({ tile: t, x: s.x + Math.cos(a) * orbit, y: s.y + Math.sin(a) * orbit, r: 14 });
    });
  }
  return suns;
}

function draw() {
  const dpr = window.devicePixelRatio || 1;
  const W = hm.viewport.w, H = hm.viewport.h;
  if (canvas.width !== W * dpr || canvas.height !== H * dpr) { canvas.width = W * dpr; canvas.height = H * dpr; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const suns = layout();
  ctx.font = "12px system-ui, sans-serif";
  ctx.textAlign = "center";
  for (const f of frames) {
    const s = suns.get(f.id)!;
    const orbit = Math.min(sceneWidth(), H) * 0.12 * spread;
    ctx.beginPath(); ctx.arc(s.x, s.y, orbit, 0, Math.PI * 2); ctx.strokeStyle = theme.line ?? "#333"; ctx.stroke();
    ctx.beginPath(); ctx.arc(s.x, s.y, 22, 0, Math.PI * 2); ctx.fillStyle = f.color; ctx.fill();
    ctx.fillStyle = theme.fg2 ?? "#ccc"; ctx.fillText(f.title, s.x, s.y + 38);
  }
  for (const b of bodies) {
    ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    ctx.fillStyle = STATUS_COLOR[status.get(b.tile.id) ?? "unknown"]; ctx.fill();
    if (b.tile.id === docked || b.tile.id === hover) { ctx.lineWidth = 3; ctx.strokeStyle = theme.brand ?? "#fff"; ctx.stroke(); ctx.lineWidth = 1; }
  }
  if (docked) {
    const x = sceneWidth();
    ctx.fillStyle = theme.line ?? "#333"; ctx.fillRect(x, 0, 1, H);
  }
}

function at(x: number, y: number): Body | null {
  for (const b of bodies) if ((b.x - x) ** 2 + (b.y - y) ** 2 <= (b.r + 2) ** 2) return b;
  return null;
}

function dock(tileId: string | null) {
  docked = tileId;
  hm.commands.selectTile(tileId);
  hm.setSurfaceRects(tileId ? [{ tileId, x: sceneWidth(), y: 0, w: hm.viewport.w - sceneWidth(), h: hm.viewport.h }] : []);
  invalidate();
}

// ── host events ─────────────────────────────────────────────────────────────
hm.on("structure", (m) => {
  frames = m.frames; tiles = m.tiles;
  for (const t of tiles) { names.set(t.id, t.name); if (!unsubscribe.has(t.id)) unsubscribe.set(t.id, hm.subscribeStatus(t.id, (s) => { status.set(t.id, s); invalidate(); })); }
  for (const [id, off] of unsubscribe) if (!tiles.some((t) => t.id === id)) { off(); unsubscribe.delete(id); status.delete(id); }
  if (docked && !tiles.some((t) => t.id === docked)) dock(null);
  invalidate();
});
hm.on("names", (m) => { for (const [id, n] of Object.entries(m.names)) names.set(id, n); if (hover) showLabel(); });
hm.on("selection", (m) => { if (m.fresh && m.tileId && m.tileId !== docked) dock(m.tileId); });
hm.on("resize", () => { if (docked) dock(docked); else invalidate(); });
hm.on("undock", () => { docked = null; hm.commands.selectTile(null); invalidate(); }); // the host already released the tile
hm.onReveal((tileId) => {
  layout(); // positions as of NOW (the next frame may not have drawn yet, e.g. right after an undock)
  const b = bodies.find((x) => x.tile.id === tileId);
  return b ? { x: b.x - b.r, y: b.y - b.r, w: b.r * 2, h: b.r * 2 } : null;
});

// ── input ───────────────────────────────────────────────────────────────────
let lastPt = { x: 0, y: 0 };
function showLabel() {
  if (!hover) { label.style.display = "none"; return; }
  label.textContent = names.get(hover) ?? hover;
  label.style.left = `${lastPt.x + 12}px`; label.style.top = `${lastPt.y + 12}px`; label.style.display = "block";
}
canvas.addEventListener("pointermove", (e) => {
  lastPt = { x: e.clientX, y: e.clientY };
  const id = at(e.clientX, e.clientY)?.tile.id ?? null;
  if (id !== hover) { hover = id; invalidate(); }
  showLabel();
});
canvas.addEventListener("pointerleave", () => { hover = null; showLabel(); invalidate(); });
canvas.addEventListener("click", (e) => { const b = at(e.clientX, e.clientY); if (b) dock(b.tile.id); else if (docked) dock(null); });
canvas.addEventListener("wheel", (e) => {
  spread = Math.min(2, Math.max(0.5, spread * (e.deltaY > 0 ? 0.92 : 1.08)));
  hm.setLayout({ spread });
  if (docked) dock(docked); else invalidate();
}, { passive: true });
window.addEventListener("keydown", (e) => { if (e.key === "Escape" && docked) dock(null); });

invalidate();
