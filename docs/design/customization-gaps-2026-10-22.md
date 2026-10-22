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
- A ceiling test checked what a third-party view can do. It ran an Electron 44.5.1 harness under
  xvfb that copies a view's sandbox, scheme and CSP exactly, then added one sandbox token at a time
  to see what each unlocks.
- Two fact-checkers then re-checked every number and claim against the code, and a critic looked
  for gaps and over-building. Their corrections are in.
- The example views the maintainer named (a first-person office, a 3D avatar per agent) were used
  as yardsticks only. **None of them is to be built.** The question is whether anyone *could*.

## Verdict

**No, this is not the most Hivemind can be customized.** The answer has two halves.

- **Design for everything.** Reserve the names and versions now, so that brand editions, icon
  packs, mascots, languages and any view a person can imagine never need a breaking change.
- **Build only what has a consumer** (Harbour, the light preset, the three published views with a
  broken box). Write the rest down as a ceiling, with the event that starts each one.

Five findings set the order.

1. **Any website in a Browser tile gets the camera, microphone and location without asking.**
   - Main sets no permission handler anywhere (`rg setPermission apps/desktop/src` finds 0
     matches), and Electron's default with no handler is to approve every request.
   - Browser tiles load arbitrary sites in the `persist:browser` session (`main/index.ts:1706`).
   - Views are safe today only because their sandbox lacks the tokens. The first token added would
     inherit the same yes.
   - This is a security fix for now: a prompt per site for the browser session, and
     deny-by-default for views.
2. **An older build erases a theme, and fixing today's code is not enough.**
   - Every settings write rebuilds `appearance` from the 12 keys it knows
     (`settings-schema.ts:419-450`). Reproduced with bun: one unrelated
     `hive config set views.defaultView` removed `accentCustom`, `theme` and `fontFaces`, and
     turned accent `custom` into `graphite`.
   - Builds already shipped behave this way and stay installable: `--version <tag>` and 14
     nightlies.
   - So old keys must keep values old builds accept: the accent stays a built-in id. New values
     (a custom accent, font faces, the theme record with its `before`) go in one new key at the
     **top level** of settings.json, which every release since 2026-09-21 keeps
     (`settings.ts:62-69`).
   - The plan's "nothing lost in the file" is wrong.
3. **Several look settings do nothing, and the guide documents them as working.**
   - **Corner radius.** It is painted as `--radius-panel`, which no rule reads; only views get it.
   - **Fonts.** `uiFont` and `monoFont` are painted to variables nothing reads. All 8 published
     views draw in `system-ui` while the app draws Geist: 7 through the font they are sent, and
     agent-board hard-codes it.
   - **Light mode.** It is accepted and documented, changes 2 CSS rules, and 10 places are
     hard-coded dark.
   - **Accent.** Its label promises "Buttons, selection and focus". Buttons use the text colour,
     and switches and the focus outline use `select`.
   - **Colours no setting reaches.** 24 of the 69 colour tokens are fixed literals.
   - **Increased contrast.** It only acts while glass is on (`styles.css:1319`).

   A brand partner tries these first. Correct the guide now, and wire the ones a planned theme
   uses.
4. **A theme is the wrong unit for an edition. Reserve the parts now; build them when an edition
   needs them.**
   - Every store that sells brand editions treats one as parts the person equips one by one:
     Samsung, LINE, Xiaomi, KDE, Fortnite and VS Code profiles.
   - The parts are the look, icons, cursors, sounds, the background scene, a mascot, the empty,
     idle and loading screens, words, and the view and widgets it opens with.
   - T2 carries three of these (the look with its fonts, the background, sounds), and T3 applies
     the file whole with one `before`.
   - Ship T0–T4 and Harbour as planned, with a `format` number and the other slot names reserved.
     Build parts, per-part revert and a layered look when a second theme exists and someone asks
     to mix.
5. **"Any view anyone can dream up" is mostly possible already. The walls are sandbox and CSP
   lines, not the GPU.**
   - **What works.** In the harness, a view ran in its own renderer process with its own 32 WebGL
     contexts, apart from the terminals' 12 (`webgl-slots.ts:25`). WASD, gamepad, audio with no
     click and continuous rendering work. Walking up to an agent and typing into its live
     terminal works in Archipelago's flat form.
   - **What blocks:**
     - pointer lock;
     - element fullscreen;
     - forms (a live bug, below);
     - fetching the view's own files, which costs 33% in base64;
     - live terminals in perspective;
     - an agent's reply text;
     - the microphone;
     - free movement of other people in a shared world;
     - hiding all app chrome.

     Each is a small capability the host mediates.
   - **Build now** the two that fix real defects: forms and own-file fetch. The table in Appendix
     B is the written ceiling for the rest.

Two insights that were not obvious:
- **A talking avatar does not need agent text inside the view.** The host speaks the reply and
  sends only loudness, which is enough for lip sync (ChatVRM's method), so the protocol's rule "no
  text an agent wrote" can stay.
- **The forward-compatibility fix has to work for builds that already shipped**, which only data
  shape can do. A code change alone cannot.

## 1. Problem

**Goal.** A person, or an edition a package ships, can change what a person sees and hears, one
part at a time, and undo any part. Accessibility and the person's own tweaks keep working. A view
author can build any world they can imagine, inside the sandbox.

**Constraints.**
- Untrusted code stays sandboxed, and themes and parts carry no code. KDE learned this in 2024,
  when a third-party global theme ran `rm -rf`.
- Nothing new runs per event on Electron main (CLAUDE.md).
- The person decides. The person-only gate in the CLI is a courtesy, not a boundary: it reads
  environment variables (`apps/cli/src/person-only.ts`), and an agent can write settings.json
  directly. So:
  - keys and sounds are person-only, because they can hijack or annoy;
  - looks stay agent-drivable when the person asks, since Revert is one step and the guide's
    AgentPrompt relies on it;
  - an agent can always *build, check and preview* a theme, and the person applies it.
- The renderer changes fast: 266 commits in the last 30 days
  (`git log --since="30 days ago" --oneline -- apps/desktop/src/renderer | wc -l`). So parts set
  values in named slots and never target markup.
- Do not build for scale nobody needs: 6 presets, 0 published themes, 8 views, 15 widgets and 13
  tools, all first-party, and about 3 people in a shared workspace.

**Numbers.**

| What | Number | Source |
|---|---|---|
| Colour tokens in the renderer's CSS | 69 | `rg -o '--color-[a-z0-9-]+:'` over the renderer CSS |
| …that `paintTheme` writes / that no setting reaches | 18 / 24 | `theme-store.ts:126-161` against the literal tokens in `styles.css` |
| Properties painted that nothing in the app reads | 3 (`--radius-panel`, `--font-ui-user`, `--font-mono-user`) | `rg` for each name: only the write |
| Presets / of them light | 6 / 0 | `settings-schema.ts:180-207` |
| CSS rules that respond to light mode / places hard-coded dark | 2 / 10 | `rg 'themeType\|theme[=:] ?"dark"\|dark: true\|class="dark"\|backgroundColor: "#'`, plus `tile-fullscreen.tsx` by hand |
| Icons, all from one module | about 100 (Hugeicons); 11 inline SVG icons bypass it | `components/icons.tsx`; `rg '<svg'` |
| Key bindings / rebindable / rows on Settings ▸ Shortcuts | 59 / 0 / 35 (copied by hand) | `shared/keymap.ts:22-78`; `settings-panels.tsx:105-178` |
| Hard-coded English strings in renderer TSX | about 1,049, in 94 of 137 files | parsed with @babel/parser: JSX text, labels, toasts |
| Package member kinds / HiveHub categories | 4 / 9 | `package-format.ts:51-56`; `category.ts:3` |
| Published views / widgets / tools; their settings; colour settings | 8 / 15 / 13; 49; 0 | the 36 manifests in hivemind-plugins |
| HiveHub caps | 2 MiB a file, 8 MiB a plugin, 200 files | `hive-hub/src/plugin-checks.ts:12-14` |
| Archipelago: whole folder (what the hub counts) / files the view loads | 5,744,001 B, 68% / 3,601,953 B, 43% | `du -sb` of the package and of `dist` |
| A view's sandbox; permission handlers anywhere in the app | `allow-scripts` only; 0 | `CommunityView.tsx:136`; `rg setPermission apps/desktop/src` |
| Renderer preferences in localStorage, outside settings.json | about 20 keys in 13 files, most of them per-device UI state | `rg localStorage apps/desktop/src/renderer/src` |

**Which known problems these are.**
1. **Layered configuration with precedence**: VS Code's settings layers, the CSS cascade.
2. **A loadout of typed slots**, each equipped on its own: theme stores and game lockers.
3. **Capability permissions for sandboxed code**: the browser's Permissions Policy, Android's
   permissions.
4. **Schema evolution with old readers still in the field**: the protobuf rule. Never change the
   meaning of an existing field; add a new one.

### The gap map

How to read the columns:
- **Works**: changeable today.
- **Broken**: stored or promised, but not applied.
- **Missing**: no way to change it at all.
- **Plan**: what `sounds-and-themes.md` or the 2026-10-21 design covers, and what they miss.

| Area | Works | Broken | Missing | Plan |
|---|---|---|---|---|
| **Colours** | 13 palette keys (presets, CLI, JSON); 10 accents | The accent reaches toasts, sliders, the selection clip, the caret and some focus rings, but not buttons, switches or the focus outline. `--color-fg-muted` is used and never defined. A look with an unknown preset id is labelled "Ubuntu" with Ubuntu's swatches (`appearance-controls.tsx:75,87,349`). | 24 tokens no setting reaches: issue states ×6, syntax ×7, notes ×7, unread, grid, scrim, brand-hover. No colour editor in the app. No custom accent. | T2: custom accent. The 24 tokens are not in T2, and the branch's `APP_COLORS` has 15. |
| **Type** | Per-tile terminal size | `uiFont` and `monoFont` are painted nowhere in the app; views get them | Display font. A default terminal size (15 is a literal; each tile is enlarged by hand). UI zoom (removing the menu removed it). Line height, ligatures. | T1 fixes the app window. It misses `TerminalTile.tsx:715`, `pierre-codeview.ts:35,40`, `main.tsx:43` and view frames. |
| **Shape and motion** | Glass opacity and blur | `radius` changes nothing in the app (views get it) | Density. Motion tokens (24 token uses against 40 literal durations). Shadows (7 fixed tokens). | T2 adds `radius` and wires nothing |
| **Light, dark, contrast** | OS reduced motion and reduced transparency | Light mode (2 rules, 10 dark sites). Increased contrast only under glass. | Following the system's mode. High-contrast presets. Forced colours (0 rules). | T5 audits from screenshots; its list misses the editor, the diff tile and PatchView, fullscreen chrome, mermaid, the window background and toasts |
| **Background** | 8 scenes, photo, video; overlays (a person's own art layers) | The wallpaper draws only while glass is on (`Wallpaper.tsx:79`), so a theme's wallpaper is invisible with glass off | Scene colours set by a theme, pattern masks tinted by tokens, parallax with the camera, a theme's overlays | T2 wallpaper. Draw it without needing glass; glass stays the person's (it costs frames). |
| **Terminal** | 16 ANSI + background, foreground and cursor | Selection is set from the CLI only. Frost half-applies until reload (`TerminalTile.tsx:360-364`). Agent TUIs ask for the background once at launch (OSC 11) and keep the old one after a theme or mode change. | Cursor shape, padding, bold-as-bright, Option-as-Meta, scrollback. Bell (nothing hears `onBell`). `minimumContrastRatio` silently changes brand ANSI colours. | T2 `terminal`, colours only |
| **Code** | — | — | Syntax colours. Two highlighters show the same file in two schemes, both fixed dark. | Not planned |
| **Icons and cursors** | Agent marks, from `agent.yaml` | 11 inline SVG icons bypass the icon module | Icon packs, cursor sets | Not planned |
| **Sounds** | — | The registry says "Alerts and sounds"; none exist | — | S1–S3, T4 (3 moments) |
| **Status signal** | A dot, a word and a pulse in the terminal header | Three surfaces disagree on exits (`FrameNode.tsx:235-237`, `TerminalTile.tsx:312`, `slot-chrome.tsx:21-24`). The slot bar cannot tell idle from exited. Two vocabularies ("approve?" and "Needs you"). | A shape per state in the slot bar and Layers, which are colour only. Nothing for screen readers: no `aria-live` for "needs you", and xterm's `screenReaderMode` is never set. | S1–S2 add sound for 3 moments |
| **Words** | — | — | No i18n. About 1,049 strings, 16 inline plurals, 212 physical-direction classes. | Not planned |
| **Keys and commands** | Plugin command keys, while the plugin has focus | Settings ▸ Shortcuts and the guide show ⌘Tab for Ctrl+Tab. Settings ▸ Agents and the guide promise ⌘\, which nothing binds. `cmdk` is a dependency nobody imports. | Rebinding. Showing a plugin's keys anywhere the person can look. | Not planned |
| **Menus and toolbar** | Toolbar order, visibility and placement per view | — | Plugin toolbar buttons and context-menu items. A native menu: it is `null`, macOS included. | "Third-party action registration … still need implementation" (`configurable-workspace-ui.md`) |
| **App identity** | — | The window background flashes `#0d0e12` | Dock or window icon, dock badge, tray, title bar colour, About | Not planned |
| **Screens** | A view draws inside its frame | — | Empty canvas, start, idle and loading art; a first-run tour | Not planned |
| **Plugins' look** | Views get 15 colours, 6 status tones, radius, fonts and glass | Views are told fonts they cannot load when the font is one the app bundles (CSP `font-src` is own origin plus data:) | Tools read 11 private variables 258 times with no frozen contract. Widgets have no colour, font or spacing props. Plugin tokens exist for views only, on the unmerged branch. | Branch; customization steps 1, 3, 6 |
| **Package members** | Tool, widget, view, agent preset | `startup` is validated and never run. Presets are listed and never offered. review-room is refused by today's schema. | Theme, and every other part | T2: theme |
| **Scope** | One look per machine | — | A look per workspace, view, host or agent; discreet mode | `scope: view:<id>` was designed, then dropped from T2 |
| **Sharing and sync** | Copy JSON / Import | `hive theme export` copies media URLs the recipient lacks. A wallpaper picked before the media picker carries an absolute path with the username (`hm-media://v/…`, never migrated). | A link for colours only. Profiles. A second machine. A one-click install link (no OS handler for `hivemind://`). | T3 is per machine |
| **Settings file** | `hive config path/get/set` with validation | Notifications live in a second settings.json on macOS, Windows and dev runs | A JSON schema for editors. A hand edit applies only after `settings.reload` (main does not watch the file). | Not planned |
| **Phone** | Follows the OS mode and contrast | Status colours swapped for views (`views.ts:85`). Views there get no settings. Three terminal palettes. | Any desktop look, accent or theme. The phone-look design says "never on chrome". | Out of scope by decision |
| **Guests** | The host's look as values | A guest's edits are saved and not shown, with no notice. `sharedAppearance` spreads the remaining keys. | Keeping your own look as a guest | T3 note only |

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
  A `{mode, light, dark}` selector follows the system. Overrides are keyed by theme, and the
  format is versioned (it was renamed once).
- **JetBrains themes and Islands**
  ([expUI theme](https://github.com/JetBrains/intellij-community/blob/master/platform/platform-resources/src/themes/expUI/expUI_dark.theme.json)).
  Named palette colours feed semantic keys, and `parentTheme` lets a theme set only what differs.
  When the chrome was redesigned, inheriting themes survived and flat ones had to be redone.
- **Ghostty** ([config](https://github.com/ghostty-org/ghostty/blob/main/src/config/Config.zig)).
  Custom shaders give retro editions their character. An invalid shader can turn the window
  black, and a background image is duplicated in VRAM per terminal. Effects must be built in,
  capped and recoverable.
- **WezTerm backgrounds**
  ([docs](https://github.com/wezterm/wezterm/blob/main/docs/config/lua/config/background.md)).
  Layered images with parallax and per-layer dimming. A brand scene that moves slower than the
  tiles as you pan is a compositor transform, so it is cheap.
- **Warp themes and brand editions** ([repo](https://github.com/warpdotdev/themes)). A developer
  tool shipped brand collaborations as values plus one image: a gradient accent, art and ANSI
  colours.
- **iTerm2 automatic profile switching**
  ([docs](https://github.com/gnachman/iterm2-website/blob/master/source/_includes/3.5/documentation-automatic-profile-switching.md)).
  Looks that switch by host, path or job are the most practically useful kind (production in
  red).
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
  character themes. Live signals sit at fixed spots that art is designed around. Palette swaps of
  an existing theme are refused as duplicates.
- **Xiaomi themes** ([guide](https://androidauthority.com/miui-themes-guide-xiaomi-885210)).
  A picker per part, filled from every installed theme, plus "save this mix as my look".
- **KDE Plasma global themes** ([docs](https://develop.kde.org/docs/plasma/)). A manifest points
  at parts that also stand alone. Two cautions: a third-party theme ran arbitrary code in 2024,
  and "use layout from theme" wiped people's panels.
- **Discord, Steam and Fortnite**
  ([Discord](https://support.discord.com/hc/articles/17162747936663),
  [Steam](https://partner.steamgames.com/doc/marketing/pointsshopitems)).
  The cosmetics people value most are the ones others see. Every animated asset ships with a
  still, and every slot has a size and duration cap.
- **Doki Theme and AMII** ([repo](https://github.com/doki-theme/doki-theme-jetbrains)). The
  closest evidence for an anime edition of a developer tool: a mascot that reacts to builds,
  empty-editor art, and a one-switch discreet mode. With no slots in the host, they patch VS
  Code's CSS and break on every update.
- **Winamp Skin Museum** ([webamp](https://github.com/captbaritone/webamp)). Fixed named slots
  with a fallback per file kept 25-year-old skins working.
- **Wallpaper Engine** ([docs](https://docs.wallpaperengine.io/en/web/customization/properties.html)).
  An interactive wallpaper is a sandboxed page fed by properties and events. The host owns
  playback: it pauses when covered and caps the frame rate.

Standards and accessibility:
- **W3C Design Tokens 2025.10**
  ([format](https://www.w3.org/community/reports/design-tokens/CG-FINAL-format-20251028/)).
  Accept DTCG colour objects at the edges if a partner hands over Figma tokens. Keep `theme.json`
  as the stored format.
- **Material 3 dynamic colour**
  ([material-color-utilities](https://github.com/material-foundation/material-color-utilities)).
  A palette generated from one hero colour passes contrast by construction. Use it when an author
  reports that the contrast check blocks their brand colours.
- **GitHub Primer** ([primitives](https://github.com/primer/primitives)) and **Firefox design
  tokens**
  ([docs](https://firefox-source-docs.mozilla.org/toolkit/themes/shared/design-system/docs/README.json-design-tokens.stories.html)).
  The colour-blind, high-contrast and forced-colours variants belong to the app, not to brand
  themes.
- **WCAG 2.2 and APCA**
  ([1.4.3](https://raw.githubusercontent.com/w3c/wcag/main/understanding/20/contrast-minimum.html)).
  Gate on WCAG 2.2. Use APCA only as advice, because WCAG 2 overstates how readable dark pairs
  are.
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
  Code agents as pixel characters in an office, driven by hooks. Hivemind's views already receive
  the same signal.
- **ChatVRM lip sync**
  ([lipSync.ts](https://github.com/pixiv/ChatVRM/blob/main/src/features/lipSync/lipSync.ts)).
  The mouth moves from the audio's loudness alone. **three-vrm and VRM 1.0**
  ([three-vrm](https://github.com/pixiv/three-vrm)) are the durable open path for avatars.
  Hosted avatar services are retreating, so a view should depend on local files:
  - Ready Player Me ended its public service in January 2026
    ([report](https://www.pocketgamer.biz/netflix-acquires-avatar-creation-platform-ready-player-me));
  - Meta Horizon Workrooms closed in February 2026
    ([notice](https://www.meta.com/en-gb/help/quest/2464765133873078/));
  - Spatial ended creator hosting in July 2026
    ([report](https://uploadvr.com/spatial-is-discontinuing-its-creator-platform-in-july/)).
- **WorkAdventure** ([energy](https://workadventu.re/article/measuring-energy-cost-of-animations/)).
  Map animations took a laptop from 7.5 W to 9.8 W. Continuous rendering needs a budget the host
  enforces.

## 3. From every side

| View | What worries them |
|---|---|
| Person | Undo must be one step. A brand must never make text unreadable or hide which agent needs them. Their own tweaks must survive a theme switch or update. Websites in a Browser tile must not reach the camera unasked. |
| Data | settings.json drops unknown keys inside sections and never reads its `v`. Builds that do this stay installable, so new values go in new keys and records at the top level. Renderer localStorage (about 20 keys) cannot be moved by the numbered migrations, which run on files, and the browser app on 127.0.0.1 is another origin with its own storage. |
| Operator at 3am | A bad part must fall back per slot, with a notice, and never brick the app: a safe-mode start skips theme parts. Report every key a theme has that the app does not use (KDE's splash key was silently ignored). |
| Security | Parts carry no code. SVG icons are sanitised and drawn as masks. No remote URLs in any part. Permission handlers come first: a prompt per site for Browser tiles, deny-by-default for views. HiveHub has no report, unlist or takedown route (`guide/(hivehub)/hivehub-api.mdx:22-31`); it needs one before the first edition with someone's art. `startup.agents` must never start an agent, with its 16,000-character prompt, without the person confirming each one. |
| Cost | The look is resolved once per change, never per event. Fonts reach views in `hello` and again only when their digest changes, never inside the `theme` message, which fires on every slider move (`plugin-link.tsx:288-294`). Animated parts need a still, pause rules, a frame cap and real-GPU numbers. |
| Next year | (1) A first brand edition with its view, widgets and art. (2) A language for that edition. (3) Teams sharing a look per workspace. Each needs a reserved slot today and its machinery only when it arrives. |

## 4. Options

### 4a. How looks are put together

**A. One `theme.json`, copied on apply (the plan today).** One file holds the look, fonts,
wallpaper and sounds, and is copied into the settings on apply, with one `before`.

```
theme.json (palette, accent, terminal, fonts, wallpaper, sounds)
   │ apply = copy into settings, keep one `before`
   ▼
appearance ── paintTheme ── app, views, guests
```

Where it breaks:
- Mixing parts from two editions is impossible.
- The person's tweaks are lost on a theme switch or update.
- Every brand theme must author its own accessibility variants.

**B. A look stack of parts, with editions as references.** Each part is its own member and can
be equipped alone. One owner resolves the layers into values.

```
 layer 6  discreet mode ─────────────── hides art, keeps colours (person)
 layer 5  access (app-owned) ────────── high contrast · vision · forced colours · motion · contrast floor
 layer 4  person's overrides ────────── keyed by part and theme id
 layer 3  workspace look ────────────── kept in the person's data, never in .hivemind/
 layer 2  equipped parts ────────────── look · type · icons · cursors · sounds · scene · mascot · screens · words
 layer 1  app defaults (presets)
           │ resolveLook(): pure, in hive-core, on change only, same object if nothing changed
           ▼
   app window · views (ViewTheme + a11y + tokens) · guests (allow-list) · phones (values)

 edition member ── references parts + startup {view, widgets, layout as a new workspace}
```

Where it breaks: a part can only fill slots the app defines. A look that needs a new shape is
still a view's job inside its frame.

**C. Skin pages.** A package ships a sandboxed page that draws the app's chrome.

```
edition ── skin page (iframe) ── draws toolbar, panels, backgrounds ── host composites it
```

Where it breaks:
- Memory: about 68 MB a frame (`plugin-runtimes-2026-09-17.md`).
- Contrast and focus inside a page cannot be checked.
- The page can draw a fake "Allow" button.

**D. Theme CSS against the app's markup** was rejected on 2026-10-21 and stays rejected.
Obsidian, Doki Theme and KDE all show selectors breaking on each update, and KDE shows code in a
theme destroying data.

**Scale.**
- Load: themes or editions. Today there are 6 built-in presets and 0 published themes; 10× is 60
  and 100× is 600.
- Slots a full edition fills: about 203 = 69 colours + about 100 icons + 8 cursors + 10 sound
  moments + 3 screens + 3 fonts + 4 background layers + 6 mascot states.

| Design | Today (6) | 10× (60) | 100× (600) |
|---|---|---|---|
| A. One theme.json | Holds: 6 presets, 1 planned theme (Harbour), nobody mixing. | Strained: 60 × 410 = 24,600 values, each theme authoring its own accessibility variants; tweaks lost on switch. | Breaks: 246,000 values, and each renderer change can orphan 600 themes. |
| B. Look stack and parts | Over-built: 6 layers and 11 part kinds for 1 theme. | Holds: access layers authored once by the app (156 values); parts shared across editions; resolve ≈ 1,218 copies per change. | Holds. |
| C. Skin pages | Strained: 68 MB per window, no contrast checks. | Breaks on trust: any page can draw a fake dialog. | Breaks. |

Arithmetic:
- **A, per theme:** 410 = 69 × 4 colour variants (276) + 134 other slots (203 − 69). Then 60 × 410
  = 24,600, and 600 × 410 = 246,000.
- **B, access layers:** 156 = 2 high-contrast presets × 69 + 3 vision overlays × 6 status tokens.
- **B, resolve:** 6 layers × 203 slots = 1,218 property copies. This is an estimate, to be measured
  when B is built.
- **C:** 68 MB is the measured cost of a frame.

### 4b. How a view gets more power

**V1. Open the sandbox.** Add `allow-same-origin`, `allow=microphone`, `connect-src *` and the
rest, so a view becomes a web app. Where it breaks:
- The host's handshake relies on the frame's origin being opaque (`CommunityView.tsx:65`).
- A view could record the room and send it anywhere.

**V2. Capabilities the host mediates.** The manifest declares `capabilities: [...]`. The install
review shows them, and the person can revoke any of them. The host does the dangerous part itself
and hands the view the result.

```
view ─ request ─▶ host (permission handler, deny by default) ─▶ does it: fullscreen, listen, speak,
     ◀─ result ──                                                 fetch own files, relay presence
```

Where it breaks: each capability is a protocol minor, with a `since.ts` entry, SDK release, skill
text and guide pages. That is slower than V1, but each one is small.

**V3. Trusted views.** A view that needs full power runs as a tool plugin, as in-app React with no
sandbox. Where it breaks: one bad plugin gets the app, the disk and every terminal's text.

**Scale.**
- Load: views installed. Today 8; 10× is 80; 100× is 800.
- People in one shared world. Today 3; 10× is 30; 100× is 300.

| Design | Today | 10× | 100× |
|---|---|---|---|
| V1. Open the sandbox | 8 views can each record the room and send it anywhere. Breaks on trust from day one. | 80. Breaks. | 800. Breaks. |
| V2. Host-mediated capabilities | Holds. Archipelago loads 43% of the 8 MiB cap. Presence state at 1 KB × 10 Hz: each peer receives 2 × 10 KB/s = 20 KB/s. | Holds: 29 × 10 KB/s = 290 KB/s per peer. | Breaks at 299 × 10 KB/s ≈ 3 MB/s per peer. Fix: send only the nearest 20 peers, 200 KB/s. |
| V3. Trusted views | No sandbox memory, but full access for every view. Breaks on trust. | Breaks. | Breaks. |

Arithmetic:
- **Presence per peer:** (N − 1) peers × 1 KB × 10 Hz.
- **Rate:** the multiplayer design sends presence through a 50 ms throttle
  (`multiplayer-2026-09-28.md:726`), a ceiling of 20 Hz.
- **Package size:** the view loads `dist`, 3,601,953 B, out of the 8,388,608 B cap.

## 5. Choice

**For looks: A now, shaped so it grows into B without a breaking change. For views: V2, built one
capability at a time when a real view needs it.**
- **B is the target, not the next build.** At today's 6 presets and 1 planned theme it is
  over-built, and it would push Harbour, the only real theme, behind two rounds.
- **A becomes B cheaply if four things are true from the start:**
  - new values and theme records live in a top-level key;
  - `theme.json` carries `format: 1`;
  - the other slot names are reserved in the format doc;
  - copy-on-apply stores values, which a later stack can split into layers.
- **C lost** on memory and trust, **V1** on trust at today's count, and **V3** because it removes
  the sandbox.

What was surprising:
1. **The serious bugs are in the foundations, not the features.**
   - A Browser tile can reach the camera unasked.
   - Settings drop unknown keys, in builds that stay installable.
   - Notifications live in a different settings.json on macOS, Windows and dev runs.
   - Several look settings were never wired, and the guide documents them as working.
2. **Most of the "wildest" views already work.** WebGL runs out of process, keys reach a focused
   view, audio plays without a click and gamepads are allowed. The walls are CSP and sandbox lines
   that were drawn for safety and never revisited for 3D.
3. **The protocol's privacy rule and a talking avatar fit together.** The host speaks, and the view
   only sees loudness.

### The target, in outline (built by trigger; see section 7)

**Reserved part slots.** Each row gets a name and a `format` number now. Each is built when its
trigger in section 7 fires.

| Part | Slots | Rules when built |
|---|---|---|
| Look | 13 palette keys (or a seed), the accent (any colour), status and frame colours, note colours, plugin tokens (`archipelago.sea`), syntax (a TextMate theme for Shiki, mapped for CodeMirror), shadows, radius scale, motion, density | Contrast is checked on text, faint text, borders, focus, status and brand-as-caret. A group is set whole. **People colours stay out:** a person's colour is the same to everyone, so it is not themable. Move `PROFILE_COLORS` clear of the status bands instead, as `FRAME_HUES` already are. |
| Type | UI, mono and display faces (woff2, `unicode-range`, metric overrides); line height; terminal cursor shape | Japanese faces are sliced by range. Fonts reach views in `hello`, and again only when their digest changes. |
| Icons | A map from the app's icon names to single-colour SVG paths | Sanitised and drawn as masks in `currentColor`. Security icons (lock, warning) cannot be replaced. Plugin icons get a tinted tray. |
| Cursors | Pointer, grab, grabbing, resize, crosshair, presence cursor | 32–48 px with a hotspot. Terminals and editors keep the I-beam. |
| Sounds | Named moments with prefix fallback (`agent-done-tests` → `agent-done`), voice lines | S1's pacer stays the only gate. Voice lines are off by default. |
| Scene | Up to 4 layers: gradient, pattern mask tinted by tokens, image, video; parallax with the camera | Each layer has a still. It pauses on blur, idle and battery. No infinite CSS keyframes. It never needs glass. |
| Mascot | An image per agent state plus a still | It reacts to status-bucket changes only, at most every few hundred ms. Clicks pass through it. |
| Screens | Empty canvas, start, idle and loading art | "Needs you" always breaks through. Loading art never delays readiness. |
| Words | A `locale` (ICU JSON) and a short glossary ("crew" for "agent") | Needs one owner for words first. |
| Credit | The artist's or brand's mark and text | Drawn by the app in a fixed spot, so it cannot pass for app UI. |
| Variants | The part's own settings (settings v2): an alternate wallpaper, pose or accent | Values only. |

**Edition member (target).** It holds references to parts plus `startup` {view, widgets, layout}.
Applying one:
- shows a review list;
- opens a layout as a **new** workspace, never over the current one (KDE's lesson);
- can be undone as one step;
- never starts `startup.agents` without the person confirming each agent and its prompt.

**View capabilities (target).**

| Capability | Today | Unlock (host-mediated) | Risk | Build when |
|---|---|---|---|---|
| Forms | Blocked (bug: 3 views' boxes do nothing) | Handle Enter and click in those views, or add `allow-forms`; CSP `form-action 'none'` still stops navigation | About nil | **Now** |
| Fetch own files | Blocked (`connect-src 'none'`) | `connect-src` naming only the view's own host. **Not** the scheme-wide `hm-view:`: view files are served with `Access-Control-Allow-Origin: *` (`view-packages.ts:112,121`), so that would let a view read every other view's files. | Low | **Now** (removes the 33% base64) |
| Big assets | 8 MiB HiveHub cap | First publish only member files (Archipelago's loaded files are 43%). Then asset packs. | Disk and bandwidth | Asset packs when a view's loaded files pass about 6 MiB |
| Pointer lock | Blocked (SecurityError) | `allow-pointer-lock`, with the permission handler | Low; check Esc in Electron | A view that asks |
| Fullscreen | Blocked | Host command `setFullscreen` (the window, so terminal slots keep working) | Low | A view that asks |
| Hide all chrome | Partly (corner controls stay) | `chrome: "none"` with a hover handle the host draws | Low | A view that asks |
| Terminal in perspective | Blocked (axis-aligned rects only) | Optional `matrix3d` and clip polygon on `SurfaceRect`, fixed size, bar required | Medium: legibility, spoofing | A view that asks |
| Agent replies | Blocked by design | Host `speak(tileId)` sending loudness only; or a `replies` permission with its own install wording | Medium | A view that asks |
| Voice input | Blocked (opaque origin) | Host push-to-talk with speech-to-text in the host, into the confirm-each-prompt flow | High: room audio, so a visible indicator | A view that asks |
| Shared world | Partly (presence is a tile id) | A per-participant state blob, capped at 1 KB, on the presence channel | Low to medium | A view that asks |
| Suggest a theme, add a widget | Partly | `suggestTheme`, `addWidget`, each confirmed by the person | Low | A view that asks |
| Continuous rendering | Works; the watchdog misses GPU work | Declare `animates {maxFps}`; the host pauses it when hidden and counts GPU time | Low | When a view drains batteries |
| VR (WebXR) | Blocked in the harness (Linux, no XR runtime). Electron's DEPS sets `checkout_openxr` to False ([DEPS](https://github.com/electron/electron/blob/44-x-y/DEPS)). | Only the browser app in a headset browser | High | Not planned |

## 6. Pre-mortem

It is October 2027, and this failed. The four likeliest reasons:

1. **We built the machinery before anyone used it.**
   - The look stack, 11 part kinds, keymap layers and i18n went in before a single edition existed.
     Harbour slipped, and 266 renderer commits a month kept breaking unused code.
   - *Change:* build by trigger (section 7). Reserve names and versions instead.
2. **Editions broke on every release, and authors gave up.**
   - *Change:* slots are few and named, and versioned with `format`. Colours are tokens and tints,
     not pixel-fitted art.
   - An author, or their agent, renders previews with `apps/desktop/scripts/docs-shots.mjs
     --theme <folder>` (an option to add) and commits them, and HiveHub shows them. HiveHub is a
     Cloudflare Worker and cannot run Electron, and CI does not run e2e, so the previews are made
     by the author, not by the hub.
3. **A brand made the app unusable for someone, and the app took the blame.**
   - *Change:* status carries a shape as well as a colour. Increased contrast works without glass.
     T2's contrast check covers focus, borders and status, not only text.
   - High-contrast presets come on the first request. Discreet mode comes with the first art part.
4. **A capability, or a website, was abused.**
   - *Change:* the permission handlers ship first: a prompt per site for the browser session, and
     deny-by-default for views.
   - Each view capability is shown at install and can be revoked. `listen` shows an indicator.
   - The written ceiling: presence beyond 20 nearby peers needs interest management.

## 7. Build order

Foundation first. Each step lists its check. Rounds land as one PR each (CLAUDE.md), and each
round walks the feature-done table, including the guide.

**Round 0. Fix now.** Small and independent; each has a test shown failing first.
1. **Permission handlers.**
   - A prompt per site in `persist:browser` (camera, microphone, location, notifications).
   - Deny-by-default for view frames.
   - *Check:* an e2e where a page in a Browser tile asks for the microphone and is asked, not
     granted. A view's `Notification.requestPermission()` is denied.
2. **The three "Give it work" boxes** (Archipelago, Island, Agents by state): handle Enter and
   click directly, in hivemind-plugins.
   - *Check:* in the built app, Enter sends the prompt request.
3. **Correct the guide.**
   - `settings.mdx` documents radius, fonts and light mode as working.
   - `keyboard-shortcuts.mdx` lists ⌘Tab and ⌘\.
   - Generate Settings ▸ Shortcuts and the guide table from `KEYMAP`, so there are no hand
     copies.
   - Either build the ⌘K palette or remove `cmdk` and the stale comments.
   - *Check:* a test that every `KEYMAP` row appears.
4. **Status.**
   - A shape per state in the slot bar and Layers.
   - One word list for status ("approve?" and "Needs you" from one module).
   - Increased contrast without glass.
   - An `aria-live` line for "needs you".
   - *Check:* screenshots, and a unit test on the word list.
5. **Smaller fixes.**
   - `sharedAppearance` becomes an allow-list.
   - Widget `hive.notify` goes through the notification settings.
   - `hive theme export` drops media URLs, or warns.
   - The "Ubuntu" fallback is fixed.
   - The gate's wording says it is advisory; keys and sounds are person-only.

**Round 1. Foundation.**

6. **Settings that survive old builds.**
   - Unknown keys are kept in every section.
   - Old keys keep values old builds accept (the accent stays a built-in id).
   - New values go in one new top-level key that the app reads on top of `appearance`: the custom
     accent, font faces and the theme record.
   - `v` is read.
   - Notifications move into the one settings.json, with a migration.
   - *Check:*
     - a writer with today's schema leaves the new keys alone;
     - today's merge, run on a file written by the new code, keeps a valid accent;
     - the migration is tested, killed at 20 points.
7. **Freeze the plugin contract.**
   - List the 11 app variables tools read and the 15 `ViewTheme` colours.
   - Add a test that each is still defined.
   - Then merge or drop `feat/tokens-settings-v2`, so token work does not collide.
8. **S1, S2** (sounds), then **T1** (fonts), with the four missed sites. Fonts reach views in
   `hello` and on a digest change.

**Round 2. Themes, as planned.**

9. **T0–T4** with `format: 1` and the reserved slot names.
   - A theme's wallpaper draws without glass.
   - The accent reaches buttons, switches and focus.
   - An agent can build, `check` and preview a theme; the person applies it.
10. **T5** (light) with the full list of dark sites, plus `nativeTheme.themeSource` and the window
    background.
    - Answer agent TUIs on a mode change: send OSC 11 again, or set `COLORFGBG`.
11. **T6** Harbour. Offer to open `startup.view` after install ("Open Archipelago?").
12. **Own-file fetch** for views (own host only), and publish only member files.

**Ceilings and triggers.** Designed above, built when the trigger fires.

| Build | Trigger |
|---|---|
| Parts, the look stack, per-part revert, saved looks, overrides kept per theme | A second theme package exists and someone asks to mix, or a person reports losing tweaks on a switch |
| Icon packs, cursors, mascot, screens, credit, discreet mode | The first brand edition is agreed |
| A report, unlist and takedown route on HiveHub | Before the first edition with someone else's art is published |
| Seed palettes, DTCG import | An author says the contrast check blocks their brand colours, or a partner sends Figma tokens |
| High-contrast presets, vision overlays, forced colours | The first request, or Windows becomes a supported build |
| A flat key override `keys: {action: chord or null}`; plugin toolbar and menu entries | The first request; a plugin that asks |
| One owner for words, locale members, a glossary | An edition partner commits to a language |
| Each view capability in section 5 | A real view needs it |
| Asset packs | A view's loaded files pass about 6 MiB |
| Looks per workspace, context rules (production in red) | The first request |
| The look on phones (values over the connection, one token source for presets) | An edition needs the phone |
| A `hivemind://` install link | The first partner asks for a link on their site |
| A JSON schema for settings.json, applying hand edits by watching the file | Theme authors iterate on files by hand |

## 8. Unknown

| What | How to check |
|---|---|
| Whether the view forms really fail in the app (measured in the harness only) | Press Enter in Archipelago's "Give it work" box in the built app |
| Whether a view can write the clipboard: `navigator.clipboard` is refused, but `document.execCommand("copy")` returned true in the sandbox under a gesture | Copy from a view, then read the clipboard back |
| Whether ⌘C and ⌘V work in text fields on macOS with the menu set to `null` | Try it on the arm64 build |
| Whether widget command keys bind for the whole app (read from the code, not run) | A widget that declares a key, pressed inside a terminal |
| Whether macOS's own camera and microphone prompt protects Browser tiles there (Linux has none) | A Browser tile asking for the microphone on each OS |
| The cost of resolving and painting a look, and of an animated scene at 50 tiles | Measure on a real GPU when built, as CLAUDE.md requires |
| VRM avatar sizes against the 8 MiB cap | Measure three VRoid exports |
| Whether font bytes in a message load inside a view frame without a CSP change | A view test with `new FontFace(name, bytes)` |
| Esc and pointer lock in Electron; WebGPU on a real GPU; WebXR on Windows with a headset; platform speech voices | The harness on real macOS and Windows machines |
| Why a view's icon is nulled in its HiveHub listing | The HiveHub server repo, which is not in this checkout |

## Appendix A. Found along the way

Every row was checked against the code by a second agent; ✓ rows were also re-checked by the
author.

| # | What | Evidence |
|---|---|---|
| 1 ✓ | Browser tiles, and anything else, get every permission: no handler is set | `rg setPermission apps/desktop/src` → 0; `main/index.ts:1706` |
| 2 ✓ | An older build's write erases an applied theme (unknown appearance keys dropped, `custom` accent turned into `graphite`) | `settings-schema.ts:419-450`; reproduced with bun |
| 3 ✓ | The person-only gate covers `plugins.*` only, and it is advisory (it reads environment variables). The guide's AgentPrompt asks agents to run `hive theme use`. | `apps/cli/src/commands/config.ts:51`; `person-only.ts`; `guide/(use)/appearance.mdx:9-18` |
| 4 ✓ | Notification settings live in `userData/settings.json`, a different file on macOS, Windows and dev runs. `hive config get notifications` → NOT_FOUND, and `set` exits 0 having written nothing. | `notification-settings-store.ts:26-28` against `settings.ts:32-36` |
| 5 ✓ | The "Give it work" box in Archipelago, Island and Agents by state does not submit: with no `allow-forms`, the submit event never fires (measured in the harness) | `archipelago/src/main.ts:477`; `island/src/main.ts:462`; `agents-by-state/index.js:114` |
| 6 | `hive theme export` copies media URLs the recipient lacks. A wallpaper picked before the media picker carries an absolute path with the username, and no migration rewrote it. | `config.ts:93-102`; `main/index.ts:1759-1783`; `settings-schema.ts:418` |
| 7 | `sharedAppearance` spreads the remaining keys, so future `fontFaces` and `theme.before` (a disk path) would reach guests | `settings-schema.ts:457-467` |
| 8 | Widget `hive.notify` ignores the master switch, Do Not Disturb and OS pop-ups, with no rate limit; 8 of 15 widgets use it | `widget-runtime.ts:322` |
| 9 | The long-task watchdog cannot fire for a view (it runs out of process); only the 60% CPU check acts, and it does not see GPU work | `CommunityView.tsx:70-84`; harness: 0 entries for a 400 ms loop |
| 10 | Settings ▸ Shortcuts and the guide show ⌘Tab (the keymap binds Ctrl+Tab); Settings ▸ Agents and the guide promise ⌘\, which nothing binds | `settings-panels.tsx:113`; `keymap.ts:31`; `settings-agents.tsx:98`; `keyboard-shortcuts.mdx:31,87` |
| 11 | 11 Mac-only "⌘" hints show on Linux and Windows; Recent shows "Ctrl O" on a Mac | `standard-toolbar.tsx:92`; `RecentProjects.tsx:104` |
| 12 | A look with an unknown preset id is labelled and reset as "Ubuntu", though the default is Signal | `appearance-controls.tsx:75,87,349` |
| 13 | A widget `tint` that is not one of the 6 note colours (or is `ink`) draws dark ink on a transparent or ink card. Arrow `color` is kept by the document, but nothing sets or draws it. | `widget-format.ts:118-121`; `WidgetBody.tsx:158`; `Arrows.tsx:68-72` |
| 14 | Frost tool content half-applies until reload; the minimap choice resets on remount | `TerminalTile.tsx:360-364`; `CanvasView.tsx:224` |
| 15 | Three surfaces disagree about an exited agent; the slot bar cannot tell idle from exited | `FrameNode.tsx:235-237`; `TerminalTile.tsx:312`; `slot-chrome.tsx:21-24` |
| 16 | The phone page swaps status colours for views (working green, done in the text colour) | `crates/hive-web/www/app/views.ts:85` |
| 17 | Views on a phone or remote screen get no settings (`hello` has none) | `packages/host/src/views.ts:258-263` |
| 18 | A package's `startup` is validated and never run; agent presets are listed and never offered; review-room is refused by today's schema | `packages.ts:186-201`; `package-format.ts` |
| 19 | HiveHub: install counts are dropped from the index (the search tiebreak is always 0); every package is "other: A package of N"; a view's icon is nulled | `index-format.ts`; `plugin-checks.ts:168,290-293` |
| 20 | Tool plugins are served images and fonts, but the app's CSP allows `hm-plugin:` in `script-src` only | `tool-packages.ts:37-40`; `renderer/index.html:14` |
| 21 | Three package caps disagree: 2/8 MiB and 200 files (HiveHub), 20/50 MiB (download), 16/128 MiB and 4,096 files (local) | `plugin-checks.ts:12-14`; `plugin-catalog.ts:15-16`; `packages.ts:15` |
| 22 | The terminal bell does nothing: nothing listens to `onBell` | `TerminalTile.tsx` |
| 23 | Views get tile names built from titles agents set, which contradicts the view skill's "never sees a title the agent wrote" | `Workspace.tsx:646`; `host/src/board-structure.ts:28-33` |
| 24 | A guest's Appearance edits are saved and not shown, with no notice | `theme-store.ts:37,165-171` |
| 25 | `--color-fg-muted` is used and never defined; `--color-brand-hover`, `--hm-ease-in` and `--hm-ring-strong` are never read; the view theme observer watches a `data-theme` attribute nothing writes | `PromptDialog.tsx:19`; `plugin-link.tsx:294` |
| 26 | Agent TUIs are never told about a theme change: OSC 11 is answered only when asked, and no `COLORFGBG` is set | `osc-color.ts:1-9`; `pty-daemon.ts:321-323` |
| 27 | Per-tile font keys (`hm:tileFont:<id>`) are never removed | `tile-font.tsx:15` |

## Appendix B. The view ceiling, measured

These were measured in an Electron 44.5.1 harness under xvfb that copies the app's view sandbox,
the `hm-view` scheme privileges and the exact view CSP. Absolute frame rates under xvfb are not
valid (CLAUDE.md); these rows are about what is allowed, not how fast it runs.

| Need | Today | Measured |
|---|---|---|
| WASD, Escape and digits reach a focused view | Works | Keys reach the frame and the host sees none. Main still takes Mod+Q, F11, Mod+1–9 and the other "anywhere" keys first. |
| WebGL | Works | The frame has its own renderer process. 30 host + 30 view contexts: none lost. |
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
| Downloads, pop-ups, `alert`, async clipboard | Blocked | All refused. `document.execCommand("copy")` returned true (see Unknown). |
| Screen wake lock | Blocked | It works with `allow="screen-wake-lock"`. |
| WebXR | Blocked here | With `allow="xr-spatial-tracking"`, immersive-vr is unsupported on Linux, which has no XR runtime. |
| Agent replies, terminal text | Blocked by design | Status words, counts and ids (`protocol.ts:162,193`), though tile names built from titles agents set do reach views (Appendix A #23). An agent can push text in itself with `hive ctl plugin call` (up to 64 KiB). |
