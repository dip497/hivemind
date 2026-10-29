---
name: ascii-character-animation
description: Design and animate scenes drawn in characters (ASCII and block art) that look good, sit calmly behind other things and stay cheap — the cell grid, tone from glyph ramps and colour, block cells against line glyphs, silhouettes and bodies that bend along a spine, markings per kind, palettes of a scene's own in a dark and a light version (OKLCH, OKLab, gamut mapping), readable text over the scene, layers, motion (boids, steering, beats), a population sized to the screen with rhythms of its own, pointer play that stays calm, seeded randomness, still frames, cost and tests. Distilled from Hivemind's Shoal, Koi Pond, Jellyfish and Fireflies. Use first when designing any character-cell animation, a live wallpaper above all.
---

# Drawing living scenes in characters

This is the craft behind Hivemind's live scenes: Shoal (sharks and fish seen from above, ported
from https://github.com/stackedlol/ascii-sharks, MIT), Koi Pond, Jellyfish and Fireflies. Each is
a grid of character cells on a 2D canvas, redrawn up to 30 times a second behind tiles of
terminal text: a small world whose life goes on by itself and plays with the pointer. What follows
is what made them look good and what it cost to find out. The sketches are TypeScript on a
`CanvasRenderingContext2D` (or an `OffscreenCanvas`'s), working in CSS pixels with the transform
set to the pixel ratio.

For a Hivemind live wallpaper, the contract (what the scene is told, the clock, packaging) is the
**hivemind-live-wallpaper** skill beside this one. This one is how the scene should look and move.

## 1. The cell grid

Everything sits on a grid of whole cells, like a terminal's. Nothing is drawn between cells:
a creature moves a whole cell at a time, which is what makes it read as character art and not as
a blurry picture with letters on it.

```ts
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

// From the shorter side: a creature is the same number of cells long on any shape of window.
const cw = clamp(Math.round(Math.min(w, h) / 110), 7, 13);
const ch = Math.round(cw * 1.45);              // taller than wide, as a terminal's cells are
const cols = Math.ceil(w / cw), rows = Math.ceil(h / ch);

g.font = `600 ${Math.round(ch * 0.74)}px ${mono}, monospace`;
g.textAlign = "center";
g.textBaseline = "middle";

/** One cell: a block of colour, and a character on it. */
function cell(c: number, r: number, block: string | null, ink: string, glyph: string) {
  const x = c * cw, y = r * ch;
  if (block) { g.fillStyle = block; g.fillRect(x + 1, y + 1, cw - 1, ch - 1); }  // a 1px seam
  if (glyph) { g.fillStyle = ink; g.fillText(glyph, x + cw / 2, y + ch / 2 + 1); }
}
```

- A monospace face, semibold (600): thin weights vanish at 7 to 13 px. Always give the font list
  a `monospace` fallback; the person's font may not be there.
- The 1px seam round each block keeps the grid visible inside a body: it reads as made of cells.
- Width from the window's shorter side, clamped: a shark is some 48 cells long on any window.
  Taken from the width alone, a wide window drew it coarser.
- Cells are not square. Distances in cells weigh rows by about 1.4
  (`Math.hypot(dc, dr * 1.4)`), or circles come out tall.
- A faint grid over the ground (a step of 0.055 toward the light on dark water, 0.015 toward the
  dark on light water, where ink shows more) makes the empty water read as part of the same
  picture.

## 2. Tone: from a glyph ramp, and from colour

A cell has two tones: its block and its character. Light comes from both.

- **The glyph ramp.** Order characters by how much of the cell they cover, and pick by shade.
  Shoal's skin is `":;t%SX8#@"`: sparse glyphs on bright skin, dense ones in shadow, so the
  texture deepens the shading instead of fighting it. Fins take `"%;tS:"`, a dorsal ridge catching
  the light `"@8%"`, markings `"#%@"`, an eye `"o"`.
- **Edges are their own ramp.** Where a body only partly covers a cell, draw a light glyph alone,
  no block: one of `":;"` for a cell at least half covered, one of `` ".',`" `` for less. That is
  the anti-aliasing; it makes the silhouette soft and round.
- **Tone from colour.** Work out the steps between two colours once (65 is plenty) and pick by
  index each frame. A frame that builds colour strings is slow, and a frame that picks from 65
  strings is not.
- **Let glyphs ride with the skin.** Pick a cell's glyph from a key anchored to the body (how far
  along it, how far across, which body), not to the screen cell, or the texture crawls over a
  creature as it moves:

```ts
/** A stable number in [0, 1) from three integers: the same input, the same glyph, every frame. */
function hash3(x: number, y: number, z: number) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const SKIN = ":;t%SX8#@";
const key = (hash3(Math.round(s * 52), Math.round(v / (cw * 0.9)), body.id) * 4294967295) >>> 0;
const jitter = ((key >>> 4) % 3) - 1;            // a little variety, fixed to the skin
const glyph = SKIN[clamp(Math.floor((1 - shade) * 8.99) + jitter, 0, SKIN.length - 1)]!;
```

- **Shimmer, sparingly.** Re-roll a few glints on a slow, staggered clock
  (`hash3(key, Math.floor(t * 2.4 + (key % 997) / 97), 7) < 0.05`) and flicker each cell's shade by
  ±3% six times a second: the hide looks alive without boiling.

## 3. Block cells, not line glyphs

Line glyphs (`| / \ - _`) are one pixel wide at these sizes. Behind a window of terminal text they
read as faint scratches, and a shape made of them reads as a diagram, not a thing.

- **Draw bodies in block cells:** a filled block with a character on it. Shoal's reef began as
  line-art coral and became block cells, each a block of its colour half faded into the water with
  its character on it, as the sharks are. Only then did the reef read at a glance.
- **Keep line glyphs for what is thin in life:** a weed's blade (its foot a block, the rest bare
  characters), a reed, a tentacle, a lily pad's veins, a wing. Pick each one along the way the
  thing runs:

```ts
/** A line along (dx, dy), as a character. */
const lineGlyph = (dx: number, dy: number) =>
  Math.abs(dx) < Math.abs(dy) * 0.45 ? "|" : Math.abs(dy) < Math.abs(dx) * 0.45 ? "-" : dx * dy > 0 ? "\\" : "/";
```

- A thing that must read as solid at its thinnest (a hammerhead's head) gets its full depth
  nearly to its tips, so it reads as a bar rather than a thin line.

## 4. Silhouettes first, a little fatter than life

At 7 to 13 px a cell, a creature is recognised by its outline before anything else. Get the
outline right at the smallest size before you add a single marking.

- Draw from the viewpoint that gives the clearest outline: sharks and koi from above (fins spread,
  tail fanned), jellies and fireflies from the side.
- Make bodies a little fuller than life: a real shark's body is too thin to cover whole cells, and
  a body two cells wide flickers between one and three as it swims. Koi are drawn smaller than
  sharks and fuller.
- Exaggerate what tells kinds apart: a hammerhead's head, a thresher's whip of a tail, a box
  jelly's square bell, a koi's fan of a tail.
- Size the biggest creature from the window's shorter side, clamped (Shoal's sharks: 0.44 of it,
  170 to 430 px), so it is the same number of cells long on any screen. The more a scene holds,
  the smaller each is drawn, so the water never fills up. Nearer is bigger: a creature at the
  surface is drawn a little larger than one deep down.

## 5. Bodies that bend along a spine

A creature that swims is a chain of nodes, snout first; its outline is laid along that chain each
frame. Shoal and Koi Pond use 20 nodes.

```ts
const N = 20, MAX_BEND = 0.16;                   // radians between joints: a C at most, never a U
const angleDiff = (a: number, b: number) => { let d = (b - a) % (2 * Math.PI); if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; return d; };

/** Follow the leader: each node trails the one before by one segment, bending by at most MAX_BEND. */
function follow(nodes: Float32Array, heading: number, seg: number) {
  let prev = heading + Math.PI;
  for (let k = 1; k < N; k++) {
    const px = nodes[(k - 1) * 2]!, py = nodes[(k - 1) * 2 + 1]!;
    let a = Math.atan2(nodes[k * 2 + 1]! - py, nodes[k * 2]! - px);
    a = prev + clamp(angleDiff(prev, a), -MAX_BEND, MAX_BEND);
    nodes[k * 2] = px + Math.cos(a) * seg;
    nodes[k * 2 + 1] = py + Math.sin(a) * seg;
    prev = a;
  }
}

/** For drawing only: a travelling wave on top, growing toward the tail. */
function swimOffset(L: number, s: number, phase: number, speed: number) {
  const swim = clamp(speed / 60, 0.4, 1.4);
  const amp = L * 0.05 * (0.1 + 0.9 * s ** 1.8) * swim;   // s: 0 snout, 1 tail
  return amp * Math.sin(phase - s * 5.2);                 // sideways, along the normal
}
```

- The joint limit is what keeps a calm creature in long, lazy curves. Without it, sharks folded
  into a U a third of the time.
- Advance `phase` with speed (`phase += dt * (2 + speed / 24)`): a creature that hurries beats
  its tail faster.
- **The outline as a function.** Describe the body as a half-width along its length
  (`halfWidth(s)`, fractions of its length L), and each fin as a triangle on its side of the
  spine. To draw, sample each cell's centre against it: find the nearest point on the spine,
  which gives `s` (along) and `v` (across); inside if `|v| <= halfWidth(s) * L`, or inside a fin.
- **Coverage.** Sample a cell at its centre and four sub-points. Centre inside and three of five
  inside: a body cell, its glyph from the ramp by shade. Otherwise, any hit: an edge cell, its
  shade the share of hits. A centre deeper inside than half a cell's diagonal is covered whole:
  skip its sub-samples.
- **Light it.** Shade a body as a rounded back lit from the top left:
  `0.58 - across² * 0.42 + facing * 0.26`, where `across` is `|v| / halfWidth` and `facing` how
  far the surface normal points at the light. Fins darker, the dorsal ridge brightest, the eye
  darkest.
- **Bank into turns.** Keep a smoothed turn rate, and foreshorten the inside fin and spread the
  outside one by it (`bank = clamp(turn * 0.45, -0.35, 0.35)`). It is the cheapest thing that
  makes a turn look like effort.
- Bodies that hang (tentacles, a jelly's arms) are chains too, without the joint limit: each node
  keeps its length from the one before, trails back from the bell, and sways more toward its tip.

## 6. Marks and patterns per kind

A scene holds several kinds of creature, and every kind should be on screen; a kind is known by
its outline and its marks.

- Markings are a function of the body point, `(s, v)`, and the body's id, never of the screen:
  a tiger's bars across `s`, a zebra shark's spots, a koi's patches, an asagi koi's net of scales.
  Value noise over `(s * 7.5, v / L * 9)` seeded by the body's id gives patches that ride the skin
  and differ from one koi to the next.
- A marking can be a darker glyph on the skin (a shark's), or a colour of its own that replaces
  the skin there (a koi's red patch).
- Kinds in Hivemind's scenes: eight sharks (classic, hammerhead, tiger, mako, thresher, zebra,
  great hammerhead, nurse), eight koi (kohaku, showa, ogon, asagi, sanke, tancho, platinum,
  chagoi), eight jellies (moon, purple-striped, sea nettle, crystal, lion's mane, fried egg, box,
  comb), eight fireflies known by their light's colour and the code they flash (one long flash, a
  burst of six, a steady glow, a double flash and others).

## 7. Colour: a palette of the scene's own, dark and light

Draw the scene in colours of its own, in two versions: one for a dark theme and one for a light
one (a reef at night against a sunlit lagoon, the deep sea against a pale one, a meadow at night
against one at dusk). Pick the version by the theme's page: Hivemind's scenes draw the light one
when the page is lighter than the text.

Set every colour in OKLCH (lightness 0 to 1, chroma, hue in degrees), so lightness means the same
on every hue. Mix in OKLab, so a step from one hue to another keeps an even lightness without a
grey dip. Convert to sRGB once per palette, never per frame.

```ts
type Rgb = readonly [number, number, number];
const toLin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const fromLin = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
function labToLin(L: number, a: number, b: number): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}
function linToLab(r: number, g: number, b: number): Rgb {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
const to255 = (lin: Rgb) => lin.map((v) => Math.round(fromLin(clamp(v, 0, 1)) * 255)) as unknown as Rgb;
const inGamut = (c: Rgb) => c.every((v) => v >= -1e-4 && v <= 1 + 1e-4);

/** OKLCH to sRGB. Out of gamut: keep lightness and hue, lower chroma until it fits. */
function rgbOf([L, C, H]: Rgb): Rgb {
  const at = (c: number) => labToLin(L, c * Math.cos((H * Math.PI) / 180), c * Math.sin((H * Math.PI) / 180));
  if (inGamut(at(C))) return to255(at(C));
  let lo = 0, hi = C;
  for (let i = 0; i < 20; i++) { const mid = (lo + hi) / 2; if (inGamut(at(mid))) lo = mid; else hi = mid; }
  return to255(at(lo));
}

/** `t` of the way from a to b, in OKLab. */
function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const A = linToLab(...(a.map((v) => toLin(v / 255)) as unknown as [number, number, number]));
  const B = linToLab(...(b.map((v) => toLin(v / 255)) as unknown as [number, number, number]));
  return to255(labToLin(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t));
}

/** 65 steps from `from` to `to`, as CSS colours: built once per palette, picked by index each frame. */
const hex = (c: Rgb) => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
const ramp = (from: Rgb, to: Rgb) => Array.from({ length: 65 }, (_, i) => hex(mix(from, to, i / 64)));
const tone = (steps: string[], t: number) => steps[clamp(Math.round(t * 64), 0, 64)]!;
```

- **A creature's ramp** runs from its **shadow** (dark water's shade, or on light water the water
  itself) to its kind's colour at full light. Fish, wake dots and flashes run from the middle of
  the water to their colour.
- **The ground** is a gradient of three stops top to bottom, a soft glow where the light comes in,
  and the grid over it at a few percent.
- **Chroma where it is small.** Keep chroma modest on large areas (water: 0.03 to 0.07) and spend
  it on small things (coral, koi patches, firefly lights: 0.1 to 0.19).
- **On a dark ground, light on dark.** A body cell is a lit block with a darker character cut
  into it; an edge is a light character alone; a glint is a character at full light.
- **On a light ground, ink on paper.** Not the dark version inverted, which leaves pale creatures
  that vanish into the water. The more of the creature, the darker its block, its character darker
  still, a glint lighter; an edge a faint block under a slightly darker character, so it fades into
  the water.
- **A cast per kind.** Give each kind a lean of its own (a grey-blue shark, a brownish one), enough
  to tell kinds apart at a glance without a rainbow.
- **Markings as shares of the skin's light.** A koi's red patch is half the skin's light, its
  black spots a fifth; a showa koi's skin itself is dark under its pattern.
- **Lift dark creatures off dark ground.** On a ground lighter than black, a creature drawn at
  plain levels sinks into it. Lift its skin (`0.28 + 0.8 * lit` of the way up its ramp), with its
  eyes and markings kept dark. On light ground, a creature that is white in life (a white koi) is
  drawn bright, lit as on dark water, rather than as ink.

## 8. Text over the scene must stay readable

The scene is a background. Whatever sits over it (terminals, a frosted side panel, toolbars) has
to stay readable, or the scene has failed however good it looks.

- **Ground dark enough, or light enough.** Over a frosted panel the ground shows through its tint.
  Test it rather than eyeball it: composite the panel's colour at its tint over every point of the
  ground (each gradient stop, the glow at its brightest, a light shaft at its brightest) and check
  the panel's text against the result, for the dark version and the light one:

```ts
const lum = (c: Rgb) => { const [r, g, b] = c.map((v) => toLin(v / 255)); return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!; };
const contrast = (a: Rgb, b: Rgb) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
const over = (top: Rgb, alpha: number, under: Rgb) => top.map((v, i) => v * alpha + under[i]! * (1 - alpha)) as unknown as Rgb;

for (const ground of [...stops, glowAtBrightest, shaftAtBrightest]) {
  const panel = over(panelColour, 1 / 6, ground);            // Hivemind's clearest panel over a live scene
  assert(contrast(panelText, panel) >= 7);                   // names
  assert(contrast(panelSecondaryText, panel) >= 4.5);        // details
}
```

- **Modest contrast in the creatures.** Terminals may be frosted too, the scene blurred under
  their text. A creature that is a step or two from its water reads as a shape through the frost;
  one at full contrast fights every line over it.
- **The busiest part along an edge.** Keep the reef, the grass or the skyline along an edge,
  where fewer panels sit, and the open middle calm.

## 9. Layers: paint each at the rate it changes

A frame is a stack. Paint each layer only as often as it changes, and copy it in otherwise.

| Layer | Painted | In Hivemind's scenes |
|---|---|---|
| The ground: gradient, glow, grid | once per size and look, into an offscreen canvas | every scene |
| Still scenery | once per grid and look, into a layer the height it needs | Shoal's reef, Fireflies' grass |
| Slow light | a few times a second (every 0.25 s), over a copy of the ground | Shoal's and Jellyfish's light shafts: a few copies of one soft sprite, sheared to slant, swaying |
| Sprites | once per look, drawn scaled each frame | a glow (a radial gradient in a 64 px canvas), a lily pad (redrawn only when it turns a step) |
| Moving scenery | each frame, a few cells | swaying weed and reeds, ripples, marine snow, stars twinkling |
| Creatures | each frame | the big creatures, their wakes and the small fish |
| Flashes | each frame, last | a ripple, a burst of light, pellets landing: over everything |

- Glow: draw a sprite scaled round the creature with `globalCompositeOperation = "lighter"` on a
  dark ground (light adds), and plain at about 60% on a light one (it tints).
- A field that diffuses (a wake: each cell takes a blur of its four neighbours and decays,
  `exp(-1.5 * dt)`) gives water that remembers where things swam, for one pass over the grid.
- A light shaft drawn every frame cost 3 ms a frame at 1× and 9 at 2×; laid four times a second,
  it moves a pixel or two between, and nobody sees the difference.

## 10. Motion

- **Schools: boids.** Separation, alignment, cohesion, in the zones of Couzin's model, with a
  blind spot behind each fish. Set separation in cells (an ellipse, wide across a row, tight
  between rows) so each fish gets a glyph of its own. Mixes of weights make the shapes: strong
  alignment gives ribbons, weak gives swarms, a pull round the local centre gives a bait ball.
  Alarm passes from fish to fish (86% each hop) so a whole school bolts when its edge is
  startled, and fish break to the side of the threat's path they are on: the fountain.
- **Creatures: steering.** Sum a few wishes into one heading: momentum, a wander (a slowly
  drifting point on a circle ahead), the goal, room from the others, avoiding what is ahead, soft
  walls. Then turn toward it at a limited rate: `maxTurn = min(base, speed / (L * k)) * dt`, so the
  turning circle grows with speed and a creature in no hurry turns on a circle half its length
  across.
- **Look ahead, not at.** Push a creature off a window edge by the point most of its length ahead
  of it. A long creature that turns wide then turns before the edge, not after.
- **Beats.** A jelly's bell shuts quickly and opens slowly (`phase < 0.3 ? sin((phase / 0.3) * π / 2) : cos(((phase - 0.3) / 0.7) * π / 2) ** 2`);
  it is pushed only while it shuts, then drifts and sinks a little. A firefly flashes a code:
  `bump(x) = sin(π x)²` placed in time.
- **Tilt into turns.** Fins bank; a jelly leans toward where it is going (at most 1.3 rad, 0.6
  resting); a firefly faces the way it flies. Nothing pivots on the spot.
- **Ease everything.** Depth, size and speed move toward their targets
  (`depth += (target - depth) * min(1, dt * 0.6)`), never jump. Smooth the turn rate before
  anything reads it.
- **A fixed step.** Step the simulation by 1/60 s as many times as the time passed needs (at most
  four a frame) and draw once: it moves the same at 30 and 60 frames a second.

## 11. A population with rhythms of its own

An ambient scene is watched for hours, often by someone resting their hands. It must look alive
the whole time without ever looking busy or looping.

- **Sized to the screen.** Work out each kind's count from the screen's area, between a floor and
  a ceiling, so a laptop and a wide monitor are equally full. Put every kind on screen: a kind that
  never appears is wasted drawing. On a resize, add or remove a few, never rebuild the scene.
- **Born already living.** On the first frame the population is spread over the screen, at
  different depths, facing different ways, mid-behaviour. A scene that fills from the edges looks
  broken for its first seconds.
- **Behaviours chosen over time.** Give each creature a few things it does (cruise, rest, feed,
  school, surface, sink, wander off), and let it pick the next with some chance per second,
  weighted by what it is doing and where it is. Each lasts seconds to minutes. A koi that rests
  deep for a minute, then cruises under a pad, then rises, reads as a koi; one that does all three
  every ten seconds reads as a screensaver.
- **No two in step.** Each creature has its own phase, pace and place it likes, from its seed.
  Nothing happens on a fixed beat across the scene; the eye finds a beat and then can't stop seeing
  it.
- **Rare things stay rare.** A shark turning on the fish, a firefly wave, a koi rising: a few a
  minute at most, so each one is a small event.
- **Bounded over hours.** Trails, wakes, ripples and food are capped and decay. Leave the scene
  running overnight in a test and check every count at the end.

## 12. Pointer play that stays calm

The pointer is the one thing the person does to the scene. Let the life near it answer, a little,
and then go back to its own.

- **A short reach.** Only what is within a hundred-odd pixels answers, more the nearer it is
  (`k = 1 - d / reach`). Everything else carries on.
- **A wish, not a shove.** Add the pointer to a creature's wishes (away, toward, round it) and
  let the steering turn it at its usual rate. A creature that jumps away reads as a glitch.
- **Character per kind.** Small, quick things flee; bigger ones are curious and glide past; koi
  come to a pointer that has rested a moment; fireflies drift toward it and circle. Mixing two
  answers in one scene (fish scatter while a shark turns to look) is what makes it feel alive.
- **Resting and moving.** Track how long the pointer has stayed put. A resting pointer can draw
  the curious in; a moving one parts what is in its way.
- **Let go.** When the pointer leaves the scene, drop it at once and let each creature ease back.
- **A click is a small event.** A ripple, a pulse, a burst of light, pellets dropped: brief, near
  the click, and capped, so a dozen fast clicks never fill the screen. Food is eaten by the nearest
  few, who race for it; the rest ignore it.
- **Never in a still frame.** The pointer and clicks change the simulation, which a still frame
  does not run. Motion off means no motion.

## 13. Randomness, seeded where it should repeat

- **Per kind:** what a kind looks like (its outline, colours, flash code) is fixed: the same every
  time the scene starts.
- **Per creature:** its size, its marking, its phase, which way it circles, the place it likes:
  from a hash of a number it is given when it is made. It looks the same every frame.
- **Per window:** the reef, the lily pads, the grass, the stars and the light shafts from a
  generator seeded by the grid's size (`mulberry32(0x5eabed + cols * 131 + rows)`): the same
  window shows the same scene. A spread can be fixed rather than random (the shafts are evenly
  spaced with a fixed wobble).
- **Moment to moment:** `Math.random` for the wander, the jitter and the choice of what to do
  next, so tests can replace it.

```ts
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
```

## 14. Still frames

When motion is off, show one picture that looks like a moment of the scene, not a paused film:

1. Spread the population as it would be after a while: schools together, resting things low,
   each creature at a natural depth and heading.
2. Run the simulation on for a while (360 steps of 1/60 s) so schools form and bodies straighten.
3. Draw once.

On a change of size or look, keep the creatures you have: move them into the new space and settle
again. A still picture that rebuilds from scratch on every change jumps whenever the theme does.

## 15. What it costs, and how to know

- **Draw only what changed**; cache the ground, the scenery, the sprites (section 9).
- **One `fillStyle` per bucket.** Sort the cells to draw by style (a counting sort over 6 or 65
  levels) and set each style once.
- **Search less.** Rasterize a body only within its reach: per row, only as far as some spine
  segment's part of the body reaches. In Shoal that took the creatures from 5.5 to 2.1 ms a frame.
  Check such a speed-up against the slow way, cell by cell: Shoal's changed no cell over 3,200
  frames at seven window sizes.
- **A population grows with the screen.** Measure at the biggest screen you expect, not the one
  you have; cap the count where the cost stops being worth it.
- **30 frames a second.** Characters read smooth at 30; it costs half of 60.
- **Off the main thread.** The first Shoal drew on the window's main thread: 170 ms of script a
  second, beside every terminal. In a worker on an `OffscreenCanvas`, or in a frame of its own,
  the terminals never wait for it.

**Measure** the draw over 600 frames, and report the median and the 90th percentile, at 1440×900
and 2560×1440, at 1× and at 2×, in the dark version and the light one:

```ts
const times: number[] = [];
function timed(draw: (dt: number) => void) {
  return (dt: number) => {
    const t0 = performance.now(); draw(dt); times.push(performance.now() - t0);
    if (times.length === 600) {
      const s = [...times].sort((a, b) => a - b);
      console.log(`median ${s[300]!.toFixed(2)} ms, p90 ${s[540]!.toFixed(2)} ms`);
    }
  };
}
```

**A headless browser renders in software**, with no GPU: it overstates the cost, and its frame
rates mean nothing. Compare a change with what came before it, on the same machine, the same way,
and say how.

## 16. Tests

- **Seed the simulation.** Replace `Math.random` with `mulberry32(seed)`, step a fixed number of
  times at 1/60 s, and assert on behaviour, over a few seeds. Split the simulation from the
  drawing, so it runs with no canvas at all.
- **One test per behaviour, with its number.** Every kind is on screen within ten seconds; the
  count stays within its bounds at the smallest and the biggest screen; calm creatures are over 90%
  in sight; a creature never folds back on itself; no two of a kind keep the same phase; creatures
  within reach of a resting pointer move away from it (or toward it, for the curious) and the rest
  do not; a click's pellets are eaten by the nearest few; after an hour of steps every trail and
  ripple count is under its cap; a still frame keeps its creatures through a change of look. Take
  each bar from what many seeds measure, with room on both sides.
- **Show each one failing.** Break the rule it guards and see the test go red, then put the rule
  back. A test that passes with its rule removed guards nothing.
- **Golden pictures.** Draw fixed seeds at fixed sizes (dark, light at 2×, a third theme; a few
  seconds each with the pointer resting, moving and a click) and hash the pixels. A refactor that
  should change nothing on screen must hash the same, dark and light.

## 17. Starting points people like

Each needs what lives there (several kinds, each known at a glance), its ground, a life that goes
on by itself, and an answer to the pointer and a click.

| Scene | What lives there | The ground | Its own life | The pointer | A click |
|---|---|---|---|---|---|
| Aquarium, seen from the side | fish of a few species (angelfish, clownfish, tang, puffer), each body on a spine; small fish schooling | sand and rocks in block cells, coral, a stone breathing bubbles | schools cruise, a tang picks at the coral, a puffer hangs in mid-water | small fish dart off; a puffer turns to look | food flakes drift down, and the nearest fish rise to them |
| Koi pond, from above | koi of a few varieties, known by their patterns; fry | dark water, pebbles, lily pads drifting over | koi cruise under the pads, rest deep, rise now and then; the fry shoal | koi drift toward a pointer that rests | pellets, and the nearest koi race to eat them |
| Jellyfish, from the side | jellies of a few kinds: bell, rim, tentacles | the deep, blue to near black, light from far above, marine snow | jellies beat up and drift down, each at its own pace | the snow parts round it, jellies nudged aside | a pulse, and the jellies near it jet away |
| Fireflies, at night | fireflies of a few species, known by their light's colour and flash code | sky with stars, grass and reeds along the bottom | they drift and flash their codes, now and then answering each other in a wave | they drift toward it and circle | a burst of light, and the ones near it scatter |
| Birds | swallows, crows, gulls, herons, wings in two glyph frames (`v` and `^`) | sky in a gradient, clouds baked a few times a second, a wire and a tree line along the bottom | a flock wheels as boids; birds land on the wire and leave | the flock bends away; a crow lands near it | a burst of wings, and the wire empties |
| Bees | bees, stripes and colour per kind | flowers along the bottom in block cells, a comb of `<>` cells in a corner | flower to flower, back to the comb, a waggle dance now and then | a few hover near it, curious | a puff of pollen, and the bees near it scatter |
| Starfield | ships and comets, trails' glyphs and colour per kind | three layers of stars at three speeds (the far one baked), a faint nebula | ships cross, comets arc, now and then a slow one | the near stars lean away from it | a burst of sparks |
| Rain or snow | clouds, drops or flakes | puddles that ring where drops land, or snow drifting up along the bottom, cell by cell | showers come and go; snow thickens and thins | drops bend round it, as round an umbrella | a splash, or a gust that swirls the snow |
| City lights at night | small aircraft, drones and blimps, lights' colours and blink per kind | a skyline of block cells along the bottom, windows lit and going out a few at a time, street lights | craft cross the sky; windows change over the evening | a searchlight finds a pointer that rests | a firework over the skyline |

Whatever you make: draw the dark version first and make it beautiful there, then a light one that
is ink on paper; keep the middle of the screen calm and the busy scenery along an edge; and let the
pointer be a small pleasure that never startles.
