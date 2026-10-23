// A view that leaves room under each tile's name for the host to draw its last line (protocol
// 1.17, `lineSlots`), and keeps every message the host sent it, for the spec to check that no
// line's text ever reached it.
import { connect } from "@hivemind/view-sdk";

const hm = await connect();
document.body.style.cssText = "margin:0;height:100vh;background:#101418;color:#fff;font:14px system-ui";
const list = document.createElement("div");
document.body.append(list);
window.__lineSlots = { supports: hm.supports("lineSlots"), heard: [] };
for (const kind of ["structure", "names", "selection"]) hm.on(kind, (m) => window.__lineSlots.heard.push(JSON.stringify(m)));
hm.on("structure", ({ tiles }) => {
  list.replaceChildren(...tiles.map((t, i) => {
    const row = document.createElement("div");
    row.style.cssText = `position:absolute;left:16px;top:${16 + i * 56}px`;
    row.textContent = t.name;
    return row;
  }));
  // Under each name, 24px for the host's line.
  hm.setLineRects(tiles.map((t, i) => ({ tileId: t.id, x: 16, y: 40 + i * 56, w: 480, h: 24 })));
});
