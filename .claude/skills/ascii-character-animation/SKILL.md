---
name: ascii-character-animation
description: Design and animate scenes drawn in characters (ASCII and block art) that look good, read well behind other things and stay cheap — the cell grid, tone from glyph ramps and colour, block cells against line glyphs, silhouettes and bodies that bend along a spine, markings per kind, two-colour and full-colour palettes (OKLCH, OKLab, gamut mapping), readable text over the scene, layers, motion (boids, steering, beats), seeded randomness, states a glance can read, still frames, keeping out from under tiles, hit testing, cost and tests. Distilled from Hivemind's Shoal, Koi Pond, Jellyfish and Fireflies. Use first when designing any character-cell animation, a live wallpaper above all.
---

# Drawing living scenes in characters

This is the craft behind Hivemind's live scenes, the Live scenes package
(https://github.com/dip497/hivemind-plugins, `packages/live-scenes`): Shoal (sharks hunting fish,
seen from above, ported from https://github.com/stackedlol/ascii-sharks, MIT), Koi Pond, Jellyfish
and Fireflies. Each is a grid of character cells on a 2D canvas, redrawn up to 30 times a second,
behind tiles of terminal text. They began with one creature for each of the person's agents, and
what that taught (states a glance can read, keeping off tiles, hit testing) is here for a scene
that draws agents. What follows is what made
them look good and what it cost to find out. The sketches are TypeScript on a
`CanvasRenderingContext2D` (or an `OffscreenCanvas`'s), working in CSS pixels with the transform
set to the pixel ratio.

For a Hivemind live wallpaper, the contract (what the scene is told, the clock, packaging) is the
**hivemind-live-wallpaper** skill beside this one. This one is how the scene should look and move.

## 1. The cell grid

Everything sits on a grid of whole cells, like a terminal's. A creature moves a whole cell at a
time, which is what makes it read as character art and not as a blurry picture with letters on
it. Its outline is finer than the cells: each cell has six parts, two across by three down, and an
edge cell fills only the parts the body covers.

```ts
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

// From the shorter side: a creature is the same number of cells long on any shape of window.
const cw = clamp(Math.round(Math.min(w, h) / 110), 7, 13);
const ch = Math.round(cw * 1.45);              // taller than wide, as a terminal's cells are
const cols = Math.ceil(w / cw), rows = Math.ceil(h / ch);

g.font = `600 ${Math.round(ch * 0.74)}px ${mono}, monospace`;
g.textAlign = "center";
g.textBaseline = "middle";

// A cell's six parts: part k is column k % 2, row k >> 1. Sample a body at each one's middle.
const PART_X = [0.25, 0.75, 0.25, 0.75, 0.25, 0.75], PART_Y = [1 / 6, 1 / 6, 0.5, 0.5, 5 / 6, 5 / 6];
const WHOLE = 63;

/** Fill the parts of cell (c, r) in `mask`, each edge on a device pixel: cells meet with no seam. */
function fillParts(c: number, r: number, mask: number) {
  const X = (u: number) => Math.round(u * cw * dpr) / dpr, Y = (v: number) => Math.round(v * ch * dpr) / dpr;
  if (mask === WHOLE) return g.fillRect(X(c), Y(r), X(c + 1) - X(c), Y(r + 1) - Y(r));
  for (let row = 0; row < 3; row++) {
    const two = (mask >> (row * 2)) & 3;
    if (!two) continue;
    const [x0, x1] = two === 3 ? [c, c + 1] : two === 1 ? [c, c + 0.5] : [c + 0.5, c + 1];
    g.fillRect(X(x0), Y(r + row / 3), X(x1) - X(x0), Y(r + (row + 1) / 3) - Y(r + row / 3));
  }
}

/** One cell: a block of colour over the parts it covers, and on a whole cell a character. */
function cell(c: number, r: number, mask: number, block: string, ink: string, glyph: string) {
  g.fillStyle = block; fillParts(c, r, mask);
  if (mask === WHOLE && glyph !== " ") { g.fillStyle = ink; g.fillText(glyph, (c + 0.5) * cw, (r + 0.5) * ch + 1); }
}
```

- A monospace face, semibold (600): thin weights vanish at 7 to 13 px. Always give the font list
  a `monospace` fallback; the person's font may not be there.
- **No seam, no grid.** Blocks meet edge to edge, snapped to device pixels, so a body reads as one
  lit form. A 1px seam round each block, and a faint grid over the ground, drew lines over the
  whole window that read as a screen's, not the water's, and people said so: Hivemind's scenes
  dropped both, and a test now fails if the open water shows a line where cells meet.
- **An outline in parts.** Sample an edge cell at its six parts' middles and fill those on the
  body. The silhouette is two to three times finer than the cells and still on their grid. A cell
  whose middle is deeper inside than its parts reach (`hypot(cw / 4, ch / 3)`, and a pixel) is
  whole without sampling them. A cell the body covers one part of is drawn fainter: the outline's
  last step into the water.
- Width from the window's shorter side, clamped: a shark is some 48 cells long on any window.
  Taken from the width alone, a wide window drew it coarser.
- Cells are not square. Distances in cells weigh rows by about 1.4
  (`Math.hypot(dc, dr * 1.4)`), or circles come out tall.

## 2. Tone: from a glyph ramp, and from colour

A cell has two tones: its block and its character. Light comes from both.

- **The block carries the light; the character is its grain.** Shade the block from the light
  (section 5), and put on it a character only a step darker (about a fifth of the ramp on dark
  ground; darker ink, about a sixth more, on light). A character cut in at full contrast turns a
  body into a page of letters.
- **The grain ramp.** Order characters by how much of the cell they cover, and pick by shade:
  Shoal's skin is `" .:;+*%#"`, sparse on bright skin, denser into shadow, so the grain deepens the
  shading instead of fighting it. **No letters.** The old ramp `":;t%SX8#@"` read as text
  (`SXtS8`), and people saw letter soup, not a shark.
- **Lines mean a direction.** A dorsal fin standing off the back is a line along the spine (`- \ |
  /` by the spine's angle there); a fin's rays run across it; markings are `#` and `%` in their
  own dark; an eye is one dark part inside the head, never an `o` off its edge.
- **Edges carry no character.** An edge cell is its parts alone: a character there stands off the
  body.
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
const SKIN = " .:;+*%#";
const key = (hash3(Math.round(s * 52), Math.round(v / (cw * 0.9)), body.id) * 4294967295) >>> 0;
const jitter = ((key >>> 4) % 3) - 1;            // a little variety, fixed to the skin
const glyph = SKIN[clamp(Math.floor((1 - shade) * SKIN.length) + jitter, 0, SKIN.length - 1)]!;
```

- **Never shimmer.** Real things move; light does not boil. No glints re-rolled on a clock, no
  shade flickering per cell, no twinkle, no breathing glow. A body changes only as it swims. (The
  first scenes shimmered; it read as noise.)

## 3. Block cells, not line glyphs

Line glyphs (`| / \ - _`) are one pixel wide at these sizes. Behind a window of terminal text they
read as faint scratches, and a shape made of them reads as a diagram, not a thing. A column of
`| / \` for grass or `| { } ( )` for a tentacle reads as a barcode.

- **Draw bodies in block cells:** a filled block with a character on it. Shoal's reef began as
  line-art coral and became block cells, each a block of its colour half faded into the water with
  its character on it, as the sharks are. Only then did the reef read at a glance.
- **Draw what is thin in life as fine lines,** antialiased, in the palette's colours: a blade of
  seagrass or grass, a reed, kelp's stalk and blades, a coral's branches, a fan's rays, a tentacle,
  a lily pad's veins, a ring on the water, a small fish seen from above (a sliver along its way).
  A blade is a ribbon through the cells it rises through, `bend` (its sway before rounding to the
  cells) giving each point's place, thinning from its root to its tip, one `fill()` per colour.
  Keep characters where they are the thing itself: a polyp `o` at a branch's tip, a float `o` on
  kelp, a starfish `*` on the sand.
- A line glyph still serves inside a body, where it means a direction:

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
- Size the biggest creature from the window (Shoal: 0.44 of the shorter side, clamped to 170 to
  430 px; Koi Pond: 0.24), and shrink all of them by `sqrt(4 / n)` when more than four swim at
  once. Nearer is bigger: a creature at the surface is drawn a little larger than one deep down.

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

Each program's agents are one kind of creature; a kind is known by its outline and its marks.

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

## 7. Two colours: drawn in the theme's page and text

Most people never turn on a scene's own colours, so the plain version is the one that matters.
Every tone is a step from the page colour to the text colour:

```ts
/** 65 steps from page to text (0xRRGGBB). A channel weight over 1 casts the steps toward it. */
function themeRamp(page: number, text: number, [wr, wg, wb] = [1, 1, 1]) {
  const ch = (c: number, k: number) => (c >> k) & 255;
  const out: string[] = [];
  for (let i = 0; i <= 64; i++) {
    const t = i / 64;
    const mix = (k: number, w: number) => clamp(Math.round(ch(page, k) + (ch(text, k) - ch(page, k)) * t * w), 0, 255);
    out.push(`#${((mix(16, wr) << 16) | (mix(8, wg) << 8) | mix(0, wb)).toString(16).padStart(6, "0")}`);
  }
  return out;
}
const tone = (ramp: string[], t: number) => ramp[clamp(Math.round(t * 64), 0, 64)]!;
```

- **On a dark page, light on dark.** A body cell is a lit block (an 18% to 80% step toward the
  text) with its grain a fifth of the ramp darker on it; an edge is its parts in the body's own
  tone.
- **On a light page, ink on paper.** Not the dark version inverted, which leaves pale creatures
  that vanish into the page. The more of the creature, the darker its block (2% plus up to 88% of
  the way to the text), its grain a little darker still (15% more); an edge its parts, as on dark.
- **A cast, not a colour.** Give each kind a slight lean toward a channel (weights such as
  `[0.92, 0.97, 1.05]` for a grey-blue shark, `[1.02, 0.95, 0.84]` for a brownish one, used at
  60%), enough to read grey-blue or grey-brown. On a light page use
  the inverse weights: more red ink leaves a shark bluer. Colour itself is kept for meaning: the
  theme's needs-you colour is for an agent that needs the person, and nothing else.
- **Markings as shares of the skin's light.** A koi's red patch is half the skin's light, its
  black spots a fifth; a showa koi's skin itself is dark under its pattern.
- **Lift dark creatures off dark ground.** On a ground lighter than black, a creature drawn at
  plain levels sinks into it. Lift its skin: `0.28 + 0.8 * lit` of the way up its ramp, with its
  eyes and markings kept dark. On light ground, a creature that is white in life (a white koi)
  is drawn bright, lit as on dark water, rather than as ink.

## 8. Full colour: OKLCH in, OKLab mixing, gamut mapped

When the scene has colours of its own, set every colour in OKLCH (lightness 0 to 1, chroma, hue in
degrees), so lightness means the same on every hue. Mix in OKLab, so a step from one hue to another
keeps an even lightness without a grey dip. Convert to sRGB once per palette, never per frame.

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
```

- Two palettes per scene, one for a dark theme and one for a light one (a reef at night against a
  sunlit lagoon, the deep sea against a pale one, a meadow at night against one at dusk).
- A creature's ramp runs from its **shadow** (dark water's shade, or on light water the water
  itself) to its kind's colour at full light. Fish, wake dots and flashes run from the middle of
  the water to their colour.
- Ground as a gradient of three stops top to bottom and a soft glow where the light comes in.
  Nothing over it: no grid.
- Keep chroma modest on large areas (water: 0.03 to 0.07) and spend it on small things (coral,
  koi patches, firefly lights: 0.1 to 0.19).

## 9. Text over the scene must stay readable

The scene is a background. Whatever sits over it (terminals, a frosted side panel, toolbars) has
to stay readable, or the scene has failed however good it looks.

- **Nothing under a solid tile.** A cell whose centre is within half a cell of a tile is covered,
  which also covers the seams between two tiles narrower than a cell; without that, a shark under
  a block of tiles shows through as a strip.
- **Soft under frosted tiles.** Under a see-through tile, draw a creature one pixel a cell into a
  small image, then scale it up smoothly over the tile, clipped to it, at 55% of its usual step
  toward the text: a soft shape, with no characters for the tile's own text to run through.
- **Ground dark enough, or light enough.** Over a frosted panel the ground shows through its tint.
  Test it rather than eyeball it: composite the panel's colour at its tint over every point of the
  ground (each gradient stop, the glow at its brightest, a light shaft at its brightest) and check
  the panel's text against the result, for a dark theme and a light one:

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

- Keep the busiest part of the scene (a reef, the grass, a skyline) along an edge, where fewer
  panels sit, and the open middle calm.

## 10. Layers: paint each at the rate it changes

A frame is a stack. Paint each layer only as often as it changes, and copy it in otherwise.

| Layer | Painted | In Hivemind's scenes |
|---|---|---|
| The ground: gradient, glow | once per size and look, into an offscreen canvas | every scene |
| Still scenery | once per grid, look and tile layout, into a layer the height it needs | Shoal's reef, Fireflies' grass |
| Slow light | a few times a second (every 0.25 s), over a copy of the ground | Shoal's and Jellyfish's light shafts: a few copies of one soft sprite, sheared to slant, swaying |
| Sprites | once per look, drawn scaled each frame | a glow (a radial gradient in a 64 px canvas), a lily pad (redrawn only when it turns a step) |
| Moving scenery | each frame, a few cells | swaying weed and reeds, ripples, marine snow, stars twinkling |
| Creatures | each frame | the agents' creatures, their wakes and the small fish |
| Soft layer | each frame, only the span it covers | what shows under frosted tiles |
| Flashes | each frame, last | a bite, a flash, a firework: over everything |

- Glow: draw a sprite scaled round the creature with `globalCompositeOperation = "lighter"` on a
  dark ground (light adds), and plain at about 60% on a light one (it tints).
- A field that diffuses (a wake: each cell takes a blur of its four neighbours and decays,
  `exp(-1.5 * dt)`) gives water that remembers where things swam, for one pass over the grid.
- A light shaft drawn every frame cost 3 ms a frame at 1× and 9 at 2×; laid four times a second,
  it moves a pixel or two between, and nobody sees the difference.

## 11. Motion

- **Schools: boids.** Separation, alignment, cohesion, in the zones of Couzin's model, with a
  blind spot behind each fish. Set separation in cells (an ellipse, wide across a row, tight
  between rows) so each fish gets a glyph of its own. Mixes of weights make the shapes: strong
  alignment gives ribbons, weak gives swarms, a pull round the local centre gives a bait ball.
  Alarm passes from fish to fish (86% each hop) so a whole school bolts when its edge sees the
  shark, and fish break to the side of the shark's path they are on: the fountain.
- **Creatures: steering.** Sum a few wishes into one heading: momentum, a wander (a slowly
  drifting point on a circle ahead), the goal, room from the others, avoiding what is ahead, soft
  walls. Then turn toward it at a limited rate: `maxTurn = min(base, speed / (L * k)) * dt`, so the
  turning circle grows with speed and a creature in no hurry turns on a circle half its length
  across.
- **Look ahead, not at.** Push a creature off a window edge or a tile by the point most of its
  length ahead of it. A long creature that turns wide then turns before the edge, not after.
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

## 12. Randomness, seeded where it should repeat

- **Per kind:** a program's kind comes from a number fixed for the program (in Hivemind, `kind`
  0 to 1, the same for every agent of a program). All of one program's agents look alike, and
  differ from another program's.
- **Per creature:** its size, its marking, its phase, which way it circles: from a hash of its
  stable id. It looks the same every frame and after a reload.
- **Per window:** the reef, the lily pads, the grass, the stars and the light shafts from a
  generator seeded by the grid's size (`mulberry32(0x5eabed + cols * 131 + rows)`): the same
  window shows the same scene. A spread can be fixed rather than random (the shafts are evenly
  spaced with a fixed wobble).
- **Moment to moment:** `Math.random` for the wander and the jitter, so tests can replace it.

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

## 13. States a glance can read

Each creature says what its agent is doing, and the one that needs the person must stand out
without a word. Give each state its own speed, place, size and light, so the four never look alike:

| State | Shoal | Koi Pond | Jellyfish | Fireflies |
|---|---|---|---|---|
| working | hunts the fish: fast, near, bright | feeds on the fry | beats fast, roams | flies about, flashing its code fast |
| ready | cruises, a little deeper | cruises | drifts | drifts, flashing slowly |
| needs you | hurries to its agent's tile and circles it, nearest and biggest; the others give way | comes up beside its tile and mouths at the surface, a ring every two seconds | comes up beside its tile and holds there, glowing, breathing | flies to its tile and hovers, flashing two bright flashes over and over |
| resting | sinks to the bottom, dim, slow | rests deep | sinks low, barely beating | settles in the grass, glowing faintly |
| a turn done well | a bite: a flash at the mouth, fish scattering | a ring | a flash of its light | a bright flash, and the small fireflies answer in a wave |

- A creature that needs the person hardly wanders and hardly gives way: it keeps to its tile.
- Only an agent at work hunts. The others swim past the food.
- Nearness is a cheap, strong signal seen from above: nearer is bigger and brighter
  (rest 0.3, cruise 0.6, hunt 0.85, needs you 1).

## 14. Still frames

When motion is off, show one picture that looks like a moment of the scene, not a paused film:

1. Put every creature where its state has it: a resting one at the bottom, one that needs the
   person by its tile, the rest in open water, each at the size and depth of its state.
2. Run the simulation on for a while (360 steps of 1/60 s) so schools form and bodies straighten.
3. Draw once.

On a change, move only what changed: a new creature is placed, a gone one removed, one whose state
changed moved to its place, and nothing else. A still picture that rebuilds from scratch on every
change jumps whenever any agent does anything.

## 15. Keep out from under tiles, choose open spots

- **Goals in the open.** Of 16 random points, skip those within 60 px of a tile, cost the rest by
  how many of 8 steps along the way are under one (times 4), plus the turn to face it, plus half a
  turn if it is nearer than the creature's length. Take the cheapest. On a canvas too full for
  any clear point, take the one with the most room round it, not the window's middle.
- **Turn before a tile**, looking most of a length ahead. **Out quickly** when a tile is put
  down over one, by the nearest side. **Let a box over half the window be:** there is no open
  water round it to keep to.
- **The visit.** A creature whose agent needs the person goes beside that agent's tile, on the
  side with more room, clear of other tiles; failing that the other side, above, or below. All of
  it outside the tile: tentacles and tails included.
- Measure it, with tiles: what share of a creature's body is in sight, how often its head is under
  a tile, how long the visit takes. Hivemind's sharks: over 90% in sight when calm, a needs-you
  shark to its tile in a median of 2.5 s.

## 16. Hit testing

The scene must say which creature is at a point (so a pointer over it can name its agent, and a
click can go to it). Test the body, not its box:

```ts
function creatureAt(x: number, y: number): string | null {
  let best: string | null = null, bestDepth = -Infinity;
  for (const b of bodies) {
    for (let k = 0; k < N; k += 2) {                         // every other spine node
      const r = halfWidth(k / (N - 1)) * b.length + cw;     // its half-width there, and a cell
      if (Math.hypot(b.nodes[k * 2]! - x, b.nodes[k * 2 + 1]! - y) < r && b.depth > bestDepth) {
        best = b.id; bestDepth = b.depth;                    // the nearest creature wins
        break;
      }
    }
  }
  return best;
}
```

A diagonal creature leaves most of its box empty; a box test would claim the water beside it. Use
where each was last drawn, and keep it to a few distance checks per creature: it runs on every
pointer move.

## 17. What it costs, and how to know

- **Draw only what changed**; cache the ground, the scenery, the sprites (section 10).
- **One `fillStyle` per bucket.** Sort the cells to draw by style (a counting sort over 6 or 65
  levels) and set each style once.
- **Search less.** Rasterize a body only within its reach: per row, only as far as some spine
  segment's part of the body reaches. In Shoal that took the creatures from 5.5 to 2.1 ms a frame.
  Check such a speed-up against the slow way, cell by cell: Shoal's changed no cell over 3,200
  frames at seven window sizes.
- **Scale up cheaply.** Plain bilinear smoothing (`imageSmoothingQuality = "low"`) for the soft
  layer cost 2.3 ms a frame at 1× against 6 for "high", which also rang round a dark fin. Drawing
  only the span it covers, not the whole window, took it from 10 ms to 2.3.
- **30 frames a second.** Characters read smooth at 30; it costs half of 60.
- **Off the main thread.** The first Shoal drew on the window's main thread: 170 ms of script a
  second, beside every terminal. In a worker on an `OffscreenCanvas`, or in a frame of its own,
  the terminals never wait for it.

**Measure** the draw over 600 frames, and report the median and the 90th percentile, at 1440×900
at 1× and at 2×, in the theme's colours and in the scene's own:

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

For scale, Hivemind's scenes, median per frame in headless Chromium, 1× / 2×: Fireflies 1.1 / 2.2
ms, Jellyfish 1.9 / 3.4, Koi Pond 3.3 / 4.7, Shoal 5.6 / 8.0. **A headless browser renders in
software**, with no GPU: it overstates the cost, and its frame rates mean nothing. Compare a
change with what came before it, on the same machine, the same way, and say how.

## 18. Tests

- **Seed the simulation.** Replace `Math.random` with `mulberry32(seed)`, step a fixed number of
  times at 1/60 s, and assert on behaviour, over a few seeds. Split the simulation from the
  drawing, so it runs with no canvas at all.
- **One test per behaviour, with its number.** A needs-you creature is beside its tile 90% of ten
  seconds; with another tile on one side, it holds on the open side; heads under a tile under 1%
  of the time; calm creatures over 90% in sight; a resting one stays low; a creature never folds
  back on itself; a still frame changes only what changed. Take each bar from what many seeds
  measure, with room on both sides.
- **Show each one failing.** Break the rule it guards and see the test go red, then put the rule
  back. A test that passes with its rule removed guards nothing.
- **Golden pictures.** Draw fixed seeds at fixed sizes (dark, light at 2× with frosted tiles, and
  a third theme; a few seconds each with a bite, a click, the pointer and a tile moved) and hash
  the pixels. A refactor that should change nothing on screen must hash the same, plain and in
  colour.

## 19. Starting points people like

Each needs its creature (one per agent, a kind per program), its ground, and a look for each state.

| Scene | The creature | The ground | Working | Ready | Needs you | Resting | A turn done well |
|---|---|---|---|---|---|---|---|
| Aquarium, seen from the side | a fish per agent, a species per program (angelfish, clownfish, tang, puffer), its body on a spine | sand and rocks in block cells, coral, a stone breathing bubbles, small fish schooling | darts after food flakes | hangs in mid-water, fins sculling | swims to the glass beside its tile and mouths at it, bubbles rising | rests behind a rock, dim | a burst of bubbles |
| Koi pond, from above | a koi per agent, a variety per program, known by its pattern | dark water, pebbles, lily pads drifting over, fry | feeds on the fry | cruises under the pads | surfaces beside its tile, mouthing, rings spreading | deep and slow | a ring |
| Jellyfish, from the side | a jelly per agent: bell, rim, tentacles, a kind per program | the deep, blue to near black, light from far above, marine snow | beats fast and roams | drifts | rises beside its tile and holds, glowing | sinks low, barely beating | a flash of its light |
| Fireflies, at night | a bigger firefly per agent, its light's colour and flash code per program | sky with stars, grass and reeds along the bottom, small fireflies | flies about, flashing its code fast | drifts, flashing slowly | hovers by its tile, flashing two bright flashes over and over | settles in the grass, faint | a bright flash, answered in a wave |
| Birds | a bird per agent (swallow, crow, gull, heron), wings in two glyph frames (`v` and `^`) | sky in a gradient, clouds baked a few times a second, a wire and a tree line along the bottom, a flock of small birds as boids | swoops after insects | glides in wide circles | flaps in place beside its tile, calling, notes rising | roosts on the wire, head tucked | a loop, or a dive |
| Bees | a bee per agent, bigger than the workers, stripes and colour per kind | flowers along the bottom in block cells, a comb of `<>` cells in a corner | flies flower to flower, pollen trailing | hovers lazily | dances a figure eight beside its tile: the bee's way to say "here" | still, in the comb | a puff of pollen |
| Starfield | a ship or comet per agent, its trail's glyphs and colour per kind | three layers of stars at three speeds (the far one baked), a faint nebula | crosses fast, the near stars streaking | drifts | orbits beside its tile, its beacon blinking | docked at an edge, dim | a burst of sparks |
| Rain or snow | a cloud per agent, its shape per kind | rain into puddles that ring where drops land, or snow drifting up along the bottom, cell by cell | rains or snows hard | drifts, a light drizzle | gathers beside its tile, darkens, a flicker of lightning now and then | thins to a wisp, low | the sky clears for a moment, or a rainbow in colour |
| City lights at night | a small aircraft, drone or blimp per agent, its lights' colours and blink per kind | a skyline of block cells along the bottom, windows lit and going out a few at a time, street lights | crosses the sky fast, lights blinking | drifts slowly | hovers beside its tile, its light blinking the call | parked on a rooftop, lights low | a firework over the skyline |

Whatever you make: draw the plain two-colour version first and make it beautiful there; keep the
middle of the screen calm and the busy scenery along an edge; and make "needs you" the one state
nobody can miss.
