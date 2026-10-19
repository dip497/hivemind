# Diagrams

The guide's diagrams, drawn as code. `npm run diagrams` (in `site/`) draws every one to
`guide/images/<slug>.svg` at the top of the repository, and to `html/<slug>.html` with a light and
a dark `.png`, to open and look at. A guide page shows the SVG inline with
`<Diagram name="<slug>" caption="…" />`, so it takes the page's fonts and its light or dark
colours; opened on its own, the SVG falls back to the same colours.
`npm run diagrams -- <slug>` draws one. The same input gives the same files, so a rerun with
nothing changed leaves `git status` clean.

Once per machine, Playwright needs a Chromium: `npx playwright install chromium`.

| File | What it holds |
|---|---|
| `diagrams.mjs` | One function per diagram: its boxes, wires, labels and notes, by coordinate. |
| `how-it-works.mjs` | The same, for the How it works pages; each fact is traced to the code. |
| `draw.mjs` | The builder: boxes, rounded right-angle wires, masked labels, the SVG. |
| `brand.mjs` | The colour roles, from the guide's own tokens in `site/docs/app/global.css`. |
| `build.mjs` | Writes the SVG, the HTML page and the two PNGs. |

## Change a diagram

1. Read the code the diagram describes first. A diagram that disagrees with the code is worse
   than none.
2. Edit its function in `diagrams.mjs`, run `npm run diagrams -- <slug>`, open the PNG.
3. Commit the `.svg` and the `html/` page with the change.

## Add one

1. Add a function to `diagrams.mjs` that returns a `new Diagram({ slug, w, h, title, desc })`,
   and add it to the list at the bottom. Name the slug `<page>-<what>`.
2. Draw wires and labels first, boxes last, so lines sit behind boxes. Wires take points that
   share an x or a y; corners are rounded for you. A label sits 16px off its wire, in open space,
   never over a box.
3. One or two `focal` boxes at most. Sentence case, mono only for commands and wire labels.
4. Put it in the page, with its boxes and arrows as a short list right under it:

   ```mdx
   <Diagram name="<slug>" caption="Caption" />

   - **A** → **B**: what goes, and how.
   ```

   The list says what the diagram says, not what it looks like. The Markdown copy of the page
   shows the list and a link to the SVG.

## Credit

The layout rules, connector rules and node treatments follow
[diagram-design](https://github.com/cathrynlavery/diagram-design) by Cathryn Lavery, MIT licence.
None of its files are copied here.
