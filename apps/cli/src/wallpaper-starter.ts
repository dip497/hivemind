/** What `hive plugins new wallpaper` writes: a live wallpaper that builds outside this repository
 *  and draws as written, in a package of its own that offers it on install, or as a member of one.
 *  The SDK is served by the app, as it is to a view: the wallpaper gets its types here and leaves
 *  `@hivemind/view-sdk` out of its bundle. */
import { PACKAGE_MANIFEST } from "@hivemind/hub";
import { WALLPAPER_MANIFEST, WALLPAPER_PROTOCOL } from "@hivemind/view-sdk/wallpaper";
import { pluginBrief, WALLPAPER_SKILLS, type InPackage } from "./plugin-brief.js";
import { VIEW_TYPE_SETUP } from "./view-starter.js";
import type { TypeSetup } from "./check/types.js";

const title = (name: string) => name.split("-").map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");

/** What a wallpaper's code is checked against: the view SDK's types, with a view's settings. */
export const WALLPAPER_TYPE_SETUP: TypeSetup = VIEW_TYPE_SETUP;

/** The files of the wallpaper `name` in its own folder, a member of the package `inPackage.id`,
 *  which is at `inPackage.root` from that folder. */
function wallpaperFolder(name: string, inPackage: InPackage): Record<string, string> {
  const id = `${inPackage.id}/${name}`;
  const pkg = inPackage.root;
  return {
    [WALLPAPER_MANIFEST]: JSON.stringify({
      protocol: WALLPAPER_PROTOCOL, name: title(name), entry: "dist/main.js",
      description: "One creature for each of your agents, drawn in characters.", colour: true,
    }, null, 2) + "\n",
    "package.json": JSON.stringify({
      name, version: "0.1.0", private: true, type: "module",
      scripts: { build: "node build.mjs", typecheck: "tsc" },
      devDependencies: { esbuild: "^0.28.0", typescript: "^5.9.0" },
    }, null, 2) + "\n",
    "tsconfig.json": JSON.stringify({ compilerOptions: WALLPAPER_TYPE_SETUP.compilerOptions, include: ["src", "types"] }, null, 2) + "\n",
    ".gitignore": "node_modules/\n",
    "build.mjs": `// dist/main.js is the wallpaper's code: ${WALLPAPER_MANIFEST} names it, and it installs with this folder.
import { build } from "esbuild";
import { rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
await build({
  entryPoints: ["src/main.ts"], outfile: "dist/main.js",
  // The map lets \`hive plugins check\` say which line of src/ threw.
  bundle: true, format: "esm", target: "es2022", minify: true, sourcemap: true,
  // Served by the app; bundling a copy would pin an old one.
  external: ["@hivemind/view-sdk"],
});
`,
    "src/main.ts": SCENE,
    "README.md": `# ${title(name)}

A [Hivemind](https://hivemind.griiken.com) live wallpaper: one creature for each of your agents,
drawn in characters behind the canvas.

\`\`\`bash
npm install
npm run build                     # src/main.ts into dist/main.js
hive plugins check ${pkg}
hive plugins install ${pkg}
hive config set appearance.wallpaper.kind '"${id}"'
\`\`\`

\`dist/\` is the wallpaper's code and installs with this folder: build it before each install, and
commit it. It is published with its package: \`hivehub publish ${pkg}\`, after pushing the commit.
`,
    ...WALLPAPER_TYPE_SETUP.files(),
  };
}

/** What `hive plugins new wallpaper <name> --in <package>` writes in the wallpaper's folder: the
 *  wallpaper and its brief. The skills go at the package's root (`WALLPAPER_SKILLS`), where a
 *  coding agent working on the package finds them. */
export function wallpaperStarter(name: string, inPackage: InPackage): Record<string, string> {
  return { ...wallpaperFolder(name, inPackage), "PROMPT.md": pluginBrief("wallpaper", `${inPackage.id}/${name}`, inPackage) };
}

/** What `hive plugins new wallpaper <name>` writes without `--in`: a package `@owner/<name>`
 *  holding the wallpaper in `wallpapers/<name>` and offering it as the background once installed,
 *  with the brief and the skills for a coding agent at its root. Only the member's folder and the
 *  README install. */
export function wallpaperPackage(owner: string, name: string): Record<string, string> {
  const id = `@${owner}/${name}`;
  const folder = `wallpapers/${name}`;
  const manifest = { apiVersion: 2, id, name: title(name), version: "0.1.0", wallpapers: [{ path: folder }], startup: { wallpaper: `${id}/${name}` } };
  const member = Object.entries(wallpaperFolder(name, { root: "../..", id })).map(([f, text]) => [`${folder}/${f}`, text]);
  return {
    [PACKAGE_MANIFEST]: JSON.stringify(manifest, null, 2) + "\n",
    "README.md": `# ${title(name)}\n\nA live wallpaper for [Hivemind](https://hivemind.griiken.com): what it shows, in one line. Installing the package offers it as the background.\n\nGuide: https://hivemind.griiken.com/guide/live-wallpapers/\n`,
    "PROMPT.md": pluginBrief("wallpaper", `${id}/${name}`, { root: ".", id, member: folder }),
    ".gitignore": "node_modules/\n",
    ...WALLPAPER_SKILLS,
    ...Object.fromEntries(member),
  };
}

/** The scene a new wallpaper starts with. Written without template strings, so it sits in this
 *  file as it is. */
const SCENE = `// A Hivemind live wallpaper: one creature for each of the person's agents, drawn in characters
// behind the canvas. The app says who the agents are, where the tiles are, the colours and whether
// to move; this answers which creature is under the pointer. A scene of its own may ignore the
// agents and the tiles instead, and only answer the pointer and clicks. The whole guide is in
// PROMPT.md.
import { connectWallpaper, type AgentState, type WallpaperCreature } from "@hivemind/view-sdk";

const wp = await connectWallpaper();

const canvas = document.createElement("canvas");
canvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%";
document.body.append(canvas);
const ctx = canvas.getContext("2d")!;

/** How each state moves: its top speed (pixels a second), how hard it heads for where it is
 *  going, and how bright it is. */
const MOVE: Record<AgentState, { speed: number; pull: number; bright: number }> = {
  working: { speed: 240, pull: 6, bright: 1 },
  ready: { speed: 40, pull: 1.5, bright: 0.8 },
  "needs-you": { speed: 180, pull: 5, bright: 1 },
  resting: { speed: 24, pull: 1, bright: 0.35 },
};
/** A body for each kind of agent (every agent of one program is one kind), and the trail behind
 *  it, from the body back. */
const BODIES = "@&%#$8O*";
const TRAIL = "oo+::..";
/** How long a finished turn's ring and a click's ripple last, in seconds. */
const RING = 1.1;
const RIPPLE = 1.8;

/** An agent's creature: where it is and how fast it goes, where it was (the newest first), its
 *  own offset in time, so no two move together, and the seconds left of its ring. */
interface Creature { c: WallpaperCreature; x: number; y: number; vx: number; vy: number; trail: Array<{ x: number; y: number }>; phase: number; ring: number }

const creatures = new Map<string, Creature>();
const ripples: Array<{ x: number; y: number; age: number }> = [];
/** Specks in the water that glint and drift on a slow current, where they are as a share of the
 *  screen. */
const specks = Array.from({ length: 220 }, () => ({
  x: Math.random(), y: Math.random(), ch: ".,'"[Math.floor(Math.random() * 3)]!, rate: 0.3 + Math.random(), phase: Math.random() * 7, drift: 0.002 + Math.random() * 0.006,
}));
let t = 0;

/** A number from 0 to 1 for a string, the same every time: an agent's id gives its own phase. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 2 ** 32;
}

/** From a to b by f (0 to 1), both #rrggbb: the tones between the theme's page and text. */
function mix(a: string, b: string, f: number): string {
  const n = (s: string, i: number) => parseInt(s.slice(1 + 2 * i, 3 + 2 * i), 16);
  return "rgb(" + [0, 1, 2].map((i) => Math.round(n(a, i) + (n(b, i) - n(a, i)) * f)).join(",") + ")";
}

/** The water, its specks and the ink of ripples: the theme's own, or with Colour on, a sea. */
function palette() {
  const { page, text, colour, dark } = wp.look;
  if (!colour) return { water: page, speck: mix(page, text, 0.25), ink: mix(page, text, 0.6) };
  return dark ? { water: "#06202a", speck: "#2c6b78", ink: "#8fd3d0" } : { water: "#dcefee", speck: "#86b9ba", ink: "#2d6f78" };
}
let colours = palette();

/** A creature's colour: the theme's text, or with Colour on, its kind's own. */
const colourOf = (c: WallpaperCreature) =>
  wp.look.colour ? "hsl(" + (Math.round(180 + c.kind * 300) % 360) + " 70% " + (wp.look.dark ? 66 : 36) + "%)" : wp.look.text;

/** Whether a point is under a tile, or within m pixels of one. */
const under = (x: number, y: number, m = 0) => wp.tiles.some((b) => x > b.x0 - m && x < b.x1 + m && y > b.y0 - m && y < b.y1 + m);

/** Beside its agent's tile, on the open side: the one with the most room and not under another
 *  tile. Null when that tile is not on the screen. */
function beside(id: string): [number, number] | null {
  const tile = wp.tiles.find((b) => b.id === id);
  if (!tile) return null;
  const { w, h } = wp.viewport;
  const gap = 28;
  const cx = Math.min(w - gap, Math.max(gap, (tile.x0 + tile.x1) / 2));
  const cy = Math.min(h - gap, Math.max(gap, (tile.y0 + tile.y1) / 2));
  const sides: Array<[number, number, number]> = [
    [tile.x0 - gap, cy, tile.x0], [tile.x1 + gap, cy, w - tile.x1], [cx, tile.y0 - gap, tile.y0], [cx, tile.y1 + gap, h - tile.y1],
  ];
  let best: [number, number, number] | null = null;
  for (const s of sides) if (s[2] > gap * 1.5 && !under(s[0], s[1], 8) && (!best || s[2] > best[2])) best = s;
  return best && [best[0], best[1]];
}

/** Where a creature is heading now. */
function goal(me: Creature): [number, number] {
  const { w, h } = wp.viewport;
  const p = me.phase;
  // A place of its own, wandering the whole screen slowly.
  const hx = w * (0.5 + 0.4 * Math.sin(t * 0.031 + p));
  const hy = h * (0.5 + 0.36 * Math.sin(t * 0.023 + p * 1.7));
  switch (me.c.state) {
    case "working": return [hx + 90 * Math.cos(t * 2.4 + p), hy + 60 * Math.sin(t * 3.3 + p)];
    case "ready": return [hx + 120 * Math.sin(t * 0.2 + p), hy + 70 * Math.cos(t * 0.15 + p)];
    case "needs-you": return beside(me.c.id) ?? [hx, hy];
    case "resting": return [hx, h - 24 - 30 * me.c.size];
  }
}

/** Out from under a tile, by its nearest edge. */
function keepOff(me: Creature, dt: number) {
  const m = 16;
  for (const b of wp.tiles) {
    if (me.x < b.x0 - m || me.x > b.x1 + m || me.y < b.y0 - m || me.y > b.y1 + m) continue;
    const out = [me.x - b.x0 + m, b.x1 + m - me.x, me.y - b.y0 + m, b.y1 + m - me.y];
    const side = out.indexOf(Math.min(...out));
    if (side < 2) me.vx += (side === 0 ? -1500 : 1500) * dt;
    else me.vy += (side === 2 ? -1500 : 1500) * dt;
  }
}

function step(dt: number) {
  t += dt;
  for (const s of specks) s.x = (s.x + s.drift * dt) % 1;
  for (const me of creatures.values()) {
    const move = MOVE[me.c.state];
    const [gx, gy] = goal(me);
    // Head for the goal, no faster than its state lets it.
    let dx = (gx - me.x) * move.pull;
    let dy = (gy - me.y) * move.pull;
    const d = Math.hypot(dx, dy);
    if (d > move.speed) { dx *= move.speed / d; dy *= move.speed / d; }
    me.vx += (dx - me.vx) * Math.min(1, dt * 3);
    me.vy += (dy - me.vy) * Math.min(1, dt * 3);
    keepOff(me, dt);
    me.x += me.vx * dt; me.y += me.vy * dt;
    // A glyph of trail each few pixels it moves, so a slow one keeps its length.
    const last = me.trail[0];
    if (!last || Math.hypot(me.x - last.x, me.y - last.y) > 7) {
      me.trail.unshift({ x: me.x, y: me.y });
      if (me.trail.length > TRAIL.length) me.trail.pop();
    }
    me.ring = Math.max(0, me.ring - dt);
  }
  for (const r of ripples) r.age += dt;
  while (ripples.length && ripples[0]!.age > RIPPLE) ripples.shift();
}

/** A ring of ch round a point, flattened as the water is. */
function ring(x: number, y: number, radius: number, alpha: number, ch: string) {
  ctx.globalAlpha = Math.max(0, alpha);
  const n = Math.max(8, Math.round(radius / 7));
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    ctx.fillText(ch, x + Math.cos(a) * radius, y + Math.sin(a) * radius * 0.6);
  }
}

function drawCreature(me: Creature, font: string) {
  const { c } = me;
  const bright = MOVE[c.state].bright;
  const px = Math.round(20 * c.size);
  const colour = colourOf(c);
  // Waiting on the person, it pulses in the theme's colour for that.
  const waiting = c.state === "needs-you";
  const pulse = waiting ? 0.5 + 0.5 * Math.sin(t * 6) : 0;
  const body = waiting ? wp.look.attention : colour;
  // A soft glow round it.
  const r = px * (1.8 + pulse);
  const glow = ctx.createRadialGradient(me.x, me.y, 0, me.x, me.y, r);
  glow.addColorStop(0, body);
  glow.addColorStop(1, "transparent");
  ctx.globalAlpha = bright * (0.16 + 0.2 * pulse);
  ctx.fillStyle = glow;
  ctx.fillRect(me.x - r, me.y - r, 2 * r, 2 * r);
  // The trail, fading toward its end.
  ctx.font = Math.round(px * 0.8) + "px " + font;
  ctx.fillStyle = colour;
  me.trail.forEach((at, i) => {
    ctx.globalAlpha = bright * 0.75 * (1 - i / TRAIL.length);
    ctx.fillText(TRAIL[i]!, at.x, at.y);
  });
  ctx.font = "bold " + Math.round(px * (1 + 0.35 * pulse)) + "px " + font;
  ctx.fillStyle = body;
  ctx.globalAlpha = bright;
  ctx.fillText(BODIES[Math.floor(c.kind * BODIES.length) % BODIES.length]!, me.x, me.y);
  if (waiting) ring(me.x, me.y, 18 + 8 * pulse, 0.6 * pulse, ".");
  // A turn that ended well: a bright ring going out from it.
  if (me.ring > 0) {
    ctx.fillStyle = colour;
    ring(me.x, me.y, 12 + (1 - me.ring / RING) * 50, me.ring / RING, "o");
  }
}

function draw() {
  const { w, h, dpr } = wp.viewport;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = colours.water;
  ctx.fillRect(0, 0, w, h);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // The person's terminal font, which may not be on this computer.
  const font = wp.look.mono + ", ui-monospace, monospace";
  ctx.font = "13px " + font;
  ctx.fillStyle = colours.speck;
  for (const s of specks) {
    ctx.globalAlpha = 0.35 + 0.65 * Math.max(0, Math.sin(t * s.rate + s.phase));
    ctx.fillText(s.ch, s.x * w, s.y * h);
  }
  ctx.fillStyle = colours.ink;
  for (const r of ripples) ring(r.x, r.y, 10 + r.age * 70, 0.8 * (1 - r.age / RIPPLE), "~");
  for (const me of creatures.values()) drawCreature(me, font);
  ctx.globalAlpha = 1;
}

wp.on("viewport", ({ w, h, dpr }) => { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); });
wp.on("look", () => { colours = palette(); });
// One creature for each agent: a new one starts where its state would take it.
wp.on("creatures", (list) => {
  for (const id of creatures.keys()) if (!list.some((c) => c.id === id)) creatures.delete(id);
  for (const c of list) {
    const had = creatures.get(c.id);
    if (had) { had.c = c; continue; }
    const me: Creature = { c, x: 0, y: 0, vx: 0, vy: 0, trail: [], phase: hash(c.id) * 100, ring: 0 };
    [me.x, me.y] = goal(me);
    creatures.set(c.id, me);
  }
});
wp.on("done", ({ id }) => { const me = creatures.get(id); if (me) me.ring = RING; });
// A click on open water ripples it and pushes the creatures near it away. A click on a creature
// is the app's: it went to that agent's tile.
wp.on("click", ({ x, y, id }) => {
  if (id !== null) return;
  ripples.push({ x, y, age: 0 });
  if (ripples.length > 6) ripples.shift();
  for (const me of creatures.values()) {
    const d = Math.hypot(me.x - x, me.y - y);
    if (d > 0 && d < 140) { me.vx += ((me.x - x) / d) * 160; me.vy += ((me.y - y) / d) * 160; }
  }
});
// The creature under the pointer: the nearest body within reach. The app shows its agent's name.
wp.hitTest((x, y) => {
  let found: string | null = null;
  let near = Infinity;
  for (const me of creatures.values()) {
    const d = Math.hypot(me.x - x, me.y - y);
    if (d < 12 + 12 * me.c.size && d < near) { near = d; found = me.c.id; }
  }
  return found;
});
// At most 30 frames a second while it runs, nothing while it is held, one settled frame when
// Animation is off: the app's clock, the same as its own scenes'.
wp.animate({ step, draw });
`;
