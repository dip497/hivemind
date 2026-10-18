// The workspace as a map: the workspace on the left, its frames, the worktrees made from them, and
// every tile, agents lit by what they are doing; arcs show which agent started or feeds which.
// Beside it, the workspace's issues by state (permission workspace:issues); pick one to read it.
import { applyThemeVars, connect } from "@hivemind/view-sdk";
import { issueCounts, tree } from "./lib.js";

const hm = await connect();
applyThemeVars(hm);

const style = document.createElement("style");
style.textContent = `
  html, body { margin: 0; height: 100%; background: transparent; color: var(--hm-color-fg); font: 13px var(--hm-font-ui, system-ui); }
  main { position: absolute; inset: 0; display: grid; grid-template-columns: 1fr 340px; gap: 14px; padding: 18px 22px 76px; box-sizing: border-box; }
  .map, .issues { min-height: 0; border-radius: 12px; border: 1px solid var(--hm-color-line); background: color-mix(in srgb, var(--hm-color-bg2) 80%, transparent); }
  .map { position: relative; overflow: auto; }
  .map h1, .issues h1 { margin: 0; padding: 14px 16px 4px; font-size: 15px; font-weight: 600; }
  .map p.sum, .issues p.sum { margin: 0; padding: 0 16px 8px; color: var(--hm-color-fg3); font-size: 12px; }
  svg { display: block; }
  .edge { fill: none; stroke: var(--hm-color-fg3); stroke-opacity: .35; stroke-width: 1.4; }
  .tie { fill: none; stroke: var(--hm-status-attention); stroke-width: 1.6; stroke-dasharray: 5 4; opacity: .8; }
  .tie.pipe { stroke: var(--hm-accent, #8af); stroke-dasharray: none; }
  .node text { font-size: 12px; fill: var(--hm-color-fg); dominant-baseline: middle; }
  .node text.sub { font-size: 10.5px; fill: var(--hm-color-fg3); }
  .node.tile { cursor: pointer; }
  .node.tile:hover text { text-decoration: underline; }
  .node .ring { fill: none; stroke-width: 2; }
  .pulse { animation: pulse 1.6s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }
  @keyframes pulse { 50% { transform: scale(1.6); opacity: .25; } }
  @media (prefers-reduced-motion: reduce) { .pulse { animation: none; } }
  .issues { display: flex; flex-direction: column; overflow: hidden; }
  .list { flex: 1; min-height: 0; overflow-y: auto; padding: 0 10px 12px; }
  .list h2 { margin: 10px 6px 4px; font-size: 11px; font-weight: 600; text-transform: none; color: var(--hm-color-fg3); }
  .issue { display: block; width: 100%; text-align: left; padding: 7px 8px; border: 0; border-radius: 8px; background: transparent; color: var(--hm-color-fg); font: inherit; cursor: pointer; }
  .issue:hover, .issue[aria-current="true"] { background: color-mix(in srgb, var(--hm-color-fg) 7%, transparent); }
  .issue code { font: 11px var(--hm-font-mono, monospace); color: var(--hm-color-fg3); margin-right: 6px; }
  .issue small { display: block; margin-top: 2px; color: var(--hm-color-fg3); font-size: 11px; }
  .read { border-top: 1px solid var(--hm-color-line); padding: 10px 16px 14px; max-height: 42%; overflow-y: auto; font-size: 12px; display: none; }
  .read[data-open] { display: block; }
  .read h3 { margin: 0 0 6px; font-size: 13px; }
  .read p { margin: 0 0 8px; color: var(--hm-color-fg2); white-space: pre-wrap; }
  .read li { margin: 2px 0; list-style: none; }
  .read ul { padding: 0; margin: 0; }
  .note { padding: 16px; color: var(--hm-color-fg3); font-size: 12px; }
`;
document.head.append(style);
document.body.innerHTML = `<main><section class="map"><h1>Workspace map</h1><p class="sum"></p><div class="canvas"></div></section>
<aside class="issues"><h1>Issues</h1><p class="sum"></p><div class="list"></div><div class="read"></div></aside></main>`;
const $ = (s) => document.querySelector(s);
const NS = "http://www.w3.org/2000/svg";
const el = (tag, attrs = {}, text) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v)); if (text != null) n.textContent = text; return n; };

let frames = [], tiles = [], links = { pipes: [], spawns: [] };
const names = new Map();
const lights = new Map();
const watching = new Map();
let issues = [];
let reading = null;

const lightOf = (status, a) => (status === "blocked" || a?.state === "waiting" ? "attention" : a?.state === "failed" || a?.state === "limited" ? "failed" : status === "working" || a?.state === "working" ? "working" : status === "exited" ? "exited" : "idle");

function drawMap() {
  const { nodes, rows, depth } = tree(frames, tiles);
  const ROW = 34, COL = 210, PAD = 30;
  const width = Math.max($(".map").clientWidth - 4, PAD * 2 + COL * depth + 260);
  const height = PAD * 2 + rows * ROW;
  const at = new Map(nodes.map((n) => [n.id, { x: PAD + n.depth * COL, y: PAD + n.row * ROW + ROW / 2 }]));
  const svg = el("svg", { width, height, viewBox: `0 0 ${width} ${height}` });
  for (const n of nodes) {
    if (!n.parent) continue;
    const a = at.get(n.parent), b = at.get(n.id);
    svg.append(el("path", { class: "edge", d: `M${a.x + 8},${a.y} C${a.x + COL * 0.55},${a.y} ${b.x - COL * 0.55},${b.y} ${b.x - 8},${b.y}` }));
  }
  // Who started whom, and who feeds whom: arcs bowing out to the right of the tiles.
  const right = PAD + depth * COL + 190;
  for (const [a, b, kind] of [...links.spawns.map((s) => [s.parent, s.child, "spawn"]), ...links.pipes.map((p) => [p.src, p.dst, "pipe"])]) {
    const p = at.get(a), q = at.get(b);
    if (!p || !q) continue;
    const bow = right + Math.min(120, Math.abs(q.y - p.y) * 0.35);
    svg.append(el("path", { class: `tie ${kind}`, d: `M${right - 20},${p.y} C${bow},${p.y} ${bow},${q.y} ${right - 20},${q.y}` }));
  }
  for (const n of nodes) {
    const p = at.get(n.id);
    const g = el("g", { class: `node ${n.kind}`, transform: `translate(${p.x},${p.y})` });
    if (n.kind === "root") {
      g.append(el("circle", { r: 9, fill: "var(--hm-color-fg)" }), el("text", { x: 16 }, "Workspace"));
    } else if (n.kind === "frame") {
      const f = n.item;
      g.append(el("rect", { x: -8, y: -8, width: 16, height: 16, rx: 4, fill: f.color }));
      g.append(el("text", { x: 16, y: -5 }, f.title));
      g.append(el("text", { x: 16, y: 9, class: "sub" }, [f.folder?.kind === "worktree" ? "worktree" : null, f.branch, f.machine?.name].filter(Boolean).join(" · ") || "folder"));
    } else {
      const t = n.item;
      const light = t.agent ? lights.get(t.id) ?? "idle" : "exited";
      const color = `var(--hm-status-${light})`;
      if (t.agent && (light === "working" || light === "attention")) g.append(el("circle", { r: 7, fill: color, class: "pulse" }));
      g.append(el("circle", { r: t.agent ? 7 : 4, fill: t.agent ? color : "var(--hm-color-fg3)" }));
      g.append(el("text", { x: 16, y: t.agent ? -5 : 0 }, names.get(t.id) ?? t.name));
      if (t.agent) g.append(el("text", { x: 16, y: 9, class: "sub" }, `${t.agent} · ${light === "attention" ? "waiting on you" : light}`));
      g.addEventListener("click", () => hm.commands.selectTile(t.id));
    }
    svg.append(g);
  }
  $(".canvas").replaceChildren(svg);
  const agents = tiles.filter((t) => t.agent);
  $(".map .sum").textContent = `${frames.length} frames · ${frames.filter((f) => f.parentId).length} worktrees · ${agents.length} agents · ${links.spawns.length} started by another agent`;
}

const STATES = [["in_progress", "In progress"], ["in_review", "In review"], ["todo", "To do"], ["backlog", "Backlog"], ["done", "Done"]];
function drawIssues() {
  const list = $(".list");
  if (!hm.capabilities.includes("workspace:issues") || !hm.supports("issues")) {
    list.innerHTML = `<p class="note">Allow this view to read issues on its page in Settings ▸ Plugins to see them here.</p>`;
    return;
  }
  const c = issueCounts(issues);
  $(".issues .sum").textContent = `${issues.length} issues · ${c.in_progress ?? 0} in progress · ${c.done ?? 0} done`;
  list.replaceChildren();
  for (const [state, title] of STATES) {
    const here = issues.filter((i) => i.state === state);
    if (!here.length) continue;
    const h = document.createElement("h2");
    h.textContent = `${title} · ${here.length}`;
    list.append(h);
    for (const i of here) {
      const b = document.createElement("button");
      b.className = "issue";
      if (i.id === reading) b.setAttribute("aria-current", "true");
      b.innerHTML = `<code></code><span></span><small></small>`;
      b.children[0].textContent = i.id;
      b.children[1].textContent = i.title;
      b.children[2].textContent = i.assignee ? `${i.assignee.type === "agent" ? "agent" : "person"}: ${i.assignee.id}` : "nobody on it";
      b.onclick = () => read(i.id);
      list.append(b);
    }
  }
}

async function read(id) {
  reading = id;
  drawIssues();
  const box = $(".read");
  box.setAttribute("data-open", "");
  box.textContent = "Reading…";
  try {
    const i = await hm.issues.read(id);
    box.replaceChildren();
    const h = document.createElement("h3");
    h.textContent = `${i.id} ${i.title}`;
    const p = document.createElement("p");
    p.textContent = (i.sections?.description ?? i.description ?? "").slice(0, 600) || "No description.";
    box.append(h, p);
    const ac = i.sections?.acceptanceCriteria ?? i.acceptanceCriteria ?? [];
    if (ac.length) {
      const ul = document.createElement("ul");
      for (const a of ac) { const li = document.createElement("li"); li.textContent = `${a.done ? "☑" : "☐"} ${a.text}`; ul.append(li); }
      box.append(ul);
    }
  } catch (e) { box.textContent = e.message; }
}

hm.on("structure", (s) => {
  frames = s.frames; tiles = s.tiles; links = s.links ?? { pipes: [], spawns: [] };
  for (const t of tiles) {
    names.set(t.id, t.name);
    if (t.agent && !watching.has(t.id)) watching.set(t.id, hm.subscribeStatus(t.id, (st, info) => { lights.set(t.id, lightOf(st, info?.agent)); drawMap(); }));
  }
  for (const [id, stop] of watching) if (!tiles.some((t) => t.id === id)) { stop(); watching.delete(id); }
  drawMap();
});
hm.on("names", ({ names: n }) => { for (const [id, v] of Object.entries(n)) names.set(id, v); drawMap(); });
hm.on("resize", drawMap);
if (hm.supports("issues") && hm.capabilities.includes("workspace:issues")) hm.onIssues((list) => { issues = list; drawIssues(); });
drawIssues();

hm.onCommand("map", () => tree(frames, tiles).nodes.filter((n) => n.kind !== "root").map((n) => ({
  kind: n.kind, name: n.kind === "frame" ? n.item.title : names.get(n.id) ?? n.item.name, under: n.parent === "workspace" ? null : frames.find((f) => f.id === n.parent)?.title ?? null,
  ...(n.item.agent ? { agent: n.item.agent, state: lights.get(n.id) ?? "idle" } : {}),
})));
hm.onCommand("read", async (a) => { if (!a || typeof a.id !== "string") throw new Error("id is required"); await read(a.id); return { shown: a.id }; });
