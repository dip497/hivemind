// A live wallpaper for the e2e suite: dots drifting on the page. It keeps what the app told it on
// `window.seen`: the look, the size, each mode, the pointer and the clicks.
import { connectWallpaper } from "@hivemind/view-sdk";

const wp = await connectWallpaper();
const seen = { look: wp.look, viewport: wp.viewport, modes: [], pointer: null, clicks: [] };
window.seen = seen;

const canvas = document.createElement("canvas");
canvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%";
document.body.append(canvas);
const ctx = canvas.getContext("2d");

wp.on("look", (look) => { seen.look = look; });
wp.on("viewport", (v) => { seen.viewport = v; });
wp.on("mode", (mode) => { seen.modes.push(mode); });
wp.on("pointer", (p) => { seen.pointer = p; });
wp.on("click", ({ x, y }) => { seen.clicks.push({ x, y }); });

const dots = Array.from({ length: 40 }, (_, i) => ({ x: (i * 0.137) % 1, y: (i * 0.311) % 1, phase: i }));
let t = 0;
wp.animate({
  step(dt) { t += dt; },
  draw() {
    const { w, h, dpr } = wp.viewport;
    if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = wp.look.text;
    for (const d of dots) {
      ctx.beginPath();
      ctx.arc(d.x * w + 40 * Math.sin(t + d.phase), d.y * h + 30 * Math.cos(t * 0.7 + d.phase), 14, 0, Math.PI * 2);
      ctx.fill();
    }
  },
});
