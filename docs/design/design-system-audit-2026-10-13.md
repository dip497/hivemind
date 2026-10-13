# Design system audit — 2026-10-13

The question that started it, next to a screenshot of Settings → API access (a native `<select>`
with the operating system's blue highlight and an orange focus ring, beside a 32px input and a
28px button): *"is there no proper design system, or are components not properly managed?"*

There is a design system — `apps/desktop/DESIGN.md`, its sidecar `.impeccable/design.json`, the
tokens in `styles.css` and thirteen primitives in `components/ui/`. The components are what is not
managed: the system has no select, no type tokens, no height scale and no one place for focus, so
every surface filled the gaps by hand and the gaps drifted.

Scope: the renderer (`apps/desktop/src/renderer/src`) and the tool plugins bundled with the app
(`apps/desktop/tools`), which draw with the same classes through `@hivemind/app-ui`. Measured on
`feat/design-system` at `bbe81cd`, by grep over the sources and with the Impeccable detector.

## Audit Health Score

| # | Dimension | Score | Key Finding |
|---|-----------|-------|-------------|
| 1 | Accessibility | 2 | Three focus recipes; the default accent's ring is 2.8:1 on a selected row, under 3:1 |
| 2 | Performance | 3 | One width transition (update bar); the rest is deliberate, measured work |
| 3 | Responsive Design | 2 | Settings reflows at 800/540px; tile and row chrome is 16–20px under a phone's thumb |
| 4 | Theming | 2 | Tokens exist but 405 literal font sizes, untokened shadows and scrims, no `color-scheme` |
| 5 | Implementation Integrity | 1 | No Select: 16 native selects in 10 files take the OS look; the scale has no tokens |
| **Total** | | **10/20** | **Acceptable (significant work needed)** |

## Implementation Integrity Verdict

**Fail.** DESIGN.md describes a coherent system — six type steps, 32px controls, one accent that
is not a signal — but the code has no way to say any of it except by repeating the number:

- **No Select primitive.** 16 native `<select>` in 10 files (12 in the renderer: `settings-programs`,
  `appearance-controls`, `settings-panels`, `settings-agents`, `settings-views`,
  `plugins/SettingsForm`, `plugins/PluginsHome`, `multiplayer/share-prefs` ×4,
  `multiplayer/people-list`; 4 in `tools/issues`). A native select is drawn by Chromium with the
  operating system's colours: on Ubuntu the GTK accent (orange) as its focus ring and the system
  blue for the highlighted option. That is both colours in the person's screenshot. Each select is
  then restyled by a different rule: `settings.css` gives the ones inside a dialog 5px corners and
  6px padding, `.plugins-controls select` forces 32px, `SettingsForm` uses `rounded px-1 py-0.5`,
  `NewIssuePanel` its own `inputCls`.
- **No type tokens.** 405 `text-[Npx]` across **17 sizes** (renderer 346, tools 59), against
  DESIGN.md's six steps. Only the Layers panel and menus are held to the scale, by
  `tests/unit/type-scale.test.ts`; nothing else is.
- **No height scale.** Button has twelve sizes; `sm` (28px) is used 107 times, so a Settings row
  routinely puts a 28px button beside a 32px input — the API access row in the screenshot. `lg`
  (36px) has one caller each for `lg` and `icon-lg`; DESIGN.md has no 36px control.
- **One focus ring, three ways.** `styles.css:438` gives everything a 2px accent outline at 1px
  offset with a forced 3px radius; `settings.css:14` re-declares it at 3px offset for Settings;
  Button, Input, Switch and Textarea add a second, `box-shadow` ring in `--ring` on top (an
  unlayered `*:focus-visible` beats the layered `outline-none` utility, so both draw).

Detector (Impeccable, before): renderer **4 anti-patterns + 56 advisories**, tools **0 + 2**.

| Finding | Renderer | Tools | Verified |
|---|---|---|---|
| design-system-color (advisory) | 43 | 0 | 23 real drift; 20 are data palettes (wallpaper scenes, syntax colours) — see Theming |
| design-system-font-size (advisory) | 10 | 2 | real |
| design-system-radius (advisory) | 3 | 0 | real (`3px` ×3) |
| side-tab | 2 | 0 | `review-ui.tsx:46` real (3px amber stripe on a rounded card); `.md-preview blockquote` is a Markdown blockquote, a false positive |
| border-accent-on-rounded | 1 | 0 | `BrowserTile.tsx:304` is a tab's 2px underline, a false positive |
| layout-transition | 1 | 0 | real: `.hm-update-bar > span` animates `width` |

## Executive Summary

- Audit Health Score: **10/20** (Acceptable)
- Issues: **P0 0 · P1 4 · P2 6 · P3 3**
- Top issues:
  1. **[P1]** No Select; 16 native selects show the OS accent and highlight (the screenshot).
  2. **[P1]** Focus is drawn three ways, doubled on every primitive, and under 3:1 with the default accent.
  3. **[P1]** No type tokens: 405 literal sizes in 17 steps where DESIGN.md has six.
  4. **[P1]** Mixed control heights in one row (28px buttons beside 32px inputs and padding-sized selects).
  5. **[P2]** 184 colour literals in the sources (79 in TS/TSX, 105 in CSS, the token definitions included); shadows, scrims and selection tints have no token.
- Next: tokens (type, height, colour), a Select and one focus rule, then a guard test so it cannot drift back.

## Detailed Findings by Severity

### P1

**[P1] Native selects take the operating system's look**
- Location: the 16 selects listed above; `settings.css:46-47` restyles them
- Category: Implementation Integrity / Theming
- Impact: the open list, its highlight and the focus ring come from the OS (orange and blue on Ubuntu, other colours on macOS and Windows); the closed control is a different height, radius and padding in each place; the person reads it as "no design system".
- Standard: DESIGN.md "Inputs / Fields" (32px, control-line border, 6px corners), "Popover and menu"
- Recommendation: a `Select` in `components/ui` on Radix Select (as shadcn's), the Input's box and the dropdown menu's surface, exported to plugins through `@hivemind/app-ui`; replace all 16.
- Suggested command: /impeccable harden

**[P1] Focus has three recipes and a contrast gap**
- Location: `styles.css:438`, `settings.css:14`, `components/ui/{button,input,switch,textarea}.tsx`
- Category: Accessibility
- Impact: a keyboard user sees a different ring per surface, a double ring on primitives, and with the default Graphite accent (`#5f6b7a`) a ring at 3.5:1 on the ground but 2.8:1 on the hover and selected surface (`bg4`), under the 3:1 non-text minimum. Native controls have no `accent-color`, so checkboxes and radios outside two rules are OS blue/orange; no `color-scheme` is declared, so native scrollbars, pickers and the select popup are drawn light in the dark theme.
- Standard: WCAG 2.2 SC 2.4.7, 2.4.11, 1.4.11
- Recommendation: one `:focus-visible` rule, one `--color-focus` token (the accent lifted toward the text colour so it clears 3:1 on every surface with any accent), 2px at 2px offset; primitives drop their own rings; `accent-color` and `color-scheme` on `:root`, the scheme following the theme's mode.
- Suggested command: /impeccable harden

**[P1] Type has no tokens**
- Location: everywhere; 405 `text-[Npx]` (12px 121, 11px 116, 10px 39, 13px 30, 11.5px 31, 10.5px 25, 14px 16, 12.5px 7, 9.5px 6, 9px 2, 8.5px 2, 15px 2, 20px 2, 18px 3, 16px 1, 26px 1, 13.5px 1); CSS sets 8 sizes more by hand.
- Category: Theming / Implementation Integrity
- Impact: half-pixel sizes (10.5, 11.5, 12.5) render as neither step, so same-role text differs between surfaces; a change to the scale cannot be made in one place.
- Standard: DESIGN.md "The Five Sizes Rule"
- Recommendation: `text-title/row/body/label/count/chip` as Tailwind tokens from DESIGN.md, every literal mapped to the nearest step; tailwind-merge told they are sizes (otherwise `cn("text-label", "text-muted-foreground")` drops one as a colour clash).
- Suggested command: /impeccable typeset

**[P1] Controls in one row are three heights**
- Location: `components/ui/button.tsx` (12 sizes), 107 `size="sm"` callers, the select rules in `settings.css`
- Category: Implementation Integrity
- Impact: the API access row is a 32px input, a select sized by its padding and a 28px button; the same in People, Your devices, Plugins and Machines.
- Standard: DESIGN.md "Buttons" (32px default), "Inputs" (32px, 28px small)
- Recommendation: two height tokens — `control` 32px and `control-compact` 28px — plus the tile-chrome steps DESIGN.md names (24, 20, 16); Settings pages use `control`; `lg` (36px) goes.
- Suggested command: /impeccable polish

### P2

**[P2] Colour literals without tokens**
- Location: tile shells `shadow-[0_8px_22px_rgba(0,0,0,0.45)]` ×6 (`TerminalTile`, `EditorTile` ×2, `WorkbenchTile`, `PlanReviewTile`, `FileTreeTile`, `BrowserTile`); scrims `rgba(0,0,0,0.55)` in `.hm-modal-overlay`, `settings.css:3` and the minimap mask; island/toast/pinned/controls shadows in `styles.css` (5 recipes); CodeMirror selection and syntax colours in `EditorTile.tsx` (13); `review-ui.tsx` amber tint; `main.tsx` toast shadow; the canvas dot grid colour.
- Category: Theming
- Impact: a preset or light theme cannot reach them — a 45% black shadow and white selection tints stay as they are on a light palette.
- Recommendation: `--hm-shadow-tile`, `--hm-shadow-island`, `--color-scrim`, `--color-selection`, `--color-syntax-*`, `--color-grid-dot` as tokens; status tints from `color-mix` of the status colour.
- Data palettes that stay literal and are allow-listed by name: wallpaper scenes (`styles.css` `[data-scene]`), the sticky-note paper colours, frame colours (`frame-color.ts`), people's colours (`multiplayer/people.ts`), issue state colours (`tools/issues/StateMeta.tsx`), the QR code's black on white (scanners need it). The wallpaper previews in `appearance-controls.tsx` repeat the scene colours a second time with slightly different values (`#0a0d18` vs `#090c16`) — they should read the same `[data-scene]` variables.
- Suggested command: /impeccable colorize

**[P2] Broken or dead theme hooks**
- `plan-review/PlanReviewBody.tsx:228,255` read `--color-danger`, which no theme defines; it always falls back to `#e5484d` instead of the theme's `--color-err`.
- `settings.css:222` reads `--warn`, which does not exist (`#b7791f` always wins).
- `settings.css:230-231` key the monogram on `data-theme`, but the theme writes `data-theme-mode`, so the light monogram rule never applies.
- `theme-store.ts:153-155` writes `--radius-panel`, `--font-ui-user` and `--font-mono-user`, which nothing reads: a theme's font and radius change only what plugins see.
- Category: Theming
- Suggested command: /impeccable harden

**[P2] Radii off the scale**
- Location: `3px` in `styles.css:441` (the focus outline), `styles.css:675` (selection clip), `settings.css:122` (swatch); `5px` in 5 CSS rules and `rounded-[5px]` ×2 for controls DESIGN.md puts at 6px.
- Category: Theming
- Recommendation: radii from DESIGN.md's scale (4, 5 keycap, 6, 8, 10, 12, 14, full) as Tailwind tokens (`rounded-control`, `rounded-menu`, …).
- Suggested command: /impeccable polish

**[P2] Tab strips drawn three ways**
- Location: `plugins/PluginPage.tsx:89` (underline), `plugins/PluginsHome.tsx:47` (segmented), `workspace/add-dialog.tsx:97`
- Category: Implementation Integrity
- Recommendation: one `Tabs` primitive; not done in this pass (below).
- Suggested command: /impeccable polish

**[P2] Reduced motion kills every transition**
- Location: `styles.css` `@media (prefers-reduced-motion)` sets every animation and transition to 0.01ms.
- Category: Accessibility
- Impact: state changes that only fade (toasts already have a gentler path) snap; the blanket rule also overrides the opacity fades the file keeps elsewhere.
- Suggested command: /impeccable animate

**[P2] Small targets on the phone**
- Location: tile and row chrome uses 16–20px buttons (`micro`, `2xs`, `icon-micro`, `icon-2xs`: 75 callers); the phone browser (`docs/design/phone-browser-2026-10-03.md`) reaches the same views.
- Category: Responsive
- Suggested command: /impeccable adapt

### P3

- **[P3]** `.hm-update-bar > span` transitions `width` (layout) — `scaleX` would composite. /impeccable optimize
- **[P3]** The UI font is still bundled Geist; DESIGN.md records the move to the OS font as settled. /impeccable typeset
- **[P3]** `review-ui.tsx:46` draws a 3px amber stripe down a rounded card's left side (the side-tab tell). /impeccable quieter

## Raw `<button>` and `<input>` outside `components/ui`

Before: 55 `<button>` (renderer 50, tools 5) and 15 `<input>` (renderer 14, tools 1). The ones
that are not a button or a field are justified here; the rest move to the primitive.

| Where | What | Verdict |
|---|---|---|
| `LayersPanel.tsx` (14) | tile, frame, recent and action rows; the rail | Justified: the panel's rows are the Tile Row and Action Row signature components, not buttons |
| `TerminalTile`, `EditorTile`, `BrowserTile`, `FrameNode`, `DiffHeader`, `canvas-overlays`, `tile-fullscreen` (3), `board-objects/*` (4), `MachineChip`, `presence` | tile and canvas chrome: tab handles, title rename, fold toggles, note colours, checklist ticks | Justified: canvas internals with their own hit areas and drag rules |
| `appearance-controls` (4), `settings-profile` | swatch, wallpaper and anchor pickers (radio groups of previews) | Justified: a preview is the control |
| `components/qr-code` | the code is the button | Justified |
| `App.tsx:650` | Settings sidebar items | Justified: sidebar rows |
| `plugins/PluginPage` (3), `PluginsHome` (3), `MakePlugin`, `add-dialog` (2), `MachinesHub` (6) | tabs, links, choices | Links move to `Button variant="link"`; tabs stay until a `Tabs` primitive exists |
| `type="range"`, `type="color"`, `type="file"` (hidden) | native pickers | Justified: themed by `accent-color` and `.hm-range` |
| checkboxes (`MachinesHub`, `SettingsForm`, `settings-views` ×2) | | `SettingsForm` → `Switch`; the toolbar list keeps checkboxes, themed by `accent-color` |
| text inputs (`SettingsForm`, `GitCommitModal`, `BranchPicker`, `DiffTile`, `IssuePanel`) | | move to `Input` |
| `FrameNode`, `board-objects/TextDraft` | inline rename on the canvas | Justified: the field is the object |

## Patterns & Systemic Issues

- Every gap in the primitives was filled locally: 16 selects with 5 stylings, 17 font sizes,
  3 focus recipes, 3 tab strips. The fix is the primitive and a guard, not more local fixes.
- The only scale test (`type-scale.test.ts`) covers five files; the rest of the renderer is
  unguarded, which is why drift collected there.
- Shadows were authored per surface (seven recipes for "lifted") although DESIGN.md names four.

## Positive Findings

- The palette is a real token system: oklch throughout, presets recolour every surface through
  `--color-*`, and glass derives from the same `--surface-*` sources.
- Motion is one curve and three durations (`--hm-ease-out`, `--hm-dur-1..3`), used consistently.
- Performance work is careful and measured: per-motion compositing, stepped wallpaper drift,
  no backdrop blur behind opaque surfaces.
- `Button`, `Input`, `MenuItem`, `DropdownMenu`, `Dialog`, `Switch` already carry the system for
  most of the app, and plugins get the same kit through `@hivemind/app-ui`.

## Recommended Actions

1. **[P1] `/impeccable harden`**: a Select primitive (Radix), all 16 native selects replaced; one focus rule and token; `accent-color` and `color-scheme`.
2. **[P1] `/impeccable typeset`**: six type tokens, 405 literals mapped; tailwind-merge taught the names.
3. **[P1] `/impeccable polish`**: one control height (32px), compact 28px only in dense rows; Settings rows aligned.
4. **[P2] `/impeccable colorize`**: shadow, scrim, selection and syntax tokens; the broken theme hooks fixed.
5. **[P2] `/impeccable adapt`**: targets for the phone browser.
6. **`/impeccable polish`** last, over Settings, the panel, the toolbar, menus and dialogs.

Guard: a unit test that fails on a native `<select>`, a literal font size, a colour literal
outside the token files and allow-listed palettes, or a control height off the scale.
