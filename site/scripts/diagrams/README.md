# Diagrams

The guide's diagrams, drawn as code. `npm run diagrams` (in `site/`) draws every one to
`guide/images/<slug>.svg` at the top of the repository, and to `html/<slug>.html` and `.png`, to
open and look at.
`npm run diagrams -- <slug>` draws one. The same input gives the same files, so a rerun with
nothing changed leaves `git status` clean.

Once per machine, Playwright needs a Chromium: `npx playwright install chromium`.

| File | What it holds |
|---|---|
| `diagrams.mjs` | One function per diagram: its boxes, wires, labels and notes, by coordinate. |
| `draw.mjs` | The builder: boxes, rounded right-angle wires, masked labels, the SVG. |
| `brand.mjs` | The colours, read from `src/generated/tokens.json`, plus the diagram's own three. |
| `build.mjs` | Subsets the fonts into each SVG and writes the SVG, PNG and HTML. |

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
4. Put it in the page:

   ```mdx
   <Frame caption="Caption">
     <img src="/images/<slug>.svg" alt="What it shows, in words." />
   </Frame>
   ```

   The alt text says what the diagram says, not what it looks like.

## Fonts and credit

Each SVG embeds the glyphs it uses from Geist and JetBrains Mono, both under the SIL Open Font
License 1.1 (from `@fontsource/geist-sans` and `@fontsource/jetbrains-mono`, which carry the
licence text), because an `<img>` cannot load web fonts.

The layout rules, connector rules and node treatments follow
[diagram-design](https://github.com/cathrynlavery/diagram-design) by Cathryn Lavery, MIT licence.
None of its files are copied here.
