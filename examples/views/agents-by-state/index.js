// Your agents as a board: a column for those waiting on you, those working, those ready for work
// and those that stopped. Cards move by themselves as their status changes. Click one to dock its
// live terminal beside the board; on a card that is ready, write it its next task (the app shows
// you the message before it is sent: permission workspace:prompt).
import { applyThemeVars, connect } from "@hivemind/view-sdk";
import { COLUMNS, columnOf, detailOf, group } from "./lib.js";

const hm = await connect();
applyThemeVars(hm);

const style = document.createElement("style");
style.textContent = `
  html, body { margin: 0; height: 100%; background: transparent; color: var(--hm-color-fg); font: 13px var(--hm-font-ui, system-ui); }
  main { position: absolute; inset: 0; display: flex; flex-direction: column; padding: 18px 22px 76px; box-sizing: border-box; }
  header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 14px; }
  h1 { margin: 0; font-size: 15px; font-weight: 600; }
  .sum { color: var(--hm-color-fg3); font-size: 12px; }
  .wrap { flex: 1; min-height: 0; display: flex; gap: 14px; }
  .board { flex: 1; min-width: 0; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
  body[data-docked] .board { grid-template-columns: repeat(2, minmax(0, 1fr)); grid-auto-rows: minmax(0, 1fr); }
  .col { display: flex; flex-direction: column; min-height: 0; border-radius: 12px; background: color-mix(in srgb, var(--hm-color-bg2) 80%, transparent); border: 1px solid var(--hm-color-line); }
  .col h2 { display: flex; align-items: center; gap: 8px; margin: 0; padding: 12px 14px 8px; font-size: 12px; font-weight: 600; }
  .col h2 i { width: 8px; height: 8px; border-radius: 50%; }
  .col h2 span.n { margin-left: auto; color: var(--hm-color-fg3); font-weight: 500; font-variant-numeric: tabular-nums; }
  .col[data-col="waiting"] h2 i { background: var(--hm-status-attention); box-shadow: 0 0 10px var(--hm-status-attention); }
  .col[data-col="working"] h2 i { background: var(--hm-status-working); }
  .col[data-col="idle"] h2 i { background: var(--hm-status-idle); }
  .col[data-col="stopped"] h2 i { background: var(--hm-status-failed); }
  .cards { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 10px 12px; display: flex; flex-direction: column; gap: 8px; }
  .card { position: relative; padding: 10px 12px; border-radius: 10px; background: color-mix(in srgb, var(--hm-color-bg3) 85%, transparent); border: 1px solid transparent; cursor: pointer; transition: transform 160ms ease, border-color 160ms ease; animation: in 220ms ease; }
  @keyframes in { from { opacity: 0; transform: translateY(6px); } }
  .card:hover { border-color: var(--hm-color-line2, var(--hm-color-line)); }
  .card[aria-current="true"] { border-color: var(--hm-accent, #8af); }
  .col[data-col="waiting"] .card { border-left: 3px solid var(--hm-status-attention); }
  .col[data-col="working"] .card { border-left: 3px solid var(--hm-status-working); }
  .col[data-col="stopped"] .card { border-left: 3px solid var(--hm-status-failed); }
  .top { display: flex; align-items: center; gap: 8px; }
  .top svg { width: 15px; height: 15px; flex: none; }
  .top b { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .top time { margin-left: auto; font-size: 11px; color: var(--hm-color-fg3); font-variant-numeric: tabular-nums; }
  .meta { display: flex; align-items: center; gap: 6px; margin-top: 5px; font-size: 11.5px; color: var(--hm-color-fg3); }
  .meta i { width: 6px; height: 6px; border-radius: 2px; flex: none; }
  .col[data-col="waiting"] .meta .why { color: var(--hm-status-attention); }
  .task { display: flex; gap: 6px; margin-top: 8px; }
  .task input { flex: 1; min-width: 0; padding: 5px 8px; border-radius: 6px; border: 1px solid var(--hm-color-line); background: var(--hm-color-bg); color: var(--hm-color-fg); font: inherit; font-size: 12px; }
  .empty { margin: 8px 4px; font-size: 12px; color: var(--hm-color-fg3); }
  .dock { width: 48%; border-radius: 12px; border: 1px solid var(--hm-color-line); display: none; }
  body[data-docked] .dock { display: block; }
`;
document.head.append(style);
document.body.innerHTML = `<main><header><h1>Agents</h1><span class="sum"></span></header><div class="wrap"><div class="board"></div><div class="dock"></div></div></main>`;
const $ = (s) => document.querySelector(s);

let frames = [], tiles = [];
const names = new Map();
const status = new Map();
const watching = new Map();
let docked = null;
const canPrompt = hm.capabilities.includes("workspace:prompt");

const ago = (t) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

function cards() {
  return tiles.filter((t) => t.agent).map((t) => {
    const st = status.get(t.id) ?? { status: "unknown", since: Date.now() };
    const a = st.agent ?? {};
    return { id: t.id, name: names.get(t.id) ?? t.name, agent: t.agent, icon: t.icon, frame: frames.find((f) => f.id === t.frameId), column: columnOf(st.status, a), since: st.since, state: a.state, waitingFor: a.waitingFor, subagents: a.subagents ?? 0 };
  });
}

function draw() {
  const all = cards();
  const by = group(all);
  const board = $(".board");
  board.replaceChildren(...COLUMNS.map((c) => {
    const col = document.createElement("section");
    col.className = "col";
    col.dataset.col = c.id;
    const h = document.createElement("h2");
    h.innerHTML = `<i></i><span></span><span class="n"></span>`;
    h.children[1].textContent = c.title;
    h.children[2].textContent = String(by[c.id].length);
    const list = document.createElement("div");
    list.className = "cards";
    if (!by[c.id].length) list.innerHTML = `<p class="empty">${c.id === "waiting" ? "Nobody is waiting on you." : "None"}</p>`;
    for (const card of by[c.id]) list.append(cardEl(card));
    col.append(h, list);
    return col;
  }));
  const w = by.waiting.length;
  $(".sum").textContent = `${all.length} agents · ${by.working.length} working · ${w ? `${w} waiting on you` : "nobody waiting on you"}`;
  placeDock();
}

function cardEl(c) {
  const el = document.createElement("article");
  el.className = "card";
  el.dataset.tile = c.id;
  if (c.id === docked) el.setAttribute("aria-current", "true");
  el.innerHTML = `<div class="top">${c.icon ?? ""}<b></b><time></time></div><div class="meta"><i></i><span class="frame"></span><span>·</span><span class="why"></span></div>`;
  el.querySelector("b").textContent = c.name;
  el.querySelector("time").textContent = ago(c.since);
  el.querySelector(".meta i").style.background = c.frame?.color ?? "var(--hm-color-fg3)";
  el.querySelector(".frame").textContent = c.frame?.title ?? "no frame";
  el.querySelector(".why").textContent = detailOf(c);
  el.onclick = (e) => { if (!e.target.closest(".task")) dock(c.id === docked ? null : c.id); };
  if (c.column === "idle" && canPrompt) {
    const f = document.createElement("form");
    f.className = "task";
    f.innerHTML = `<input placeholder="Its next task…" aria-label="Next task for this agent">`;
    f.onsubmit = async (e) => {
      e.preventDefault();
      const text = f.firstChild.value.trim();
      if (!text) return;
      const out = await hm.prompt(c.id, text).catch(() => "cancelled");
      if (out === "sent") f.firstChild.value = "";
    };
    el.append(f);
  }
  return el;
}

function placeDock() {
  if (!docked || !hm.supports("surfaces")) { hm.setSurfaceRects([]); return; }
  const b = $(".dock").getBoundingClientRect();
  hm.setSurfaceRects([{ tileId: docked, x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height), chrome: "bar", radius: 12 }]);
}
function dock(id) {
  docked = id;
  document.body.toggleAttribute("data-docked", !!id);
  if (id) hm.commands.selectTile(id);
  draw();
}

hm.on("structure", (s) => {
  frames = s.frames; tiles = s.tiles;
  for (const t of tiles) {
    names.set(t.id, t.name);
    if (t.agent && !watching.has(t.id)) watching.set(t.id, hm.subscribeStatus(t.id, (st, info) => { status.set(t.id, { status: st, since: info?.since ?? Date.now(), agent: info?.agent }); draw(); }));
  }
  for (const [id, stop] of watching) if (!tiles.some((t) => t.id === id)) { stop(); watching.delete(id); status.delete(id); }
  if (docked && !tiles.some((t) => t.id === docked)) dock(null);
  draw();
});
hm.on("names", ({ names: n }) => { for (const [id, v] of Object.entries(n)) names.set(id, v); draw(); });
hm.on("resize", placeDock);
hm.on("undock", ({ tileId }) => { if (tileId === docked) { docked = null; document.body.removeAttribute("data-docked"); draw(); } });
hm.onReveal((tileId) => {
  if (!tiles.some((t) => t.id === tileId && t.agent)) return null;
  dock(tileId);
  const b = $(".dock").getBoundingClientRect();
  return { x: b.left, y: b.top, w: b.width, h: b.height };
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && docked) dock(null); });
setInterval(() => { if (hm.visible && !document.hidden) draw(); }, 15_000);

hm.onCommand("board", () => {
  const by = group(cards());
  return Object.fromEntries(COLUMNS.map((c) => [c.title, by[c.id].map((x) => ({ name: x.name, agent: x.agent, frame: x.frame?.title ?? null, for: ago(x.since), detail: detailOf(x) }))]));
});
hm.onCommand("open", (a) => {
  const want = String((a && a.name) || "").toLowerCase();
  const c = cards().find((x) => want && x.name.toLowerCase().includes(want));
  if (!c) throw new Error(`no agent is called ${JSON.stringify(a && a.name)}`);
  dock(c.id);
  return { docked: c.name };
});
