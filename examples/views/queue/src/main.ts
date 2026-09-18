/**
 * Queue — for the person running many agents at once, whose job is to never leave one waiting.
 *
 * Agents are ordered by who needs you, and the selected one's live terminal is docked beside
 * the list: answering an approval is typing into the real terminal, not opening anything.
 *
 * What this view does not know, it does not claim. It only sees status while it is on screen,
 * so a duration is shown when the change was observed here, and a remembered one is shown as
 * "since" only if the agent is still in the state it was remembered in.
 */
import { applyThemeVars, connect, createInvalidator, type SurfaceRect, type ViewFrame, type ViewRect, type ViewStatus, type ViewTile } from "@hivemind/view-sdk";
import { createField } from "./field";

type Group = "needs" | "finished" | "working" | "quiet" | "exited" | "other";
const GROUPS: readonly { id: Group; label: string }[] = [
  { id: "needs", label: "Needs you" },
  { id: "finished", label: "Just finished" },
  { id: "working", label: "Working" },
  { id: "quiet", label: "Quiet" },
  { id: "exited", label: "Exited" },
  { id: "other", label: "Other tiles" },
];

interface Saved { v: 1; since: Record<string, [ViewStatus, number]>; finished: Record<string, number>; collapsed: Group[] }

const MARK: Record<Group, string> = {
  needs: '<path d="M6 1.2 10.8 6 6 10.8 1.2 6Z" fill="var(--hm-status-attention)"/>',
  finished: '<path d="M2.6 6.3 5 8.6 9.4 3.8" fill="none" stroke="var(--hm-status-done)" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>',
  working: '<circle cx="6" cy="6" r="4" fill="var(--hm-status-working)"/>',
  quiet: '<circle cx="6" cy="6" r="3.6" fill="none" stroke="var(--hm-status-idle)" stroke-width="1.5"/>',
  exited: '<path d="M3.2 3.2 8.8 8.8M8.8 3.2 3.2 8.8" stroke="var(--hm-status-exited)" stroke-width="1.8" stroke-linecap="round"/>',
  other: '<rect x="2.5" y="2.5" width="7" height="7" rx="1.5" fill="none" stroke="var(--hm-color-fg3)" stroke-width="1.4"/>',
};

const $ = <T extends Element>(s: string) => document.querySelector(s) as T;
const listEl = $<HTMLDivElement>(".q-list");
const summaryEl = $<HTMLParagraphElement>(".q-summary");
const dockEl = $<HTMLElement>(".q-dock");
const emptyTitle = $<HTMLParagraphElement>(".q-empty-title");
const emptySub = $<HTMLParagraphElement>(".q-empty-sub");
const offerEl = $<HTMLDivElement>(".q-offer");

const hm = await connect();
applyThemeVars(hm);
const reduce = matchMedia("(prefers-reduced-motion: reduce)");

let frames: ViewFrame[] = [];
let tiles: ViewTile[] = [];
const names = new Map<string, string>();
const status = new Map<string, ViewStatus>();
const unsub = new Map<string, () => void>();

const saved = hm.hello.layout as Saved | null;
const since = new Map<string, [ViewStatus, number]>(Object.entries(saved?.v === 1 ? saved.since : {}));
const finished = new Map<string, number>(Object.entries(saved?.v === 1 ? saved.finished : {}));
const collapsed = new Set<Group>(saved?.v === 1 ? saved.collapsed : ["other"]);

let selected: string | null = null;
let docked: string | null = null;
let offer: string | null = null;
/** A finished agent stays under "Just finished" while you look at it, and leaves once you move on. */
let visiting: string | null = null;

const isAgent = (t: ViewTile) => t.kind === "claude" || t.kind === "planReview";
const nameOf = (t: ViewTile) => names.get(t.id) ?? t.name;
const frameOf = (t: ViewTile) => frames.find((f) => f.id === t.frameId) ?? null;

function groupOf(t: ViewTile): Group {
  if (!isAgent(t)) return "other";
  const s = status.get(t.id) ?? "unknown";
  if (s === "blocked") return "needs";
  if (s === "working") return "working";
  if (s === "exited") return "exited";
  return finished.has(t.id) ? "finished" : "quiet";
}

function ordered(): Map<Group, ViewTile[]> {
  const out = new Map<Group, ViewTile[]>(GROUPS.map((g) => [g.id, []]));
  for (const t of tiles) out.get(groupOf(t))!.push(t);
  const at = (t: ViewTile) => since.get(t.id)?.[1] ?? 0;
  out.get("needs")!.sort((a, b) => at(a) - at(b));                                  // longest waiting first
  out.get("finished")!.sort((a, b) => (finished.get(b.id) ?? 0) - (finished.get(a.id) ?? 0));
  out.get("working")!.sort((a, b) => at(a) - at(b));
  for (const g of ["quiet", "exited", "other"] as const) out.get(g)!.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  return out;
}

// ── time, told honestly ──────────────────────────────────────────────────────
function duration(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d`;
}
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

// ── geometry: the list, and the dock the host fills with a real terminal ──────
const GUTTER = 12;
const OFFER_H = 46;
/** The app's settings button floats over the top-right of every view; the dock starts below it. */
const TOP = 52;
function listWidth() {
  const { w } = hm.viewport;
  return w < 720 ? w : Math.round(Math.min(420, Math.max(300, w * 0.3)));
}
function dockRect(): SurfaceRect | null {
  if (!docked) return null;
  const { w, h } = hm.viewport;
  const narrow = w < 720;
  const x = narrow ? 0 : listWidth();
  const y = narrow ? Math.round(h * 0.42) : 0;
  const top = (narrow ? GUTTER : TOP) + (offer ? OFFER_H : 0);   // the offer sits above the hole, never under it
  return { tileId: docked, x: x + GUTTER, y: y + top, w: (narrow ? w : w - x) - GUTTER * 2, h: (narrow ? h - y : h) - GUTTER - top, chrome: "bar" };
}
function applyDock() {
  const r = dockRect();
  hm.setSurfaceRects(r ? [r] : []);
  dockEl.toggleAttribute("data-docked", !!r);
}

// ── selection and docking ────────────────────────────────────────────────────
function select(id: string | null, opts: { dock?: boolean } = {}) {
  if (visiting && visiting !== id) { finished.delete(visiting); visiting = null; }
  selected = id;
  if (id && finished.has(id)) visiting = id;
  if (offer && offer === id) offer = null;
  if (id) hm.commands.selectTile(id);
  if (opts.dock ?? true) docked = id;
  applyDock();
  persist();
  invalidate();
  if (id) queueMicrotask(() => rows.get(id)?.scrollIntoView({ block: "nearest" }));
}

function release() {
  docked = null;
  offer = null;
  applyDock();
  invalidate();
}

function visibleOrder(): string[] {
  const g = ordered();
  return GROUPS.flatMap(({ id }) => (collapsed.has(id) ? [] : g.get(id)!.map((t) => t.id)));
}

function move(step: number) {
  const order = visibleOrder();
  if (!order.length) return;
  const i = selected ? order.indexOf(selected) : -1;
  select(order[Math.max(0, Math.min(order.length - 1, i < 0 ? 0 : i + step))]!);
}

function nextNeeding(except: string | null = selected) {
  return ordered().get("needs")!.find((t) => t.id !== except)?.id ?? null;
}

// ── status ───────────────────────────────────────────────────────────────────
function onStatus(id: string, s: ViewStatus) {
  const prev = status.get(id);
  status.set(id, s);
  if (prev === undefined) {
    // The first report after mounting says what it is, not since when. Keep a remembered
    // start only if the agent is still in the state it was remembered in.
    if (since.get(id)?.[0] !== s) since.delete(id);
  } else if (prev !== s) {
    since.set(id, [s, Date.now()]);
    if (prev === "working" && s === "idle") finished.set(id, Date.now());
    if (s === "working" || s === "blocked") finished.delete(id);
    if (id === docked && prev === "blocked") {
      // It stopped needing you. Offer the next one rather than jumping — you may still be typing.
      offer = nextNeeding(id);
      applyDock();
    }
  }
  persist();
  invalidate();
}

function persist() {
  const live = new Set(tiles.map((t) => t.id));
  hm.setLayout({
    v: 1,
    since: Object.fromEntries([...since].filter(([id]) => live.has(id))),
    finished: Object.fromEntries([...finished].filter(([id]) => live.has(id))),
    collapsed: [...collapsed],
  } satisfies Saved);
}

// ── rendering ────────────────────────────────────────────────────────────────
const rows = new Map<string, HTMLDivElement>();
const sections = new Map<Group, HTMLElement>();

function section(g: { id: Group; label: string }): HTMLElement {
  let el = sections.get(g.id);
  if (!el) {
    el = document.createElement("section");
    el.className = "q-group";
    el.dataset.group = g.id;
    el.innerHTML = `<h2 role="button" tabindex="-1"><svg class="chev" width="10" height="10" viewBox="0 0 10 10"><path d="M2.5 3.8 5 6.2l2.5-2.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg><span></span><span class="n"></span></h2><div class="q-rows" role="group"></div>`;
    el.querySelector("h2")!.addEventListener("click", () => {
      if (collapsed.has(g.id)) collapsed.delete(g.id); else collapsed.add(g.id);
      persist();
      invalidate();
    });
    sections.set(g.id, el);
  }
  return el;
}

function row(t: ViewTile): HTMLDivElement {
  let el = rows.get(t.id);
  if (!el) {
    el = document.createElement("div");
    el.className = "q-row";
    el.setAttribute("role", "option");
    el.dataset.id = t.id;
    el.innerHTML = `<svg class="q-mark" viewBox="0 0 12 12" aria-hidden="true"></svg><span class="q-name"></span><span class="q-time"></span><span class="q-frame"><i></i><span></span></span>`;
    el.addEventListener("click", () => { select(t.id); listEl.focus({ preventScroll: true }); });
    rows.set(t.id, el);
  }
  return el;
}

function render() {
  const groups = ordered();
  const before = new Map([...rows].map(([id, el]) => [id, el.getBoundingClientRect().top]));
  const now = Date.now();
  const agents = tiles.filter(isAgent);
  const needs = groups.get("needs")!.length;
  const working = groups.get("working")!.length;

  for (const g of GROUPS) {
    const list = groups.get(g.id)!;
    const sec = section(g);
    if (!list.length) { sec.remove(); continue; }
    sec.toggleAttribute("data-collapsed", collapsed.has(g.id));
    const [label, count] = sec.querySelectorAll("h2 span");
    label!.textContent = g.label;
    count!.textContent = String(list.length);
    const holder = sec.querySelector(".q-rows")!;
    list.forEach((t, i) => {
      const el = row(t);
      const mark = MARK[g.id];
      if (el.dataset.group !== g.id) { el.dataset.group = g.id; el.querySelector(".q-mark")!.innerHTML = mark; }
      el.setAttribute("aria-selected", String(t.id === selected));
      el.toggleAttribute("data-released", t.id === selected && docked !== t.id);
      (el.querySelector(".q-name") as HTMLElement).textContent = nameOf(t);
      const f = frameOf(t);
      const frameEl = el.querySelector(".q-frame") as HTMLElement;
      frameEl.style.setProperty("--c", f?.color ?? "transparent");
      frameEl.querySelector("span")!.textContent = f?.title ?? "No frame";
      const timeEl = el.querySelector(".q-time") as HTMLElement;
      const rec = since.get(t.id);
      const shown = g.id === "finished" ? finished.get(t.id) : rec?.[1];
      timeEl.textContent = shown ? duration(now - shown) : "";
      timeEl.title = shown ? `since ${clock(shown)}` : "";
      if (holder.children[i] !== el) holder.insertBefore(el, holder.children[i] ?? null);
    });
    for (const child of [...holder.children]) if (!list.some((t) => rows.get(t.id) === child)) child.remove();
  }
  // Sections in fixed order, whatever order they were created in; empty ones stay out.
  for (const g of GROUPS) if (groups.get(g.id)!.length) listEl.append(section(g));
  for (const [id, el] of rows) if (!tiles.some((t) => t.id === id)) { el.remove(); rows.delete(id); }

  // A row that changed group travels to its place, so you can see where it went.
  if (!reduce.matches) {
    for (const [id, el] of rows) {
      const top = before.get(id);
      if (top === undefined || !el.isConnected) continue;
      const dy = top - el.getBoundingClientRect().top;
      if (Math.abs(dy) > 2) el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 220, easing: "cubic-bezier(0.23, 1, 0.32, 1)" });
    }
  }

  const lead = needs ? Object.assign(document.createElement("b"), { textContent: `${needs} need${needs === 1 ? "s" : ""} you` }) : "Nothing needs you";
  summaryEl.replaceChildren(lead, working ? ` · ${working} working` : "");

  if (!agents.length) { emptyTitle.textContent = "No agents yet"; emptySub.textContent = "Start one from the toolbar and it will appear here."; }
  else if (needs) { emptyTitle.textContent = `${needs} ${needs === 1 ? "agent needs" : "agents need"} you`; emptySub.textContent = "Press N for the one that has waited longest."; }
  else { emptyTitle.textContent = "Nothing needs you"; emptySub.textContent = [working && `${working} working`, groups.get("quiet")!.length && `${groups.get("quiet")!.length} quiet`].filter(Boolean).join(" · ") || "All quiet."; }

  const next = offer ? tiles.find((t) => t.id === offer) : undefined;
  if (next) {
    // Agent titles are set by agents: text nodes only, never markup.
    const done = tiles.find((t) => t.id === docked);
    const note = document.createElement("span");
    note.textContent = `${done ? nameOf(done) : "It"} is moving again.`;
    const go = document.createElement("button");
    go.type = "button";
    go.append(`Next: ${nameOf(next)} `, Object.assign(document.createElement("kbd"), { textContent: "N" }));
    offerEl.replaceChildren(note, go);
  }
  offerEl.hidden = !next;

  field?.setEnergy(agents.length ? working / agents.length : 0);
  field?.setActive(!docked && !needs && hm.visible);
}

const { invalidate } = createInvalidator(hm, render);

// ── the field ────────────────────────────────────────────────────────────────
const field = (() => { try { return createField($<HTMLCanvasElement>(".q-field")); } catch { return null; } })();
if (!field) dockEl.classList.add("no-gl");
// Neutral on purpose: colour in this view means an agent's state, and the field is not one.
const paintField = () => {
  const css = getComputedStyle(document.documentElement);
  field?.setColors(css.getPropertyValue("--hm-color-fg3").trim() || "#777777", css.getPropertyValue("--hm-color-fg").trim() || "#e6e6e6");
};
paintField();
field?.onFrame(() => hm.reportFrame());

// ── host ─────────────────────────────────────────────────────────────────────
hm.on("structure", (s) => {
  frames = s.frames;
  tiles = s.tiles;
  for (const t of tiles) if (!unsub.has(t.id)) unsub.set(t.id, hm.subscribeStatus(t.id, (st) => onStatus(t.id, st)));
  for (const [id, off] of unsub) if (!tiles.some((t) => t.id === id)) { off(); unsub.delete(id); status.delete(id); }
  if (selected && !tiles.some((t) => t.id === selected)) { selected = null; release(); }
  invalidate();
});
hm.on("names", ({ names: n }) => { for (const [id, v] of Object.entries(n)) names.set(id, v); invalidate(); });
hm.on("selection", ({ tileId, fresh }) => {
  const t = tileId ? tiles.find((x) => x.id === tileId) : undefined;
  if (!t || t.id === selected) return;
  // A choice made elsewhere while this view is open is followed. What was selected when you
  // arrived is only marked: you came here for the queue, not for whatever was last clicked.
  if (fresh) select(t.id);
  else if (isAgent(t)) select(t.id, { dock: false });
});
hm.on("resize", () => { document.body.style.setProperty("--list-w", `${listWidth()}px`); applyDock(); invalidate(); });
hm.on("undock", ({ tileId }) => { if (tileId === docked) { docked = null; offer = null; dockEl.removeAttribute("data-docked"); invalidate(); } });
hm.on("visibility", () => invalidate());
hm.on("theme", () => { paintField(); invalidate(); });
hm.onReveal((tileId): ViewRect | null => {
  const r = dockRect();
  if (r && r.tileId === tileId) return { x: r.x, y: r.y, w: r.w, h: r.h };
  const el = rows.get(tileId);
  if (!el) return null;
  el.scrollIntoView({ block: "nearest" });
  const b = el.getBoundingClientRect();
  return { x: b.left, y: b.top, w: b.width, h: b.height };
});

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === "j" || e.key === "ArrowDown") { e.preventDefault(); move(1); }
  else if (k === "k" || e.key === "ArrowUp") { e.preventDefault(); move(-1); }
  else if (k === "n") { const id = offer ?? nextNeeding(); if (id) { e.preventDefault(); select(id); } }
  else if (e.key === "Enter" && selected) { e.preventDefault(); select(selected); }
  else if (e.key === "Escape" && docked) { e.preventDefault(); release(); }
});
offerEl.addEventListener("click", (e) => { if ((e.target as Element).closest("button") && offer) select(offer); });

// Durations age while you watch; nothing else needs a timer.
setInterval(() => { if (hm.visible) invalidate(); }, 20_000);

document.body.style.setProperty("--list-w", `${listWidth()}px`);
invalidate();
