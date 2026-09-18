/**
 * Board — for the lead who starts longer tasks, checks in a few times a day, and owns review.
 *
 * Each agent session is a card moving from Doing, to Review, to Done. Status moves a card only
 * where status is certain: working is Doing, needing you is Needs you, finishing while watched is
 * Review, exiting is Done. Everything else is the lead's call, and it persists — until the agent
 * starts working again, which moves the card back with a note that says so. Done is never
 * inferred: Hivemind cannot know a change was merged, so it does not pretend to.
 */
import { applyThemeVars, connect, createInvalidator, type ViewFrame, type ViewRect, type ViewStatus, type ViewTile } from "@hivemind/view-sdk";

type Col = "doing" | "needs" | "review" | "done";
const COLS: readonly { id: Col; label: string; empty: string }[] = [
  { id: "doing", label: "Doing", empty: "Nothing running." },
  { id: "needs", label: "Needs you", empty: "Nobody is waiting on you." },
  { id: "review", label: "Review", empty: "Finished sessions land here." },
  { id: "done", label: "Done", empty: "Move a card here once you have reviewed it." },
];
const WIP = 5;             // past five sessions in flight, review becomes the bottleneck

interface Place { col: Col; at: number }
interface Saved { v: 1; placed: Record<string, Place>; entered: Record<string, number>; finished: string[]; notes: Record<string, string>; cleared: string[] }

const MARK = {
  working: '<circle cx="6" cy="6" r="4" fill="var(--hm-status-working)"/>',
  needs: '<path d="M6 1.2 10.8 6 6 10.8 1.2 6Z" fill="var(--hm-status-attention)"/>',
  finished: '<path d="M2.6 6.3 5 8.6 9.4 3.8" fill="none" stroke="var(--hm-status-done)" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>',
  idle: '<circle cx="6" cy="6" r="3.6" fill="none" stroke="var(--hm-status-idle)" stroke-width="1.5"/>',
  exited: '<path d="M3.2 3.2 8.8 8.8M8.8 3.2 3.2 8.8" stroke="var(--hm-status-exited)" stroke-width="1.8" stroke-linecap="round"/>',
} as const;

const $ = <T extends Element>(s: string) => document.querySelector(s) as T;
const boardEl = $<HTMLElement>(".b-board");
const summaryEl = $<HTMLParagraphElement>(".b-summary");
const panelEl = $<HTMLElement>(".b-panel");
const panelTitle = $<HTMLDivElement>(".b-panel-title");

const hm = await connect();
applyThemeVars(hm);
const reduce = matchMedia("(prefers-reduced-motion: reduce)");

let frames: ViewFrame[] = [];
let tiles: ViewTile[] = [];
const names = new Map<string, string>();
const status = new Map<string, ViewStatus>();
const unsub = new Map<string, () => void>();

const saved = (hm.hello.layout as Saved | null)?.v === 1 ? (hm.hello.layout as Saved) : null;
const placed = new Map<string, Place>(Object.entries(saved?.placed ?? {}));
const entered = new Map<string, number>(Object.entries(saved?.entered ?? {}));
const finished = new Set<string>(saved?.finished ?? []);
const notes = new Map<string, string>(Object.entries(saved?.notes ?? {}));
const cleared = new Set<string>(saved?.cleared ?? []);
let reviewing: string | null = null;

const isAgent = (t: ViewTile) => t.kind === "claude";
const nameOf = (t: ViewTile) => names.get(t.id) ?? t.name;
const on = () => tiles.filter((t) => isAgent(t) && !cleared.has(t.id));

function columnOf(id: string): Col {
  const s = status.get(id) ?? "unknown";
  if (s === "blocked") return "needs";
  if (s === "working") return "doing";
  const p = placed.get(id);
  if (p && p.col !== "needs") return p.col;
  if (s === "exited") return "done";
  return finished.has(id) ? "review" : "doing";
}

function markOf(id: string, col: Col): keyof typeof MARK {
  const s = status.get(id);
  if (s === "blocked") return "needs";
  if (s === "working") return "working";
  if (s === "exited") return "exited";
  return col === "review" || col === "done" ? "finished" : "idle";
}

// ── time ─────────────────────────────────────────────────────────────────────
function ago(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// ── moving cards ─────────────────────────────────────────────────────────────
const refusal = new Map<string, number>();
function move(id: string, to: Col): boolean {
  const s = status.get(id);
  const from = columnOf(id);
  // Needs you belongs to status, and a card that is still working or waiting cannot be declared
  // reviewed or done — status would move it straight back, which reads as the board being broken.
  if (to === "needs" || ((s === "working" || s === "blocked") && to !== "doing" && to !== from)) {
    refusal.set(id, Date.now());
    invalidate();
    return false;
  }
  if (to === from) return true;
  placed.set(id, { col: to, at: Date.now() });
  entered.set(id, Date.now());
  notes.delete(id);
  persist();
  invalidate();
  return true;
}

function onStatus(id: string, s: ViewStatus) {
  const prev = status.get(id);
  const before = prev === undefined ? null : columnOf(id);
  status.set(id, s);
  if (prev !== undefined && prev !== s) {
    if (prev === "working" && s === "idle") finished.add(id);
    const p = placed.get(id);
    if ((s === "working" || s === "blocked") && p && (p.col === "review" || p.col === "done")) {
      notes.set(id, s === "working" ? `Back from ${p.col === "done" ? "Done" : "Review"}: it started working again` : `Back from ${p.col === "done" ? "Done" : "Review"}: it needs you`);
      placed.delete(id);
      finished.delete(id);
    }
    if (s === "working") finished.delete(id);
  }
  if (before !== null && before !== columnOf(id)) entered.set(id, Date.now());
  persist();
  invalidate();
}

function persist() {
  const live = new Set(tiles.map((t) => t.id));
  const keep = <V>(m: Map<string, V>) => Object.fromEntries([...m].filter(([k]) => live.has(k)));
  hm.setLayout({ v: 1, placed: keep(placed), entered: keep(entered), finished: [...finished].filter((k) => live.has(k)), notes: keep(notes), cleared: [...cleared].filter((k) => live.has(k)) } satisfies Saved);
}

// ── rendering ────────────────────────────────────────────────────────────────
const colEls = new Map<Col, HTMLElement>();
const cardEls = new Map<string, HTMLElement>();

for (const c of COLS) {
  const el = document.createElement("section");
  el.className = "b-col";
  el.dataset.col = c.id;
  el.innerHTML = '<header><h2></h2><span class="b-count"></span><button type="button" class="b-clear" hidden>Clear</button></header><div class="b-cards" role="list"></div><p class="b-empty"></p>';
  el.querySelector("h2")!.textContent = c.label;
  el.querySelector(".b-empty")!.textContent = c.empty;
  el.querySelector(".b-clear")!.addEventListener("click", () => {
    for (const t of on()) if (columnOf(t.id) === "done") cleared.add(t.id);
    persist();
    invalidate();
  });
  boardEl.append(el);
  colEls.set(c.id, el);
}

function card(t: ViewTile): HTMLElement {
  let el = cardEls.get(t.id);
  if (!el) {
    el = document.createElement("article");
    el.className = "b-card";
    el.tabIndex = 0;
    el.dataset.id = t.id;
    el.setAttribute("role", "listitem");
    el.innerHTML = '<div class="b-top"><svg class="b-mark" viewBox="0 0 12 12" aria-hidden="true"></svg><span class="b-name"></span><span class="b-time"></span></div><div class="b-meta"><i></i><span class="b-frame"></span></div><p class="b-note"></p>';
    attachDrag(el, t.id);
    el.addEventListener("keydown", (e) => onCardKey(e, t.id));
    cardEls.set(t.id, el);
  }
  return el;
}

function render() {
  const now = Date.now();
  const cards = on();
  const byCol = new Map<Col, ViewTile[]>(COLS.map((c) => [c.id, []]));
  for (const t of cards) byCol.get(columnOf(t.id))!.push(t);
  for (const list of byCol.values()) list.sort((a, b) => (entered.get(a.id) ?? 0) - (entered.get(b.id) ?? 0));

  const before = new Map([...cardEls].map(([id, el]) => [id, el.getBoundingClientRect()]));

  for (const c of COLS) {
    const col = colEls.get(c.id)!;
    const list = byCol.get(c.id)!;
    const count = col.querySelector(".b-count") as HTMLElement;
    count.textContent = c.id === "doing" ? `${list.length}/${WIP}` : String(list.length);
    col.toggleAttribute("data-over-limit", c.id === "doing" && list.length > WIP);
    (col.querySelector(".b-clear") as HTMLElement).hidden = !(c.id === "done" && list.length);
    (col.querySelector(".b-empty") as HTMLElement).hidden = list.length > 0;
    const holder = col.querySelector(".b-cards")!;
    list.forEach((t, i) => {
      const el = card(t);
      const mark = markOf(t.id, c.id);
      if (el.dataset.mark !== mark) { el.dataset.mark = mark; el.querySelector(".b-mark")!.innerHTML = MARK[mark]; }
      (el.querySelector(".b-name") as HTMLElement).textContent = nameOf(t);
      const at = entered.get(t.id);
      (el.querySelector(".b-time") as HTMLElement).textContent = at ? ago(now - at) : "";
      const f = frames.find((x) => x.id === t.frameId);
      const meta = el.querySelector(".b-meta") as HTMLElement;
      meta.style.setProperty("--c", f?.color ?? "transparent");
      (meta.querySelector(".b-frame") as HTMLElement).textContent = f?.title ?? "No frame";
      const note = el.querySelector(".b-note") as HTMLElement;
      const refused = (refusal.get(t.id) ?? 0) > now - 2400;
      note.textContent = refused ? (status.get(t.id) === "working" ? "Still working — it moves on its own when it finishes." : "Waiting on you — answer it first.") : notes.get(t.id) ?? "";
      note.hidden = !note.textContent;
      el.toggleAttribute("data-refused", refused);
      el.toggleAttribute("data-reviewing", t.id === reviewing);
      if (holder.children[i] !== el) holder.insertBefore(el, holder.children[i] ?? null);
    });
    for (const child of [...holder.children]) if (!list.some((t) => cardEls.get(t.id) === child)) child.remove();
  }
  for (const [id, el] of cardEls) if (!cards.some((t) => t.id === id)) { el.remove(); cardEls.delete(id); }

  // A card that changed column travels there, so the change is seen rather than inferred.
  if (!reduce.matches) {
    for (const [id, el] of cardEls) {
      const b = before.get(id);
      if (!b || !el.isConnected || drag?.id === id) continue;
      const a = el.getBoundingClientRect();
      const dx = b.left - a.left, dy = b.top - a.top;
      if (Math.abs(dx) + Math.abs(dy) > 2) el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 260, easing: "cubic-bezier(0.23, 1, 0.32, 1)" });
    }
  }

  const needs = byCol.get("needs")!.length, review = byCol.get("review")!.length, doing = byCol.get("doing")!.length;
  summaryEl.textContent = [`${cards.length} session${cards.length === 1 ? "" : "s"}`, needs && `${needs} need${needs === 1 ? "s" : ""} you`, review && `${review} to review`, doing > WIP && `${doing - WIP} over the limit`].filter(Boolean).join(" · ");

  document.body.toggleAttribute("data-reviewing", !!reviewing);
  if (reviewing) {
    const t = tiles.find((x) => x.id === reviewing);
    panelTitle.textContent = t ? nameOf(t) : "";
  }
  applyPanel();
  // A refusal note explains itself for a moment and then goes; one timer, only while one is showing.
  for (const [id, at] of refusal) if (at <= now - 2400) refusal.delete(id);
  if (refusal.size) setTimeout(invalidate, 2500);
}

const { invalidate } = createInvalidator(hm, render);

// ── the review panel: the session's live terminal, beside the board ──────────
const PANEL_TOP = 56;          // clear of the settings button the app floats over every view
const PANEL_HEAD = 48;
function panelWidth() { return Math.round(Math.min(860, Math.max(420, hm.viewport.w * 0.46))); }
function applyPanel() {
  const w = panelWidth();
  document.body.style.setProperty("--panel-w", `${w}px`);
  panelEl.hidden = !reviewing;
  if (!reviewing) { hm.setSurfaceRects([]); return; }
  const x = hm.viewport.w - w;
  hm.setSurfaceRects([{ tileId: reviewing, x: x + 10, y: PANEL_TOP + PANEL_HEAD, w: w - 20, h: hm.viewport.h - PANEL_TOP - PANEL_HEAD - 10, chrome: "none" }]);
}
function review(id: string | null) {
  reviewing = id;
  if (id) hm.commands.selectTile(id);
  invalidate();
}
$(".b-close").addEventListener("click", () => review(null));
for (const b of document.querySelectorAll<HTMLButtonElement>(".b-panel-actions [data-to]")) {
  b.addEventListener("click", () => { if (reviewing) move(reviewing, b.dataset.to as Col); });
}

// ── dragging: the card follows the pointer on a spring and leans into the motion ──
let drag: null | {
  id: string; card: HTMLElement; ghost: HTMLElement | null; ox: number; oy: number; sx: number; sy: number;
  x: number; y: number; vx: number; vy: number; tx: number; ty: number; over: Col | null; raf: number; last: number; dropping: boolean;
} = null;

function columnAt(x: number, y: number): Col | null {
  for (const [id, el] of colEls) { const r = el.getBoundingClientRect(); if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return id; }
  return null;
}

function stepDrag(now: number) {
  if (!drag || !drag.ghost) return;
  const dt = Math.min(1 / 30, (now - drag.last) / 1000);
  drag.last = now;
  const k = 700, c = 50;
  drag.vx += (k * (drag.tx - drag.x) - c * drag.vx) * dt; drag.x += drag.vx * dt;
  drag.vy += (k * (drag.ty - drag.y) - c * drag.vy) * dt; drag.y += drag.vy * dt;
  const tilt = drag.dropping ? 0 : Math.max(-7, Math.min(7, drag.vx / 95));
  drag.ghost.style.transform = `translate3d(${drag.x.toFixed(1)}px, ${drag.y.toFixed(1)}px, 0) rotate(${tilt.toFixed(2)}deg) scale(${drag.dropping ? 1 : 1.03})`;
  hm.reportFrame();
  const settled = Math.abs(drag.tx - drag.x) < 0.5 && Math.abs(drag.ty - drag.y) < 0.5 && Math.hypot(drag.vx, drag.vy) < 8;
  if (drag.dropping && settled) { finishDrop(); return; }
  drag.raf = requestAnimationFrame(stepDrag);
}

function finishDrop() {
  if (!drag) return;
  drag.ghost?.remove();
  drag.card.removeAttribute("data-dragging");
  for (const el of colEls.values()) el.removeAttribute("data-drop");
  drag = null;
}

function attachDrag(el: HTMLElement, id: string) {
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || drag) return;
    const r = el.getBoundingClientRect();
    drag = { id, card: el, ghost: null, ox: e.clientX - r.left, oy: e.clientY - r.top, sx: e.clientX, sy: e.clientY, x: r.left, y: r.top, vx: 0, vy: 0, tx: r.left, ty: r.top, over: null, raf: 0, last: performance.now(), dropping: false };
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener("pointermove", (e) => {
    if (!drag || drag.id !== id || drag.dropping) return;
    if (!drag.ghost) {
      if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 5) return;
      const ghost = el.cloneNode(true) as HTMLElement;
      ghost.classList.add("b-ghost");
      ghost.style.width = `${el.getBoundingClientRect().width}px`;
      document.body.append(ghost);
      drag.ghost = ghost;
      el.setAttribute("data-dragging", "");
      if (reduce.matches) ghost.style.transform = `translate3d(${drag.x}px, ${drag.y}px, 0)`;
      else drag.raf = requestAnimationFrame(stepDrag);
    }
    drag.tx = e.clientX - drag.ox;
    drag.ty = e.clientY - drag.oy;
    if (reduce.matches) drag.ghost.style.transform = `translate3d(${drag.tx}px, ${drag.ty}px, 0)`;
    const over = columnAt(e.clientX, e.clientY);
    if (over !== drag.over) {
      for (const [cid, colEl] of colEls) colEl.toggleAttribute("data-drop", cid === over && cid !== columnOf(id));
      drag.over = over;
    }
  });
  const end = () => {
    if (!drag || drag.id !== id || drag.dropping) return;
    if (!drag.ghost) { drag = null; review(id); return; }            // no movement: a click opens review
    if (drag.over) move(id, drag.over);
    render();                                                        // lay out now, so the card's new home is measurable
    if (reduce.matches) { finishDrop(); return; }
    const home = el.getBoundingClientRect();
    drag.dropping = true;
    drag.tx = home.left;
    drag.ty = home.top;
    if (!drag.raf) drag.raf = requestAnimationFrame(stepDrag);
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
}

// ── keyboard: every move a drag can make ─────────────────────────────────────
function onCardKey(e: KeyboardEvent, id: string) {
  const order = COLS.map((c) => c.id);
  const col = columnOf(id);
  if (e.shiftKey && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
    e.preventDefault();
    let i = order.indexOf(col) + (e.key === "ArrowRight" ? 1 : -1);
    if (order[i] === "needs") i += e.key === "ArrowRight" ? 1 : -1;   // status owns that column
    if (order[i]) { move(id, order[i]!); queueMicrotask(() => cardEls.get(id)?.focus()); }
  } else if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    review(id);
  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const sibling = e.key === "ArrowDown" ? (e.currentTarget as HTMLElement).nextElementSibling : (e.currentTarget as HTMLElement).previousElementSibling;
    (sibling as HTMLElement | null)?.focus();
  }
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && reviewing) { e.preventDefault(); review(null); } });

// ── host ─────────────────────────────────────────────────────────────────────
hm.on("structure", (s) => {
  frames = s.frames;
  tiles = s.tiles;
  for (const t of tiles) if (!unsub.has(t.id)) unsub.set(t.id, hm.subscribeStatus(t.id, (st) => onStatus(t.id, st)));
  for (const [id, off] of unsub) if (!tiles.some((t) => t.id === id)) { off(); unsub.delete(id); status.delete(id); }
  if (reviewing && !tiles.some((t) => t.id === reviewing)) reviewing = null;
  invalidate();
});
hm.on("names", ({ names: n }) => { for (const [id, v] of Object.entries(n)) names.set(id, v); invalidate(); });
hm.on("selection", ({ tileId, fresh }) => { if (fresh && tileId && reviewing && tileId !== reviewing && tiles.some((t) => t.id === tileId && isAgent(t))) review(tileId); });
hm.on("undock", ({ tileId }) => { if (tileId === reviewing) review(null); });
hm.on("resize", () => invalidate());
hm.on("visibility", () => invalidate());
hm.onReveal((tileId): ViewRect | null => {
  if (tileId === reviewing) { const w = panelWidth(); return { x: hm.viewport.w - w, y: PANEL_TOP, w, h: hm.viewport.h - PANEL_TOP }; }
  const el = cardEls.get(tileId);
  if (!el) return null;
  el.scrollIntoView({ block: "nearest" });
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
});

setInterval(() => { if (hm.visible) invalidate(); }, 30_000);
invalidate();
