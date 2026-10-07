/**
 * Windows — one tab per open tile, tinted by its frame, and the active tile filling the rest. The
 * Layers rail beside it is the app's own (`"layers": true` in its manifest), so every frame action
 * is there. Selection is one fact, the app's: whatever selects a tile (a tab, the rail, a spawn,
 * `hive ctl focus`) makes it the visible tab, bringing it back if it was minimized. What it keeps
 * is which tabs are minimized, and the last active one, for when nothing is selected.
 */
import { applyThemeVars, connect, type ViewFrame, type ViewTile } from "@hivemind/view-sdk";

interface Saved { v: 1; minimized: string[]; active: string | null }

const BAR_H = 36; // .w-bar's height in windows.css

const tabsEl = document.querySelector(".w-tabs") as HTMLElement;
const emptyEl = document.querySelector(".w-empty") as HTMLElement;

const hm = await connect();
applyThemeVars(hm);

let frames: ViewFrame[] = [];
let tiles: ViewTile[] = [];
const names = new Map<string, string>();
let selected: string | null = null;
const saved = hm.hello.layout as Saved | null;
const minimized = new Set<string>(saved?.v === 1 ? saved.minimized : []);
let fallback: string | null = saved?.v === 1 ? saved.active : null;

const save = () => hm.setLayout({ v: 1, minimized: [...minimized], active: fallback } satisfies Saved);

/** The tabs: every open tile but the minimized, the selected one always. */
const tabs = () => tiles.filter((t) => !minimized.has(t.id) || t.id === selected);

/** The active tab: the selected tile when it is open, else the last active if still a tab, else the first. */
function activeTab(): string | null {
  if (selected && tiles.some((t) => t.id === selected)) return selected;
  const shown = tabs().map((t) => t.id);
  return fallback && shown.includes(fallback) ? fallback : shown[0] ?? null;
}

const glyph = (t: ViewTile) => (t.agent ? "✦" : t.kind === "shell" ? "›_" : "▢");

function button(cls: string, label: string, text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button"; b.className = cls; b.title = label; b.setAttribute("aria-label", label); b.textContent = text;
  b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
  return b;
}

function minimize(id: string) {
  minimized.add(id);
  save();
  // The active one handed back: the rule above picks a neighbour.
  if (id === selected) hm.commands.selectTile(null);
  render();
}

function render() {
  const active = activeTab();
  if (active !== fallback) { fallback = active; save(); }
  // A tab chosen by the rule, not by a selection, is made the selection: its body takes the keys.
  if (active && active !== selected) hm.commands.selectTile(active);
  const color = new Map(frames.map((f) => [f.id, f.color]));
  tabsEl.replaceChildren(...tabs().map((t) => {
    const name = names.get(t.id) ?? t.name;
    const tab = document.createElement("div");
    tab.className = "w-tab"; tab.setAttribute("role", "tab"); tab.tabIndex = 0; tab.title = name;
    tab.setAttribute("aria-selected", String(t.id === active));
    tab.dataset.tileId = t.id;
    const dot = document.createElement("span");
    dot.className = "w-dot"; dot.setAttribute("aria-hidden", "true");
    dot.style.background = (t.frameId && color.get(t.frameId)) || "var(--hm-color-fg3)";
    const mark = document.createElement("span");
    mark.className = "w-glyph"; mark.setAttribute("aria-hidden", "true"); mark.textContent = glyph(t);
    const label = document.createElement("span");
    label.className = "w-name"; label.textContent = name;
    tab.append(dot, mark, label, button("w-act", `Minimize ${name}`, "–", () => minimize(t.id)));
    if (hm.capabilities.includes("workspace:close")) tab.append(button("w-act", `Close ${name}`, "×", () => hm.commands.closeTile(t.id)));
    tab.addEventListener("click", () => hm.commands.selectTile(t.id));
    tab.addEventListener("auxclick", (e) => { if (e.button === 1) { e.preventDefault(); minimize(t.id); } });
    tab.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); hm.commands.selectTile(t.id); } });
    return tab;
  }));
  emptyEl.hidden = !!active;
  emptyEl.textContent = tabs().length ? "Select a tab to view it." : "Nothing open. Spawn a tile (1–7) or restore one from the rail.";
  // The active tile's live surface fills the stage; the rest wait, alive, in the app.
  const { w, h } = hm.viewport;
  hm.setSurfaceRects(active ? [{ tileId: active, x: 0, y: BAR_H, w, h: Math.max(0, h - BAR_H), chrome: "none" }] : []);
}

hm.on("structure", (s) => {
  frames = s.frames;
  tiles = s.tiles;
  const open = new Set(tiles.map((t) => t.id));
  let pruned = false;
  for (const id of minimized) if (!open.has(id)) { minimized.delete(id); pruned = true; }
  if (pruned) save();
  render();
});
hm.on("names", (n) => { names.clear(); for (const [id, name] of Object.entries(n.names)) names.set(id, name); render(); });
hm.on("selection", (s) => {
  selected = s.tileId;
  // Selecting a minimized tile, from anywhere, brings it back: the selected tile is the one shown.
  if (selected && minimized.delete(selected)) save();
  render();
});
hm.on("resize", render);
