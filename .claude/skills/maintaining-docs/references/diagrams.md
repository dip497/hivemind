# Diagram craft

How to draw a guide diagram that reads well at page size, in both themes, on a phone and as text.
The builder's files and commands are in `site/scripts/diagrams/README.md`. This file holds the
craft rules that README does not.

The style follows [diagram-design](https://github.com/cathrynlavery/diagram-design) by Cathryn
Lavery (MIT). Read its `references/` for the layout, connector and node rules. None of its
files are copied here.

## When a diagram earns a place

Draw one when the reader needs to see parts and what flows between them, a sequence over time,
or states and the moves between them. Don't draw one to decorate a page or to restate a list. One
diagram per idea. A page rarely needs more than two.

## The builder

- `draw.mjs` holds the `Diagram` class: `node`, `wire`, `label`, `note`, `zone`, `lifeline`,
  `raw`.
- `brand.mjs` holds the colour roles, read from the guide's tokens in `site/docs/app/global.css`.
- `diagrams.mjs` and `how-it-works.mjs` hold one function per diagram, and `build.mjs` writes it.

Rules for using it:

- Draw wires and labels first and boxes last, so lines sit behind boxes. Wires take points that
  share an x or a y; the corners are rounded for you.
- A label sits about 16px off its wire, in open space. It never sits over a box, a zone's name or
  another wire.
- Use a colour role (`C.ink`, `C.muted`, `C.soft`, `C.accent`, …), never a hex value. The roles
  are CSS variables, so the SVG follows the page's theme. Opened on its own, it falls back to the
  same colours.
- Make one or two boxes `focal` at most: the thing the diagram is about. Use `accent` on wires for
  the one path that matters. Use a dashed box (`dashed`, `plain`) for something outside your
  control, like HiveHub or your server.
- Write in sentence case. Use mono only for commands, file names and wire labels.

## Sizes

The page draws a diagram at its own width, 1:1. At 1440 the guide's column is about 807px, so a
diagram is at most **800 wide**.

| Text | Size |
|---|---|
| Box title | 15px, weight 600 |
| Box subtitle, note | 12.5px (mono 12px) |
| Wire label, zone name | 12px |

The builder enforces the minimums. When text doesn't fit, take these steps, in this order:

1. Cut words: "windows and views", not "windows · canvas · views".
2. Shorten a wire label to the one word that tells what flows ("token", "event").
3. Reflow: stack columns or move a box to a new row.
4. Merge two boxes that always go together (the desktop app "draws it in the tile").

Never scale the art down. Small text is the most common reason a diagram gets sent back.

## Contrast

Every text colour is at least **4.5:1** on every fill it can sit on (paper, box fill, focal tint,
warn tint), in light and dark. Body text uses `ink`, labels `muted` and subtitles and notes
`soft`. `link` and `warn` colour lines and borders only, never text. When you change a role in
`brand.mjs`, compute the ratios for both themes before you commit.

## Phones

At 390 the guide's diagram box is about 325px wide. A diagram wider than that scrolls inside its
frame at full size. The page itself never scrolls sideways.

An overview that a reader needs on a phone gets a second layout, `<name>-phone`, about 320 wide.
Stack it top to bottom with the same parts and the same wire labels. `<Diagram name="<name>">`
shows it on small screens when `guide/images/<name>-phone.svg` exists. Both layouts share one
text list, so they must say the same thing.

## The text list

Right under every `<Diagram>`, list its boxes and arrows in a few short lines:

```mdx
<Diagram name="phone-flow" caption="How your phone sees an agent" />

- **Agent** → **background process**: a hook says what it does.
- Background process → **desktop app**: the agent's state.
- Desktop app → **network server** → **phone page**: encrypted end to end.
```

- Bold each box the first time it appears.
- Say what goes, and how. Don't say what the diagram looks like ("on the left", "the blue line").
- The Markdown copy and `llms.txt` replace the diagram with a link to its SVG plus this list. So
  the list alone must carry the meaning.
- The page's prose does not walk the arrows again.

## Checking a diagram

1. `npm run diagrams -- <name>` in `site/`, then open `site/scripts/diagrams/html/<name>.png` and
   `<name>-dark.png`.
2. Run `verify-geometry.py` (see `checks.md`): no text over a box, no wire through a label,
   nothing past the edge.
3. Check every box and arrow against the code it describes.
4. On the built page at 1440 and 390, check that the smallest text renders at 12px or more and
   nothing scrolls the page sideways.
