---
name: hivemind-live-wallpaper
description: Build, check, package and publish a Hivemind live wallpaper — a sandboxed scene drawn behind the canvas, a world of its own whose life moves by itself and plays with the pointer (as Shoal's fish scatter from it). Covers live wallpaper protocol 2 and its SDK (connectWallpaper, on, animate, drawn, fakeWallpaperHost), the clock and its run/hold/still rule, sizing the canvas, what makes a good ambient scene behind terminals, the pointer and clicks as play, colours and readable panel text, cost, tests, the package it ships in, offering it with startup.wallpaper, shipping it beside a view and a theme, HiveHub, and what the sandbox refuses. Use when making, debugging or reviewing a live wallpaper.
---

# Building a Hivemind live wallpaper

The guide for people is https://hivemind.griiken.com/guide/live-wallpapers/ (as Markdown:
https://hivemind.griiken.com/guide/live-wallpapers.md). This file is for the coding agent that
writes one. Its sister skill, **ascii-character-animation**, is the craft of drawing a scene in
characters; read it before you design how anything looks.

## Why this exists

A live wallpaper is drawn behind the person's canvas all day. It is a small world of its own: a
sea, a pond, the deep, a meadow at night. What lives there goes about its life by itself, and
plays with the one thing the person does to it, the pointer. It knows nothing of their work and
asks nothing of them.

Two things make it hard, and neither is the protocol, which is small:

- **It sits under work.** Tiles with terminals in them float over it, and frosted panels show it
  through their tint. A scene that is busy, bright or flickering pulls the eye from the work it
  decorates, and one too bright behind a frosted panel makes the panel's names hard to read.
- **It runs all day.** A scene that draws 60 times a second while the window is hidden, or that
  costs 20 ms a frame, spends the battery on nothing and is turned off by the app.

## What you are given, and what you may do

The app tells the wallpaper:

- **Viewport**: `{ w, h, dpr }`, its size in CSS pixels and the screen's pixel ratio (the app
  sends at most 2: a sharper screen is drawn at 2).
- **Look**: `{ page, text, dark, mono }`. `page` and `text` are the theme's colours as `#rrggbb`;
  `dark` says whether the theme is dark; `mono` is the terminals' font as a CSS font list.
- **Mode**: `run`, `hold` or `still` (see the clock).
- **Pointer**: `{ x, y, over }`, the pointer over empty canvas, or gone from it (`over: false`).
  At most once a frame while it moves there, and once as it leaves.
- **Click**: `{ x, y }`, the main button pressed on empty canvas.

`hello` carries the first three at once, with the protocol, after the wallpaper says `ready`.
The app sends each of `viewport`, `look` and `mode` again only when it changes, never the same
thing twice.

It is told nothing of the workspace: not the agents, the tiles, where they are, their names or
anything a terminal shows. It can do nothing to the workspace. It says two things back, each with
its own keys and no others: `ready { protocol: 2 }` (it speaks this protocol) and `drawn` (its
first frame is up, so the app shows the layer). Anything else it sends is refused.

It is not drawn behind a plugin view (a view paints its own scene) or on the phone page, and not
at all when the computer asks for more contrast or less transparency.

## The smallest one that works

`hive plugins new wallpaper <name>` writes a package `<name>/` holding the wallpaper in
`wallpapers/<name>/`, its `hivemind-wallpaper.json`, a working scene in `src/main.ts` (fish drawn
in characters that wander, shy from the pointer and ripple where you click), a `PROMPT.md`, and
this skill and its sister in the package's `.claude/skills/`. The package's `startup.wallpaper`
names the wallpaper. `--in <package>` adds one to a package that exists; `--owner <login>` sets
the GitHub login when `gh` is not signed in.

```json
{
  "protocol": 2,
  "name": "Pond",
  "entry": "dist/main.js",
  "description": "Koi under lily pads that drift toward your pointer.",
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
  populate(w, h);                               // as many as this screen holds
});
wp.on("pointer", ({ x, y, over }) => notice(over ? { x, y } : null));
wp.on("click", ({ x, y }) => splash(x, y));
wp.animate({ step, draw, settle });             // the clock; says drawn after the first frame
```

An `entry` that is a `.js` script is put in a page of the app's own, so create your canvas in
code, as above; an `.html` entry may hold its own. `connectWallpaper()` rejects after 10 s with no
handshake. Await it before reading `wp.look`, `wp.viewport` or `wp.mode`: they are not there
before the hello.

`wp.on(event, cb)` takes `viewport`, `look`, `mode`, `pointer` and `click`, and returns the way to
stop listening. For `viewport`, `look` and `mode`, a new listener is called at once with the
latest value.

A manifest whose `protocol` is `1` is refused at install and by `hive plugins check`: "it speaks
live wallpaper protocol 1, which this Hivemind no longer does: build it again with the SDK this
app serves, and set "protocol" to 2".

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
| `run` | the window is shown and focused, whether or not the person is using it | steps and draws |
| `hold` | the window is hidden or not focused, or something covers the canvas (Settings, a fullscreen tile) | nothing on its own. It draws one frame again, without stepping, only when the size or the look changes. No pointer or click comes |
| `still` | the person turned off **Animation**, or the system asks for reduced motion | `settle()` and one draw; the same again on each change |

The first frame is drawn at once in every mode, so a held wallpaper still shows something.

**A live scene runs while the person is idle.** Someone resting their hands is there to watch
it; only a video and a photo's pan pause for that. So the scene must be calm enough to run for
hours on a screen nobody is touching, and cheap enough not to matter.

**Why held means you draw nothing of your own.** The app holds the scene because nobody can see
it: the window is hidden, behind another, or covered. Every frame drawn then is battery spent on a
picture no one sees. A `setInterval` that "keeps the water moving" while held is exactly that.
The clock already redraws when something the person could see changes.

**Still frames are a picture, not a paused film.** Settle the simulation: the population where it
would be after a while, schools formed, bodies straightened, each facing a sensible way; then draw
once. A resize or a new look calls `settle()` again: keep the creatures you have and settle them
in the new space, rather than re-randomising the scene, or the picture jumps on every theme change.

Without `animate` (a scene that draws once, say), call `wp.drawn()` after the first frame, or the
app never shows the layer.

## Size the canvas to the viewport times its pixel ratio

`viewport` is CSS pixels and `dpr` the screen's pixel ratio. Make the canvas `w × dpr` by
`h × dpr` device pixels and `w` by `h` CSS pixels, and draw with
`setTransform(dpr, 0, 0, dpr, 0, 0)`. The pointer and clicks come in CSS pixels, so the scene
works in CSS pixels and only the transform knows about `dpr`.

Setting `canvas.width` clears the canvas and resets its transform: set the transform at the start
of every `draw`, and rebuild anything sized in device pixels (a backdrop, a glyph atlas) on a
`viewport` change. The clock draws again after a resize in every mode, so the canvas never shows
blank.

## A good ambient scene behind terminals

The scene is a place, not a show. What makes one people keep for months:

- **A population sized to the screen.** Work out how many of each kind the screen holds from its
  area, so a laptop and a wide monitor look equally alive, and every kind you drew appears. Top
  it up or thin it on a resize; never start from an empty screen.
- **Lives of their own.** Give each creature its own rhythm: a phase, a pace, a place it likes,
  and behaviours it chooses over time (cruise, rest, feed, school, surface, wander off and come
  back), each lasting seconds to minutes and picked with some chance per second. No two move in
  step, and nothing happens on a fixed beat the eye learns.
- **Calm in the middle, busy at the edges.** Terminals sit mostly in the middle. Keep the middle
  open and slow, and put scenery and the busiest life along an edge (a reef, the grass, the sea
  bed).
- **Slow against reading.** Motion that crosses a terminal's width in a second pulls the eye from
  every line under it. Most life drifts; a dart or a flash is rare and brief.
- **Nothing that speaks.** Draw no text, numbers, badges or anything that looks like the app's own
  marks, and do not flash in the theme's accent colours. The person reads anything like that as
  the app telling them something.

## The pointer as play

The pointer over empty canvas is the one thing the person does to the scene. Let the life near it
notice, then go back to its own:

```ts
let pointer: { x: number; y: number } | null = null;
let rested = 0;                                    // seconds the pointer has stayed put
wp.on("pointer", ({ x, y, over }) => {
  if (!over) { pointer = null; return; }
  if (!pointer || Math.hypot(x - pointer.x, y - pointer.y) > 4) rested = 0;
  pointer = { x, y };
});

function step(dt: number) {
  if (pointer) rested += dt;
  for (const f of fish) {
    let { wantX, wantY } = f.ownGoal();             // its own life first
    if (pointer) {
      const dx = f.x - pointer.x, dy = f.y - pointer.y, d = Math.hypot(dx, dy);
      const reach = 140;
      if (d > 0 && d < reach) {
        const k = (1 - d / reach) * f.shyness;      // near: more; far: none
        wantX += (dx / d) * k * 200;                // away, eased in by the steering
        wantY += (dy / d) * k * 200;
      }
    }
    f.steerToward(wantX, wantY, dt);                // turns at a limited rate: weight, not teleport
  }
}
```

- **A short reach, a soft push.** Only what is near the pointer answers, and by a little: a
  scatter of small fish, a jelly nudged, snow pushed aside. The rest of the scene goes on.
- **Character per kind.** Small, quick things flee; bigger, slower ones are curious and glide
  past; koi come to a pointer that rests a moment (`rested`), as to a hand over the pond; fireflies
  drift toward it and circle. One scene can hold several of these.
- **Let go.** When `over` turns `false` (the pointer went over a tile or a panel, left the window,
  or the window lost focus), drop the pointer at once, and let each creature drift back to its own
  life, not snap.
- **A click is brief.** A ripple, a burst of light, food dropped, a pulse that sends the near ones
  away: over within a second or two, and capped (a few at once), so a burst of clicks never fills
  the screen. The same press also reaches the canvas, so a drag that starts on empty canvas pans
  it while your ripple spreads: answer the press, not a drag.
- **Answer in `step`.** The pointer and clicks change the simulation; `draw` only shows it. A held
  scene gets neither; in a still frame nothing moves, as the person asked.
- **Touch.** A touch screen sends no pointer, but a tap is a click.

The built-in scenes, for reference: in Shoal small fish scatter from the pointer and a shark may
turn and glide past it, curious, and a click ripples the water and bursts the fish; in Koi Pond
koi drift toward a resting pointer and a click drops pellets the nearest koi race to eat; in
Jellyfish the pointer pushes the snow and nudges the jellies, and a click sends a pulse that jets
the near ones away; in Fireflies the fireflies drift toward the pointer and circle it, and a click
is a burst of light that scatters the near ones.

## Colours: its own, and readable panels

- **Its own palette, dark and light.** Draw the scene in colours of its own, one version for a
  dark theme and one for a light one, picked by `look.dark`; the built-in scenes do this (a reef at
  night, a sunlit lagoon by day). Set colours in OKLCH, mix in OKLab, and map out-of-gamut colours
  by lowering chroma: the sister skill shows how. Work the tones out once per `look` (65 steps is
  plenty) and pick by index each frame; a frame that builds colour strings is slow.
- **The theme's two colours.** `page` and `text` are there if you want them: lean the ground
  toward `page` so the scene sits with the theme, or draw a two-colour scene in the steps between
  them.
- **Light is not dark inverted.** On a light version, draw ink on paper: creatures darker than
  their water, characters darker than their cells. Pale creatures on pale water vanish.
- **Panel text over it.** With glass on, the Layers panel and the toolbars are frosted glass over
  the scene, and their names sit right over your water. Over a live wallpaper the Layers panel is
  clearer still: a third of its usual tint, as little as a sixth with See-through. Keep the ground
  dark enough on a dark theme and light enough on a light one. Test it the way the built-in scenes
  do: composite the panel colour at a sixth over every point of your ground (each gradient stop, a
  glow at its brightest, a light shaft at its brightest) and check the panel's text at 7:1 or more
  and its secondary text at 4.5:1 or more, for a dark theme and a light one.
- **Behind frosted tiles.** With **Frost tool content** on, the scene shows through the terminals
  too, blurred under their text. Keep the creatures' contrast with the water modest, so a
  terminal's text reads over a passing one.
- **`mono` may not exist here.** It is the person's font, and the frame has none of the app's web
  fonts. Always end it with a fallback (`` `${look.mono}, monospace` ``), measure a cell with
  `measureText("M")` after setting the font, and rebuild what depends on it when `look` changes.

## What it costs

The scene runs in a process of its own, so it never stalls the person's terminals. The app still
watches it: 60% of a CPU core for six seconds turns it off for the session. At 30 frames a second
that is 20 ms a frame; a scene near that on your computer is turned off on a slower one. And it
runs while the person is idle, for hours: aim for a few milliseconds a frame.

- Draw what changed, not everything: paint the still ground once into an offscreen canvas per
  size and look, and copy it in each frame. Bake slow layers (light shafts, a reef) a few times a
  second, not every frame. Cache sprites (a glow, a lily pad) and draw them again only when they
  change.
- Group cells by colour, so a frame sets `fillStyle` a few dozen times, not once per cell.
- Keep `step` free of allocation in its loops. A population sized to the screen grows with the
  screen: measure at the biggest you expect.

**Measure.** Time `draw` over 600 frames and report the median and the 90th percentile, at
1440×900 and 2560×1440, at 1× and at 2×, on a dark theme and a light one:

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

**A headless browser renders in software**, with no GPU: its numbers overstate what a real screen
costs, and its frame rate means nothing. Compare like with like, and say how you measured.

## Test it without the app

`fakeWallpaperHost` from `@hivemind/view-sdk/testing` is a pretend app over a real
`MessageChannel`: it sends what your test says, checks every answer the way the app does, and
keeps what it saw. The starter's `tsconfig.json` maps `@hivemind/view-sdk` and
`@hivemind/view-sdk/testing` to the copy in `types/view-sdk/`, and Bun reads that mapping, so
`bun test` runs a test like this one:

```ts
import { expect, test } from "bun:test";
import { fakeWallpaperHost } from "@hivemind/view-sdk/testing";

test("it settles, draws once, and says only what the app takes", async () => {
  const host = fakeWallpaperHost({ viewport: { w: 1440, h: 900, dpr: 1 }, mode: "still" });
  const wp = await host.connect();   // or host.handshake(window) before the page's own connectWallpaper()
  startScene(wp);                    // your scene, taking the client rather than connecting itself
  await host.settle();
  host.point(700, 400);              // the pointer over empty canvas
  host.click(700, 400);              // a click there
  host.point(700, 400, false);       // gone from it
  host.send({ type: "look", look: { page: "#f6f4ee", text: "#1d2126", dark: false, mono: "monospace" } });
  await host.settle();
  expect(host.drawn).toBe(true);     // it said its first frame is up
  expect(host.refused).toEqual([]);  // what the app would refuse, and why
  expect(host.received.map((m) => m.type)).toEqual(["ready", "drawn"]);
  host.close();
});
```

The host's look defaults to a dark theme (`#101418` on `#e6edf3`), its viewport to 1280×800 and
its mode to `hold`; pass `look`, `viewport` and `mode` to change them, and `send` any message the
app sends.

Make the scene testable by splitting it: a simulation that takes the client's values and knows no
canvas, and a drawing that reads the simulation. Then test behaviour on the simulation alone:

- **Seed the randomness.** Replace `Math.random` with a seeded generator (mulberry32) in the test,
  run a fixed number of steps of 1/60 s, and assert on what happened, over a few seeds.
- **One test per behaviour, with its number.** Every kind appears within ten seconds at
  1440×900; the population is within its bounds at the smallest and the biggest screen; fish
  within reach of the pointer move away from it, and the rest do not change course; after
  `over: false` none is still pushed; a click's ripples are gone within two seconds and never
  more than the cap; nothing steps while held. Pick each bar from what many seeds measure, clear
  of them.
- **Show each test failing.** Break the rule it guards (delete the push from the pointer, the
  cap on ripples), run it, see it fail, put the rule back. A test that passes with its rule gone
  guards nothing.
- **Golden pictures.** Draw a fixed seed's frame at a fixed size and hash its pixels, dark and
  light. When a refactor should not change the picture, the hash proves it did not.

## Package it, offer it, ship it beside a view

A live wallpaper always ships in a package. The package names it:

```json
{
  "apiVersion": 2,
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
  and on, the app offers it as the background ("Use Pond as your background?"), once per package,
  the way `startup.view` offers a view. The person chooses; the app never switches on its own,
  because an agent may be the one installing.
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
hive plugins check <package>                  # manifests, then the wallpaper loaded in headless Chromium:
                                              # it must say ready and drawn, say nothing else, throw and log no error
hive plugins install <package>                # --json names startWallpaper, with the command to use it
hive config set appearance.wallpaper.kind '"@you/pond/pond"'   # switch to it (ask the person first)
hive config set appearance.glass.animate false                 # Animation off: see its still frame
hivehub publish <package>                     # after commit and push, with dist/ committed
```

`hive plugins check` plays the app for a moment: it hands the wallpaper two sizes, a light and a
dark theme, each mode, the pointer and clicks. It needs Playwright's Chromium where Node finds it;
without it, it says that part did not run and how to install it
(`npm install -g playwright && npx playwright install chromium`).

**Settings → Appearance → Background** lists installed live wallpapers after the built-in scenes.
Install again after each change. Ask the person before switching their background; on a yes,
use the command the install printed. Read `hive config get appearance.wallpaper.kind` first, and
put it back when you are done looking.

Publishing: commit the package with the wallpaper's `dist/`, push it to a public GitHub
repository, and run `hivehub publish <package>`. HiveHub publishes the pushed commit, never the
disk. It lists a package holding a live wallpaper as needing Hivemind 2026.10.9 or newer. The
whole flow is https://hivemind.griiken.com/guide/publish-to-hivehub/ and packages are
https://hivemind.griiken.com/guide/packages/.

## What the sandbox refuses

The wallpaper runs in a sandboxed frame like a view: an opaque origin, `default-src 'none'`,
nothing network, no permissions, in its own process.

| You wrote | What happens |
|---|---|
| `fetch()`, XHR, WebSocket, an `EventSource` | refused: there is no network. Bundle the data into the script |
| a Google Fonts `<link>`, a CDN `<script>` | loads nothing, with no error worth reading |
| `localStorage`, `indexedDB` | they throw in an opaque origin: hold state in memory. Nothing survives a reload, so a scene must look right from a cold start |
| `<iframe>` | refused |
| `Notification`, `getUserMedia`, geolocation, the clipboard | refused: no permissions |
| `require`, `process`, `node:*`, `window.hive` | none of them exist here |
| a picture from the web | refused. Bundle pictures, or draw them; `data:` and `blob:` URLs work |

Like a view's, its frame can still open a WebRTC connection, which no page policy in Chromium
stops. Never do; the guide tells people to install wallpapers only from people they trust.

## What turns it off

The app checks everything the wallpaper sends. It turns the wallpaper off for the session, with
a notice, and draws the plain background instead, when it:

- sends 8 messages that do not parse (a `ready` or `drawn` with keys of its own counts);
- sends more than 120 messages a second (it says two things, once each: far fewer);
- says `ready` with a newer protocol than the app speaks;
- takes the keyboard: anything in its frame focused (an input, a `tabindex`), by script or not;
- uses 60% of a CPU core for six seconds.

`hive plugins check` and `fakeWallpaperHost`'s `refused` catch the first three before the person
does.

## True, and not guessable

- **`look` is undefined before the hello.** Everything reads after `await connectWallpaper()`.
- **The first viewport is the screen as it is.** Populate it at once, spread over the screen and
  already about their lives; a scene that swims in from the edges shows an empty sea for seconds
  after the person picks it.
- **A held frame is redrawn on a change, with `dt` of 1/60.** `draw` must not assume `dt` is a
  real frame's length, and must draw a sensible picture without a `step` before it.
- **The pointer can vanish without a move.** `over: false` comes when the window loses focus or
  the scene is held, wherever the pointer was. Never wait for it to move away.
- **A click is a press.** It comes as the main button goes down on empty canvas, before the
  person knows whether they are panning. Make its answer something a pan does not spoil.
- **No pointer from touch.** A tap is still a click.
- **It runs while the person is idle.** Anything that builds up over time (a trail, a field,
  ripples, a population) must stay bounded after hours with nobody touching it.
- **Light themes are not dark themes inverted.** Light creatures on a light page vanish. Draw ink
  on paper, and lift a dark creature on dark ground so it never sinks into it.
- **The scene is not on screen behind a plugin view or on the phone,** nor with more contrast or
  less transparency asked for. Do not build a feature that only works there.

## Before you finish

| Check | How |
|---|---|
| It loads, says ready and drawn, and nothing else | `hive plugins check <package>` says ok |
| Nothing runs while held | in a test: `mode: "hold"`, then no `step`, and no `draw` after the first frame, for a second |
| A still frame is settled, and a new look keeps the scene | in a test: `still`, then a new `look`, compare where the creatures are |
| The population fits the screen, every kind appears | a seeded test at the smallest and the biggest screen |
| The pointer nudges what is near it, and lets go | a seeded test: `point`, steps, then `point(x, y, false)`, steps |
| A click answers, briefly, and clicks stay capped | a seeded test with a burst of `click` |
| Light and dark | screenshots of both behind real tiles; panel text contrast tested |
| Sharp on a 2× screen | the canvas is `w × dpr` by `h × dpr` |
| Cost | median and p90 per frame at 1× and 2×, stated with how you measured |
| The package offers it | `startup.wallpaper` names it; the install's `--json` has `startWallpaper` |
| `README.md` | says what the scene is and what the pointer and a click do |
