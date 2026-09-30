// A view that shows who else is here (protocol 1.5): everyone in the workspace by name, in their
// colour, and each tile with who points at it and who selected it. A sample of `onParticipants`
// and `hm.device` for view authors, and the view view-participants.spec.ts drives.
import { applyThemeVars, connect } from "@hivemind/view-sdk";

const hm = await connect();
applyThemeVars(hm);

document.head.append(Object.assign(document.createElement("style"), {
  textContent: `
    body { margin: 0; padding: 24px; font: 13px var(--hm-font-ui, system-ui); color: var(--hm-color-fg, #ddd); }
    body[data-compact] { padding: 12px; }
    .here { display: flex; gap: 6px; min-height: 22px; margin-bottom: 16px; }
    .face { padding: 2px 8px; border-radius: 999px; color: #fff; }
    ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; max-width: 32rem; }
    li { display: flex; gap: 8px; padding: 8px 10px; border-radius: var(--hm-radius, 8px); background: var(--hm-surface, #0006); outline: 2px solid transparent; }
    body[data-touch] li { padding: 14px 12px; }
    .pointing { margin-left: auto; opacity: .8; }
  `,
}));
const here = Object.assign(document.createElement("div"), { className: "here" });
const list = document.createElement("ul");
document.body.append(here, list);
// Room for a finger on a touch screen, one narrow column on a phone's.
document.body.toggleAttribute("data-touch", hm.device.touch);
document.body.toggleAttribute("data-compact", hm.device.compact);

let tiles = [];
let people = [];

function draw() {
  here.replaceChildren(...people.map((p) => {
    const face = Object.assign(document.createElement("span"), { className: "face", textContent: p.name || "Someone" });
    face.style.background = p.color;
    face.dataset.person = p.person;
    return face;
  }));
  list.replaceChildren(...tiles.map((tile) => {
    const pointing = people.filter((p) => p.cursor?.tileId === tile.id);
    const selecting = people.filter((p) => p.selection.includes(tile.id));
    const row = document.createElement("li");
    row.dataset.tile = tile.id;
    row.dataset.selectedBy = selecting.map((p) => p.name).join(",");
    row.dataset.pointedBy = pointing.map((p) => p.name).join(",");
    // Ringed in the colour of whoever selected it; the names of whoever points at it beside it.
    if (selecting.length) row.style.outlineColor = selecting[0].color;
    const who = Object.assign(document.createElement("span"), { className: "pointing", textContent: pointing.map((p) => p.name).join(", ") });
    row.append(tile.name, who);
    return row;
  }));
}

hm.on("structure", (s) => { tiles = s.tiles; draw(); });
hm.on("names", ({ names }) => { tiles = tiles.map((t) => ({ ...t, name: names[t.id] ?? t.name })); draw(); });
// An app that predates 1.5 has no one to tell of: the view shows the tiles alone.
if (hm.supports("participants")) hm.onParticipants((p) => { people = p; draw(); });
document.body.dataset.ready = "1";
