# Customizing views, widgets and tools — design (2026-10-21)

Status: proposal. Builds on `plugin-platform-2026-10-03.md` (the two runtimes and the kernel),
`plugin-settings-2026-10-07.md` (one record and one settings vocabulary per plugin),
`configurable-workspace-ui.md` (toolbar and panel preferences), `tool-plugins-2026-10-07.md` and
`package-marketplace.md`. Out of scope: who may publish what (publisher identity, licences), and
payments.

## Verdict

Hivemind's three kinds of plugin can each be customized, but each in its own way, and the parts a
person sees together do not share a look. A view repaints everything inside its frame, and gets the
theme from the app, one way. A widget can pick a card tint, muted text and one large text size, and
nothing else. A tool tile can do anything, because it runs inside the app, and promises nothing
about the theme.

The fix is **one look and one settings vocabulary that every kind uses, in each kind's own
runtime**. There is no new runtime and no injected CSS. Five parts:

1. **Tokens.** The app's named colours, radii, fonts and motion, read the same way by all three
   kinds. A plugin can add tokens of its own, with defaults, the way VS Code's `contributes.colors`
   works.
2. **Themes** are a new member a package can ship: values for any token, fonts as files, and a
   wallpaper. Choosing a theme is a setting, so undoing it is a setting too.
3. **Widgets draw richer**, but still only in tokens:
   - sizes (S, M and L);
   - layout and spacing properties;
   - charts, rings, badges and icons;
   - motion that honours reduced motion.

   They also share **one worker per widget kind**, not one per instance.
4. **Settings vocabulary v2**: colour, image, slider, list, sections and conditions, drawn by one
   renderer for every kind.
5. **A layout contract between a view and the app**: the areas each needs kept clear, so neither
   covers the other (from the #216 review).

Two numbers decided the shape:
- **Sandboxing every widget as a web page costs ~68 MB a widget.** At ten times today's count
  that is about 4 GB, so it cannot be how widgets get their freedom.
- **Themes that restyle the app with CSS selectors would break every few hours.** The renderer
  took 276 commits across 262 files in the last 30 days. So themes set values; they never target
  markup.

## 1. Problem

**Goal.** A person, or a whole package, can change how every view, widget and tool looks and
behaves, consistently, without forking the app. A plugin author can build a distinctive look
without giving up the app's theme, accessibility or performance.

**Hard constraints.**
- Untrusted code stays in its sandbox. Views stay in their frame and widgets in their worker.
  Tools are trusted only once switched on (`tool-plugins-2026-10-07.md`).
- Nothing new runs per event on Electron main (CLAUDE.md, "Work that runs per event").
- A customization is the person's to undo, at any time, from Settings or the CLI.

**What is there today.**

| Kind | Draws with | Customizable by its author | Customizable by the person |
|---|---|---|---|
| View | anything, in its own frame | all of it; the theme arrives one way (`ViewTheme`, `protocol.ts:127`) | its settings (4 field types), toolbar placement |
| Widget | 11 node types (`WIDGET_NODE_TYPES`, `widget-api.ts:191`) drawn by the app | `tint` on the outermost stack, `muted`, `size: "large"` on text | its options (4 field types); where the card sits |
| Tool | React inside the app (`tool-plugins.tsx:80`) | all of it; no theme contract | its settings |

**Numbers that matter.**

| What | Number | Source |
|---|---|---|
| Published widgets | 15 (11 in `widgets/`, 4 in Archipelago) | `ls` in hivemind-plugins |
| Published tools / views | 13 / 8 | same |
| Widgets that ask for a width of 260–320 px | 8 of 11 | their `widget.json` |
| Width a floating card is drawn at | 240 px, whatever it asks for | `CARD_W`, `widget-stack.ts:6` |
| Colour tokens in the app's CSS | 69 distinct `--color-*` | grep of the renderer's CSS |
| Setting field types | 4: boolean, number, text, choice | `settings.ts:18-21` |
| Cost of one sandboxed view frame | ~68 MB RSS | `plugin-runtimes-2026-09-17.md`, measured |
| Cost of one widget worker | ~10 MB RSS (node `worker_threads`; a Chromium dedicated worker is not measured yet) | measured here, n = 20 |
| Workers per code widget | one per instance on the board | `widget-runtime.ts:294-301` |
| Renderer churn | 276 commits, 262 files, last 30 days | `git log -- apps/desktop/src/renderer` |

**Which known problem this is.** Three, each solved elsewhere:
1. **A design-token contract** that third-party UI reads and a theme sets: VS Code theme colours,
   Home Assistant themes, Obsidian's CSS variables.
2. **A declarative UI whose style properties are bounded**: Figma widgets, iOS WidgetKit.
3. **An options schema that the host draws**: Grafana's panel options builder, VS Code
   `configuration`, Obsidian Style Settings.

## 2. What others do

- **VS Code, `contributes.colors`**
  ([contribution points](https://code.visualstudio.com/api/references/contribution-points)).
  - What it does: an extension declares new theme colours by id, with defaults for dark, light
    and high contrast. A default can reference an existing colour.
  - What it teaches here: themes and users can then set those colours, and the extension reads
    them through `ThemeColor`. Plugin tokens are first-class and themable, and a default should
    point at an app token, not a hex value, so the plugin follows every theme for free.
- **Home Assistant themes and per-card themes**
  ([forum](https://community.home-assistant.io/t/theming-specific-cards/660956),
  [card-mod themes](https://github.com/thomasloven/lovelace-card-mod/wiki/Card-mod-Themes)).
  - What it does: a theme is a YAML map of CSS variables that can apply globally, per dashboard
    or per card. Per-card theming only works through standard variables. Anything more needs
    card-mod, a community tool that injects CSS.
  - What it teaches here: scoped themes are wanted. Pure-variable theming reaches only as far as
    the variables do, and the injected-CSS escape hatch is where the fragility lives.
- **Obsidian Style Settings**
  ([plugin](https://github.com/mgmeyers/obsidian-style-settings)).
  - What it does: themes and plugins declare their adjustable variables (colour, number, toggle
    class) in an `@settings` block, and one shared pane draws them.
  - What it teaches here: the community built the missing "one settings renderer for looks"
    itself, and three forks of it now conflict. The host should own it from the start.
- **Figma widgets**
  ([`AutoLayout`](https://developers.figma.com/docs/widgets/api/component-AutoLayout),
  [`usePropertyMenu`](https://developers.figma.com/docs/widgets/api/properties/widget-usepropertymenu)).
  - What it does: widgets are declarative nodes with layout and style properties (fill, stroke,
    corner radius, gap). Each instance has a property menu for quick per-instance choices.
  - What it teaches here: a declarative node set can be expressive without being a web page.
    Per-instance properties belong on the widget, not in a settings window.
- **iOS WidgetKit families**
  ([WidgetFamily](https://developer.apple.com/documentation/widgetkit/widgetfamily)).
  - What it does: a widget declares the sizes it supports (small, medium, large) and draws a
    layout per size. Small shows one critical value; large holds detail.
  - What it teaches here: give widgets a few fixed sizes the person picks from. Do not let them
    resize freely, so the layout stays predictable and the author designs each size.
- **Grafana panel options**
  ([`PanelOptionsEditorBuilder`](https://grafana.com/docs/grafana/v8.4/packages_api/data/paneloptionseditorbuilder/)).
  - What it does: a panel declares text, switch, select, colour-picker and slider options, and
    the host draws the editor.
  - What it teaches here: colour and slider are the first two types a looks-heavy plugin
    ecosystem needs, after the four Hivemind has.

## 3. From every side

| View | What worries them |
|---|---|
| Person using it | A theme that makes text unreadable, or a widget that cannot be told apart from the view behind it. Undo must be one step. Reduced motion must still hold. |
| Data | Themes and token values are settings (settings.json `appearance`, the plugin record). Widget instance options already live on the board object. New on-disk shapes need a numbered migration. |
| Operator at 3am | A broken theme must not brick the app: values are validated, and a theme that fails to load falls back to the default with a notice. A bad widget must not take its whole kind down when one worker hosts every instance. |
| Security | Themes carry no code. A font or wallpaper file is served like a view's assets, from the package, by its digest. Token values are colours and numbers, so a theme cannot change markup. A widget's style properties are bounded, so it cannot spoof the app's own dialogs. Tools are already trusted, and still read the same tokens. |
| Cost | Changing a theme writes about 69–1000 CSS variables once and sends one `theme` message to the open view. Widgets re-render nothing, because they reference variables. |
| Next year | (1) Brand editions: a package that ships a view, widgets, tools and a theme together. (2) Phone and remote screens reading the same tokens. (3) Plugins as many as today ×10. |

## 4. Options

### A. Grow each kind on its own (the most boring)

```
views   ── ViewTheme += more fields
widgets ── nodes += more props (raw colours, sizes)
tools   ── nothing; they read the app's CSS as they like
settings── each kind adds the field types it needs
```

Each kind adds what its authors ask for. **Where it breaks:** a theme has to be written three
times, and the three drift. A widget with raw colours ignores every theme. Tools have no contract
at all, so a theme change is a lottery for them.

### B. One look and one settings vocabulary, in each runtime (recommended)

```
                 ┌──────────── tokens: app's + plugins' (with defaults) ────────────┐
  theme member ──┤  values set by: app default < theme < person's overrides          │
  person ────────┘                                                                   │
                       │ CSS variables          │ theme message        │ CSS variables│
                       ▼                        ▼                      ▼
                 widget nodes (style props   view frame (applyThemeVars,  tool tiles
                 reference tokens; drawn     already)                    (React, in the
                 by the app)                                             app)
  settings v2 ── one schema ── one renderer (Settings page, widget property menu, CLI)
```

**Where it breaks:** tokens can only express what has a token. A look that needs a new shape (a
toolbar that is a wooden plank) is still a view's job, inside its own frame. That is what
Archipelago does today.

### C. Every widget and tool a sandboxed web page (the most freedom)

```
widget ── its own hm-view frame ── full HTML/CSS ── theme by CSS variables
```

**Where it breaks:** memory, at about 68 MB a frame.

### D. Themes as CSS against the app (the bold one, as Obsidian and card-mod do)

```
theme.css ── injected into the app window ── selectors on the app's own markup
```

It reaches everything, the toolbar included. **Where it breaks:** every renderer change can break
a theme. A stylesheet can also hide or fake the app's own UI: an `::after` that paints "Allow"
over "Deny" is a phishing kit.

### Scale

Load: today is 15 widget kinds, about 6 instances on screen (4 floating, 2 on the board), 69
tokens and 1 open view. At 10× that is 60 instances and about 150 tokens. At 100× it is 600
instances (a board of notes and checklists) and about 1000 tokens (100 plugins × 10).

| Design | Today | 10× | 100× |
|---|---|---|---|
| A. Each kind on its own | 3 × 69 = 207 values to theme. Holds. | 3 × 150 = 450, already drifting. Holds poorly. | 3 × 1000 = 3000. Breaks: no one themes it. |
| B. One look | 69 values, written once. A theme change is 69 variables and 1 message. Holds. | 150, once. Holds. | 1000 variables, under 1 ms once. Holds. |
| C. Sandboxed widget pages | 6 × 68 MB = 408 MB. Strained. | 60 × 68 MB = 4.1 GB. Breaks. | 41 GB. Breaks. |
| D. CSS against the app | about 9 renderer commits a day, each a chance to break a theme. Strained. | same churn, 10× more themes broken by it. Breaks. | Breaks. |
| Code widget workers, today's runtime (any design) | 6 × 10 MB = 60 MB. Holds. | 600 MB. Strained. | 6 GB. Breaks. |
| …with one worker per widget kind (part of B) | ≤ 15 kinds × 10 MB = 150 MB. Holds. | ≤ 150 MB, bounded by kinds, not instances. Holds. | Same. Holds. |

Arithmetic:
- 9 commits a day is 276 ÷ 30.
- The 10 MB a worker is the node `worker_threads` measurement above; a Chromium dedicated worker
  may differ.
- The 68 MB a frame is the measurement in `plugin-runtimes-2026-09-17.md`.
- The worker rows assume every instance runs code. Draw-only widgets (notes, checklists) run
  none, which is why boards of hundreds already work.

## 5. Choice

**B**, together with one worker per widget kind.
- **A lost** because three vocabularies drift, and a theme then reaches nothing reliably.
- **C lost** on memory, already at today's count.
- **D lost** on brittleness and on spoofing.

Two things surprised me:
- **A widget's freedom does not need a frame.** The widget sizes and style properties authors
  already ask for (8 of 11 ask to be wider) are layout, not pixels, and the app can draw them.
- **The cost that does not scale is a worker per instance, not the drawing.** Sharing one worker
  per kind bounds it by the number of kinds.

### The contract, in outline

**Tokens.**
- The app's tokens are named and documented, with a version: the 69 colours plus `radius.*`,
  `font.ui`, `font.mono`, `font.display`, `motion.*` and `space.*`.
- They reach each kind the same way: as CSS variables in the app window and view frames
  (`applyThemeVars` does this for views now), and by name in widget style properties.
- A plugin manifest may add `tokens`, each with an id under its own scope (`archipelago.sea`), a
  description, and defaults for dark and light. A default is a hex value or a reference to an
  app token (`"=accent"`).

**The theme member** (`theme.json`, in a package; no code):
```jsonc
{
  "id": "@you/harbour-dusk",
  "name": "Harbour Dusk",
  "mode": "dark",
  "tokens": { "bg": "#0e1a2b", "accent": "#f5a524", "archipelago.sea": "#123a5a" },
  "fonts": { "display": "fonts/Pirata.woff2" },
  "wallpaper": { "kind": "image", "src": "wallpaper.webp" },
  "scope": "app"
}
```
- `scope` is `"app"`, or `"view:<id>"` for a look that applies only while that view is shown,
  like Home Assistant's per-dashboard themes.
- Precedence, lowest first: the app's default, the chosen theme, then the person's own overrides.
- The theme is listed in Appearance next to the built-in presets. Choosing it is the person's
  act, and choosing another undoes it.

**Widgets.**
- `widget.json` gains `sizes: ["s", "m", "l"]`: 240, 360 and 480 px wide. The person picks the
  size from the card's menu, and the widget's code reads `hive.size` and draws for it.
- Nodes gain bounded style properties: `pad`, `gap`, `align`, `radius`, `tone` (a token name),
  `bg` (a token name or one of its own images), `font` (`ui`, `mono` or `display`), and
  `size: "xs" … "xl"`.
- New nodes: `chart` (spark, bars or area, from numbers, drawn in tokens), `ring`, `badge`,
  `divider`, `icon` (the app's icon set) and `grid`.
- Motion is a property, `enter` or `pulse`. The app draws it and drops it under reduced motion.
- Colours come from tokens, never as raw hex. A widget's own look comes from its own contributed
  tokens.
- One worker per widget kind. Each instance's `hive` calls carry its instance id, and its state
  and options stay per instance, as now.

**Settings vocabulary v2** (`settings.ts`):
- New field types: `color` (a token or hex), `slider` (number with `step`), `image` (one of the
  plugin's assets, or a file the person picks), `list` (strings) and `multi` (several choices).
- Fields can be grouped into sections and shown conditionally with `showIf`.
- One renderer draws the Settings page, the widget's property menu (quick per-instance choices,
  as in Figma) and the CLI (`hive plugins set`).

**View and app layout** (from the #216 review):
- The app keeps widget cards off the live surfaces a view placed.
- `hm.setReservedRects` (capped) for a view's other panels.
- The app tells the view where its own corner controls are.

## 6. Pre-mortem

It is October 2027 and this failed. The three likeliest reasons:

1. **Themes made things unreadable, and people blamed the app.**
   - *Change:* the app checks contrast as it applies a theme. Text tokens on their background
     must reach WCAG 4.5:1; a pair that fails is corrected toward it and the theme's page says so.
   - The person's own override is never corrected.
2. **One worker per kind meant one bad instance broke all of them**, or one busy instance starved
   the rest.
   - *Change:* the shared worker keeps each instance's handlers apart, so an error in one
     instance's code removes that instance only.
   - Per-instance CPU is counted, as views' long tasks are (`LIMITS.longTaskMsPerWindow`). An
     instance over budget is moved to a worker of its own.
   - This is the known ceiling: the number of kinds × about 10 MB, plus the instances moved out.
3. **Authors still wanted pixels**: the token and node set was too small, and they left for tools
   (full power, no sandbox) or views.
   - *Change:* the node set grows from real requests, one PR each, with the widgets in
     hivemind-plugins as the test bed.
   - A widget that truly needs pixels uses `image` or `sprite` with its own art. A full custom
     surface is a view. That is a written boundary, not a gap.

## 7. Build order

Foundation first. Each step lists how it is checked.

1. **Tokens named and versioned.**
   - Name and document the app's tokens.
   - Send all of them to views (the `colors` map is most of it already).
   - Add `tokens` to every manifest kind, with defaults.
   - *Check:* a view test that reads a contributed token; a theme change updates the variables in
     the app window and the open frame.
2. **Settings vocabulary v2**: colour, slider, image, list, multi, sections and `showIf`, with one
   renderer.
   - *Check:* `settings.ts` tests for every type, the Settings page in the real app, and
     `hive plugins set` for each type.
3. **Widget sizes and style properties**, honouring `size` at last.
   - *Check:* widget runtime tests. Port two published widgets (Harbour, Ship's log) and take
     real-app screenshots at S, M and L, in light and dark.
4. **One worker per widget kind.**
   - *Check:* memory measured in the built app with 1, 10 and 50 instances of one code widget,
     before and after, both numbers in the commit. Plus a test that one instance's error removes
     that instance only.
5. **The theme member**: fonts and wallpaper as package files, contrast checking, and scope
   `app` or `view:`.
   - *Check:* install, choose, switch and remove a theme, in the CLI and the app. The contrast
     test, and a migration test for `appearance` holding a theme id.
6. **New widget nodes and motion**: chart, ring, badge, icon, grid, `enter` and `pulse`.
   - *Check:* a test per node, and a reduced-motion test.
7. **The layout contract** (#216 review, steps 2–5 there).

Steps 1 and 2 stand alone and are useful at once. Step 5 needs 1. Step 3 needs 1. Step 4 can go
at any point.

## 8. Unknown

- **What one Chromium dedicated worker costs.** Here it is estimated from node `worker_threads`.
  Measure it in the built app, using the process RSS of a window with 1, 10 and 50 code widgets.
- **Which style properties authors actually miss.** Ask in the hivemind-plugins issues, and read
  the eight widgets that ask for a width: what they would do with 360 px.
- **Whether a contrast correction keeps a theme recognisable.** Try it on three community themes,
  once one exists, and on the built-in presets.
- **The phone.** It draws its own native colours (`ViewLook.swift`, `ViewLook.kt`). Whether it
  should read themes is a separate design, since the phone has no CSS variables.
