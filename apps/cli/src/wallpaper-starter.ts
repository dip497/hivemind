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
      description: "Fish drawn in characters, drifting in the water; they shy from the pointer.",
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

A [Hivemind](https://hivemind.griiken.com) live wallpaper: fish drawn in characters, drifting
behind the canvas, that shy from the pointer.

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
const SCENE = `// A Hivemind live wallpaper: a world of its own, drawn in characters behind the canvas, whose
// life goes on by itself and plays with the pointer. The app says the size, the theme and whether
// to move, and the pointer and clicks over empty canvas. The whole guide is in PROMPT.md.
import { connectWallpaper } from "@hivemind/view-sdk";

const wp = await connectWallpaper();

const canvas = document.createElement("canvas");
canvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%";
document.body.append(canvas);
const ctx = canvas.getContext("2d")!;

/** A body for each kind of fish, and the trail behind it, from the body back. */
const BODIES = "@&%#$8O*";
const TRAIL = "oo+::..";
/** How fast a fish cruises (pixels a second), how near the pointer comes before it turns away,
 *  and how long a click's ripple lasts (seconds). */
const SPEED = 70;
const SHY = 150;
const RIPPLE = 1.8;

/** A fish: where it is and how fast it goes, its kind (0 to 1) and size, its own offset in time,
 *  so no two wander together, and where it was (the newest first). */
interface Fish { x: number; y: number; vx: number; vy: number; kind: number; size: number; phase: number; trail: Array<{ x: number; y: number }> }

const fish: Fish[] = [];
const ripples: Array<{ x: number; y: number; age: number }> = [];
/** Specks in the water that glint and drift on a slow current, where they are as a share of the
 *  screen. */
const specks = Array.from({ length: 220 }, () => ({
  x: Math.random(), y: Math.random(), ch: ".,'"[Math.floor(Math.random() * 3)]!, rate: 0.3 + Math.random(), phase: Math.random() * 7, drift: 0.002 + Math.random() * 0.006,
}));
let pointer: { x: number; y: number } | null = null;
let t = 0;

/** The water, its specks and the ink of ripples: a sea, light or dark by the theme. */
const palette = () => (wp.look.dark ? { water: "#06202a", speck: "#2c6b78", ink: "#8fd3d0" } : { water: "#dcefee", speck: "#86b9ba", ink: "#2d6f78" });
let colours = palette();

/** A fish's colour: its kind's own. */
const colourOf = (f: Fish) => "hsl(" + (Math.round(180 + f.kind * 300) % 360) + " 70% " + (wp.look.dark ? 66 : 36) + "%)";

/** As many fish as the screen holds without crowding, each kind among them, anywhere on it. */
function stock() {
  const { w, h } = wp.viewport;
  const n = Math.max(10, Math.min(40, Math.round((w * h) / 45000)));
  while (fish.length < n) {
    fish.push({ x: Math.random() * w, y: Math.random() * h, vx: 0, vy: 0, kind: (fish.length % BODIES.length) / BODIES.length, size: 0.7 + Math.random() * 0.5, phase: Math.random() * 100, trail: [] });
  }
  fish.length = n;
}

/** Where a fish is heading: a place of its own, wandering the whole screen slowly. */
function goal(f: Fish): [number, number] {
  const { w, h } = wp.viewport;
  return [w * (0.5 + 0.45 * Math.sin(t * 0.031 + f.phase)), h * (0.5 + 0.4 * Math.sin(t * 0.023 + f.phase * 1.7))];
}

function step(dt: number) {
  t += dt;
  for (const s of specks) s.x = (s.x + s.drift * dt) % 1;
  for (const f of fish) {
    const [gx, gy] = goal(f);
    const dx = gx - f.x;
    const dy = gy - f.y;
    const d = Math.hypot(dx, dy) || 1;
    const speed = Math.min(SPEED * f.size, d);
    let vx = (dx / d) * speed;
    let vy = (dy / d) * speed;
    // Shy of the pointer: within reach, away from it, the nearer the faster.
    if (pointer) {
      const px = f.x - pointer.x;
      const py = f.y - pointer.y;
      const pd = Math.hypot(px, py);
      if (pd > 0 && pd < SHY) {
        const k = (1 - pd / SHY) * 260;
        vx += (px / pd) * k;
        vy += (py / pd) * k;
      }
    }
    // It turns toward what it wants, not at once: a fish has weight.
    const ease = Math.min(1, dt * 2);
    f.vx += (vx - f.vx) * ease;
    f.vy += (vy - f.vy) * ease;
    f.x += f.vx * dt;
    f.y += f.vy * dt;
    // A glyph of trail each few pixels it moves, so a slow one keeps its length.
    const last = f.trail[0];
    if (!last || Math.hypot(f.x - last.x, f.y - last.y) > 7) {
      f.trail.unshift({ x: f.x, y: f.y });
      if (f.trail.length > TRAIL.length) f.trail.pop();
    }
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
  for (const f of fish) {
    const px = Math.round(18 * f.size);
    ctx.fillStyle = colourOf(f);
    ctx.font = Math.round(px * 0.8) + "px " + font;
    f.trail.forEach((at, i) => {
      ctx.globalAlpha = 0.75 * (1 - i / TRAIL.length);
      ctx.fillText(TRAIL[i]!, at.x, at.y);
    });
    ctx.font = "bold " + px + "px " + font;
    ctx.globalAlpha = 1;
    ctx.fillText(BODIES[Math.floor(f.kind * BODIES.length) % BODIES.length]!, f.x, f.y);
  }
  ctx.globalAlpha = 1;
}

wp.on("viewport", ({ w, h, dpr }) => { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); stock(); });
wp.on("look", () => { colours = palette(); });
wp.on("pointer", ({ x, y, over }) => { pointer = over ? { x, y } : null; });
// A click ripples the water, and the fish near it dart away.
wp.on("click", ({ x, y }) => {
  ripples.push({ x, y, age: 0 });
  if (ripples.length > 6) ripples.shift();
  for (const f of fish) {
    const d = Math.hypot(f.x - x, f.y - y);
    if (d > 0 && d < 160) { f.vx += ((f.x - x) / d) * 220; f.vy += ((f.y - y) / d) * 220; }
  }
});
// At most 30 frames a second while it runs, nothing while it is held, one settled frame when
// Animation is off: the app's clock, the same as its own scenes'.
wp.animate({ step, draw });
`;
