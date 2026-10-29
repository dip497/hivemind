// A live wallpaper for the e2e suite: one dot per agent in a row along the bottom, where no tile
// is, so a test knows where each creature is. It keeps what the app told it on `window.seen`.
import { connectWallpaper } from "@hivemind/view-sdk";

const wp = await connectWallpaper();
const seen = { creatures: [], tiles: [], look: null, modes: [], done: [], clicks: [] };
window.seen = seen;

const canvas = document.createElement("canvas");
canvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%";
document.body.append(canvas);
const ctx = canvas.getContext("2d");

/** Where creature `i` is: where a test put it, else in a row along the bottom. */
const placed = new Map();
const at = (i) => placed.get(wp.creatures[i]?.id) ?? { x: 120 + i * 140, y: wp.viewport.h - 70 };
window.place = (id, p) => { placed.set(id, p); };

wp.on("creatures", (cs) => { seen.creatures = cs.map((c) => ({ id: c.id, state: c.state, agent: c.agent })); });
wp.on("tiles", ({ tiles }) => { seen.tiles = tiles; });
wp.on("look", (look) => { seen.look = look; });
wp.on("mode", (mode) => { seen.modes.push(mode); });
wp.on("done", ({ id }) => { seen.done.push(id); });
wp.on("click", ({ id }) => { seen.clicks.push(id); });
wp.hitTest((x, y) => {
  const i = wp.creatures.findIndex((_, i) => Math.hypot(x - at(i).x, y - at(i).y) < 28);
  return i < 0 ? null : wp.creatures[i].id;
});
wp.animate({
  step() {},
  draw() {
    const { w, h, dpr } = wp.viewport;
    if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    wp.creatures.forEach((c, i) => {
      const p = at(i);
      ctx.fillStyle = c.state === "needs-you" ? wp.look.attention : wp.look.text;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 24, 0, Math.PI * 2);
      ctx.fill();
    });
  },
});
