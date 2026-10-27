// A view that lists the workspace's tiles and docks the chosen one's live terminal beside the
// list: a row click or J/K selects the tile in the app and docks it, as does the app asking it to
// show one (a widget's button, `hive ctl focus`); Escape releases it. It draws only when something
// changes. The view the e2e specs drive a docked terminal through.
import { applyThemeVars, connect, createInvalidator } from "@hivemind/view-sdk";

const hm = await connect();
applyThemeVars(hm);

const LIST_W = 260;
document.head.append(Object.assign(document.createElement("style"), {
  textContent: `
    body { margin: 0; font: 13px var(--hm-font-ui, system-ui); color: var(--hm-color-fg, #ddd); }
    .list { position: fixed; inset: 0 auto 0 0; width: ${LIST_W}px; padding: 12px; box-sizing: border-box; outline: none; }
    .row { padding: 8px 10px; border-radius: var(--hm-radius, 8px); cursor: pointer; }
    .row[aria-selected="true"] { background: var(--hm-surface, #0006); }
  `,
}));
const list = Object.assign(document.createElement("div"), { className: "list", tabIndex: 0 });
list.setAttribute("role", "listbox");
list.setAttribute("aria-label", "Tiles");
document.body.append(list);

let tiles = [];
let cursor = null;
let docked = null;

const dockRect = (tileId) => ({ tileId, x: LIST_W, y: 0, w: Math.max(1, hm.viewport.w - LIST_W), h: hm.viewport.h });

const { invalidate } = createInvalidator(hm, () => {
  list.replaceChildren(...tiles.map((t) => {
    const row = Object.assign(document.createElement("div"), { className: "row", textContent: t.name });
    row.dataset.id = t.id;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(t.id === cursor));
    return row;
  }));
});

async function pick(tileId) {
  cursor = tileId;
  invalidate();
  // Select first, then dock: once the app shows it docked, it holds the selection too.
  await hm.commands.selectTile(tileId);
  docked = tileId;
  hm.setSurfaceRects([dockRect(tileId)]);
}

function release() {
  docked = null;
  hm.setSurfaceRects([]);
}

list.addEventListener("click", (e) => {
  const row = e.target.closest(".row");
  if (row) void pick(row.dataset.id);
});
list.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { release(); return; }
  if (e.key !== "j" && e.key !== "k" || !tiles.length) return;
  const at = tiles.findIndex((t) => t.id === cursor);
  const next = e.key === "j" ? Math.min(tiles.length - 1, at + 1) : Math.max(0, at - 1);
  void pick(tiles[next].id);
});

hm.on("structure", (s) => {
  tiles = s.tiles.map((t) => ({ id: t.id, name: t.name }));
  if (docked && !tiles.some((t) => t.id === docked)) release();
  invalidate();
});
hm.on("names", ({ names }) => { tiles = tiles.map((t) => ({ ...t, name: names[t.id] ?? t.name })); invalidate(); });
hm.on("resize", () => { if (docked) hm.setSurfaceRects([dockRect(docked)]); });
hm.on("undock", () => { docked = null; });
hm.on("visibility", () => invalidate());
hm.onReveal((tileId) => {
  if (!tiles.some((t) => t.id === tileId)) return null;
  void pick(tileId);
  return dockRect(tileId);
});
