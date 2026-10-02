// Priya's phone board: the community view the phone apps show from the computer in their UI tests
// against it (phone-app.spec.ts; docs/design/phone-app-2026-10-02.md §6.1, P8 step 4). Its entry
// is a script, so the computer makes the page that runs it, puts the SDK's import map first and
// serves the SDK: the whole of how a view's files reach a phone. Plain DOM, room for a finger.
//
// It says where it is shown ("On a phone" when hello.device is touch and compact), lists the agent
// tiles the board holds by name, as the host's structure and names say them, and offers two
// buttons: Select selects the first agent tile, which the host answers with the selection, shown
// as "Selected: <name>"; Start an agent asks the host to start the person's default agent, which a
// phone asks its own lock for first. A phone may not edit the board, so the host gives a view there
// no renaming whatever its manifest asks; the page says so.
import { applyThemeVars, connect } from "@hivemind/view-sdk";

const hm = await connect();
applyThemeVars(hm);
// What it is told and does, in the web view's console (on Android, the device's log), so a run
// that stops here says how far it got.
const said = (...what) => console.info("phone-probe:", ...what);
const size = () => `${innerWidth}x${innerHeight}`;
said("connected", JSON.stringify(hm.device), size());
// The page's first frames (Chromium drops a page's input while it holds those back), and any touch
// that reaches the page, and where: a tap that never comes is told apart from one that misses.
requestAnimationFrame(() => requestAnimationFrame(() => said("drawn", size())));
addEventListener("pointerdown", (e) => said(
  "pointerdown", e.clientX, e.clientY, e.target.tagName,
  "elementFromPoint", document.elementFromPoint(e.clientX, e.clientY)?.tagName,
  "htmlClientHeight", document.documentElement.clientHeight,
  "bodyHeight", getComputedStyle(document.body).height,
  "selectRect", JSON.stringify(select.getBoundingClientRect()),
), true);

document.head.append(Object.assign(document.createElement("style"), {
  textContent: `
    body { margin: 0; padding: 20px; font: 18px var(--hm-font-ui, system-ui); color: var(--hm-color-fg, #e6e7e9); }
    h1 { font-size: 24px; margin: 0 0 12px; }
    p { margin: 8px 0; color: var(--hm-color-fg2, #c9ced6); }
    ul { list-style: none; margin: 16px 0; padding: 0; display: grid; gap: 8px; }
    li { padding: 14px 12px; border-radius: var(--hm-radius, 12px); background: var(--hm-color-bg3, #25272c); }
    button {
      display: block; width: 100%; min-height: 56px; margin: 12px 0; border: 0; font: inherit;
      border-radius: var(--hm-radius, 12px); color: var(--hm-color-bg, #141518); background: var(--hm-accent, #c9ced6);
    }
    button:disabled { opacity: .5; }
  `,
}));

const text = (tag, words = "") => Object.assign(document.createElement(tag), { textContent: words });
const where = text("p", hm.device.touch && hm.device.compact ? "On a phone" : "On a computer");
const renaming = text("p", "Renaming is not offered on this phone");
renaming.hidden = hm.capabilities.includes("workspace:edit");
const agents = document.createElement("ul");
const select = text("button", "Select");
const start = text("button", "Start an agent");
const selected = text("p");
document.body.append(text("h1", "Priya's phone board"), where, renaming, agents, select, start, selected);

/** The agent tiles on the board, in its order, and what each is called now. */
let tiles = [];
let names = {};
let chosen = null;
const nameOf = (id) => names[id] ?? tiles.find((t) => t.id === id)?.name ?? id;

function draw() {
  agents.replaceChildren(...tiles.map((t) => text("li", nameOf(t.id))));
  select.disabled = tiles.length === 0;
  selected.textContent = chosen === null ? "" : `Selected: ${nameOf(chosen)}`;
}

hm.on("structure", (s) => {
  tiles = s.tiles.filter((t) => t.agent !== undefined);
  draw();
});
hm.on("names", (n) => {
  names = n.names;
  draw();
});
// Only what was selected since the page came: the host's answer to Select.
hm.on("selection", (s) => {
  said("selection", JSON.stringify(s));
  if (!s.fresh) return;
  chosen = s.tileId;
  draw();
});

select.addEventListener("click", () => {
  said("select", tiles[0]?.id ?? "none");
  if (tiles[0]) hm.commands.selectTile(tiles[0].id);
});
start.addEventListener("click", () => {
  try {
    hm.commands.spawnAgent(null, null);
  } catch (e) {
    hm.error(String(e));
  }
});
draw();
