# What a good design-system page does, and what we took

Status: reference, 2026-09-17. Studied from screenshots of paperclip.ing (home, /product,
/product/org-chart, /solutions, /blog, a post, /changelog, /about and the 44,706px /brand page).
Kept here so the next pass does not have to re-derive it.

## The five patterns worth copying

**1. Specimens are tables, not prose.** The type ramp is three columns — ROLE · SAMPLE · SPEC —
with the sample rendered at its real size and the spec printed in mono beside it
(`clamp(42, 5.5vw, 80) · 600 · -0.04em`). The colour section repeats the idea as
TOKEN · LIGHT · DARK · USAGE with a chip inline next to each value. Hairline rows, no fills.
A reader can scan a table; they cannot scan a paragraph about type.

**2. A rule line under every subsection head.** "Use the role, not the size." · "Components
reference these — they swap with theme." One sentence, stating the rule the specimen below is
demonstrating. It turns a gallery into a document.

**3. Swatches carry four facts, in this order.** A large chip, the human name (Graphite,
Charcoal, Ink), the raw value in mono, the token name(s) in mono, then a usage sentence in
plain words: "Secondary text + mono labels in light mode". Ours can do better here than most,
because the app's stylesheet already carries that sentence as a comment next to the token.

**4. Type does the work; everything else is quiet.** Hero ~92px, section headings ~72px,
subsections ~34px, then a hard drop to 16px body and 11px mono. Nothing lives in between.
Tracking tightens as size grows (-0.04em at display, -0.02em at card title). Because the type
carries the page, the surfaces can be hairlines and the palette can be two greys.

**5. Feature blocks alternate and always follow the same five beats.** Mono uppercase eyebrow
("FOR EVERYONE, EVERY DAY") → headline → a bold lead sentence, then prose → em-dash bullets
("— Tasks, approvals & review gates") → two arrow links. Text left / UI right, then swapped.
The UI is DOM, with a window bar and real-looking rows: mono IDs (`PAP-1041`), and status chips
in the documented recipe — DONE green, IN PROGRESS blue, BLOCKED red, IN REVIEW amber.

## The writing

Short declarative sentences, often three in a row: "Declare intent. Agents work. You verify the
output." Headlines are sentences with a full stop, sentence case, never a slogan
("A line. A loop. A clip." · "A palette with purpose." · "Editorial gravity. Industrial
precision."). Rules are stated as consequences, not preferences: *at 92% a surface still hides
the wallpaper's detail while remaining part of the same scene*. Do/don't pairs end a section:
the DO says what to do and why it works, the DON'T names the failure it prevents, one sentence
each, never scolding.

## What we deliberately did not take

- **The rainbow agent palette and pill CTAs.** Consumer register; ours is a terminal on a dark
  canvas, and amber already means "an agent needs you".
- **The theme FAB and the version dropdown.** We removed the theme picker on purpose; a control
  that contradicts that decision would be worse than none.
- **A 44,000px page.** Fourteen sections with a graphic generator is their product surface.
  Nine sections that are all true is ours.

## Ours, and where it now stands

`/brand` is generated from `apps/desktop/src/renderer/src/styles.css`: 111 tokens vendored by
`docs/scripts/sync-tokens.mjs` at build time, with the app's own comments shown as the reasoning
beside each swatch. The type ramp and the token dump are tables, following (1). The page cannot
drift from the app without the build noticing, which is the one thing their page asks a human to
remember.
