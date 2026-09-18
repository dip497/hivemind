/**
 * Tiled — for the person who lives in tmux and has two to four agents on one task.
 *
 * The active frame's tiles lay themselves out as live terminals: one fills the view, two
 * split, three or more take a main pane and a stack. Nothing is dragged or sized. Frames are
 * tabs, and a tab lights when something in that frame needs you, so another task can call you
 * without being on screen. The terminals are real — the host fills each rect — and carry the
 * host's own bar, so status, pop-out and undock are the app's controls, not this view's.
 */
import { applyThemeVars, connect, createInvalidator, type SurfaceRect, type ViewFrame, type ViewRect, type ViewStatus, type ViewTile } from "@hivemind/view-sdk";

type Mode = "main" | "grid";
interface Saved { v: 1; frame: string | null; mode: Mode; order: Record<string, string[]> }
interface Rect { x: number; y: number; w: number; h: number }

const BAR_H = 44;          // the tab bar's height in tiled.css
const GAP = 8;
const EDGE = 10;
const MAX_PANES = 9;       // past nine, a terminal is too small to read; the rest wait their turn
const LOOSE = "__loose";

const $ = <T extends Element>(s: string) => document.querySelector(s) as T;
const tabsEl = $<HTMLElement>(".t-tabs");
const indicator = $<HTMLSpanElement>(".t-indicator");
const ringsEl = $<HTMLDivElement>(".t-rings");
const emptyEl = $<HTMLDivElement>(".t-empty");
const restoreEl = $<HTMLButtonElement>(".t-restore");

const hm = await connect();
applyThemeVars(hm);
const reduce = matchMedia("(prefers-reduced-motion: reduce)");

let frames: ViewFrame[] = [];
let tiles: ViewTile[] = [];
const names = new Map<string, string>();
const status = new Map<string, ViewStatus>();
const unsub = new Map<string, () => void>();

const saved = hm.hello.layout as Saved | null;
let active: string | null = saved?.v === 1 ? saved.frame : null;
let mode: Mode = saved?.v === 1 ? saved.mode : "main";
const order = new Map<string, string[]>(Object.entries(saved?.v === 1 ? saved.order : {}));
/** Undocked from the host's bar this session: out of the layout until you bring them back. */
const hidden = new Set<string>();
let hostSelected: string | null = null;
const needsBefore = new Map<string, number>();

const keyOf = (t: ViewTile) => t.frameId ?? LOOSE;
const nameOf = (t: ViewTile) => names.get(t.id) ?? t.name;

function tabs(): { id: string; title: string; color: string }[] {
  const out = frames.map((f) => ({ id: f.id, title: f.title, color: f.color }));
  if (tiles.some((t) => !t.frameId)) out.push({ id: LOOSE, title: "Loose tiles", color: "transparent" });
  return out;
}

function panes(key: string): string[] {
  const inFrame = tiles.filter((t) => keyOf(t) === key && !hidden.has(t.id)).map((t) => t.id);
  const kept = (order.get(key) ?? []).filter((id) => inFrame.includes(id));
  const all = [...kept, ...inFrame.filter((id) => !kept.includes(id))];
  order.set(key, all);
  return all;
}

// ── layout: a pure function of count, mode and space ─────────────────────────
function layout(n: number, w: number, h: number): Rect[] {
  const area: Rect = { x: EDGE, y: BAR_H + GAP, w: w - EDGE * 2, h: h - BAR_H - GAP - EDGE };
  if (n <= 0 || area.w < 80 || area.h < 60) return [];
  if (n === 1) return [area];
  const r = (x: number, y: number, ww: number, hh: number): Rect => ({ x: Math.round(x), y: Math.round(y), w: Math.round(ww), h: Math.round(hh) });

  if (mode === "main") {
    if (n === 2) {
      const cw = (area.w - GAP) / 2;
      return [r(area.x, area.y, cw, area.h), r(area.x + cw + GAP, area.y, cw, area.h)];
    }
    // Past three in the stack a pane stops being readable, so the stack becomes two columns.
    const cols = n - 1 > 3 ? 2 : 1;
    const mainW = (area.w - GAP) * (cols === 2 ? 0.5 : 0.58);
    const stackX = area.x + mainW + GAP, stackW = area.w - mainW - GAP;
    const rest = n - 1, rows = Math.ceil(rest / cols), rowH = (area.h - GAP * (rows - 1)) / rows;
    return [r(area.x, area.y, mainW, area.h), ...Array.from({ length: rest }, (_, i) => {
      const row = Math.floor(i / cols);
      const inRow = Math.min(cols, rest - row * cols);
      const cw = (stackW - GAP * (inRow - 1)) / inRow;
      return r(stackX + (i % cols) * (cw + GAP), area.y + row * (rowH + GAP), cw, rowH);
    })];
  }

  const cols = Math.ceil(Math.sqrt(n)), rowsN = Math.ceil(n / cols);
  const rowH = (area.h - GAP * (rowsN - 1)) / rowsN;
  const out: Rect[] = [];
  for (let row = 0; row < rowsN; row++) {
    // The last row's cells widen to fill it, so a grid never leaves a hole in the corner.
    const inRow = Math.min(cols, n - row * cols);
    const cw = (area.w - GAP * (inRow - 1)) / inRow;
    for (let c = 0; c < inRow; c++) out.push(r(area.x + c * (cw + GAP), area.y + row * (rowH + GAP), cw, rowH));
  }
  return out;
}

function current(): { ids: string[]; rects: Rect[] } {
  const ids = active ? panes(active).slice(0, MAX_PANES) : [];
  return { ids, rects: layout(ids.length, hm.viewport.w, hm.viewport.h) };
}

// ── the active-tab indicator: a spring, so it travels and can be caught mid-flight ──
const spring = { x: 0, w: 0, vx: 0, vw: 0, tx: 0, tw: 0, raf: 0, last: 0 };
const paintIndicator = () => { indicator.style.transform = `translateX(${spring.x.toFixed(2)}px)`; indicator.style.width = `${spring.w.toFixed(2)}px`; };
function springTo(x: number, w: number) {
  spring.tx = x; spring.tw = w;
  if (reduce.matches || spring.w === 0) { spring.x = x; spring.w = w; paintIndicator(); return; }
  if (!spring.raf) { spring.last = performance.now(); spring.raf = requestAnimationFrame(step); }
}
function step(now: number) {
  const dt = Math.min(1 / 30, (now - spring.last) / 1000);
  spring.last = now;
  // Stiff and critically damped: it arrives quickly and does not bounce.
  const k = 520, c = 44;
  spring.vx += (k * (spring.tx - spring.x) - c * spring.vx) * dt; spring.x += spring.vx * dt;
  spring.vw += (k * (spring.tw - spring.w) - c * spring.vw) * dt; spring.w += spring.vw * dt;
  const settled = Math.abs(spring.tx - spring.x) < 0.3 && Math.abs(spring.tw - spring.w) < 0.3 && Math.abs(spring.vx) < 5;
  if (settled) { spring.x = spring.tx; spring.w = spring.tw; spring.raf = 0; } else spring.raf = requestAnimationFrame(step);
  paintIndicator();
  hm.reportFrame();
}

// ── rendering ────────────────────────────────────────────────────────────────
const tabEls = new Map<string, HTMLButtonElement>();
const ringEls = new Map<string, HTMLDivElement>();

function tab(t: { id: string }): HTMLButtonElement {
  let el = tabEls.get(t.id);
  if (!el) {
    el = document.createElement("button");
    el.type = "button";
    el.className = "t-tab";
    el.setAttribute("role", "tab");
    el.innerHTML = '<i class="t-dot"></i><span class="t-title"></span><span class="t-count"></span><span class="t-needs"></span>';
    el.addEventListener("click", () => activate(t.id));
    tabEls.set(t.id, el);
  }
  return el;
}

function render() {
  const list = tabs();
  if (!active || !list.some((t) => t.id === active)) active = list.find((t) => tiles.some((x) => keyOf(x) === t.id))?.id ?? list[0]?.id ?? null;

  list.forEach((t, i) => {
    const el = tab(t);
    const inFrame = tiles.filter((x) => keyOf(x) === t.id);
    const needs = inFrame.filter((x) => status.get(x.id) === "blocked").length;
    el.setAttribute("aria-selected", String(t.id === active));
    el.style.setProperty("--c", t.color);
    (el.querySelector(".t-title") as HTMLElement).textContent = t.title;
    (el.querySelector(".t-count") as HTMLElement).textContent = String(inFrame.length);
    const badge = el.querySelector(".t-needs") as HTMLElement;
    badge.textContent = needs ? String(needs) : "";
    badge.hidden = !needs;
    // Another frame starting to need you is the one thing worth a flash — once, not a loop.
    if (needs > (needsBefore.get(t.id) ?? 0) && t.id !== active && !reduce.matches) el.animate(
      [{ boxShadow: "0 0 0 0 color-mix(in srgb, var(--hm-status-attention) 55%, transparent)" }, { boxShadow: "0 0 0 8px transparent" }],
      { duration: 700, easing: "cubic-bezier(0.23, 1, 0.32, 1)" });
    needsBefore.set(t.id, needs);
    el.title = i < 9 ? `${t.title} — press ${i + 1}` : t.title;
    if (tabsEl.children[i + 1] !== el) tabsEl.insertBefore(el, tabsEl.children[i + 1] ?? null);
  });
  for (const [id, el] of tabEls) if (!list.some((t) => t.id === id)) { el.remove(); tabEls.delete(id); }

  const activeEl = active ? tabEls.get(active) : null;
  if (activeEl) springTo(activeEl.offsetLeft, activeEl.offsetWidth);
  indicator.hidden = !activeEl;

  const { ids, rects } = current();
  const surfaces: SurfaceRect[] = ids.map((id, i) => ({ tileId: id, ...rects[i]!, chrome: "bar" }));
  hm.setSurfaceRects(surfaces);

  // A pane that needs you gets a ring in the gutter around it — outside the hole, where it can be seen.
  const wanted = new Set<string>();
  ids.forEach((id, i) => {
    if (status.get(id) !== "blocked" || !rects[i]) return;
    wanted.add(id);
    let ring = ringEls.get(id);
    if (!ring) { ring = document.createElement("div"); ring.className = "t-ring"; ringsEl.append(ring); ringEls.set(id, ring); }
    const r = rects[i]!;
    Object.assign(ring.style, { left: `${r.x - 3}px`, top: `${r.y - 3}px`, width: `${r.w + 6}px`, height: `${r.h + 6}px` });
  });
  for (const [id, el] of ringEls) if (!wanted.has(id)) { el.remove(); ringEls.delete(id); }

  const frameTitle = list.find((t) => t.id === active)?.title ?? "";
  emptyEl.hidden = ids.length > 0;
  if (!ids.length) {
    (emptyEl.querySelector(".t-empty-title") as HTMLElement).textContent = list.length ? `Nothing open in ${frameTitle}` : "No frames yet";
    (emptyEl.querySelector(".t-empty-sub") as HTMLElement).textContent = list.length ? "Start an agent or a shell in this frame and it tiles itself here." : "Open a project and its terminals tile themselves here.";
  }

  const parked = tiles.filter((t) => keyOf(t) === active && hidden.has(t.id)).length + Math.max(0, (active ? panes(active).length : 0) - MAX_PANES);
  restoreEl.hidden = !parked;
  restoreEl.textContent = parked ? `${parked} not shown` : "";
  for (const b of document.querySelectorAll<HTMLButtonElement>(".t-mode button")) b.setAttribute("aria-checked", String(b.dataset.mode === mode));
}

const { invalidate } = createInvalidator(hm, render);

// ── actions ──────────────────────────────────────────────────────────────────
function persist() {
  hm.setLayout({ v: 1, frame: active, mode, order: Object.fromEntries(order) } satisfies Saved);
}
function activate(id: string) {
  if (id === active) return;
  active = id;
  if (id !== LOOSE) hm.commands.selectFrame(id);
  persist();
  invalidate();
}
function promote(id: string) {
  const t = tiles.find((x) => x.id === id);
  if (!t) return;
  const key = keyOf(t);
  hidden.delete(id);
  order.set(key, [id, ...panes(key).filter((x) => x !== id)]);
  if (active !== key) active = key;
  persist();
  invalidate();
}
function toggleMode() { mode = mode === "main" ? "grid" : "main"; persist(); invalidate(); }

restoreEl.addEventListener("click", () => {
  const back = tiles.find((t) => keyOf(t) === active && hidden.has(t.id));
  if (back) { hidden.delete(back.id); promote(back.id); return; }
  // More than fit: rotate the first one that is not shown into the main pane.
  const all = active ? panes(active) : [];
  if (all.length > MAX_PANES) promote(all[MAX_PANES]!);
});
for (const b of document.querySelectorAll<HTMLButtonElement>(".t-mode button")) {
  b.addEventListener("click", () => { if (b.dataset.mode !== mode) toggleMode(); });
}

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const list = tabs();
  const i = list.findIndex((t) => t.id === active);
  if (/^[1-9]$/.test(e.key) && list[Number(e.key) - 1]) { e.preventDefault(); activate(list[Number(e.key) - 1]!.id); }
  else if (e.key === "]" && list.length) { e.preventDefault(); activate(list[(i + 1) % list.length]!.id); }
  else if (e.key === "[" && list.length) { e.preventDefault(); activate(list[(i - 1 + list.length) % list.length]!.id); }
  else if (e.key.toLowerCase() === "m") { e.preventDefault(); toggleMode(); }
  else if (e.key === "Enter" && hostSelected) { e.preventDefault(); promote(hostSelected); }
});

// ── host ─────────────────────────────────────────────────────────────────────
hm.on("structure", (s) => {
  frames = s.frames;
  tiles = s.tiles;
  for (const t of tiles) if (!unsub.has(t.id)) unsub.set(t.id, hm.subscribeStatus(t.id, (st) => { status.set(t.id, st); invalidate(); }));
  for (const [id, off] of unsub) if (!tiles.some((t) => t.id === id)) { off(); unsub.delete(id); status.delete(id); hidden.delete(id); }
  invalidate();
});
hm.on("names", ({ names: n }) => { for (const [id, v] of Object.entries(n)) names.set(id, v); invalidate(); });
hm.on("selection", ({ tileId, frameId, fresh }) => {
  hostSelected = tileId;
  // Follow a choice made elsewhere to the frame it lives in; what you arrived with is just shown.
  const t = tileId ? tiles.find((x) => x.id === tileId) : undefined;
  if (t && (fresh || !active)) { hidden.delete(t.id); if (keyOf(t) !== active) { active = keyOf(t); persist(); } }
  else if (!t && frameId && fresh && frameId !== active) { active = frameId; persist(); }
  invalidate();
});
hm.on("undock", ({ tileId }) => { hidden.add(tileId); invalidate(); });
hm.on("resize", () => invalidate());
hm.on("visibility", () => invalidate());
hm.onReveal((tileId): ViewRect | null => {
  const t = tiles.find((x) => x.id === tileId);
  if (!t) return null;
  promote(tileId);                    // bring it into view: its frame, its place first
  const { ids, rects } = current();
  const i = ids.indexOf(tileId);
  return i >= 0 ? rects[i]! : null;
});

invalidate();
