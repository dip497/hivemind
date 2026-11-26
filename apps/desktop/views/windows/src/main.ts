/**
 * Windows — the open tiles as an editor's panes: split right or down, each pane its own tabs, the
 * dividers dragged, one pane maximized. The Layers rail beside it is the app's own (`"layers": true`),
 * so every frame action is there. Selection is one fact, the app's: whatever selects a tile (a tab,
 * the rail, a spawn, `hive ctl focus`) shows it in its pane and focuses that pane, bringing it back
 * if it was minimized. Each tab says what its tile asks of the person (`attentionOf`), and a pane
 * says when a tab in it needs them. A frame or a page opens as a layout of its own. It keeps the
 * panes of each layout and which tiles are minimized, each person their own.
 */
import { applyThemeVars, connect, type ViewFrame, type ViewTile } from "@hivemind/view-sdk";
import { statusMarkSvg } from "@hivemind/view-sdk/status";
import { attentionOf, attentionRank, attentionStateOf, type Attention, type AttentionFacts } from "@hivemind/core/attention";
import { isTerminalKind } from "@hivemind/workspace-doc/shapes";
import {
  MAX_PANES, activate, closePane, cycleTab, equalize, equalizeAll, gridOf, layout, moveTab, neighbor, normalize, paneAlong, paneById, paneOf, panes, readTree, resize, single, split, swapPanes, toggleZoom, unsplit,
  type Divider, type Layout, type Side, type Tree,
} from "./tree";
import { groupTiles, rankEntries, touch, type Entry, type Group, type GroupBy, type GroupFrame } from "./switcher";

interface SavedV1 { v: 1; minimized: string[]; active: string | null }
interface SavedV2 { v: 2; tree: Tree; minimized: string[] }
/** A layout per group: "" is every tile, else a group's key (`frame:<id>`, `page:<id>`). */
interface SavedV3 { v: 3; trees: Record<string, Tree>; scope: string; groupBy: GroupBy; minimized: string[] }

const roomEl = document.querySelector(".w-room") as HTMLElement;
const groupsEl = document.querySelector(".w-groups") as HTMLElement;
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
let tileById = new Map<string, ViewTile>();
const names = new Map<string, string>();
let selected: string | null = null;
let seq = 0;
const newPaneId = () => `p${Date.now().toString(36)}${(seq++).toString(36)}`;

const saved = hm.hello.layout as SavedV1 | SavedV2 | SavedV3 | null;
const minimized = new Set<string>(saved?.v ? saved.minimized : []);
const trees = new Map<string, Tree>();
if (saved?.v === 3) for (const [k, t] of Object.entries(saved.trees ?? {})) { const r = readTree(t); if (r) trees.set(k, r); }
let scope = saved?.v === 3 && typeof saved.scope === "string" && trees.has(saved.scope) ? saved.scope : "";
let groupBy: GroupBy = saved?.v === 3 && saved.groupBy === "page" ? "page" : "frame";
let tree: Tree = trees.get(scope)
  ?? ((saved?.v === 2 && readTree(saved.tree)) || single(newPaneId(), saved?.v === 1 && saved.active ? [saved.active] : []));
let savedJson = "";
/** Kept as it changes: at once for a change made in one step, gathered while a divider is dragged. */
function save(now = false) {
  trees.set(scope, tree);
  const next = JSON.stringify({ v: 3, trees: Object.fromEntries(trees), scope, groupBy, minimized: [...minimized] } satisfies SavedV3);
  if (next !== savedJson) { savedJson = next; hm.setLayout(JSON.parse(next), { now: now && !dragging }); }
}

// ── Groups: a frame or a page as a layout of its own ──────────────────────────────────────────────

let frameMap = new Map<string, GroupFrame>();
let groups: Group[] = [];
const groupOf = (key: string) => groups.find((g) => g.key === key);
/** The tiles this layout shows, in the app's order. */
const open = () => (scope ? groupOf(scope)?.tiles ?? [] : tiles.map((t) => t.id));
const nameOf = (id: string) => names.get(id) ?? tileById.get(id)?.name ?? id;

/** Show group `key`'s layout ("" every tile): the one it had, or one laid out from its tiles. */
function openLayout(key: string) {
  const g = key ? groupOf(key) : null;
  if (key && !g) return;
  trees.set(scope, tree);
  scope = key;
  tree = trees.get(key) ?? (g ? gridOf(g.tiles.filter((id) => !minimized.has(id)), newPaneId) : single(newPaneId()));
  change(tree);
  showFocused();
}

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

function showFocused() {
  const shownTab = paneById(tree, tree.focus)?.active;
  if (shownTab) hm.commands.selectTile(shownTab);
}

/** The focused pane's shown tab goes `by` panes along; with one pane it splits off to that side. */
function moveToPane(by: number) {
  const tile = paneById(tree, tree.focus)?.active;
  if (!tile) return;
  const to = paneAlong(tree, tree.focus, by);
  if (to) change(moveTab(tree, tile, to));
  else splitActive(by > 0 ? "right" : "left");
  hm.commands.selectTile(tile);
}

// ── What each tile asks of the person ──────────────────────────────────────────────────────────────

const facts = new Map<string, AttentionFacts>();
const attention = new Map<string, Attention>();
const unwatch = new Map<string, () => void>();
/** The tiles a pane shows now, and so the person sees. */
let shownTiles = new Set<string>();
const MARKS: Partial<Record<Attention, string>> = {
  "needs-you": statusMarkSvg("attention", 8), failed: statusMarkSvg("failed", 8), done: statusMarkSvg("done", 8), working: statusMarkSvg("working", 6),
  "new-output": '<span class="w-new"></span>',
};
const WORDS: Record<Attention, string> = { "needs-you": "needs you", failed: "failed", done: "finished", working: "working", "new-output": "new output", quiet: "" };
const attentionOfTile = (id: string): Attention => attention.get(id) ?? "quiet";

function watch(id: string) {
  const watchedAt = Date.now();
  facts.set(id, { state: "unknown", since: null, outputAt: null, seenAt: null });
  const offStatus = hm.subscribeStatus(id, (status, info) => {
    const f = facts.get(id);
    if (!f) return;
    const state = attentionStateOf(status, info?.agent?.state);
    // The person's last look as Layers keeps it, when the app says it (a look on the canvas counts),
    // or a look here since; from an app that does not say, when this view started watching.
    const seen = info?.seen !== undefined ? (Math.max(info.seen ?? 0, f.seenAt ?? 0) || null) : f.seenAt ?? watchedAt;
    if (state === f.state && seen === f.seenAt) return;
    if (state !== f.state) { f.state = state; f.since = info?.since ?? Date.now(); }
    f.seenAt = seen;
    paintAttention(id);
  });
  const offActivity = hm.activity(id, (level) => {
    const f = facts.get(id);
    if (!f || level === 0 || shownTiles.has(id)) return;
    f.outputAt = Date.now();
    paintAttention(id);
  });
  unwatch.set(id, () => { offStatus(); offActivity(); });
}

/** One tile's mark brought up to date: its tab at once, the panes and groups at the next frame, and
 *  only when what it asks changed. */
function paintAttention(id: string) {
  const f = facts.get(id);
  if (!f) return;
  if (shownTiles.has(id) && hm.visible) f.seenAt = Date.now();
  const a = attentionOf(f);
  if (attention.get(id) === a) return;
  attention.set(id, a);
  const tab = tabEls.get(id);
  if (tab) paintTabMark(tab, id);
  queueCues();
}

function paintTabMark(tab: HTMLElement, id: string) {
  const a = attentionOfTile(id);
  if (tab.dataset.attention === a) return;
  tab.dataset.attention = a;
  (tab.querySelector(".w-att") as HTMLElement).innerHTML = MARKS[a] ?? "";
  if (a === "quiet") tab.removeAttribute("aria-description"); else tab.setAttribute("aria-description", WORDS[a]);
}

/** The person sees the tiles shown: what they finished or wrote is no longer news. */
function markSeen() {
  if (!hm.visible) return;
  for (const id of shownTiles) paintAttention(id);
}

let cuesQueued = false;
function queueCues() {
  if (cuesQueued) return;
  cuesQueued = true;
  requestAnimationFrame(() => { cuesQueued = false; paintCues(); });
}

/** The newest tile waiting on the person, or null. */
function newestNeedingYou(): string | null {
  let best: string | null = null;
  let at = -Infinity;
  for (const [id, a] of attention) {
    if (a !== "needs-you") continue;
    const since = facts.get(id)?.since ?? 0;
    if (since > at) { at = since; best = id; }
  }
  return best;
}

function goNeedingYou() {
  const id = newestNeedingYou();
  if (id) hm.commands.selectTile(id);
}

/** What the panes, the groups and the "needs you" button say, from the tabs' marks. */
function paintCues() {
  let count = 0;
  for (const a of attention.values()) if (a === "needs-you") count++;
  const label = `${count} need${count === 1 ? "s" : ""} you: go to the newest (${MOD}Alt+A)`;
  for (const p of panes(tree.root)) {
    const el = paneEls.get(p.id);
    if (!el) continue;
    el.toggleAttribute("data-needs-you", p.tabs.some((id) => attentionOfTile(id) === "needs-you"));
    const btn = el.querySelector(".w-needs") as HTMLButtonElement;
    btn.hidden = !count || p.id !== tree.focus;
    (btn.querySelector(".w-needs-n") as HTMLElement).textContent = String(count);
    btn.title = label; btn.setAttribute("aria-label", label);
  }
  for (const b of groupsEl.querySelectorAll<HTMLElement>("[data-group]")) {
    const g = b.dataset.group ? groupOf(b.dataset.group) : null;
    let worst: Attention = "quiet";
    for (const id of g ? g.tiles : tileById.keys()) { const a = attentionOfTile(id); if (attentionRank(a) < attentionRank(worst)) worst = a; }
    const show: Attention = worst === "needs-you" || worst === "failed" || worst === "done" ? worst : "quiet";
    const mark = b.querySelector(".w-att") as HTMLElement;
    if (mark.dataset.attention !== show) { mark.dataset.attention = show; mark.innerHTML = MARKS[show] ?? ""; }
  }
}

// ── Drawing ────────────────────────────────────────────────────────────────────────────────────────

const ICON: Record<string, string> = {
  right: '<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="M12 4.5v15"/>',
  down: '<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="M3.5 12h17"/>',
  zoom: '<path d="M9 4.5H6.5a2 2 0 0 0-2 2V9M15 4.5h2.5a2 2 0 0 1 2 2V9M9 19.5H6.5a2 2 0 0 1-2-2V15M15 19.5h2.5a2 2 0 0 0 2-2V15"/>',
  restore: '<path d="M9 4.5V7a2 2 0 0 1-2 2H4.5M15 4.5V7a2 2 0 0 0 2 2h2.5M9 19.5V17a2 2 0 0 0-2-2H4.5M15 19.5V17a2 2 0 0 1 2-2h2.5"/>',
  close: '<path d="M7 7l10 10M17 7 7 17"/>',
  min: '<path d="M7 12h10"/>',
  find: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>',
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
  tab.innerHTML = '<span class="w-dot" aria-hidden="true"></span><span class="w-mark" aria-hidden="true"></span><span class="w-name"></span><span class="w-att" aria-hidden="true"></span>';
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
  paintTabMark(tab, id);
  return tab;
}

/** A tab brought up to date: shown or not, its frame's colour, the app's mark for it, its name. */
function updateTab(tab: HTMLElement, id: string, active: boolean, color: Map<string, string>) {
  const t = tileById.get(id);
  const name = nameOf(id);
  tab.setAttribute("aria-selected", String(active));
  (tab.querySelector(".w-dot") as HTMLElement).style.background = (t?.frameId && color.get(t.frameId)) || "var(--hm-color-fg3)";
  const mark = tab.querySelector(".w-mark") as HTMLElement;
  if (mark.dataset.icon !== (t?.icon ?? "")) { mark.dataset.icon = t?.icon ?? ""; mark.innerHTML = t?.icon ?? ""; }
  (tab.querySelector(".w-name") as HTMLElement).textContent = name;
  tab.toggleAttribute("data-broadcast", broadcast.includes(id));
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

/** The strip of layouts over the panes (All, then each group), when there is a group to choose. */
function renderGroups() {
  const pages = frames.some((f) => f.page);
  const list = groups.length > 1 ? groups : [];
  groupsEl.hidden = !list.length && !scope;
  if (groupsEl.hidden) return;
  const want: HTMLElement[] = [];
  const button = (key: string, label: string, count: number) => {
    let b = groupsEl.querySelector<HTMLButtonElement>(`[data-group="${CSS.escape(key)}"]`);
    if (!b) {
      b = document.createElement("button");
      b.type = "button"; b.className = "w-group"; b.dataset.group = key;
      b.innerHTML = '<span class="w-att" aria-hidden="true"></span><span class="w-group-name"></span><span class="w-group-n"></span>';
      b.addEventListener("click", () => openLayout(key));
    }
    b.setAttribute("aria-pressed", String(scope === key));
    (b.querySelector(".w-group-name") as HTMLElement).textContent = label;
    (b.querySelector(".w-group-n") as HTMLElement).textContent = String(count);
    b.title = key ? `Open ${label} as a layout of its own` : "Every tile";
    want.push(b);
  };
  button("", "All", tiles.length);
  for (const g of list) button(g.key, g.label, g.tiles.length);
  let by = groupsEl.querySelector<HTMLButtonElement>(".w-group-by");
  if (!by) {
    by = document.createElement("button");
    by.type = "button"; by.className = "w-group-by";
    by.addEventListener("click", () => setGroupBy(groupBy === "frame" ? "page" : "frame"));
  }
  by.hidden = !pages;
  by.textContent = groupBy === "frame" ? "By frame" : "By page";
  by.title = groupBy === "frame" ? "Grouped by frame: group by page instead" : "Grouped by page: group by frame instead";
  want.push(by);
  if (want.length !== groupsEl.children.length || want.some((el, i) => groupsEl.children[i] !== el)) groupsEl.replaceChildren(...want);
}

function setGroupBy(by: GroupBy) {
  if (by === groupBy) return;
  groupBy = by;
  regroup();
  if (scope && !groupOf(scope)) { trees.set(scope, tree); scope = ""; tree = trees.get("") ?? single(newPaneId()); }
  change(tree);
}

function regroup() {
  groups = groupTiles(tiles, frameMap, groupBy);
}

function render() {
  tree = normalize(tree, open(), minimized);
  save();
  renderGroups();
  const all = panes(tree.root);
  const focused = paneById(tree, tree.focus)!;
  // A tab chosen by the rules, not by a selection, is made the selection: its body takes the keys.
  if (focused.active && focused.active !== selected) hm.commands.selectTile(focused.active);
  const color = new Map(frames.map((f) => [f.id, f.color]));
  const room = roomEl.getBoundingClientRect();
  shown = layout(tree, { x: 0, y: 0, w: room.width, h: room.height }, GAP);
  const many = all.length > 1;
  const stepAside = !!tabDrag || switcher.open;
  const corner = groupsEl.hidden;
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
      const needs = document.createElement("button");
      needs.type = "button"; needs.className = "w-needs"; needs.hidden = true;
      needs.innerHTML = `${statusMarkSvg("attention", 8)}<span class="w-needs-n"></span>`;
      needs.addEventListener("click", (e) => { e.stopPropagation(); goNeedingYou(); });
      const casting = document.createElement("button");
      casting.type = "button"; casting.className = "w-casting"; casting.hidden = true;
      casting.addEventListener("click", (e) => { e.stopPropagation(); setBroadcast(false); });
      const tool = (name: string, label: string, icon: string, run: () => void) => { const b = iconButton("w-tool", label, icon, run); b.dataset.paneTool = name; return b; };
      (el.querySelector(".w-tools") as HTMLElement).append(
        tool("Go to", `Go to a tile (${MOD}Alt+P)`, "find", () => openSwitcher()),
        tool("Split right", `Split right (${MOD}\\)`, "right", () => splitActive("right", id)),
        tool("Split down", `Split down (${MOD}Shift+\\)`, "down", () => splitActive("down", id)),
        tool("Maximize", "Maximize", "zoom", () => change(toggleZoom(tree, id))),
        tool("Close pane", "Close pane: its tabs join the next one", "close", () => change(closePane(tree, id))),
      );
      el.querySelector(".w-bar")!.insertBefore(needs, el.querySelector(".w-tools"));
      el.querySelector(".w-bar")!.insertBefore(casting, needs);
      el.addEventListener("pointerdown", () => { if (tree.focus !== id) focusPane(id); });
      paneEls.set(p.id, el);
    }
    Object.assign(el.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` });
    el.toggleAttribute("data-focused", many && p.id === tree.focus);
    el.toggleAttribute("data-corner", corner && box.y === 0 && box.x + box.w >= room.width - 1);
    const casts = !!p.active && broadcast.includes(p.active);
    el.toggleAttribute("data-broadcast", casts);
    const casting = el.querySelector(".w-casting") as HTMLButtonElement;
    casting.hidden = !casts;
    casting.textContent = `Typing to ${broadcast.length} terminals · Stop (Esc)`;
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
    // While a tab is dragged or the switcher is open the terminals step aside: each pane says which
    // tab it shows meanwhile.
    empty.hidden = !!p.active && !stepAside;
    empty.textContent = stepAside && p.active ? nameOf(p.active)
      : open().length ? "Empty pane. The next tile you open or select from the rail shows here."
      : scope ? "Nothing open in this layout. Choose All above to see every tile." : "Nothing open. Start an agent from the panel, or restore a tile from the rail.";
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
  hm.setSurfaceRects(stepAside ? [] : shown.panes.flatMap((box) => {
    const active = paneById(tree, box.id)?.active;
    const stage = paneEls.get(box.id)?.querySelector(".w-stage");
    if (!active || !stage) return [];
    const r = stage.getBoundingClientRect();
    return [{ tileId: active, x: r.left, y: r.top, w: Math.max(0, r.width), h: Math.max(0, r.height), chrome: "none" as const, radius: PANE_RADIUS - 1, ...(dragging || gripped ? { inert: true as const } : {}) }];
  }));
  shownTiles = new Set(shown.panes.flatMap((b) => { const a = paneById(tree, b.id)?.active; return a ? [a] : []; }));
  markSeen();
  paintCues();
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

// ── The quick switcher ───────────────────────────────────────────────────────────────────────────

/** The tiles in the order they were last shown, newest first. */
let recent: readonly string[] = [];
const switcher = document.querySelector(".w-switch") as HTMLDialogElement;
const switchInput = switcher.querySelector("input") as HTMLInputElement;
const switchList = switcher.querySelector('[role="listbox"]') as HTMLElement;
let listed: Entry[] = [];
let picked = 0;

function entries(): Entry[] {
  const byId = new Map(frames.map((f) => [f.id, f]));
  return tiles.map((t) => {
    const f = t.frameId ? byId.get(t.frameId) : undefined;
    return { id: t.id, title: nameOf(t.id), ...(t.agent ? { agent: t.agent } : {}), ...(f ? { folder: f.folder?.name ?? f.title } : {}) };
  });
}

function fillSwitcher() {
  listed = rankEntries(entries(), switchInput.value, attentionOfTile, recent, (id) => facts.get(id)?.since ?? 0);
  picked = Math.min(picked, Math.max(0, listed.length - 1));
  const rows = listed.map((e, i) => {
    const li = document.createElement("li");
    li.setAttribute("role", "option"); li.id = `w-opt-${i}`; li.className = "w-opt"; li.dataset.tileId = e.id;
    li.setAttribute("aria-selected", String(i === picked));
    const a = attentionOfTile(e.id);
    li.innerHTML = '<span class="w-key" aria-hidden="true"></span><span class="w-att" aria-hidden="true"></span><span class="w-opt-name"></span><span class="w-opt-where"></span>';
    (li.querySelector(".w-key") as HTMLElement).textContent = i < 9 ? String(i + 1) : "";
    (li.querySelector(".w-att") as HTMLElement).innerHTML = MARKS[a] ?? "";
    (li.querySelector(".w-opt-name") as HTMLElement).textContent = e.title;
    (li.querySelector(".w-opt-where") as HTMLElement).textContent = [WORDS[a], e.agent, e.folder].filter(Boolean).join(" · ");
    li.addEventListener("click", () => pick(i));
    return li;
  });
  if (!rows.length) { const li = document.createElement("li"); li.className = "w-opt-none"; li.textContent = "No tile matches."; rows.push(li); }
  switchList.replaceChildren(...rows);
  if (listed.length) switchInput.setAttribute("aria-activedescendant", `w-opt-${picked}`); else switchInput.removeAttribute("aria-activedescendant");
  switchList.children[picked]?.scrollIntoView({ block: "nearest" });
}

function openSwitcher() {
  if (switcher.open) return;
  switchInput.value = "";
  picked = 0;
  fillSwitcher();
  switcher.showModal();
  render();
}

function pick(i: number) {
  const e = listed[i];
  switcher.close();
  if (e) hm.commands.selectTile(e.id);
}

switchInput.addEventListener("input", () => { picked = 0; fillSwitcher(); });
switchInput.addEventListener("keydown", (e) => {
  if (/^[1-9]$/.test(e.key) && (!switchInput.value || e.altKey)) { e.preventDefault(); pick(Number(e.key) - 1); return; }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (listed.length) picked = (picked + (e.key === "ArrowDown" ? 1 : -1) + listed.length) % listed.length;
    fillSwitcher();
  } else if (e.key === "Enter") { e.preventDefault(); pick(picked); }
});
switcher.addEventListener("close", () => render());

// ── Typing into several terminals at once ─────────────────────────────────────────────────────────

/** The terminals what the person types goes to together; empty while it is off. The host says it. */
let broadcast: readonly string[] = [];
const canBroadcast = () => hm.supports("broadcast") && hm.capabilities.includes("workspace:broadcast");

/** On: the terminals the panes show now. Off: none. What stopped it, when something did. */
function setBroadcast(on: boolean): string | null {
  if (!canBroadcast()) return "this app cannot type into several terminals at once";
  const ids = on ? [...shownTiles].filter((id) => { const t = tileById.get(id); return !!t && isTerminalKind(t.kind); }) : [];
  if (on && ids.length < 2) return "show two or more terminals in panes first";
  // Drawn once the app says the group, never before: a group it did not make is never shown on.
  hm.commands.broadcastInput(ids);
  return null;
}

/** Drawn in the bar of each pane in the group, so the room keeps its size and no terminal resizes. */
function showBroadcast(ids: readonly string[]) {
  broadcast = ids;
  render();
}
addEventListener("keydown", (e) => { if (e.key === "Escape" && broadcast.length && !switcher.open) { e.preventDefault(); setBroadcast(false); } });
// The host's word on the group: it ends it on Escape in a terminal, and when its terminals close.
hm.on("broadcast", (m) => {
  if (m.tileIds.length !== broadcast.length || m.tileIds.some((id, i) => broadcast[i] !== id)) showBroadcast(m.tileIds);
});

// ── The verbs, for its keys (the manifest's) and for an agent ─────────────────────────────────────

/** The tile shown before the selected one. */
function lastTab() {
  const id = recent.find((x) => x !== selected && tileById.has(x));
  if (id) hm.commands.selectTile(id);
}

/** What an agent is told after any verb: the layout shown, the panes, and each tile's mark. */
function snapshot() {
  return {
    layout: scope || "all",
    groupBy,
    groups: groups.map((g) => ({ key: g.key, label: g.label, tiles: g.tiles })),
    panes: panes(tree.root).map((p) => ({ id: p.id, tabs: p.tabs, active: p.active })),
    focus: tree.focus,
    zoom: tree.zoom,
    attention: Object.fromEntries(tiles.map((t) => [t.id, attentionOfTile(t.id)])),
    broadcast: [...broadcast],
  };
}

const arg = (a: unknown, k: string): unknown => (a && typeof a === "object" ? (a as Record<string, unknown>)[k] : undefined);

const run: Record<string, (args: unknown) => void> = {
  "split-right": () => splitActive("right"),
  "split-down": () => splitActive("down"),
  "focus-left": () => focusPane(neighbor(shown, tree.focus, "left")),
  "focus-right": () => focusPane(neighbor(shown, tree.focus, "right")),
  "focus-up": () => focusPane(neighbor(shown, tree.focus, "up")),
  "focus-down": () => focusPane(neighbor(shown, tree.focus, "down")),
  "maximize": () => change(toggleZoom(tree, tree.focus)),
  "close-pane": () => change(closePane(tree, tree.focus)),
  "unsplit": () => change(unsplit(tree)),
  "go-to": () => openSwitcher(),
  "needs-you": () => goNeedingYou(),
  "last-tab": () => lastTab(),
  "next-tab": () => { change(cycleTab(tree, tree.focus, 1)); showFocused(); },
  "prev-tab": () => { change(cycleTab(tree, tree.focus, -1)); showFocused(); },
  "move-tab-next-pane": () => moveToPane(1),
  "move-tab-prev-pane": () => moveToPane(-1),
  "swap-pane": () => { const other = paneAlong(tree, tree.focus, 1); if (other) { change(swapPanes(tree, tree.focus, other)); showFocused(); } },
  "equalize": () => change(equalizeAll(tree)),
  "broadcast": (a) => {
    const on = arg(a, "on");
    const why = setBroadcast(typeof on === "boolean" ? on : !broadcast.length);
    if (why) throw new Error(why);
  },
  "open-layout": (a) => {
    const f = arg(a, "frame"), p = arg(a, "page");
    if (typeof f === "string" || typeof p === "string") setGroupBy(typeof f === "string" ? "frame" : "page");
    const key = typeof f === "string" ? `frame:${f}` : typeof p === "string" ? `page:${p}` : "";
    if (key && !groupOf(key)) throw new Error(`no ${typeof f === "string" ? "frame" : "page"} ${String(f ?? p)} with open tiles`);
    openLayout(key);
  },
  "group-by": (a) => {
    const by = arg(a, "by");
    if (by !== "frame" && by !== "page") throw new Error('"by" is "frame" or "page"');
    setGroupBy(by);
  },
  "panes": () => {},
};
for (const [name, f] of Object.entries(run)) hm.onCommand(name, (a) => { f(a); return snapshot(); });

// ── What the app says ─────────────────────────────────────────────────────────────────────────────

hm.on("structure", (s) => {
  frames = s.frames;
  tiles = s.tiles;
  tileById = new Map(tiles.map((t) => [t.id, t]));
  frameMap = new Map(frames.map((f) => [f.id, { id: f.id, title: f.title, ...(f.parentId ? { parentId: f.parentId } : {}), ...(f.page ? { page: true as const } : {}) }]));
  regroup();
  for (const id of minimized) if (!tileById.has(id)) minimized.delete(id);
  for (const [id, el] of tabEls) if (!tileById.has(id)) { el.remove(); tabEls.delete(id); }
  for (const [id, off] of unwatch) if (!tileById.has(id)) { off(); unwatch.delete(id); facts.delete(id); attention.delete(id); }
  for (const t of tiles) if (!unwatch.has(t.id)) watch(t.id);
  recent = recent.filter((id) => tileById.has(id));
  // A group whose frame or page is gone takes its layout with it.
  for (const key of [...trees.keys()]) if (key && !groupOf(key)) trees.delete(key);
  if (scope && !groupOf(scope)) { scope = ""; tree = trees.get("") ?? single(newPaneId()); }
  render();
  if (switcher.open) fillSwitcher();
});
hm.on("names", (n) => { names.clear(); for (const [id, name] of Object.entries(n.names)) names.set(id, name); render(); });
hm.on("selection", (s) => {
  selected = s.tileId;
  if (selected) recent = touch(recent, selected);
  // Selecting a minimized tile, from anywhere, brings it back: the selected tile is the one shown.
  if (selected) minimized.delete(selected);
  // One outside the layout shown is shown among every tile.
  if (selected && scope && !open().includes(selected)) { trees.set(scope, tree); scope = ""; tree = trees.get("") ?? single(newPaneId()); }
  tree = normalize(tree, open(), minimized);
  const p = selected ? paneOf(tree, selected) : undefined;
  if (p && selected) tree = activate(tree, p.id, selected);
  save(true);
  render();
});
hm.on("visibility", () => markSeen());
hm.on("resize", render);
