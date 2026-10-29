---
name: hivemind-live-wallpaper
description: Build, check, package and publish a Hivemind live wallpaper — a sandboxed scene that moves behind the canvas, a world of its own (as the Live scenes package's Shoal, Koi Pond, Jellyfish and Fireflies are) or one whose creatures are the person's agents. Covers live wallpaper protocol 1 and its SDK (connectWallpaper, hitTest, animate, fakeWallpaperHost), the clock and its run/hold/still rule, sizing the canvas, keeping off tiles and the needs-you visit to the creature's own tile, hover and click, colours and readable panel text, cost, tests, the package it ships in, offering it with startup.wallpaper, shipping it beside a view and a theme, and HiveHub. Use when making, debugging or reviewing a live wallpaper.
---

# Building a Hivemind live wallpaper

The guide for people is https://hivemind.griiken.com/guide/live-wallpapers/ (as Markdown:
https://hivemind.griiken.com/guide/live-wallpapers.md). This file is for the coding agent that
writes one. Its sister skill, **ascii-character-animation**, is the craft of drawing a scene in
characters; read it before you design how anything looks.

## Why this exists

A live wallpaper is drawn behind the person's canvas all day. Most are a world of their own that
moves on its own and plays with the pointer: the Live scenes package's reef, pond, deep sea and
meadow ignore the agents entirely. A wallpaper may also draw the person's agents: one creature per
agent, each program's agents one kind, and what a creature does says what its agent is doing, so
a glance at the water tells the person which agent needs them. Ask the person which they want;
everything below about creatures, `hitTest` and the needs-you visit applies only to the second.

Two things make it hard, and neither is the protocol, which is small:

- **It sits under work.** Tiles with terminals in them float over it. A creature that swims under
  a terminal's text makes the text hard to read; a scene too bright behind a frosted panel makes
  the panel's names hard to read. The scene has to keep out of the way of the thing it decorates.
- **It runs all day.** A scene that draws 60 times a second while the window is hidden, or that
  costs 20 ms a frame, spends the battery on nothing and is turned off by the app.

## What you are given, and what you may do

The app tells the wallpaper:

- **Creatures**: at most 8 `{ id, agent, kind, size, state }`. `id` is opaque and stable until
  the agent's tile closes. `agent` is the program's id (`"claude"`, `"codex"` …) or `null`.
  `kind` is 0 to 1 and the same for every agent of one program. `size` is about 0.78 to 1, the
  same for this agent every time. `state` is `working`, `ready`, `needs-you` (a permission, a
  question, a plan to review) or `resting` (stopped, failed or asleep). With more than 8 agents,
  the ones that need the person come first, then the ones at work.
- **Tiles**: `{ x0, y0, x1, y1, id? }` in CSS pixels of the viewport, each tile and each panel
  that is not glass; `id` on an agent's tile is its creature's id. `seeThrough` says the tiles are
  frosted glass. At most 256.
- **Look**: `{ page, text, attention, dark, colour, mono }`. Colours are `#rrggbb`. `attention` is
  the theme's needs-you colour. `colour` is the person's **Colour** switch. `mono` is the
  terminals' font as a CSS font list.
- **Viewport**: `{ w, h, dpr }`. **Mode**: `run`, `hold` or `still`.
- **Events**: `done { id }` (that agent finished a turn well), `pointer { x, y, over }` (the
  pointer over empty canvas), `click { x, y, id }` (a click on empty canvas; `id` is the creature
  the app opened, or `null` for open water).

It is never told a name, a folder, a command, a reply, a tile's own id or anything a terminal
shows: a creature's `id` is a handle for this session, the same on its tile. It can do nothing to
the workspace. It says three things back, each with its own keys and no others: `ready` (it speaks
protocol 1), `drawn` (its first frame is up, so the app shows the layer) and `hover { id }` (the
creature under the pointer). While the pointer is over empty canvas, the app then shows that
agent's name and state beside the pointer, and a click there goes to the agent's tile; a `hover`
while the pointer is over a tile or a panel is not heard.

That asymmetry is the design: the scene decides how the agents look; it decides nothing else.

It is not drawn behind a plugin view (a view lays out its own tiles) or on the phone page.

## The smallest one that works

`hive plugins new wallpaper <name>` writes a package `<name>/` holding the wallpaper in
`wallpapers/<name>/`, its `hivemind-wallpaper.json`, a working scene in `src/main.ts`, a
`PROMPT.md`, and this skill and its sister in the package's `.claude/skills/`. The package's
`startup.wallpaper` names the wallpaper. `--in <package>` adds one to a package that exists;
`--owner <login>` sets the GitHub login when `gh` is not signed in.

```json
{
  "protocol": 1,
  "name": "Pond",
  "entry": "dist/main.js",
  "description": "Koi under lily pads, one for each agent.",
  "colour": true,
  "preview": "preview.png"
}
```

```ts
import { connectWallpaper } from "@hivemind/view-sdk";

const wp = await connectWallpaper();            // sends ready, resolves on the app's hello
const canvas = document.body.appendChild(document.createElement("canvas"));
Object.assign(canvas.style, { position: "fixed", inset: "0" });
const g = canvas.getContext("2d")!;

wp.on("viewport", ({ w, h, dpr }) => {          // called at once with the current one
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  Object.assign(canvas.style, { width: `${w}px`, height: `${h}px` });
});
wp.hitTest((x, y) => creatureAt(x, y));         // the creature under a point, or null
wp.animate({ step, draw, settle });             // the clock; says drawn after the first frame
```

An `entry` that is a `.js` script is put in a page of the app's own, so create your canvas in
code, as above; an `.html` entry may hold its own. `connectWallpaper()` rejects after 10 s with no
handshake. Await it before reading `wp.look`, `wp.viewport` or `wp.creatures`: they are not there
before the hello.

`wp.on(event, cb)` returns the way to stop listening. For `viewport`, `look`, `mode`, `creatures`
and `tiles`, a new listener is called at once with the latest value.

## The rule that matters most: the clock

**Never run a `requestAnimationFrame` loop or a timer of your own.** Run the scene on
`wp.animate({ step, draw, settle }, { fps })`:

- `step(dt)` moves the simulation on by `dt`, which is always 1/60 s. It is called as many times
  as the time that passed needs, at most 4 times a frame; a computer that falls further behind
  drops the rest instead of racing. The scene moves at the same speed at any frame rate.
- `draw(dt)` draws the scene as it is, at most 30 times a second (`fps` asks for up to 60).
  Characters read smooth at 30, and it costs half of 60. `dt` is the time since the last frame,
  for what fades with time. Never step in `draw`, never draw in `step`.
- `settle()` puts everything where it would be after a while, for a still frame. Without it the
  clock calls `step` 360 times (six seconds of scene).

The mode decides what runs:

| Mode | When | The clock |
|---|---|---|
| `run` | the window is in front, the person busy or resting their hands | steps and draws |
| `hold` | the window is hidden, not in front, or covered | nothing on its own. It draws one frame again, without stepping, only when the size, the look, the creatures or the tiles change |
| `still` | the person turned off **Animate the background**, or the system asks for reduced motion | `settle()` and one draw; the same again on each change |

The first frame is drawn at once in every mode, so a held wallpaper still shows something.

**Why held means you draw nothing of your own.** The app holds the scene because nobody is
looking: the window is hidden, behind another, or covered. Every frame drawn then is battery spent
on a picture no one sees, on a laptop that thought it was resting. A `setInterval` that "keeps the
water moving" while held is exactly that. The clock already redraws when something the person
could see changes.

**Still frames are a picture, not a paused film.** Settle the simulation: creatures where their
state puts them (a resting one at the bottom, a needs-you one by its tile), at rest, facing a
sensible way; then draw once. Each change calls `settle()` again, so settle only what changed: a
new creature is placed, a gone one removed, one whose state changed moved to its place, and the
rest stay where they were. A `settle()` that re-randomises everything makes the whole picture jump
whenever one agent changes state.

Without `animate` (a scene that draws once, say), call `wp.drawn()` after the first frame, or the
app never shows the layer.

## Size the canvas to the viewport times its pixel ratio

`viewport` is CSS pixels and `dpr` the screen's pixel ratio (up to 4). Make the canvas
`w × dpr` by `h × dpr` device pixels and `w` by `h` CSS pixels, and draw with
`setTransform(dpr, 0, 0, dpr, 0, 0)`. Everything the app tells you (tiles, pointer, clicks) is in
CSS pixels, so the scene works in CSS pixels and only the transform knows about `dpr`.

Setting `canvas.width` clears the canvas and resets its transform: set the transform at the start
of every `draw`, and rebuild anything sized in device pixels (a backdrop, a glyph atlas) on a
`viewport` change. The clock draws again after a resize in every mode, so the canvas never shows
blank.

## Creatures: meet them, give each its kind

```ts
type State = "working" | "ready" | "needs-you" | "resting";
interface Body { id: string; x: number; y: number; heading: number; speed: number; kind: number; size: number; state: State; seed: number }

const KINDS = 6;                                            // how many kinds of creature you draw
const kindOf = (k: number) => Math.min(KINDS - 1, Math.floor(k * KINDS)); // kind can be exactly 1
const hash = (s: string) => { let h = 2166136261; for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return (h >>> 0) / 2 ** 32; };

const bodies = new Map<string, Body>();
let stocked = false;

wp.on("creatures", (cs) => {
  for (const id of bodies.keys()) if (!cs.some((c) => c.id === id)) leave(id); // swim off, then drop
  for (const c of cs) {
    const b = bodies.get(c.id);
    if (b) { b.state = c.state; b.kind = kindOf(c.kind); b.size = c.size; continue; }
    // The agents there when the scene starts are in the water already; a later one swims in.
    const nb = { id: c.id, kind: kindOf(c.kind), size: c.size, state: c.state, seed: hash(c.id), heading: 0, speed: 0, x: 0, y: 0 };
    if (stocked) enterFromEdge(nb); else placeWhereItBelongs(nb);
    bodies.set(c.id, nb);
  }
  stocked = true;
});
```

- `kind` picks the kind of creature (`kindOf`): all of one program's agents look alike, and differ
  from another program's. `kind` may be exactly 1, so clamp the index.
- Seed a creature's own variety (a marking, a phase, a wobble) from `hash(id)`: it looks the same
  every frame and after a reload, and two agents of one program still differ a little.
- Map each state to behaviour a glance can read. For instance: at work, it hunts or flies
  fast; ready, it cruises slowly; needs you, it goes to its agent's tile and calls (circles,
  holds and glows, flashes a call); resting, it sinks or settles low and goes dim. A turn done
  well (`done`) is a flash or a bite.
- A creature whose id leaves the list swims off and is dropped once out of sight. It may come
  back: the 8-creature cap can drop one for a while when other agents need the person.
- Show `done` only while `wp.mode === "run"`: a flash in a still frame is a frozen smudge.

## Keep off the tiles, and visit its own tile

Tiles come once a second while the scene runs, and at most once a frame while the canvas moves.
Keep every creature in the open water between them:

```ts
const covered = (tiles: readonly WallpaperTile[], x: number, y: number, pad: number) =>
  tiles.some((b) => x > b.x0 - pad && x < b.x1 + pad && y > b.y0 - pad && y < b.y1 + pad);

/** Somewhere in the open water a creature at `from` can reach without passing under a tile. */
function openSpot(tiles: readonly WallpaperTile[], w: number, h: number, from: { x: number; y: number }) {
  let best = { x: w / 2, y: h / 2 }, bestCost = Infinity;
  for (let i = 0; i < 16; i++) {
    const p = { x: w * (0.08 + 0.84 * Math.random()), y: h * (0.08 + 0.84 * Math.random()) };
    if (covered(tiles, p.x, p.y, 60)) continue;
    let cost = 0;                                        // how much of the way is under a tile
    for (let k = 1; k < 8; k++) if (covered(tiles, from.x + ((p.x - from.x) * k) / 8, from.y + ((p.y - from.y) * k) / 8, 30)) cost++;
    if (cost < bestCost) { best = p; bestCost = cost; if (cost === 0) break; }
  }
  return best;
}
```

- **Goals in open water.** Pick the next goal with `openSpot`, ahead of the creature where you
  can (add the turn it needs to the cost), so it swims on in long curves instead of doubling back.
- **Turn before a tile.** Look ahead of the creature by most of its length; if that point is near
  a tile, steer away from the tile's middle. A long creature turns wide, so look further.
- **Out quickly.** A tile put down over a creature: push it out by the nearest side, faster than
  it cruises.
- **A box over half the window** leaves no open water: let it be, or every creature piles up in a
  corner.
- **Draw nothing of a creature under a tile.** A cell whose centre is within half a cell of a
  tile is covered too, so nothing shows through the seams between two tiles. When `seeThrough`
  is true the tiles are frosted, and a creature under one may be drawn soft and faint (one pixel
  a cell there, scaled up smoothly, reads as shape with no characters).

**The needs-you visit.** The tile whose `id` is the creature's is its agent's. The creature goes
there and holds by the open side, where the person will look and where no other tile is:

```ts
function visitSpot(tile: WallpaperTile, tiles: readonly WallpaperTile[], w: number, h: number, r: number) {
  const right = w - tile.x1 > tile.x0;                    // more room on the right
  const midX = (tile.x0 + tile.x1) / 2, midY = (tile.y0 + tile.y1) / 2;
  const spots = [
    { x: right ? tile.x1 + r : tile.x0 - r, y: midY },     // the open side
    { x: right ? tile.x0 - r : tile.x1 + r, y: midY },     // the other side
    { x: midX, y: tile.y0 - r },                           // above
    { x: midX, y: tile.y1 + r },                           // below
  ];
  const others = tiles.filter((b) => b !== tile);
  const fits = (p: { x: number; y: number }) => p.x > r && p.x < w - r && p.y > r && p.y < h - r && !covered(others, p.x, p.y, r * 0.8);
  return spots.find(fits) ?? spots[0]!;
}
```

`r` is how far out the creature's whole body sits, tentacles and tail included: nothing of it over
the tile's text. Hurry there (a needs-you creature far from its tile moves as fast as one at
work), then hold: circle, hover, or bob. Other creatures give way to it. When its tile is not in
`tiles` (scrolled off, or in another frame out of sight), it stays in the open water: there is
nowhere on screen to point at.

## Hover and click

```ts
wp.hitTest((x, y) => {
  for (const b of bodies.values()) if (Math.hypot(b.x - x, b.y - y) < radiusOf(b)) return b.id;
  return null;
});
wp.on("click", ({ x, y, id }) => { if (id === null && wp.mode === "run") splash(x, y); });
```

- The client calls your hit test on each `pointer` message (at most once a frame while the
  pointer moves over empty canvas) and sends `hover` only when the answer changes. Keep it to a
  few distance checks per creature, against where each was drawn.
- It names only a creature the app sent: the client drops any other id, and the app refuses one
  that slips through.
- Hit the creature's body, not its whole box: a long diagonal creature has an empty box. A few
  points along its spine with a radius each is enough.
- A click with an `id` already took the person to that agent's tile. A click on open water
  (`id` null) is the scene's to answer: a ripple, a scatter, fish bolting. Never draw an agent's
  name; you do not have it, and the app draws it.

## Colours: the theme's, its own, and readable panels

- **The theme's two colours by default.** Draw every tone as a step from `page` to `text`: the
  scene then fits every theme. Work the steps out once per `look` (65 steps is plenty) and pick by
  index each frame; a frame that builds colour strings is slow.
- **Which way round.** On a dark theme (`dark`), creatures are light on the dark page. On a light
  one, draw ink on paper: creatures darker than the page, characters darker than their cells.
- **`attention` is meaning.** It is the colour the whole app uses for "needs you". Spend it on a
  creature whose agent needs the person, or not at all; never on decoration.
- **Its own colours.** Put `"colour": true` in the manifest and Settings shows the **Colour**
  switch; `look.colour` is true while it is on. Then draw in your own palette, one for a dark
  theme and one for a light one (pick by `dark`). Set it in OKLCH, mix in OKLab, map out-of-gamut
  colours by lowering chroma: the sister skill shows how.
- **Panel text over it.** With glass on, the Layers panel and the toolbars are frosted glass over
  the scene, and their names sit right over your water. Over a live wallpaper the Layers
  panel is clearer still: a third of its usual tint, as little as a sixth with See-through. Design
  for that. Keep the ground dark enough on
  a dark theme and light enough on a light one. Test it the way the Live scenes do: composite
  the panel colour at a sixth over every point of your ground (each gradient stop, a glow at its
  brightest, a light shaft at its brightest) and check the panel's text at 7:1 or more and its
  secondary text at 4.5:1 or more, for a dark preset and a light one.
- **`mono` may not exist here.** It is the person's font, and the frame has none of the app's web
  fonts. Always end it with a fallback (`` `${look.mono}, monospace` ``), measure a cell with
  `measureText("M")` after setting the font, and rebuild what depends on it when `look` changes.

## What it costs

The scene runs in a process of its own, so it never stalls the person's terminals. The app still
watches it: 60% of a CPU core for six seconds turns it off for the session. At 30 frames a second
that is 20 ms a frame; a scene near that on your computer is turned off on a slower one.

- Draw what changed, not everything: paint the still ground once into an offscreen canvas per
  size and look, and copy it in each frame. Bake slow layers (light shafts, a reef) a few times a
  second, not every frame. Cache sprites (a glow, a lily pad) and draw them again only when they
  change.
- Group cells by colour, so a frame sets `fillStyle` a few dozen times, not once per cell.
- Keep `step` and `hitTest` free of allocation in their loops.

**Measure.** Time `draw` over 600 frames and report the median and the 90th percentile, at
1440×900 at 1× and at 2×, in the theme's colours and in its own:

```ts
const times: number[] = [];
wp.animate({ step, settle, draw: (dt) => {
  const t0 = performance.now();
  drawScene(dt);                                   // your draw
  times.push(performance.now() - t0);
  if (times.length === 600) {
    const s = [...times].sort((a, b) => a - b);
    console.log(`median ${s[300]!.toFixed(2)} ms, p90 ${s[540]!.toFixed(2)} ms`);
  }
} });
```

For scale, the Live scenes measured, median per frame in headless Chromium: Fireflies 1.1 ms
at 1× and 2.2 ms at 2×, Jellyfish 1.9 / 3.4, Koi Pond 3.3 / 4.7, Shoal 5.6 / 8.0. **A headless
browser renders in software**, with no GPU: its numbers overstate what a real screen costs, and
its frame rate means nothing. Compare like with like, and say how you measured.

## Test it without the app

`fakeWallpaperHost` from `@hivemind/view-sdk/testing` is a pretend app over a real
`MessageChannel`: it sends what your test says, checks every answer the way the app does, and
keeps what it saw.

```ts
import { fakeWallpaperHost } from "@hivemind/view-sdk/testing";

const host = fakeWallpaperHost({
  viewport: { w: 1440, h: 900, dpr: 1 },
  creatures: [{ id: "a", agent: "claude", kind: 0.2, size: 1, state: "needs-you" }],
  tiles: [{ x0: 500, y0: 300, x1: 900, y1: 600, id: "a" }],
  mode: "still",
});
const wp = await host.connect();   // or host.handshake(window) before the page's own connectWallpaper()
startScene(wp);                    // your scene, taking the client rather than connecting itself
await host.settle();
host.drawn;                        // it said its first frame is up
host.point(960, 450);              // the pointer over empty canvas, beside the tile
await host.settle();
host.hovered;                      // the creature it says is there: what a click would open
host.click(960, 450);              // returns that creature, and sends the click
host.refused;                      // what the app would refuse, and why: [] for a scene that behaves
```

Make the scene testable by splitting it: a simulation that takes the client's values and knows no
canvas, and a drawing that reads the simulation. Then test behaviour on the simulation alone:

- **Seed the randomness.** Replace `Math.random` with a seeded generator (mulberry32) in the test,
  run a fixed number of steps of 1/60 s, and assert on what happened, over a few seeds.
- **One test per behaviour, with its number.** A needs-you creature is beside the open side of its
  tile 90% of ten seconds; the others' heads are under a tile under 1% of the time; a resting one
  stays in the bottom fifth; a gone one is dropped within some seconds; a still frame moves only
  what changed. Pick each bar from what many seeds measure, clear of them.
- **Show each test failing.** Break the rule it guards (delete the visit, the turn before a tile),
  run it, see it fail, put the rule back. A test that passes with its rule gone guards nothing.
- **Golden pictures.** Draw a fixed seed's frame at a fixed size and hash its pixels. When a
  refactor should not change the picture, the hash proves it did not, plain and in colour.

## Package it, offer it, ship it beside a view

A live wallpaper always ships in a package. The package names it:

```json
{
  "id": "@you/pond",
  "name": "Pond",
  "version": "0.1.0",
  "wallpapers": [{ "path": "wallpapers/pond" }],
  "startup": { "wallpaper": "@you/pond/pond" }
}
```

- Its id is `@owner/package/<folder>`: the folder's name is the last part (lowercase letters,
  digits and single dashes, up to 64). At most 8 in a package.
- `startup.wallpaper` must name one of the package's own wallpapers. Once the package is installed
  and on, the app offers it as the background, once per package, the way `startup.view` offers a
  view. The person chooses; the app never switches on its own, because an agent may be the one
  installing.
- **Beside a view and a theme.** One package can hold a view, its widgets, a theme and a live
  wallpaper that all go together, as Archipelago (`@dip497/archipelago`) holds its view, its
  widgets and a theme and offers the view with `startup.view`. Name both in `startup` (`view` and
  `wallpaper`) and the app offers both. Remember the wallpaper is not drawn behind a plugin view:
  it shows on the canvas and windows views.
- A package of wallpapers, views, widgets and themes runs no code outside a sandbox, so it
  arrives switched on.

## Check, install, use, publish

```bash
npm install                                   # once, where the starter's package.json is
npm run build                                 # writes dist/main.js, the manifest's entry
hive plugins check <package>                  # manifests, then the wallpaper loaded in a headless browser:
                                              # it must say ready and drawn and name only creatures it was sent
hive plugins install <package>                # --json names startWallpaper, with the command to use it
hive config set appearance.wallpaper.kind '"@you/pond/pond"'   # switch to it (ask the person first)
hivehub publish <package>                     # after commit and push, with dist/ committed
```

**Settings → Appearance → Background** lists installed live wallpapers after the app's own backgrounds.
Install again after each change. Ask the person before switching their background; on a yes,
use the command the install printed.

Publishing: commit the package with the wallpaper's `dist/`, push it to a public GitHub
repository, and run `hivehub publish <package>`. HiveHub publishes the pushed commit, never the
disk. It lists a package holding a live wallpaper as needing Hivemind 2026.10.8 or newer. The
whole flow is https://hivemind.griiken.com/guide/publish-to-hivehub/ and packages are
https://hivemind.griiken.com/guide/packages/.

## What the sandbox refuses

The wallpaper runs in a sandboxed frame like a view: an opaque origin, `default-src 'none'`, nothing
network, no permissions, in its own process.

| You wrote | What happens |
|---|---|
| `fetch()`, XHR, WebSocket, an `EventSource` | refused: there is no network. Bundle the data into the script |
| a Google Fonts `<link>`, a CDN `<script>` | loads nothing, with no error worth reading |
| `localStorage`, `indexedDB` | they throw in an opaque origin: hold state in memory. Nothing survives a reload, so a scene must look right from a cold start |
| `<iframe>` | refused |
| `Notification`, `getUserMedia`, geolocation, the clipboard | refused: no permissions |
| `require`, `process`, `node:*`, `window.hive` | none of them exist here |
| a picture from the web | refused. Bundle pictures, or draw them; `data:` and `blob:` URLs work |

## What turns it off

The app checks everything the wallpaper sends. It turns the wallpaper off for the session, with
a notice, and draws the plain background instead, when it:

- sends 8 messages that do not parse, or that name a creature the app never sent;
- sends more than 120 messages a second (it answers the pointer at most once a frame: far fewer);
- says `ready` with a newer protocol than the app speaks;
- takes the keyboard: anything in its frame focused (an input, a `tabindex`), by script or not;
- uses 60% of a CPU core for six seconds.

`hive plugins check` and `fakeWallpaperHost`'s `refused` catch the first three before the person
does.

## True, and not guessable

- **`kind` can be exactly 1.** `Math.floor(kind * n)` is then `n`, one past the end. Clamp it.
- **`look` is undefined before the hello.** Everything reads after `await connectWallpaper()`.
- **The first roster is the agents already there.** Put them straight where they belong; only a
  creature that arrives later swims in from an edge. Otherwise picking the wallpaper shows an
  empty sea for seconds.
- **`tiles` includes panels.** A panel that is not glass is a box without an `id`. With glass on,
  the frosted panels are not in it, and a creature may pass under them.
- **A tile can land on a creature.** Tiles arrive once a second; for up to a second a creature
  may be under one that was just put down. Leave quickly, by the nearest side.
- **A held frame is redrawn on a change, with `dt` of 1/60.** `draw` must not assume `dt` is a
  real frame's length, and must draw a sensible picture without a `step` before it.
- **The cap moves creatures in and out.** With more than 8 agents, a creature leaves when another
  agent's need outranks it, and comes back later with the same id.
- **Light themes are not dark themes inverted.** Light creatures on a light page vanish. Draw ink
  on paper, and lift a dark creature on dark ground so it never sinks into it.
- **The name shown on hover is the app's.** Do not draw labels, numbers or text that look like
  the app's own; the person reads the scene as the app.
- **The scene is not on screen behind a plugin view or on the phone.** Do not build a feature
  that only works there.

## Before you finish

| Check | How |
|---|---|
| It loads, says ready and drawn, names only creatures it was sent | `hive plugins check <package>` says ok |
| Nothing runs while held | in a test: `mode: "hold"`, then no `step`, and no `draw` after the first frame, for a second |
| A still frame is settled, and only what changed moves | in a test: change one creature's state in `still`, compare the others' places |
| Creatures keep off the tiles; nothing shows under a solid one | a seeded test with tiles, and a look with tiles over the scene |
| A needs-you creature holds on the open side of its own tile | a seeded test, with another tile beside it |
| Hover names the creature under the pointer; a click on open water answers | `fakeWallpaperHost`: `point`, `hovered`, `click` |
| Light and dark, theme colours and its own | screenshots of all four; panel text contrast tested |
| Sharp on a 2× screen | the canvas is `w × dpr` by `h × dpr` |
| Cost | median and p90 per frame at 1× and 2×, stated with how you measured |
| The package offers it | `startup.wallpaper` names it; the install's `--json` has `startWallpaper` |
| `README.md` | says what the scene is and what each state looks like |
