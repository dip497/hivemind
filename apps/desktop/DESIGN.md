---
name: hivemind
description: One quiet screen for every agent, terminal and diff you supervise.
colors:
  graphite-ground: "oklch(0.165 0.004 250)"
  graphite-sheet: "oklch(0.195 0.004 250)"
  graphite-card: "oklch(0.23 0.005 250)"
  graphite-hover: "oklch(0.27 0.005 250)"
  hairline: "oklch(0.27 0.005 250)"
  control-line: "oklch(0.34 0.006 250)"
  chalk-text: "oklch(0.93 0.004 250)"
  pencil-text: "oklch(0.80 0.005 250)"
  dust-text: "oklch(0.62 0.006 250)"
  steel-accent: "oklch(0.52 0.03 250)"
  steel-accent-hover: "oklch(0.57 0.03 250)"
  signal-amber: "oklch(0.80 0.13 72)"
  sage-done: "oklch(0.74 0.07 155)"
  brick-error: "oklch(0.66 0.11 32)"
  mist-info: "oklch(0.74 0.035 245)"
  unread-blue: "oklch(0.70 0.14 250)"
  working-white: "oklch(0.91 0.005 250)"
  terminal-ground: "#1A1C1F"
  scrim: "oklch(0 0 0 / 0.55)"
typography:
  heading:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", Ubuntu, Cantarell, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.014em"
  title:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", Ubuntu, Cantarell, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.014em"
  row:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", Ubuntu, Cantarell, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "-0.005em"
  body:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", Ubuntu, Cantarell, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "-0.005em"
  label:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", Ubuntu, Cantarell, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "-0.005em"
  count:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", Ubuntu, Cantarell, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "0.01em"
    fontFeature: "\"tnum\""
  chip:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", Ubuntu, Cantarell, sans-serif"
    fontSize: "10px"
    fontWeight: 500
    lineHeight: 1
    letterSpacing: "0.01em"
  mono:
    fontFamily: "\"JetBrains Mono\", ui-monospace, \"SFMono-Regular\", Menlo, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.4
rounded:
  sm: "4px"
  keycap: "5px"
  md: "6px"
  lg: "8px"
  menu: "10px"
  island: "12px"
  sheet: "14px"
  full: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  indent: "14px"
  lg: "16px"
  xl: "24px"
  row: "32px"
  row-tall: "44px"
  row-decide: "80px"
  control: "32px"
  control-compact: "28px"
components:
  button-primary:
    backgroundColor: "{colors.chalk-text}"
    textColor: "{colors.graphite-ground}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.pencil-text}"
    rounded: "{rounded.md}"
    size: "32px"
  button-ghost-hover:
    backgroundColor: "{colors.graphite-card}"
    textColor: "{colors.chalk-text}"
  input:
    backgroundColor: "{colors.graphite-ground}"
    textColor: "{colors.chalk-text}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "32px"
  menu-item:
    backgroundColor: "transparent"
    textColor: "{colors.chalk-text}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "6px 8px"
  menu-item-hover:
    backgroundColor: "{colors.graphite-card}"
  tile-row:
    backgroundColor: "transparent"
    textColor: "{colors.chalk-text}"
    typography: "{typography.row}"
    rounded: "{rounded.lg}"
    padding: "0 6px 0 12px"
    height: "32px"
  tile-row-hover:
    backgroundColor: "{colors.graphite-card}"
  tile-row-selected:
    backgroundColor: "{colors.graphite-hover}"
  tile-row-tall:
    height: "{spacing.row-tall}"
  tile-row-line:
    textColor: "{colors.pencil-text}"
    typography: "{typography.count}"
  tile-row-line-waiting:
    textColor: "{colors.signal-amber}"
    typography: "{typography.count}"
  status-chip:
    typography: "{typography.chip}"
    rounded: "{rounded.full}"
    padding: "3px 6px"
  keycap:
    textColor: "{colors.pencil-text}"
    typography: "{typography.count}"
    rounded: "{rounded.keycap}"
    height: "18px"
    padding: "0 4px"
  sheet:
    backgroundColor: "{colors.graphite-sheet}"
    textColor: "{colors.chalk-text}"
    rounded: "{rounded.sheet}"
---

# Design System: hivemind

## Overview

**Creative North Star: "The Quiet Workbench"**

A craftsman's bench: the tools laid out within reach, nothing shouting, and the work (the agents' terminals) in the middle. The chrome is calm, dense and exact. It is graphite on graphite, set in small sizes on a strict scale, and it gives way to the terminals a person reads for hours.

Colour is spent only where it means something. One warm colour, Signal Amber, belongs to whatever waits on a person, so it can be seen from across the room. Everything else is neutral, and the user's own wallpaper, glass, accent and preset sit on top. Every surface has to stay legible on any of them, so no surface depends on the look being the default one.

This system rejects three looks. The first is the stock generated look: default Geist with Lucide, everything one grey, an icon on every row. The second is the neon gamer dashboard: glowing gradients, saturated colour everywhere, motion for its own sake. The third is the enterprise admin: boxy tables, heavy borders, uppercase labels, dense chrome around the work.

The code is migrating to two settled decisions. The UI font moves from bundled Geist Sans to the operating system's own UI font, and icons are Hugeicons (free, stroke-rounded) at a 1.5 stroke, drawn only through `components/icons.tsx`. The tokens below record the target. Where the build still differs, the build is mid-migration, not a second rule.

**Key Characteristics:**
- Graphite surfaces stacked in four close steps; depth from tone and soft shadow, never from heavy borders.
- Side panels and Settings are inset sheets: 8px from the window edge, 14px corners, a soft lift.
- One type scale for the panel and menus: 15, 14, 12, 11, 10.
- Quiet until it needs you: working is a dot, idle is nothing, needs-you is amber and may pulse.
- The OS UI font for chrome, JetBrains Mono for terminals and machine text.

## Colors

The palette is neutral graphite tinted a hair toward blue (hue 250), with colour kept for meaning. All values are oklch so blends and alpha mixes stay even. A preset may recolour every value; the meanings stay.

### Primary
- **Steel Accent** (steel-accent; steel-accent-hover on hover): the user's accent, a quiet desaturated steel by default. It marks resize handles under the pointer and checkbox fills; never focus, which is the selection colour. The user may set it to grey, so it never carries meaning. It is held to 3:1 as a mark only, so it never colours words: text is chalk or pencil, and a link is chalk with an underline. A small mark in it on a header or a card (a pin, a check, a toast's icon) takes `--color-brand-mark`, the accent fitted to 3:1 on the page, the panels and the cards.

### Tertiary
- **Signal Amber** (signal-amber): needs-you, and nothing else. Blocked, asking and plan-review chips, the needs-you badge on the rail, the needs-you count, and what such a row waits on, on its second line. Nothing decorative borrows it.
- **Unread Blue** (unread-blue): a 6px dot after the name of a tile that finished since you last looked. It marks and never fills, and stays blue whatever the accent is.
- **Sage Done** (sage-done): a finished agent.
- **Brick Error** (brick-error): failed agents and destructive actions. Destructive hovers tint at 10%.
- **Mist Info** (mist-info): neutral information.
- **Working White** (working-white): the small dot for an agent at work. Being at work is not a call to action.

Status chips use the status colour as text on an opaque 16% mix of it over the panel colour (`color-mix(in srgb, <status> 16%, var(--surface-2))`), so a chip reads the same on any row under it.

### Neutral
- **Graphite Ground** (graphite-ground): the canvas and window behind everything.
- **Graphite Sheet** (graphite-sheet): side panels, Settings sidebar, menus and popovers. It is the panel material.
- **Graphite Card** (graphite-card): tile chrome, cards, row hover.
- **Graphite Hover** (graphite-hover): the selected row and the active rail icon.
- **Hairline** (hairline): the sheet's outer edge and the tile header's divider.
- **Control Line** (control-line): control borders, keycap outlines, popover edges, section dividers.
- **Chalk Text** (chalk-text): names, rows and titles. It also fills the primary button.
- **Pencil Text** (pencil-text): headings, menu labels, counts, keycaps, secondary lines. It is the floor for any text that carries information.
- **Dust Text** (dust-text): idle and exited states, placeholders, grip marks. Use it for things a person can skip, not for labels.
- **Terminal Ground** (terminal-ground): behind a terminal until the preset's own terminal colours paint.

### Named Rules
**The One Voice Rule.** Signal Amber means "this waits on you". Only blocked, asking and plan-review states use it, and only they may pulse. If nothing needs the person, no amber is on screen.

**The Accent Is Not a Signal Rule.** The accent belongs to the user and may be grey. Never encode state, newness or selection in it alone. Unread has its own blue, and status has its own colours.

## Typography

**UI Font:** the operating system's UI font (system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Ubuntu, Cantarell, sans-serif)
**Mono Font:** JetBrains Mono (with ui-monospace, SF Mono, Menlo, Consolas)

**Character:** the chrome speaks in the platform's own voice, so the app feels at home on Linux, macOS and Windows. Mono is for what a machine said: terminals, paths, branches, commands, ids.

### Hierarchy
Each step is a Tailwind token (`text-heading`, `text-title`, `text-row`, `text-body`, `text-label`, `text-count`, `text-chip`; in CSS `var(--text-*)`) carrying its size and tracking. Leading and weight belong to the role and are set where the text is. Tailwind's own sizes (`text-sm`, `text-xs`, …) are switched off.

- **Heading** (600, 20px, tracking -0.014em): a page's own name — a Settings page, the empty canvas's first line, an open issue.
- **Title** (600, 15px, tracking -0.014em): the workspace name at the top of the panel.
- **Row** (400, 14px; 500 for frame and section rows): every tile, frame, recent and action row in the panel.
- **Body** (400, 13px, line-height 1.5): the app default. Buttons, inputs, Settings text.
- **Label** (500, 12px, pencil-text): panel headings and menu items. Sentence case.
- **Count** (400, 11px, tabular figures): counts, keycaps, secondary choices.
- **Chip** (500, 10px): status chips, badge numbers and the initial on a person's disc only.

Letter-spacing follows size: -0.014em at 16–23px, -0.005em at 12–15px, +0.01em at 11px and below.

### Named Rules
**The Named Steps Rule.** Text is set only through the seven named steps, everywhere: the renderer, its CSS and the tools that ship with the app. The panel, menus and frame header use five of them (15, 14, 12, 11, 10); heading and body belong to pages and dialogs. `tests/unit/design-system.test.ts` fails on a literal size, a Tailwind size or an inline `fontSize` written as a number; a size worked out in code (`size * 0.5`) it cannot see, so review catches that. A new size is a defect, not a variant. A tile's content (terminal, editor, diff) follows its own zoom, not the scale.

**The Sentence Case Rule.** No uppercase section labels anywhere. A heading is 12px medium pencil-text in sentence case.

## Layout

The canvas fills the window, and the chrome sits at its edges: the Layers sheet on the left, a floating tool island at top centre, and toasts bottom right. Nothing at page level scrolls; panes scroll inside themselves.

The panel is a list of 32px rows set 8px in from the sheet's sides; a terminal's row is 44px (row-tall) while it shows a second line. Nested items indent 14px per level. Every row's name starts at the same x, after a 16px icon slot. Gaps inside a row are 10px; menus pad 4px and items pad 6px by 8px. Settings is a centred sheet (up to 1080 by 780px) with a 208px sidebar. Its page content is capped at 760px, with 28px between sections.

Row chrome stays hidden until the row is hovered or focused: close buttons, keycap hints, the status chip of a non-urgent row. Needs-you chips never hide.

## Elevation & Depth

Depth is tonal first: four graphite steps from ground to hover. Soft shadows lift what floats. Each shadow pairs a soft drop with a 1px inner top highlight, so a surface reads as lifted rather than outlined. Glass is the user's option. Under glass, panels frost against the wallpaper but keep at least 68% of their colour, so a list of names stays legible over any wallpaper. Modals and Settings stay opaque.

### Shadow Vocabulary
- **Rest** (`box-shadow: 0 1px 2px oklch(0.05 0 0 / 0.30), 0 1px 3px oklch(0.05 0 0 / 0.22)`): cards at rest.
- **Lifted** (`box-shadow: 0 4px 12px oklch(0.05 0 0 / 0.38), 0 1px 3px oklch(0.05 0 0 / 0.26)`): the Layers sheet, popovers, menus, a hovered card.
- **Raised** (`box-shadow: 0 12px 32px oklch(0.05 0 0 / 0.48), 0 4px 12px oklch(0.05 0 0 / 0.32)`): Settings and modal dialogs.
- **Top light** (`box-shadow: inset 0 1px 0 0 oklch(1 0 0 / 0.07)`): added to lifted and raised surfaces.
- **Float** (`--hm-shadow-float`, `0 8px 22px oklch(0 0 0 / 0.45)`): what floats on the canvas — tiles, the tool island, the canvas controls.
- **Glass** (`--hm-shadow-glass`, `0 10px 36px oklch(0 0 0 / 0.5)`, with `--hm-highlight-glass`, a 10% top light): the same surfaces under glass, and toasts, so a translucent slab still reads as lifted.

### Overlays and tints
- **Scrim** (`--color-scrim`, black at 55%): behind a modal dialog or Settings, and the minimap's off-screen area.
- **Selection** (`--color-selection`, the text colour at 20%), **current line** (2.5%), **match** (`--color-match`, the info colour at 22%), **bracket match** (the accent at 25%): mixed from the theme's own colours, so a light or custom preset gets them too.
- **Syntax** (`--color-syntax-*`): the editor's keyword, string, number, function, type, property and tag colours.

A colour is defined once, as a custom property in `styles.css` (a token) or in a palette a person picks from (frame colours, people's colours, wallpaper scenes, note paper). Anything else uses those names; the unit test above fails on a colour literal outside a definition.

### Named Rules
**The Inset Sheet Rule.** Side panels and Settings are sheets set 8px in from the window edges, with 14px corners, a hairline edge and the Lifted or Raised shadow. They are never full-bleed slabs.

**The Legible Without Glass Rule.** No surface relies on glass to be readable. Every surface is opaque enough to read on any wallpaper, and turning glass off loses no information.

## Shapes

Corners soften as surfaces grow (Tailwind: `rounded-sm` 4, `rounded-keycap` 5, `rounded-md` 6, `rounded-lg` 8, `rounded-menu` 10, `rounded-xl` 12, `rounded-sheet` 14, `rounded-full`; no other radius is allowed). Pills (9999px) are for status chips and dots. Keycaps use 5px. Controls and menu items use 6px. Rows and cards use 8px. Menus and popovers use 10px. Floating islands use 12px. Sheets use 14px. Borders are single 1px lines in hairline or control-line. Keycaps draw their edge as an inset 1px ring, not a border. Status marks are 6px dots.

## Components

The components are calm, exact and small. Nothing raises its voice until it needs a person.

### Buttons
- **Shape:** gently rounded (6px); 32px tall (`h-control`) by default. Compact, 28px (`h-control-compact`, `size="sm"`), only in dense rows: tile chrome, popovers and pickers, the panel. Settings pages and dialogs use 32px, so a button, an input and a select in one row line up. Tile chrome goes down to 24, 20 and 16px. Nothing is 36px.
- **Primary:** chalk-text fill with graphite-ground text, 13px medium, 12px side padding. Hover drops it to 90%.
- **Ghost:** pencil-text on nothing; graphite-card fill and chalk text on hover. Icon buttons are square (32, 28, 24, 20px).
- **Press:** scales to 0.96 in 100ms. Hover and colour changes take 150ms on the house curve `cubic-bezier(0.32, 0.72, 0, 1)`.
- **Focus:** the one focus ring (see Inputs / Fields).
- **Ghost destructive:** quiet until hovered, then brick text on a 10% brick tint.

### Chips
- **Status chip:** 10px medium, pill, 3px by 6px. The status colour is the text, on a 16% tint of itself.
- **State:** only needs-you chips pulse and stay visible on hover. Others hide on hover so row actions can show.

### Cards / Containers
- **Sheet:** graphite-sheet, 14px corners, hairline edge, Lifted shadow, 8px inset from the window.
- **Card:** graphite-card, 8px corners, control-line edge, Rest shadow. On hover it rises 1px and takes the Lifted shadow.
- **Popover and menu:** graphite-sheet, 10px corners, control-line edge, 4px padding. Never thinner than the panel it opens from.

### Inputs / Fields
- **Style:** graphite-ground fill, control-line border, 6px corners, 32px tall (28px small), 13px text.
- **Focus:** one ring for the whole app, set once in `styles.css`: a 2px outline offset 2px in `--color-focus`, which is the steel selection colour (`--color-select`): it comes from the palette, never from the person's accent, so a ring never turns amber, the colour of "waits on you". It shows on keyboard focus only (`:focus-visible`). A list or menu item shows focus by its highlight instead; a canvas object being written in is itself the field. No component draws a ring of its own.
- **Error / Disabled:** brick border on error; 45% opacity disabled.
- **Select:** the Input's box (32px, 28px small, same border, corners and ground) with a chevron; its list is the menu surface, items as menu items with a check on the chosen one. Keyboard and type-ahead work as in a native select. Never a native `<select>`: it draws the operating system's accent and highlight.
- **Native controls:** `color-scheme` follows the theme and `accent-color` is the steel accent, so checkboxes, ranges, scrollbars and pickers never show the operating system's colours.

### Navigation
- **Icon rail:** 32px square targets, 18px icons. Pencil-text at rest, graphite-card on hover, graphite-hover and chalk text when active. A needs-you count sits in the corner as an amber dot.
- **Menu item:** 12px, 6px by 8px, 6px corners, graphite-card on hover and focus. A shortcut sits at the far end in 11px pencil-text.

### Tile Row (signature)
A 32px row: a 16px icon slot (an agent's own logo, or the tool's mark), the name at 14px, an unread dot, a spacer, then one status mark. Working is a working-white dot. Done or failed is a chip that hides on hover. Needs-you is an amber chip that pulses. Idle shows nothing. While Ctrl or ⌘ is held, an 18px keycap with the jump number replaces the status. The selected row takes graphite-hover with a 12% chalk inner ring. The failed, finished and needs-you colours are fitted to the preset (`statusInk` in core's `theme-format.ts`): a chip's word reads at 4.5:1 on its own fill and on the panel, and a mark at 3:1 on a row at rest, under the pointer and selected, in the colour's own hue with as much of its chroma as it can keep, so failed stays red. A status word drawn straight on a header or a selected row takes the text colour fitted to those surfaces (`statusTextInk`, `--color-status-*-text`).

A terminal's row may say one more thing, on a second line under the name and lined up with it: what its screen last showed (`214 tests passed`), in 11px mono pencil-text (`text-count font-mono`), cut with an ellipsis. While its agent waits on the person, the line is what it waits on instead (`Bash: npm test`, `Asks: …`, Plan ready for review), in Signal Amber. The row grows to 44px (row-tall) only while it has a line; with none it stays 32px. The line never pulses or moves; for an agent that keeps a conversation it is the first line of what it last said. The View menu's **Lines** shows them for all agents, only for those that need you, or not at all.

A permission the person can answer from the row (its agent says the keys, and the tool's input is known) adds a band under the line, lined up with it: compact 28px buttons (control-compact), ghost **Deny** then primary **Allow**, 6px apart and 6px under the line, and the row grows to 80px (row-decide). Allow is offered only while the input is one line and none of it is cut; otherwise the band is one ghost **Review**, which opens a popover with the whole input in mono and the same two buttons, the keyboard on Deny. The hover card shows a terminal's whole line, or the tool and all of its input, wrapped, up to six lines. An agent's toast says the same as its row: what it waits on, with the same band, or, once it finished, its line.

### Action Row (signature)
The panel's start actions (New agent, New project, Add a tool or widget, New machine) use the tile row's shape, so the panel reads as one list. Their icon sits in a small tinted tile, the one place colour is decorative. Each action keeps its own fixed hue, never amber and never the unread blue. Its keycap hint appears only under the pointer or focus.

### Tool Island
The workspace's tool bar floats at top centre: graphite-sheet, 12px corners, control-line edge, 6px padding and ghost icon buttons 2px apart.

### Markers
- **Modified marker:** a file with unsaved edits is a 6px pencil-text dot after its name, named "unsaved changes" for a screen reader. It is neutral: an unsaved file does not wait on the person, so it never takes amber. So is a file git calls modified, in the file tree.
- **Machine link:** a machine's connection takes a status mark with a word, from the app's status owner (`workspace/status-look.tsx`, `MACHINE_LOOKS`): online a sage dot, connecting a half-filled dot, offline a dust square, paused two bars, idle a ring, and sign in the amber needs-you triangle, the one machine state that waits on the person. A mark shown without its word carries the word as its accessible name.

## Do's and Don'ts

### Do:
- **Do** set text only through the named steps; panel and menu text at 15, 14, 12, 11 or 10px (The Named Steps Rule).
- **Do** show working as a 6px dot and idle as nothing; give a word only to what a person must act on.
- **Do** reserve Signal Amber and pulsing for blocked, asking and plan review (The One Voice Rule).
- **Do** mark unread with the 6px unread-blue dot after the name, whatever the accent.
- **Do** set side panels and Settings as inset sheets: 8px from the edges, 14px corners, a soft lift.
- **Do** use colour only where it means something: start-action tiles, a frame's colour as a small dot, agents' own logos, status, unread.
- **Do** use JetBrains Mono for terminals, paths, branches, commands and ids, with tabular figures for numbers.
- **Do** check every surface on a busy wallpaper, under glass and without it, and with a grey accent.

### Don't:
- **Don't** use uppercase or widely tracked section labels; headings are 12px medium sentence case.
- **Don't** put an icon on every row or colour every icon; colour that means nothing is noise.
- **Don't** use glowing gradients, saturated fills or motion for its own sake.
- **Don't** build boxy tables, heavy borders or dense chrome around the terminals.
- **Don't** encode meaning in the accent; it may be grey (The Accent Is Not a Signal Rule).
- **Don't** make legibility depend on glass or on the default wallpaper.
- **Don't** let anything that is not waiting on a person pulse or turn amber.
