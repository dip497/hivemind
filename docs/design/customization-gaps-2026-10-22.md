# Customization: what is missing, and how far a view can go — review (2026-10-22)

Status: review. Written with the `lets-build-pyramids` skill. It continues
`customization-2026-10-21.md` (branch `design/customization`) and
`docs/plans/sounds-and-themes.md`, and corrects both where the code says otherwise. Publisher
identity and licences are out of scope, by the maintainer's decision.

**Method.**
- Five readers went through the code, one per area: the look engine; terminals, tiles and the
  canvas; input, chrome and words; the plugin platform and HiveHub; and the phone, CLI, guests and
  settings state. Every gap was checked by a search for the setting that would close it.
- Three researchers looked outside: editors and terminals, theme stores that sell brand editions,
  and the standards and accessibility rules for themable UI.
- A ceiling test checked what a third-party view can do. It ran an Electron 44.5.1 harness that
  copies a view's sandbox, scheme and CSP exactly, then added one sandbox token at a time to see
  what each unlocks.
- The example views the maintainer named (a first-person office, a 3D avatar per agent) were used
  as yardsticks only. **None of them is to be built.** The question is whether anyone *could*.

## Verdict

**No, this is not the most Hivemind can be customized. Four findings set the order of work.**

1. **An older build erases a theme.**
   - Every settings write rebuilds `appearance` from the 12 keys it knows
     (`settings-schema.ts:419-450`). Two readers confirmed this with bun on a scratch file: one
     unrelated `hive config set views.defaultView` removed `accentCustom`, `theme` and `fontFaces`,
     and turned accent `custom` into `graphite`.
   - So a nightly-to-stable rollback, a `--version` install, or an older `hive` on PATH wipes an
     applied theme on its first write.
   - The plan's "nothing lost in the file" (`sounds-and-themes.md`, the T2 forward-compatibility
     note and Definition of done row 9) is wrong. This must be fixed before T2 or T3.
2. **Half of today's look settings do nothing, so the app looks more customizable than it is.**
   - **Corner radius.** It is stored and painted as `--radius-panel`, which no rule reads. Corners
     are 44 literal px values in CSS and 185 `rounded-*` classes.
   - **Fonts.** `uiFont` and `monoFont` are painted to variables nothing reads, but are sent to
     views. So 7 of 8 published views draw in `system-ui` while the app draws Geist.
   - **Light mode.** It is accepted and documented, but changes 2 CSS rules. Nine places are
     hard-coded dark.
   - **Accent.** Its label promises "Buttons, selection and focus". Buttons use the text colour,
     focus and switches use `select`, and `--color-accent` has 3 readers.
   - **Colours no setting reaches.** 24 of the 69 colour tokens are fixed literals: issue states,
     syntax, notes, unread, grid, scrim.
   - **Increased contrast.** It only acts while glass is on (`styles.css:1319`).

   A brand partner tries these knobs first. **Wire them before adding new ones.**
3. **A theme is the wrong unit for an edition.** Every store that sells brand editions treats one
   as a set of parts the person can equip one by one: Samsung Galaxy Themes, LINE, Xiaomi, KDE
   global themes, Fortnite bundles and VS Code profiles.
   - The parts are the look, icons, cursors, sounds, the background scene, a mascot, the empty,
     idle and loading screens, the words, and the view, widgets and layout the edition opens in.
   - T2 puts five of these in one `theme.json` and applies it whole, with one `before`.
   - Missing from the plan: icons, cursors, mascot, screens, words, syntax colours, a display font,
     plugin tokens, a keymap, and `startup` (which is validated today and never run).

   Two rules above the brand are also missing:
   - **Accessibility belongs to the app, above any brand.** A Ferrari red-and-green palette makes
     "done" and "failed" the same colour for about 1 in 12 men, because status is colour only.
   - **The person's own tweaks need their own layer, kept per theme**, or every theme switch loses
     them.
4. **"Any view anyone can dream up" is mostly possible now. The walls are sandbox and CSP
   choices, not the GPU.**
   - **What works already.** A view runs in its own renderer process with its own 32 WebGL
     contexts, so it never competes with the terminals' 12. WASD, gamepad, audio with no click and
     continuous rendering all work. A first-person walk up to an agent, docking its live terminal,
     already works in Archipelago's flat form.
   - **What blocks, in nine places:**
     - pointer lock;
     - element fullscreen;
     - fetching the view's own files (`connect-src 'none'`), which costs 33% in base64 and breaks
       every three.js loader;
     - the 8 MiB HiveHub cap (Archipelago already uses 68% of it);
     - live terminals drawn in perspective;
     - an agent's reply text;
     - microphone and speech;
     - free movement of other people in a shared world;
     - hiding all app chrome.

     Each is a small capability that the host mediates and the manifest declares.
   - **Electron grants every permission today.** There is no permission handler in `main/` (0
     matches), so Electron's default is to say yes; `Notification.requestPermission()` resolved
     "granted" inside a view. The first sandbox token added must ship with a handler that denies
     by default.

The insight that was not obvious: **a talking avatar does not need agent text inside the view.** The
host can speak the reply and send the view only a loudness envelope, which is enough for lip sync
(ChatVRM's method). The protocol's rule "no text an agent wrote" can stay.

## 1. Problem

**Goal.** A person, or an edition a package ships, can change everything a person sees and hears,
one part at a time, and undo any part. Accessibility, the person's own tweaks and every other part
keep working. A view author can build any world they can imagine, inside the sandbox.

**Constraints.**
- Untrusted code stays sandboxed. Themes and other parts carry no code (KDE learned this in 2024,
  when a third-party global theme ran `rm -rf`).
- Nothing new runs per event on Electron main (CLAUDE.md).
- The person decides. Agents must not change the person's look, sounds or keys.
- The renderer changes fast: 266 commits in the last 30 days
  (`git log --since="30 days ago" --oneline -- apps/desktop/src/renderer | wc -l`). So parts set
  values in named slots and never target markup.

**Numbers.**

| What | Number | Source |
|---|---|---|
| Colour tokens in the renderer's CSS | 69 | `rg -o '--color-[a-z0-9-]+:'` over the renderer CSS |
| …that `paintTheme` writes / that no setting reaches | 18 / 24 | `theme-store.ts:126-161` against the literal tokens in `styles.css` |
| Properties painted that nothing reads | 3 (`--radius-panel`, `--font-ui-user`, `--font-mono-user`) | `rg` for each name: only the write |
| Presets / of them light | 6 / 0 | `settings-schema.ts:180-207` |
| CSS rules that respond to light mode / places hard-coded dark | 2 / 9 | `rg data-theme-mode`; `rg 'themeType\|theme="dark"\|dark: true\|class="dark"\|backgroundColor'` |
| Icons, all from one module | about 100 (Hugeicons) | `components/icons.tsx` |
| Key bindings / rebindable / rows on Settings ▸ Shortcuts | 59 / 0 / 35 (copied by hand) | `shared/keymap.ts:22-78`; `settings-panels.tsx:105-178` |
| Hard-coded English strings in renderer TSX | about 1,049, in 94 of 137 files | parsed with @babel/parser: JSX text, labels, toasts |
| Package member kinds / HiveHub categories | 4 / 9 | `package-format.ts:51-56`; `category.ts:3` |
| Published views / widgets / tools; their settings; colour settings | 8 / 15 / 13; 49; 0 | the 36 manifests in hivemind-plugins |
| HiveHub caps | 2 MiB a file, 8 MiB a plugin, 200 files | `hive-hub/src/plugin-checks.ts:12-14` |
| Archipelago's size | 5,744,001 B (68% of 8 MiB); largest file 61% of 2 MiB | `du -sb` |
| A view's sandbox; permission handlers in main | `allow-scripts` only; 0 | `CommunityView.tsx:136`; `rg setPermission` |
| Preferences kept in localStorage, outside settings.json | 13 files, 54 uses | `rg -c localStorage apps/desktop/src/renderer/src` |

**Which known problems these are.**
1. **Layered configuration with precedence**: VS Code's settings layers, the CSS cascade.
2. **A loadout of typed slots**, each equipped on its own: theme stores and game lockers.
3. **Capability permissions for sandboxed code**: the browser's Permissions Policy, Android's
   permissions.

### The gap map

How to read the columns:
- **Works**: changeable today.
- **Broken**: stored or promised, but not applied.
- **Missing**: no way to change it at all.
- **Plan**: what `sounds-and-themes.md` or the 2026-10-21 design covers, and what they miss.

| Area | Works | Broken | Missing | Plan |
|---|---|---|---|---|
| **Colours** | 13 palette keys (presets, CLI, JSON); 10 accents | Accent reaches toasts, sliders and the selection clip, not controls. `--color-fg-muted` is used and never defined. Every imported look is labelled "Ubuntu" (`appearance-controls.tsx:75,87,349`). | 24 tokens no setting reaches: issue states, syntax ×7, notes ×7, unread, grid, scrim. No colour editor in the app. No custom accent. | T2: custom accent. The 24 tokens are not in T2, and the branch's `APP_COLORS` has 15. |
| **Type** | Per-tile terminal size | `uiFont` and `monoFont` are painted nowhere; views get them | Display font. UI zoom (removing the menu removed it). Line height, letter spacing, ligatures. | T1 fixes the app window only. It misses `TerminalTile.tsx:715`, `pierre-codeview.ts:35,40` and `main.tsx:43`, and it misses view frames. |
| **Shape and motion** | Glass opacity and blur | `radius` changes nothing | Density. Motion tokens (23 token uses against 40 literal durations). Shadows (8 fixed). | T2 adds `radius` and wires nothing. Motion and space tokens are not planned. |
| **Light, dark, contrast** | OS reduced motion and reduced transparency | Light mode (2 rules, 9 dark sites). Increased contrast acts only under glass. | Following the system's mode. High-contrast presets. Forced colours (0 rules). Colour-blind status. An in-app "reduce motion". | T5 audits from screenshots. Its list misses the editor, the diff tile, fullscreen chrome, the window background and toasts. |
| **Background** | 9 scenes, photo, video; overlays (a person's own art layers) | Wallpaper only draws while glass is on, and a theme cannot switch glass on | Scene colours a theme sets, pattern masks, parallax with the camera, reacting to agents, a theme's overlays | T2 wallpaper. Missing: glass, overlays, layers. |
| **Terminal** | 16 ANSI + background, foreground and cursor (Settings, CLI) | Selection is set from the CLI only. Frost half-applies until reload (`TerminalTile.tsx:360-364`). | Cursor shape, padding, bold-as-bright. Bell (nothing hears `onBell`). `minimumContrastRatio` silently changes brand ANSI colours. | T2 `terminal`, colours only |
| **Code** | Nothing | — | Syntax colours. Two highlighters show the same file in two schemes, both fixed dark. | Not planned |
| **Icons and cursors** | Agent marks, from `agent.yaml` | 14 inline SVGs bypass the icon module | Icon packs, cursor sets, presence cursor skins | Not planned |
| **Sounds** | — | The registry says "Alerts and sounds"; none exist | — | S1–S3, T4. T4 covers 3 moments; editions sell voice lines and more moments. |
| **Status signal** | A dot, a word and a pulse in the terminal header | Three surfaces disagree on exits. The slot bar cannot tell idle from exited. Two English vocabularies ("approve?" and "needs you"). | A shape per state (colour-blind, forced colours) | Not planned |
| **Words** | — | — | No i18n. About 1,049 strings, 16 inline plurals, 212 physical-direction classes. No brand words ("crew" for "agent"). | Not planned |
| **Keys and commands** | Plugin command keys, while the plugin has focus | The Shortcuts page drifts: it shows ⌘Tab, and lists ⌘\ though nothing binds it | Rebinding, package keymaps, a command palette (`cmdk` is a dependency nobody imports), showing plugin keys | Not planned |
| **Menus and toolbar** | Toolbar order, visibility and placement per view | — | Plugin toolbar buttons, context-menu items, a status bar; a native menu (it is `null`, macOS included) | "Third-party action registration … still need implementation" (`configurable-workspace-ui.md`) |
| **App identity** | — | The window background flashes `#0d0e12` | Dock or window icon, dock badge, tray, title bar colour, About | Not planned |
| **Screens** | A view draws inside its frame | — | Empty canvas, start, idle and loading art. A first-run tour. | Not planned |
| **Plugins' look** | Views get 15 colours, 6 status tones, radius, fonts and glass | Views are told fonts they cannot load (CSP `font-src` is own origin plus data:) | Tools have no token contract: 258 uses of 11 private variables. Widgets have no colour, font or spacing props. Plugin tokens exist for views only, on the branch. | Branch, and customization steps 1, 3 and 6 |
| **Package members** | Tool, widget, view, agent preset | `startup` is validated and never run. Presets are listed and never offered. review-room is refused by today's schema. | Theme, icon pack, cursors, sounds, mascot, screens, words, keymap, layout or starter board, edition | T2: theme only |
| **Scope** | One look per machine | — | A look per workspace, per view, per host or agent (context), and discreet mode | `scope: view:<id>` was designed, then dropped from T2 |
| **Sharing and sync** | Copy JSON / Import | `hive theme export` writes an absolute path, including the username | A link for colours only. Profiles. A second machine. 54 localStorage preferences that never travel. | T3 is per machine |
| **Phone** | Follows the OS mode and contrast | Its status colours are swapped (`views.ts:85`). Views there get no settings. Three terminal palettes. | Any desktop look, accent or theme. The phone-look design says "never on chrome". | Out of scope by decision |
| **Guests** | The host's look as values | Edits a guest makes are saved and not shown, with no notice. `sharedAppearance` spreads the remaining keys. | Keeping your own look as a guest. Presence cosmetics. | T3 note only |

## 2. What others do

Editors and terminals:
- **VS Code, colour, file-icon and product-icon themes, and `colorCustomizations` per theme**
  ([themes](https://code.visualstudio.com/docs/configure/themes),
  [product icons](https://github.com/microsoft/vscode-docs/blob/main/api/extension-guides/product-icon-theme.md)).
  Icons are their own theme, keyed by the app's icon names and tinted by the colour theme. The
  person's tweaks live in their own layer keyed by theme name, so switching themes loses nothing.
  The high-contrast theme replaces the brand theme; it does not patch it.
- **VS Code Profiles** ([docs](https://github.com/microsoft/vscode-docs/blob/main/docs/configure/profiles.md)).
  A profile is a look plus extensions, layout and keys, applied per window or folder. Exports
  drop machine paths. This is what an edition is.
- **Zed themes** ([docs](https://github.com/zed-industries/zed/blob/main/docs/src/themes.md)).
  A `{mode, light, dark}` selector follows the system. Collaborator colours (`players`) belong to
  the theme. Overrides are keyed by theme, and the format is versioned (it was renamed once).
- **JetBrains themes and Islands**
  ([expUI theme](https://github.com/JetBrains/intellij-community/blob/master/platform/platform-resources/src/themes/expUI/expUI_dark.theme.json)).
  Named palette colours feed semantic keys, and `parentTheme` lets a theme set only what differs.
  When the chrome was redesigned, inheriting themes survived and flat ones had to be redone.
- **Ghostty** ([config](https://github.com/ghostty-org/ghostty/blob/main/src/config/Config.zig)).
  Custom shaders give retro editions their character. An invalid shader can turn the window
  black, and a background image is duplicated in VRAM per terminal. So effects need to be built
  in, capped and recoverable.
- **WezTerm backgrounds**
  ([docs](https://github.com/wezterm/wezterm/blob/main/docs/config/lua/config/background.md)).
  Layered images with parallax, mirrored tiling and per-layer dimming. A brand scene that moves
  slower than the tiles as you pan is a compositor transform, so it is cheap.
- **Warp themes and brand editions** ([repo](https://github.com/warpdotdev/themes)). A developer
  tool shipped brand collaborations as values plus one image: a gradient accent, art and ANSI
  colours. It can also make a theme from an image.
- **iTerm2 automatic profile switching**
  ([docs](https://github.com/gnachman/iterm2-website/blob/master/source/_includes/3.5/documentation-automatic-profile-switching.md)).
  Looks that switch by host, path or job are the most practically useful kind (production in
  red). Rules need deterministic scoring.
- **Obsidian Style Settings** ([plugin](https://github.com/mgmeyers/obsidian-style-settings)).
  Themes declare their own options. Obsidian's guidelines name selectors broken by app updates as
  the most common theme problem.
- **Raycast and Slack** ([Raycast](https://manual.raycast.com/custom-themes)). A look small
  enough to fit in a URL or a string spreads through chat.

Stores that sell brand editions:
- **Samsung Galaxy Themes**
  ([support](https://www.samsung.com/ca/support/apps-services/what-changes-are-applied-with-galaxy-themes/)).
  A theme is wallpaper, icons, always-on display, keyboard and sounds, and each can be applied on
  its own. Third-party icons the pack cannot redraw get a tinted tray.
- **LINE theme shop** ([guidelines](https://creator.line.me/en/guideline/theme/)). Official
  character themes. Slots have exact sizes, and live signals sit at fixed spots that art is
  designed around. Palette swaps of an existing theme are refused as duplicates.
- **Xiaomi themes** ([guide](https://androidauthority.com/miui-themes-guide-xiaomi-885210)).
  A picker per part, filled from every installed theme, plus "save this mix as my look".
- **KDE Plasma global themes** ([docs](https://develop.kde.org/docs/plasma/)). A manifest points
  at parts that also stand alone, with one preview per part. Two cautions: a third-party theme ran
  arbitrary code in 2024, and "use layout from theme" wiped people's panels.
- **Discord, Steam and Fortnite**
  ([Discord](https://support.discord.com/hc/articles/17162747936663),
  [Steam](https://partner.steamgames.com/doc/marketing/pointsshopitems)).
  The cosmetics people value most are the ones others see: avatar frames, name styles, profile
  backgrounds. Every animated asset ships with a still, and every slot has a size and duration
  cap. Loadouts let a person mix parts from several editions.
- **Doki Theme and AMII** ([repo](https://github.com/doki-theme/doki-theme-jetbrains)). The
  closest evidence for an anime edition of a developer tool: a mascot sticker that reacts to
  builds and tests, empty-editor art, and a one-switch discreet mode. With no slots in the host,
  they patch VS Code's CSS and break on every update.
- **Winamp Skin Museum** ([webamp](https://github.com/captbaritone/webamp)). Fixed named slots
  with a fallback per file kept 25-year-old skins working. Previews rendered by the host scale
  review.
- **Wallpaper Engine** ([docs](https://docs.wallpaperengine.io/en/web/customization/properties.html)).
  An interactive wallpaper is a sandboxed page fed by properties and events. The host owns
  playback: it pauses when covered and caps the frame rate.

Standards and accessibility:
- **W3C Design Tokens 2025.10**
  ([format](https://www.w3.org/community/reports/design-tokens/CG-FINAL-format-20251028/)).
  Accept DTCG colour objects and `{alias}` syntax at the edges, so Figma exports paste in. Keep
  `theme.json` as the stored format.
- **Material 3 dynamic colour**
  ([material-color-utilities](https://github.com/material-foundation/material-color-utilities)).
  A brand brings one hero colour. A full palette generated from it passes contrast by
  construction, so the contrast check no longer refuses a theme. The same code can take the seed
  from a wallpaper image.
- **GitHub Primer** ([primitives](https://github.com/primer/primitives)). The colour-blind and
  high-contrast variants are layers the design-system team owns, not the brand theme.
- **Firefox JSON design tokens**
  ([docs](https://firefox-source-docs.mozilla.org/toolkit/themes/shared/design-system/docs/README.json-design-tokens.stories.html)).
  Every token has `prefersContrast` and `forcedColors` values, so plugin colours degrade correctly
  in Windows high contrast without their authors testing it.
- **WCAG 2.2 and APCA**
  ([1.4.3](https://raw.githubusercontent.com/w3c/wcag/main/understanding/20/contrast-minimum.html)).
  Gate on WCAG 2.2. Use APCA only as advice, because WCAG 2 overstates how readable dark pairs
  are. Check focus rings, borders, status colours and faint text, not only text on background.
- **Electron `nativeTheme`**
  ([docs](https://github.com/electron/electron/blob/main/docs/api/native-theme.md)).
  `themeSource` decides native menus, scrollbars and every view's `prefers-color-scheme`. Main
  never sets it.
- **xterm.js `ITheme`** ([typings](https://github.com/xtermjs/xterm.js/blob/master/typings/xterm.d.ts)).
  `minimumContrastRatio` measures against `theme.background`, so it cannot see a wallpaper behind
  a transparent terminal.
- **VS Code issue 22900** ([issue](https://github.com/microsoft/vscode/issues/22900)). An infinite
  CSS keyframe animation, even a blinking cursor, ran full frames and cost 13% CPU while idle.

People who build agents as characters and 3D spaces:
- **Pixel Agents** ([repo](https://github.com/pablodelucca/pixel-agents), 9.8k stars). Claude
  Code agents as pixel characters in an office, driven by hooks. The signal Hivemind's views
  already receive is the same.
- **ChatVRM lip sync**
  ([lipSync.ts](https://github.com/pixiv/ChatVRM/blob/main/src/features/lipSync/lipSync.ts)).
  Mouth movement from the audio's loudness alone. **Three-vrm and VRM 1.0**
  ([three-vrm](https://github.com/pixiv/three-vrm)) are the durable open path for avatars.
  Hosted avatar services are retreating:
  - Ready Player Me ended its public service in January 2026
    ([report](https://www.pocketgamer.biz/netflix-acquires-avatar-creation-platform-ready-player-me));
  - Meta Horizon Workrooms closed in February 2026
    ([notice](https://www.meta.com/en-gb/help/quest/2464765133873078/));
  - Spatial ended creator hosting in July 2026
    ([report](https://uploadvr.com/spatial-is-discontinuing-its-creator-platform-in-july/)).

  So a view should depend on local files.
- **WorkAdventure** ([energy](https://workadventu.re/article/measuring-energy-cost-of-animations/)).
  Map animations took a laptop from 7.5 W to 9.8 W. Continuous rendering needs a budget the host
  enforces.

## 3. From every side

| View | What worries them |
|---|---|
| Person | Undo must be per part and one step. A brand must never make text unreadable or hide which agent needs them. Their own tweaks must survive a theme switch or update. Discreet mode must be one switch at work. |
| Data | Every look lives in settings.json, which today drops unknown keys and never reads its `v`. Parts copied on apply live in the media folder, named by digest. Overrides keyed by theme need a numbered migration. 54 localStorage preferences never travel. |
| Operator at 3am | A bad part must fall back per slot, with a notice, and never brick the app: a safe-mode start skips all parts. Report every key a part has that the app does not use (KDE's splash key was silently ignored). Previews the host renders in CI catch a slot a renderer change broke. |
| Security | Parts carry no code. SVG icons are sanitised and drawn as masks. No remote URLs in any part. Agents cannot apply looks: today only `plugins.*` is person-only (`config.ts:51`). For views, every new capability needs a deny-by-default permission handler, because Electron grants everything today. |
| Cost | The look is resolved once per change, never per event. Animated parts (mascot, scene, video) need a still, pause rules, a frame cap and real-GPU numbers. `backgroundThrottling: false` means `document.hidden` never flips, so pausing must use focus, idle and battery. |
| Next year | (1) Brand editions with views, widgets and art. (2) Japanese and other languages for those editions. (3) Teams sharing a look per workspace, with cosmetics others see. All three need parts, layers and words, not a bigger `theme.json`. |

## 4. Options

### 4a. How looks are put together

**A. Grow `theme.json` (the plan today, extended).** One file inlines every part and is copied
into `appearance` on apply, with one `before`.

```
theme.json (palette, accent, terminal, fonts, wallpaper, sounds, + icons, cursors, mascot, …)
   │ apply = copy all into appearance, keep one `before`
   ▼
appearance ── paintTheme ── app, views, guests
```

Where it breaks:
- Mixing parts from two editions is impossible.
- The person's tweaks are lost on switch or update.
- Every theme must author its own high-contrast and colour-blind variants, which most will not do.

**B. A look stack of parts, with editions as references (recommended).** Each part is its own
member and can be equipped alone. One owner resolves the layers into values.

```
 layer 6  discreet mode ─────────────── hides art, keeps colours (person)
 layer 5  access (app-owned) ────────── high contrast · vision · forced colours · motion · contrast floor
 layer 4  person's overrides ────────── keyed by part and theme id
 layer 3  workspace look (later) ────── kept in the person's data, never in .hivemind/
 layer 2  equipped parts ────────────── look · type · icons · cursors · sounds · scene · mascot · screens · words
 layer 1  app defaults (presets)
           │ resolveLook(): pure, in hive-core, on change only, same object if nothing changed
           ▼
   app window (CSS vars, nativeTheme, window bg) · views (ViewTheme + a11y + tokens) ·
   guests (an allow-list of values) · phones (values over the connection)

 edition member ── references parts + startup {view, widgets, layout as a new workspace, keymap}
```

Where it breaks: a part can only fill slots the app defines. A look that needs a new shape is still
a view's job inside its frame.

**C. Skin pages.** A package ships a sandboxed page that draws the app's chrome, as Wallpaper
Engine does for wallpapers.

```
edition ── skin page (iframe) ── draws toolbar, panels, backgrounds ── host composites it
```

Where it breaks:
- Memory: about 68 MB a frame (`plugin-runtimes-2026-09-17.md`).
- Contrast and focus inside a page cannot be checked.
- The page can draw a fake "Allow" button.
- It breaks with every chrome change.

**D. Theme CSS against the app's markup** was rejected on 2026-10-21 and stays rejected. Obsidian,
Doki Theme and KDE all show selectors breaking on each update, and KDE shows code in themes
destroying data.

**Scale.**
- Load: published themes or editions on HiveHub. Today 0 (6 built-in presets); 10× is 60; 100× is
  600.
- Slots a full edition fills: about 205 = 69 colours + about 100 icons + 8 cursors + 10 sound
  moments + 3 screens + 3 fonts + 4 background layers + 6 mascot states.

| Design | Today | 10× (60) | 100× (600) |
|---|---|---|---|
| A. Grow theme.json | 6 presets. Holds, but each needs 4 colour variants to be accessible: 69 × 4 = 276 colour values. | 60 × (276 + 136) = 24,720 values authored and reviewed, most without variants. Strained. | 247,200. Breaks: nobody reviews it, and each renderer change can orphan 600 themes. |
| B. Look stack and parts | Access layers authored once by the app: 2 high-contrast presets × 69 + 3 vision overlays × 6 = 156 values, total. A brand sets a seed or 13 keys plus the parts it wants. Holds. | Same 156; parts shared across editions. Resolving is 6 layers × 205 slots ≈ 1,230 copies per change. Holds. | Same. Previews rendered by the host catch broken slots in CI. Holds. |
| C. Skin pages | 1 window × 68 MB. Strained (memory; no contrast checks). | 3 windows × 68 MB = 204 MB per edition shown. Breaks on trust: any page can draw a fake dialog. | Breaks. |

Arithmetic:
- **A, per theme:** 136 = 205 − 69 non-colour slots. 60 × 412 = 24,720, and 600 × 412 = 247,200.
- **B, access layers:** 156 = 138 + 18.
- **B, resolve cost:** 1,230 property copies is an estimate. Step 3 of the build order measures it
  and puts the number in the commit.
- **C:** 68 MB is the measured cost of a frame.

### 4b. How a view gets more power

**V1. Open the sandbox.** Add `allow-same-origin`, `allow=microphone`, `connect-src *` and the
rest, so a view becomes a web app. Where it breaks:
- The host's handshake relies on the frame's origin being opaque (`CommunityView.tsx:65`).
- A view could read the microphone and send anything anywhere.

**V2. Capabilities the host mediates (recommended).** The manifest declares
`capabilities: [...]`. The install review shows them, and the person can revoke any of them. The
host does the dangerous part itself and hands the view the result.

```
view ─ request ─▶ host (permission handler, deny by default) ─▶ does it: fullscreen, listen, speak,
     ◀─ result ──                                                 fetch own files, relay presence
```

Where it breaks: each capability is a protocol change. That is slower than V1, but each one is
small.

**V3. Trusted views.** A view that needs full power runs as a tool plugin, as in-app React with no
sandbox. Where it breaks: one bad plugin gets the app, the disk and every terminal's text.

**Scale.**
- Load: views installed. Today 8; 10× is 80; 100× is 800.
- People in one shared world. Today 3; 10× is 30; 100× is 300.

| Design | Today | 10× | 100× |
|---|---|---|---|
| V1. Open the sandbox | 8 views can each record the room and send it anywhere. Breaks on trust from day one. | 80. Breaks. | 800. Breaks. |
| V2. Host-mediated capabilities | Package: 8 MiB cap, Archipelago at 68% → asset packs needed. Presence state at 1 KB × 10 Hz: each peer receives 2 × 10 KB/s = 20 KB/s. Holds. | 29 × 10 KB/s = 290 KB/s per peer. Holds. | 299 × 10 KB/s ≈ 3 MB/s per peer. Breaks → send only the nearest 20 peers: 200 KB/s. |
| V3. Trusted views | No sandbox memory (in-process), but full access for every view. Breaks on trust. | Breaks. | Breaks. |

Arithmetic:
- **Presence per peer:** (N − 1) peers × 1 KB × 10 Hz.
- **Rate:** the multiplayer design already sends presence through a 50 ms throttle
  (`multiplayer-2026-09-28.md:726`). That is a ceiling of 20 Hz; 10 Hz is assumed here.
- **Package size:** Archipelago is 5,744,001 B against the 8 MiB (8,388,608 B) cap.

## 5. Choice

**B for looks and V2 for views.**
- **A lost** because it makes every brand author also an accessibility author and a merge
  engineer, and nobody can mix parts.
- **C lost** on memory and trust.
- **V1 lost** on trust at today's count.
- **V3 lost** because it removes the sandbox.

What was surprising:
1. **The bugs are in the foundations, not the features.** Settings drop unknown keys, notifications
   live in a different settings.json on macOS, Windows and dev runs, and several look settings were
   never wired. Building T2 on top would have shipped themes that an older `hive` erases.
2. **Most of the "wildest" views already work.** WebGL runs out of process with its own context
   cap, keys reach a focused view, audio plays without a click and gamepads are allowed. The walls
   are CSP and sandbox lines that were drawn for safety and never revisited for 3D.
3. **The protocol's privacy rule and a talking avatar fit together.** The host speaks, and the view
   only sees loudness.

### The look stack, in outline

**One owner.** `resolveLook(defaults, parts, workspace, overrides, access, discreet)` lives in
hive-core with no DOM. It runs only when an input changes, and gives back the same object when
nothing changed. Its result:
- paints the app window and sets `nativeTheme.themeSource` and the window background;
- is sent to views as `ViewTheme`, plus `a11y` (contrast, forced, reduced motion, reduced
  transparency, vision) and the plugin tokens;
- is sent to guests through an allow-list (not a spread);
- is sent to phones as values.

**Parts.** Each part is a package member of its own, or a section of a `theme` member, with fixed
slots, caps and a fallback per slot. Format v1 carries a `format` number.

| Part | Slots | Notes |
|---|---|---|
| Look | 13 palette keys or a `seed` (Material HCT), the accent (any colour), status, people and frame colours, note colours, plugin tokens (`archipelago.sea`), syntax (a TextMate theme read by Shiki, mapped for CodeMirror), shadows, radius scale, motion, density | Contrast is checked on every pair that matters: text, faint text, borders, focus, status and brand-as-caret. A whole group must be set together (osu! rule). |
| Type | UI, mono and display faces (woff2, `unicode-range`, metric overrides), line height, terminal cursor shape | Japanese faces are sliced by range. Fonts reach views as bytes in the theme message. |
| Icons | A map from the app's icon names to single-colour SVG paths | Sanitised and drawn as masks in `currentColor`. Security icons (lock, warning) cannot be replaced. Plugin icons get a tinted tray. |
| Cursors | Pointer, grab, grabbing, resize, crosshair, presence cursor | 32–48 px with a hotspot. Terminals and editors keep the I-beam. |
| Sounds | Named moments with prefix fallback (`agent-done-tests` → `agent-done`), voice lines | S1's pacer stays the only gate. Voice lines are off by default. |
| Scene | Up to 4 layers: gradient, pattern mask tinted by tokens, image, video; parallax with the camera | Every layer ships with a still. It pauses on blur, idle and battery. No infinite CSS keyframes. |
| Mascot | One image per agent state plus a still, in a corner and on the empty canvas | It reacts to status-bucket changes only, at most every few hundred ms. Clicks pass through it. |
| Screens | Empty canvas, start, idle and loading art | "Needs you" always breaks through. Loading art never delays readiness. |
| Words | A `locale` (ICU JSON) and a short brand glossary ("crew" for "agent") | Needs the string owner (build step 9). |
| Credit | The artist's or brand's mark and text | Drawn by the app in a fixed spot, so it cannot pass for app UI. |
| Variants | The part's own settings (settings v2): an alternate wallpaper, pose or accent | Values only. |

**Edition member.** It holds references to parts plus `startup` {view, widgets, layout,
keymap layer, agent presets}. Applying one:
- shows a review list;
- opens the layout as a **new** workspace, never over the current one (KDE's lesson);
- can be undone as one step;
- equips each part, which can still be swapped one by one.

**Sharing.** A colour-only look travels as a link or a short string. It is checked like
`theme.json` and applied with Revert. Anything with files travels as a package.

### View capabilities, in outline

| Capability | Today | Unlock (host-mediated) | Risk |
|---|---|---|---|
| Fetch own files | Blocked (`connect-src 'none'`) | `connect-src 'self' hm-view:`, the view's own package only | Low: those files already load as script and images |
| Big assets | 8 MiB HiveHub cap | Asset packs: a separate member with a larger cap, stored once by digest | Disk and bandwidth |
| Pointer lock | Blocked (measured SecurityError) | `allow-pointer-lock` behind the capability, plus the permission handler | Low: Esc releases the lock in Chromium (check it in Electron) |
| Fullscreen | Blocked | A host command `setFullscreen` (the window, not the element, so terminal slots keep working) | Low |
| Hide all chrome | Partly (corner controls stay) | `chrome: "none"` with a hover handle the host draws to come back | Low |
| Terminal in perspective | Blocked (axis-aligned rects only) | An optional `matrix3d` and clip polygon on `SurfaceRect`, with fixed size (no pty refit) and the bar required | Medium: legibility and spoofing |
| Agent replies | Blocked by design | A host `speak(tileId)` that sends a loudness envelope only, or a separate `replies` permission with its own install wording | Medium (the replies permission) |
| Voice input | Blocked (opaque origin) | Host push-to-talk with speech-to-text in the host, feeding the existing confirm-each-prompt flow | High: room audio, so a visible indicator |
| Shared world | Partly (presence is a tile id) | A per-participant state blob, capped at 1 KB, on the existing presence channel | Low to medium |
| Suggest a theme or add a widget | Partly | `suggestTheme` and `addWidget`, each confirmed by the person | Low |
| Continuous rendering | Works, but the watchdog misses GPU work | Declare `animates {maxFps}`; the host pauses it when hidden and counts GPU time too | Low |
| VR (WebXR) | Blocked: Electron is built without OpenXR | No Electron path; only the browser app in a headset browser | Not planned |

## 6. Pre-mortem

It is October 2027, and this failed. The three likeliest reasons:

1. **Editions broke on every release, and authors gave up.** The renderer changes 266 times a
   month.
   - *Change:* slots are few and named, and versioned with `format`.
   - Colours are tokens and tints, not pixel-fitted art.
   - HiveHub and CI render every part on the six required screens (canvas, terminal, Settings, the
     Add menu, a widget card, the empty canvas) with the real renderer. A broken slot fails CI, not
     a fan's screen.
2. **A brand made the app unusable for someone, and the app took the blame.**
   - *Change:* access layers sit above every part and are owned by the app. In forced colours the
     brand is bypassed.
   - Status carries a shape as well as a colour.
   - A seed palette passes contrast by construction.
   - Discreet mode and safe mode are one switch each.
3. **A view capability was abused, or drained batteries.**
   - *Change:* the deny-by-default permission handler ships first.
   - Every capability is shown at install, can be revoked and has a visible indicator (listening).
   - Continuous rendering pauses when hidden and counts GPU time.
   - The written ceiling: presence beyond 20 nearby peers needs interest management.

A fourth, likely enough to plan for: **words never happened**, because externalising about 1,049
strings is the largest retrofit here. *Change:* make one owner for words now, add a pseudo-locale
e2e that fails on new inline strings, and move strings area by area.

## 7. Build order

Foundation first. Each step lists its check. Rounds land as one PR each (CLAUDE.md).

**Round 0. Fix now: small, independent bugs** (see Appendix A). Each has a test shown failing
first.

**Round 1. Foundation.**
1. **Settings keep what they do not know.**
   - `mergeSettings` and `mergeAppearance` keep unknown keys in every section.
   - The settings file's `v` is read, and a newer one is not overwritten blindly.
   - Notifications move into the one settings.json.
   - *Check:* a test where a writer built with the old schema leaves `accentCustom`, `theme` and
     `fontFaces` untouched. A migration test for the notifications move, killed at 20 points.
2. **Wire the knobs that exist.**
   - radius (bind `--radius` and the `rounded-*` scale);
   - fonts (T1, plus the four missed sites, plus views);
   - what the accent colours;
   - the 9 dark sites and the toaster;
   - increased contrast without glass;
   - Frost without reload;
   - the "Ubuntu" fallback;
   - the 24 unreachable tokens.

   *Check:* a computed-style test per knob. Real-app screenshots before and after.
3. **The look stack owner.**
   - `resolveLook`, `appearance.follow` {scheme, accent, contrast}, `nativeTheme.themeSource` and
     the window background.
   - The person's overrides keyed by theme, which needs a migration.
   - *Check:* resolve tests (same object when nothing changed). Its cost is measured and stated.
     An e2e test that switches system mode.
4. **Access layers.**
   - Two high-contrast presets and a vision overlay.
   - Forced-colours rules and a status shape per state.
   - `a11y` in `ViewTheme` (protocol minor).
   - *Check:* screenshot matrix (normal, high contrast, forced colours, deuteranopia) on the six
     screens.

**Round 2. Parts** (replaces T2 and T3).

5. **Theme format v1 as parts.** It covers the look with `seed` and syntax, type, icons, cursors,
   sounds by name, scene, mascot, screens, credit and variants, each with caps and a per-slot
   fallback. *Check:* the format tests; every unused key is reported.
6. **Apply by part.**
   - Per-part revert and saved looks.
   - Try it on: the theme applies until Keep, and reverts by itself after 30 s.
   - A colour-only link.
   - *Check:* an e2e that applies parts from two themes, reverts one, and survives a theme update.

**Round 3. Editions.**

7. **The edition member and `startup`.** A review list, a new workspace, and undo in one step.
   *Check:* installing Archipelago opens its view.
8. **Keys and commands.**
   - Keymap layers (defaults, packages, person), with `-action` rules to remove a binding.
   - A Shortcuts page generated from `KEYMAP`.
   - A command palette that lists plugin commands.
   - Toolbar and context-menu contribution points.
   - *Check:* conflict tests. Terminal keys cannot be taken.
9. **HiveHub listings.** A package's description, icon and previews rendered by the host. Install
   counts kept. *Check:* the hub index tests.

**Round 4. Views** (protocol 1.17 onward; each capability is its own minor).

10. The permission handler (it may land in Round 0), own-file fetch, asset packs, pointer lock,
    host fullscreen, `chrome: "none"`, `suggestTheme` and `addWidget`, `animates`, presence
    state, perspective surfaces, then `speak`, `replies` and `listen`.

    *Check:* the ceiling harness becomes a conformance test. Each capability is shown failing
    without the grant and passing with it.

**Round 5. Words.**

11. One owner for words, the pseudo-locale e2e, one status vocabulary, the locale member and the
    glossary. *Check:* the pseudo-locale pass on the six screens.

**Round 6. Beyond the desktop window.**

12. Look values to phones over the connection, presets generated for desktop and phone from one
    token source, a dock badge, a tray, the app icon, looks per workspace and context rules.
    *Check:* phone screenshots with a theme applied.

Sounds S1 and S2 stay as planned, after Round 1 step 1 moves the notifications file.

## 8. Unknown

| What | How to check |
|---|---|
| Whether the view forms really fail to submit in the app (measured in the harness only) | Press Enter in Archipelago's "Give it work" box in the built app |
| Whether ⌘C and ⌘V work in text fields on macOS with the menu set to `null` | Try it on the arm64 build |
| Whether widget command keys bind for the whole app (read from the code, not run) | A widget that declares a key, pressed inside a terminal |
| The cost of resolving and painting the look stack, and of an animated scene or mascot at 50 tiles | Measure on a real GPU, as CLAUDE.md requires |
| Whether a seed palette keeps a brand recognisable | Try Ferrari red, Straw Hat yellow and Naruto orange with HCT |
| VRM avatar sizes | Measure three VRoid exports against the 8 MiB cap |
| Whether font bytes sent in a message load inside a view frame without a CSP change | A view test with `new FontFace(name, bytes)` |
| Whether Esc releases pointer lock inside Electron; WebGPU on a real GPU; platform speech voices | The harness on a real macOS and Windows machine |
| Why a view's icon is nulled in its HiveHub listing | The HiveHub server repo, which is not in this checkout |

## Appendix A. Found along the way

Bugs and broken promises, each with its evidence. Every row was found by one reader and checked
against the code. The rows marked ✓ were also re-checked for this review.

| # | What | Evidence |
|---|---|---|
| 1 ✓ | An older build's write erases an applied theme (unknown appearance keys dropped; `custom` accent turned into `graphite`) | `settings-schema.ts:419-450`; tested with bun |
| 2 ✓ | Electron grants every permission: no handler is set in main | `rg setPermission apps/desktop/src/main` → 0 |
| 3 ✓ | Agents can change the look, the profile and app behaviour: only `plugins.*` is person-only, and the guide tells agents to run `hive theme use` | `apps/cli/src/commands/config.ts:51`; `guide/(use)/appearance.mdx:9-18` |
| 4 ✓ | Notification settings live in `userData/settings.json`, a different file from everything else on macOS, Windows and dev runs. `hive config get notifications` → NOT_FOUND, and `set` exits 0 having written nothing. | `notification-settings-store.ts:26-28` against `settings.ts:32-36` |
| 5 ✓ | The "Give it work" box in Archipelago, Island and Agents by state does not submit: no `allow-forms`, so the submit event never fires (measured in the harness) | `archipelago/src/main.ts:477`; `island/src/main.ts:462`; `agents-by-state/index.js:114` |
| 6 | `hive theme export` writes the wallpaper as an absolute path including the username, into a file the guide says to share | `apps/cli/src/commands/config.ts:93-116` |
| 7 | `sharedAppearance` spreads the remaining keys, so future `fontFaces` and `theme.before` (a disk path) would reach guests | `settings-schema.ts:457-467` |
| 8 | Widget `hive.notify` ignores the master switch, Do Not Disturb and OS pop-ups, with no rate limit; 8 of 15 widgets use it | `widget-runtime.ts:322` |
| 9 | The long-task watchdog cannot fire for a view (it runs out of process); only the 60% CPU check acts, and GPU work is invisible to it | `CommunityView.tsx:70-84`; harness: 0 entries for a 400 ms loop |
| 10 | Settings ▸ Shortcuts is a hand copy: it shows ⌘Tab (the keymap binds Ctrl+Tab), and Settings ▸ Agents names ⌘\, which nothing binds | `settings-panels.tsx:114`; `keymap.ts:31`; `settings-agents.tsx:98` |
| 11 | 11 Mac-only "⌘" hints show on Linux and Windows; Recent shows "Ctrl O" on a Mac | `standard-toolbar.tsx:92`; `RecentProjects.tsx:104` |
| 12 | Every look that is not a built-in preset is labelled and reset as "Ubuntu" | `appearance-controls.tsx:75,87,349` |
| 13 | Arrow `color` is stored and never drawn; a widget `tint` outside the 6 note names draws an unreadable card | `Arrows.tsx:68-72`; `widget-format.ts:118-121` |
| 14 | Frost tool content half-applies until reload; the minimap choice resets on remount | `TerminalTile.tsx:360-364`; `CanvasView.tsx:224` |
| 15 | Three surfaces disagree about an exited agent; the slot bar cannot tell idle from exited | `FrameNode.tsx:235-237`; `slot-chrome.tsx:21-24` |
| 16 | The phone page swaps status colours for views (working green, done in the text colour) | `crates/hive-web/www/app/views.ts:85` |
| 17 | Views on a phone or remote screen get no settings (`hello` has none) | `packages/host/src/views.ts:258-263` |
| 18 | A package's `startup` is validated and never run; agent presets are listed and never offered; review-room is refused by today's schema | `packages.ts:194-201`; `package-format.ts` |
| 19 | HiveHub: install counts are dropped from the index (the search tiebreak is always 0); every package is "other: A package of N"; a view's icon is nulled | `index-format.ts`; `plugin-checks.ts:168,290-293` |
| 20 | Tool plugins are served images and fonts, but the app's CSP allows `hm-plugin:` in `script-src` only | `tool-packages.ts:37-40`; `renderer/index.html:14` |
| 21 | Three different package caps: 2/8 MiB (HiveHub), 20/50 MiB (download), 16/128 MB (local) | `plugin-checks.ts:12-14`; `plugin-catalog.ts:15-16`; `packages.ts:15` |
| 22 | The terminal bell does nothing: nothing listens to `onBell` | `TerminalTile.tsx` |
| 23 | Views and the app show the same tile name built from an agent-set title, which contradicts the view skill's "never sees a title the agent wrote" | `Workspace.tsx:646`; `.claude/skills/hivemind-custom-view/SKILL.md` |
| 24 | A guest's Appearance edits are saved and not shown, with no notice | `theme-store.ts:37,165-171` |
| 25 | `--color-fg-muted` is used and never defined; `--color-brand-hover`, `--hm-ease-in` and `--hm-ring-strong` are never read; the view theme observer watches a `data-theme` attribute nothing writes | `PromptDialog.tsx:19`; `plugin-link.tsx:294` |

## Appendix B. The view ceiling, measured

These were measured in an Electron 44.5.1 harness under xvfb that copies the app's view sandbox,
the `hm-view` scheme privileges and the exact view CSP. Absolute frame rates under xvfb are not
valid (CLAUDE.md); these rows are about what is allowed, not how fast it runs.

| Need | Today | Measured |
|---|---|---|
| WASD, Escape and digits reach a focused view | Works | Keys reach the frame and the host sees none. Main still takes Mod+Q, F11, Mod+1–9 and the other "anywhere" keys first. |
| WebGL | Works | The frame has its own renderer process, so its 32 contexts do not count against the terminals' 12. 30 host + 30 view contexts, none lost. |
| Audio without a click | Works | `AudioContext` starts `running`, and `<audio>.play()` resolves. |
| Gamepad | Works by policy | `allowsFeature('gamepad')` is true. Not tried with a physical pad. |
| Continuous rendering | Works | `framesDrawn` is ignored, and the 60% CPU check is the only guard. |
| Walk up and type into an agent's terminal (flat) | Works | Archipelago docks a live surface on E. |
| Pointer lock | Blocked | SecurityError; with `allow-pointer-lock` it locks. |
| Fullscreen | Blocked | "Disallowed by permissions policy"; with `allow=fullscreen` it works. |
| Forms | Blocked | The submit event never fires without `allow-forms`. |
| Fetch the view's own files | Blocked | `fetch`, XHR, `data:` and `blob:` are all refused. Workers from files throw. |
| Storage | Blocked | localStorage, IndexedDB, Cache Storage and cookies throw. Only `setLayout` (64 KiB) persists. |
| Microphone | Blocked | Even with `allow=microphone`: "Invalid security origin" (the origin is opaque). |
| Clipboard, downloads, pop-ups, `alert` | Blocked | All refused, on purpose (view protocol 1.3 §8). |
| Screen wake lock | Blocked | It works with `allow="screen-wake-lock"`. |
| WebXR | Blocked | With `allow="xr-spatial-tracking"`, immersive-vr is unsupported: no OpenXR in this Electron build. |
| Agent replies, terminal text | Blocked by design | Status words, counts and ids only (`protocol.ts:162,193`). An agent can push text in itself with `hive ctl plugin call` (up to 64 KiB). |
