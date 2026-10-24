/**
 * Windows — the open tiles as an editor's panes: split right or down, each pane its own tabs, the
 * dividers dragged, one pane maximized. The Layers rail beside it is the app's own (`"layers": true`),
 * so every frame action is there. Selection is one fact, the app's: whatever selects a tile (a tab,
 * the rail, a spawn, `hive ctl focus`) shows it in its pane and focuses that pane, bringing it back
 * if it was minimized. It keeps the panes and which tiles are minimized, each person their own.
 */
import { applyThemeVars, connect, type ViewFrame, type ViewTile } from "@hivemind/view-sdk";
import {
  MAX_PANES, activate, closePane, equalize, layout, moveTab, neighbor, normalize, paneById, paneOf, panes, readTree, resize, single, split, toggleZoom, unsplit,
  type Divider, type Layout, type Side, type Tree,
} from "./tree";

interface SavedV1 { v: 1; minimized: string[]; active: string | null }
interface SavedV2 { v: 2; tree: Tree; minimized: string[] }

const roomEl = document.querySelector(".w-room") as HTMLElement;
/** Pixels between panes: the divider's grip. */
const GAP = 6;
/** A pane's corner radius in windows.css: the surface drawn into it matches. */
const PANE_RADIUS = 12;
/** Room kept at the end of a strip that runs under the app's corner buttons. */
const CORNER = 44;

const hm = await connect();
applyThemeVars(hm);

let frames: ViewFrame[] = [];
let tiles: ViewTile[] = [];
const names = new Map<string, string>();
let selected: string | null = null;
let seq = 0;
const newPaneId = () => `p${Date.now().toString(36)}${(seq++).toString(36)}`;

const saved = hm.hello.layout as SavedV1 | SavedV2 | null;
const minimized = new Set<string>(saved?.v ? saved.minimized : []);
let tree: Tree = (saved?.v === 2 && readTree(saved.tree)) || single(newPaneId(), saved?.v === 1 && saved.active ? [saved.active] : []);
let savedJson = "";
/** Kept as it changes: at once for a change made in one step, gathered while a divider is dragged. */
function save(now = false) {
  const next = JSON.stringify({ v: 2, tree, minimized: [...minimized] } satisfies SavedV2);
  if (next !== savedJson) { savedJson = next; hm.setLayout(JSON.parse(next), { now: now && !dragging }); }
}

const open = () => tiles.map((t) => t.id);
const nameOf = (id: string) => names.get(id) ?? tiles.find((t) => t.id === id)?.name ?? id;

/** One change to the panes: made, put right, kept, drawn. */
function change(next: Tree) {
  tree = normalize(next, open(), minimized);
  save(true);
  render();
}

function minimize(id: string) {
  minimized.add(id);
  if (id === selected) hm.commands.selectTile(null);
  change(tree);
}

function splitActive(side: Side, paneId = tree.focus) {
  const p = paneById(tree, paneId);
  // With one tab there is nothing to move: the new pane waits for the next tile.
  const tile = p && p.tabs.length > 1 ? p.active : null;
  change(split(tree, paneId, side, tile, newPaneId()));
  const moved = paneById(tree, tree.focus)?.active;
  if (moved) hm.commands.selectTile(moved);
}

function focusPane(id: string | null) {
  if (!id) return;
  const p = paneById(tree, id);
  change(activate(tree, id, p?.active ?? null));
  if (p?.active) hm.commands.selectTile(p.active);
}

// ── Drawing ────────────────────────────────────────────────────────────────────────────────────────

const ICON: Record<string, string> = {
  right: '<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="M12 4.5v15"/>',
  down: '<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="M3.5 12h17"/>',
  zoom: '<path d="M9 4.5H6.5a2 2 0 0 0-2 2V9M15 4.5h2.5a2 2 0 0 1 2 2V9M9 19.5H6.5a2 2 0 0 1-2-2V15M15 19.5h2.5a2 2 0 0 0 2-2V15"/>',
  restore: '<path d="M9 4.5V7a2 2 0 0 1-2 2H4.5M15 4.5V7a2 2 0 0 0 2 2h2.5M9 19.5V17a2 2 0 0 0-2-2H4.5M15 19.5V17a2 2 0 0 1 2-2h2.5"/>',
  close: '<path d="M7 7l10 10M17 7 7 17"/>',
  min: '<path d="M7 12h10"/>',
};
const svg = (name: string) => `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;

function iconButton(cls: string, label: string, icon: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button"; b.className = cls; b.title = label; b.setAttribute("aria-label", label); b.innerHTML = svg(icon);
  b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
  return b;
}

/** Each tab's element, made once: a redraw updates it in place, so a click that redraws first still lands. */
const tabEls = new Map<string, HTMLElement>();

function tabEl(id: string): HTMLElement {
  let tab = tabEls.get(id);
  if (tab) return tab;
  tab = document.createElement("div");
  tab.className = "w-tab"; tab.setAttribute("role", "tab"); tab.tabIndex = 0;
  tab.dataset.tileId = id;
  tab.innerHTML = '<span class="w-dot" aria-hidden="true"></span><span class="w-mark" aria-hidden="true"></span><span class="w-name"></span>';
  const label = tab.querySelector(".w-name") as HTMLElement;
  // The full name on hover only when the tab cuts it short.
  tab.addEventListener("pointerenter", () => { tab!.title = label.scrollWidth > label.clientWidth ? nameOf(id) : ""; });
  tab.append(iconButton("w-act", "Minimize", "min", () => minimize(id)));
  if (hm.capabilities.includes("workspace:close")) tab.append(iconButton("w-act", "Close", "close", () => hm.commands.closeTile(id)));
  tab.addEventListener("click", () => { if (dropped) return; const p = paneOf(tree, id); if (p) change(activate(tree, p.id, id)); hm.commands.selectTile(id); });
  tab.addEventListener("pointerdown", (e) => { if (e.button === 0 && !(e.target as Element).closest(".w-act")) dragTab(id, tab!, e); });
  tab.addEventListener("auxclick", (e) => { if (e.button === 1) { e.preventDefault(); minimize(id); } });
  tab.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); hm.commands.selectTile(id); } });
  tabEls.set(id, tab);
  return tab;
}

/** A tab brought up to date: shown or not, its frame's colour, the app's mark for it, its name. */
function updateTab(tab: HTMLElement, id: string, active: boolean, color: Map<string, string>) {
  const t = tiles.find((x) => x.id === id);
  const name = nameOf(id);
  tab.setAttribute("aria-selected", String(active));
  (tab.querySelector(".w-dot") as HTMLElement).style.background = (t?.frameId && color.get(t.frameId)) || "var(--hm-color-fg3)";
  const mark = tab.querySelector(".w-mark") as HTMLElement;
  if (mark.dataset.icon !== (t?.icon ?? "")) { mark.dataset.icon = t?.icon ?? ""; mark.innerHTML = t?.icon ?? ""; }
  (tab.querySelector(".w-name") as HTMLElement).textContent = name;
  const [min, close] = tab.querySelectorAll<HTMLElement>(".w-act");
  min?.setAttribute("aria-label", `Minimize ${name}`); if (min) min.title = `Minimize ${name}`;
  close?.setAttribute("aria-label", `Close ${name}`); if (close) close.title = `Close ${name}`;
}

const MOD = navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl+";

/** While a divider is under the pointer or dragged, the terminals let the pointer through to it:
 *  set before the drag starts, so its first moves are not caught by the terminal beside it. */
let dragging = false;
let gripped = false;
const paneEls = new Map<string, HTMLElement>();
/** The dividers, in a layer of their own: the panes are never re-inserted, which would lose their strips' scroll. */
const dividersEl = document.createElement("div");
dividersEl.className = "w-dividers";
roomEl.append(dividersEl);
/** The tab each pane last brought into view: a re-render leaves the strip's scroll alone. */
const scrolledTo = new Map<string, string | null>();
let shown: Layout = { panes: [], dividers: [] };

function render() {
  tree = normalize(tree, open(), minimized);
  save();
  const all = panes(tree.root);
  const focused = paneById(tree, tree.focus)!;
  // A tab chosen by the rules, not by a selection, is made the selection: its body takes the keys.
  if (focused.active && focused.active !== selected) hm.commands.selectTile(focused.active);
  const color = new Map(frames.map((f) => [f.id, f.color]));
  const room = roomEl.getBoundingClientRect();
  shown = layout(tree, { x: 0, y: 0, w: room.width, h: room.height }, GAP);
  const many = all.length > 1;
  for (const box of shown.panes) {
    const p = paneById(tree, box.id)!;
    let el = paneEls.get(p.id);
    if (!el) {
      el = document.createElement("section");
      el.className = "w-pane"; el.dataset.pane = p.id;
      el.innerHTML = '<header class="w-bar"><nav class="w-tabs" role="tablist"></nav><div class="w-tools"></div></header><div class="w-stage"><p class="w-empty"></p></div>';
      const tabs = el.querySelector(".w-tabs") as HTMLElement;
      // The strip scrolls sideways under a plain wheel too: its scrollbar is hidden.
      tabs.addEventListener("wheel", (e) => {
        if (!e.deltaY || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
        e.preventDefault();
        tabs.scrollLeft += e.deltaY;
      }, { passive: false });
      const id = p.id;
      const tool = (name: string, label: string, icon: string, run: () => void) => { const b = iconButton("w-tool", label, icon, run); b.dataset.paneTool = name; return b; };
      (el.querySelector(".w-tools") as HTMLElement).append(
        tool("Split right", `Split right (${MOD}\\)`, "right", () => splitActive("right", id)),
        tool("Split down", `Split down (${MOD}Shift+\\)`, "down", () => splitActive("down", id)),
        tool("Maximize", "Maximize", "zoom", () => change(toggleZoom(tree, id))),
        tool("Close pane", "Close pane: its tabs join the next one", "close", () => change(closePane(tree, id))),
      );
      el.addEventListener("pointerdown", () => { if (tree.focus !== id) focusPane(id); });
      paneEls.set(p.id, el);
    }
    Object.assign(el.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` });
    el.toggleAttribute("data-focused", many && p.id === tree.focus);
    el.toggleAttribute("data-corner", box.y === 0 && box.x + box.w >= room.width - 1);
    el.style.setProperty("--corner", `${CORNER}px`);
    const tabsEl = el.querySelector(".w-tabs") as HTMLElement;
    tabsEl.setAttribute("aria-label", `Pane ${all.indexOf(p) + 1}`);
    const want = p.tabs.map((id) => { const tab = tabEl(id); updateTab(tab, id, id === p.active, color); return tab; });
    // Moved only when the order is not already right: moving a node loses nothing, but needs doing once.
    if (want.length !== tabsEl.children.length || want.some((tab, i) => tabsEl.children[i] !== tab)) tabsEl.replaceChildren(...want);
    const zoomed = tree.zoom === p.id;
    const zoom = el.querySelector('[data-pane-tool="Maximize"], [data-pane-tool="Restore"]') as HTMLButtonElement;
    const label = zoomed ? `Restore (${MOD}Shift+Enter)` : `Maximize (${MOD}Shift+Enter)`;
    zoom.dataset.paneTool = zoomed ? "Restore" : "Maximize"; zoom.title = label; zoom.setAttribute("aria-label", label); zoom.innerHTML = svg(zoomed ? "restore" : "zoom");
    zoom.hidden = !many;
    (el.querySelector('[data-pane-tool="Close pane"]') as HTMLElement).hidden = !many;
    const empty = el.querySelector(".w-empty") as HTMLElement;
    // While a tab is dragged the terminals step aside, so where it would land can be drawn: each
    // pane says which tab it shows meanwhile.
    empty.hidden = !!p.active && !tabDrag;
    empty.textContent = tabDrag && p.active ? nameOf(p.active)
      : tiles.length ? "Empty pane. The next tile you open or select from the rail shows here." : "Nothing open. Start an agent from the panel, or restore a tile from the rail.";
    if (!el.isConnected) roomEl.insertBefore(el, dividersEl);
    if (scrolledTo.get(p.id) !== p.active) {
      scrolledTo.set(p.id, p.active);
      tabsEl.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }
  for (const [id, el] of paneEls) if (!shown.panes.some((b) => b.id === id)) { el.remove(); paneEls.delete(id); scrolledTo.delete(id); }
  // Kept by place, so the one being dragged is the same element under the pointer throughout.
  const keep = new Set<string>();
  for (const d of shown.dividers) {
    const key = `${d.path.join(".")}:${d.i}:${d.dir}`;
    keep.add(key);
    let el = dividerEls.get(key);
    if (!el) { el = dividerEl(key); dividerEls.set(key, el); dividersEl.append(el); }
    el.dataset.dir = d.dir;
    el.setAttribute("aria-orientation", d.dir === "row" ? "vertical" : "horizontal");
    Object.assign(el.style, { left: `${d.x}px`, top: `${d.y}px`, width: `${d.w}px`, height: `${d.h}px` });
  }
  for (const [key, el] of dividerEls) if (!keep.has(key)) { el.remove(); dividerEls.delete(key); }
  // Each pane's shown tile fills its stage, inside the card's edge.
  hm.setSurfaceRects(tabDrag ? [] : shown.panes.flatMap((box) => {
    const active = paneById(tree, box.id)?.active;
    const stage = paneEls.get(box.id)?.querySelector(".w-stage");
    if (!active || !stage) return [];
    const r = stage.getBoundingClientRect();
    return [{ tileId: active, x: r.left, y: r.top, w: Math.max(0, r.width), h: Math.max(0, r.height), chrome: "none" as const, radius: PANE_RADIUS - 1, ...(dragging || gripped ? { inert: true as const } : {}) }];
  }));
}

const dividerEls = new Map<string, HTMLElement>();
/** The divider laid out under `key` now. */
const dividerAt = (key: string) => shown.dividers.find((d) => `${d.path.join(".")}:${d.i}:${d.dir}` === key);

function dividerEl(key: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "w-divider"; el.setAttribute("role", "separator");
  el.title = "Drag to resize; double-click to make them equal";
  el.addEventListener("dblclick", () => { const d = dividerAt(key); if (d) change(equalize(tree, d.path)); });
  el.addEventListener("pointerenter", () => { if (!gripped) { gripped = true; render(); } });
  el.addEventListener("pointerleave", () => { if (gripped && !dragging) { gripped = false; render(); } });
  el.addEventListener("pointerdown", (e) => {
    const d = dividerAt(key);
    if (!d) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    el.toggleAttribute("data-dragging", true);
    dragging = true;
    render();
    const start = d.dir === "row" ? e.clientX : e.clientY;
    const base = tree;
    // The split's own length, from the panes it lays out.
    const span = splitSpan(d);
    const move = (ev: PointerEvent) => {
      const at = d.dir === "row" ? ev.clientX : ev.clientY;
      tree = resize(base, d.path, d.i, (at - start) / span);
      render();
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up);
      // Where it was let go: the moves just before may have been merged into this one.
      if (ev.type === "pointerup") tree = resize(base, d.path, d.i, ((d.dir === "row" ? ev.clientX : ev.clientY) - start) / span);
      el.toggleAttribute("data-dragging", false);
      dragging = false;
      gripped = el.matches(":hover");
      change(tree);
    };
    // Followed on the window, not the grip: the grip can lose its capture partway (seen in the app's
    // window with no change to the page), and its moves and its release would then go elsewhere,
    // leaving the drag held short of where it was let go.
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  });
  return el;
}

/** The length the split at a divider shares among its children, gaps taken out. */
function splitSpan(d: Divider): number {
  let n = tree.root;
  for (const i of d.path) if (n.t === "split") n = n.kids[i]!;
  if (n.t !== "split") return 1;
  const ids = new Set(panes(n).map((p) => p.id));
  const boxes = shown.panes.filter((b) => ids.has(b.id));
  const lo = Math.min(...boxes.map((b) => (d.dir === "row" ? b.x : b.y)));
  const hi = Math.max(...boxes.map((b) => (d.dir === "row" ? b.x + b.w : b.y + b.h)));
  return Math.max(1, hi - lo - GAP * (n.kids.length - 1));
}

// ── A tab dragged to another pane ──────────────────────────────────────────────────────────────────

/** Where a dragged tab lands: among a pane's tabs at `at`, or beside a pane, splitting it. */
type Drop = { pane: string; at: number } | { pane: string; side: Side };

/** The tab being dragged, once it has moved far enough to be a drag and not a click. */
let tabDrag: string | null = null;
/** A drag just ended: the click it ends with is not a click on the tab. */
let dropped = false;
const dropEl = document.createElement("div");
dropEl.className = "w-drop"; dropEl.hidden = true;
const ghostEl = document.createElement("div");
ghostEl.className = "w-ghost"; ghostEl.hidden = true;
roomEl.append(dropEl, ghostEl);

/** What a drop at (x, y) does: on a strip, among its tabs; on a pane, beside it near an edge and
 *  into it elsewhere. */
function dropAt(x: number, y: number, tile: string): Drop | null {
  for (const [id, el] of paneEls) {
    const r = el.getBoundingClientRect();
    if (x < r.left || x >= r.right || y < r.top || y >= r.bottom) continue;
    const others = [...el.querySelectorAll<HTMLElement>(".w-tab")].filter((t) => t.dataset.tileId !== tile);
    const end = { pane: id, at: others.length };
    if (y < (el.querySelector(".w-bar") as HTMLElement).getBoundingClientRect().bottom) {
      const at = others.findIndex((t) => { const b = t.getBoundingClientRect(); return x < b.left + b.width / 2; });
      return at < 0 ? end : { pane: id, at };
    }
    const s = (el.querySelector(".w-stage") as HTMLElement).getBoundingClientRect();
    const fx = (x - s.left) / s.width;
    const fy = (y - s.top) / s.height;
    const near = Math.min(fx, 1 - fx, fy, 1 - fy);
    if (near > 0.25 || panes(tree.root).length >= MAX_PANES) return end;
    return { pane: id, side: near === fx ? "left" : near === 1 - fx ? "right" : near === fy ? "up" : "down" };
  }
  return null;
}

/** The drop drawn: a line between two tabs, the half of a pane a split would give, or the pane. */
function showDrop(drop: Drop | null) {
  dropEl.hidden = !drop;
  if (!drop) return;
  const el = paneEls.get(drop.pane)!;
  const room = roomEl.getBoundingClientRect();
  let r: { left: number; top: number; width: number; height: number };
  if ("side" in drop) {
    const s = (el.querySelector(".w-stage") as HTMLElement).getBoundingClientRect();
    r = { left: drop.side === "right" ? s.left + s.width / 2 : s.left, top: drop.side === "down" ? s.top + s.height / 2 : s.top,
      width: drop.side === "left" || drop.side === "right" ? s.width / 2 : s.width, height: drop.side === "up" || drop.side === "down" ? s.height / 2 : s.height };
  } else {
    const bar = (el.querySelector(".w-bar") as HTMLElement).getBoundingClientRect();
    const others = [...el.querySelectorAll<HTMLElement>(".w-tab")].filter((t) => !t.hasAttribute("data-dragged"));
    const next = others[drop.at];
    const prev = others[drop.at - 1];
    const x = next ? next.getBoundingClientRect().left - 2 : prev ? prev.getBoundingClientRect().right + 1 : bar.left + 6;
    r = { left: x, top: bar.top + 6, width: 2, height: bar.height - 12 };
  }
  dropEl.dataset.kind = "side" in drop ? "split" : "tabs";
  Object.assign(dropEl.style, { left: `${r.left - room.left}px`, top: `${r.top - room.top}px`, width: `${r.width}px`, height: `${r.height}px` });
}

function dragTab(tile: string, tab: HTMLElement, down: PointerEvent) {
  let drop: Drop | null = null;
  tab.setPointerCapture(down.pointerId);
  // Pressed, the terminals let the pointer through: a drag that heads straight for one is still ours.
  gripped = true;
  render();
  const move = (e: PointerEvent) => {
    if (!tabDrag) {
      if (Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < 5) return;
      tabDrag = tile;
      tab.toggleAttribute("data-dragged", true);
      ghostEl.textContent = nameOf(tile);
      ghostEl.hidden = false;
      document.documentElement.toggleAttribute("data-tab-drag", true);
      render();
    }
    const room = roomEl.getBoundingClientRect();
    ghostEl.style.transform = `translate(${e.clientX - room.left + 12}px, ${e.clientY - room.top + 14}px)`;
    drop = dropAt(e.clientX, e.clientY, tile);
    showDrop(drop);
  };
  const finish = (e: Event) => {
    tab.removeEventListener("pointermove", move); tab.removeEventListener("pointerup", finish); tab.removeEventListener("pointercancel", finish);
    removeEventListener("keydown", escape, true);
    gripped = false;
    if (!tabDrag) { render(); return; }
    tabDrag = null;
    dropped = true;
    setTimeout(() => { dropped = false; });
    tab.toggleAttribute("data-dragged", false);
    ghostEl.hidden = true; dropEl.hidden = true;
    document.documentElement.toggleAttribute("data-tab-drag", false);
    if (e.type !== "pointerup" || !drop) { render(); return; }
    change("side" in drop ? split(tree, drop.pane, drop.side, tile, newPaneId()) : moveTab(tree, tile, drop.pane, drop.at));
    hm.commands.selectTile(tile);
  };
  const escape = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    drop = null;
    tab.releasePointerCapture(down.pointerId);
    finish(e);
  };
  tab.addEventListener("pointermove", move);
  tab.addEventListener("pointerup", finish);
  tab.addEventListener("pointercancel", finish);
  addEventListener("keydown", escape, true);
}

// ── The verbs, for its keys (the manifest's) and for an agent ─────────────────────────────────────

const run: Record<string, () => void> = {
  "split-right": () => splitActive("right"),
  "split-down": () => splitActive("down"),
  "focus-left": () => focusPane(neighbor(shown, tree.focus, "left")),
  "focus-right": () => focusPane(neighbor(shown, tree.focus, "right")),
  "focus-up": () => focusPane(neighbor(shown, tree.focus, "up")),
  "focus-down": () => focusPane(neighbor(shown, tree.focus, "down")),
  "maximize": () => change(toggleZoom(tree, tree.focus)),
  "close-pane": () => change(closePane(tree, tree.focus)),
  "unsplit": () => change(unsplit(tree)),
};
for (const [name, f] of Object.entries(run)) hm.onCommand(name, () => { f(); return { panes: panes(tree.root).map((p) => ({ id: p.id, tabs: p.tabs, active: p.active })), focus: tree.focus }; });

// ── What the app says ─────────────────────────────────────────────────────────────────────────────

hm.on("structure", (s) => {
  frames = s.frames;
  tiles = s.tiles;
  const ids = new Set(tiles.map((t) => t.id));
  for (const id of minimized) if (!ids.has(id)) minimized.delete(id);
  for (const [id, el] of tabEls) if (!ids.has(id)) { el.remove(); tabEls.delete(id); }
  render();
});
hm.on("names", (n) => { names.clear(); for (const [id, name] of Object.entries(n.names)) names.set(id, name); render(); });
hm.on("selection", (s) => {
  selected = s.tileId;
  // Selecting a minimized tile, from anywhere, brings it back: the selected tile is the one shown.
  if (selected) minimized.delete(selected);
  tree = normalize(tree, open(), minimized);
  const p = selected ? paneOf(tree, selected) : undefined;
  if (p && selected) tree = activate(tree, p.id, selected);
  save(true);
  render();
});
hm.on("resize", render);
