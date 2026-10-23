# Sounds and themes — build plan (start here)

The working record for app sounds and themes a package ships. **A new session starts here.** Why
each choice was made, with measurements and options, is in
[`docs/design/sounds-themes-widget-workers-2026-10-22.md`](../design/sounds-themes-widget-workers-2026-10-22.md).
This file says what to build, in which files, what "done" means, and where the work stands.
Update the status table in the same commit as the work it describes.

## Read first: corrections from the 2026-10-22 gap review

[`customization-gaps-2026-10-22.md`](../design/customization-gaps-2026-10-22.md) checked this plan
against the code. The plan stands: T0–T4 and Harbour still ship as copy-on-apply. These facts
change how it is built, and go in before T1. The order is that review's section 7: Round 0 fixes,
then Round 1, then this plan.

1. **New `appearance` values must go in new keys, and the theme record at the top level.**
   - Every settings write rebuilds `appearance` from its 12 known keys (`settings-schema.ts:419-450`).
     A write by an older app or `hive` erases `accentCustom`, `theme` and `fontFaces`, and turns
     accent `custom` into `graphite`.
   - Builds that already shipped behave this way and stay installable, so fixing today's merge is
     not enough.
     - `appearance.accent` keeps a built-in id that old builds accept.
     - The custom accent, the font faces and the theme record (with `before`) live in one
       top-level key instead, which the new build reads on top of `appearance`. Every release
       since 2026-09-21 keeps unknown top-level keys (`settings.ts:62-69`).
   - The T2 forward-compatibility note and Definition of done row 9 ("No migration needed",
     "nothing lost") are wrong.
2. **Notifications live in a second settings.json.**
   - `notification-settings-store.ts:26-28` writes to `app.getPath("userData")`. On macOS, Windows
     and dev runs that is not `~/.config/hivemind`.
   - `hive config get notifications` is NOT_FOUND today. S1 moves the file, with a migration,
     before S2's `hive notifications`.
3. **T1 misses four font sites:**
   - `TerminalTile.tsx:715`, the glyph-atlas wait (without it a custom mono font stays blurry);
   - `pierre-codeview.ts:35,40`;
   - `main.tsx:43`;
   - view frames, whose CSP cannot load the app's bundled fonts.

   Fonts reach views in `hello` and again on a digest change, never in the `theme` message, which
   fires on every slider move.
4. **T5's light audit misses dark-only sites:**
   - the editor (`EditorTile.tsx:144`);
   - the diff tile and PatchView (`themeType: "dark"`);
   - mermaid (`markdown-preview.tsx:52`);
   - fullscreen chrome (`tile-fullscreen.tsx`);
   - the window background (`main/index.ts:270`) and `<html class="dark">`;
   - the toaster (`main.tsx:56`);
   - `nativeTheme.themeSource`, which is never set;
   - agent TUIs, which read the background once at launch (OSC 11).
5. **The person-only gate is advisory.** It reads environment variables (`person-only.ts`), and
   today it covers `plugins.*` only (`config.ts:51`).
   - Sounds and keys become person-only.
   - Looks stay agent-drivable when the person asks, because the guide's AgentPrompt depends on it
     and Revert is one step.
   - An agent can always build, check and preview a theme.
6. **T2 and T3 additions:**
   - `format: 1`, with the other part slots reserved (icons, cursors, scene layers, mascot,
     screens, words; review §5).
   - A theme's wallpaper draws without glass. Glass stays the person's.
   - What the accent colours: decided 2026-10-22 to keep buttons in the text colour (the calm,
     monochrome look Clean is built on) and to make the Accent's description say what it does
     colour. A brand that needs coloured buttons is a T2 question.

## Status

| Step | What | State |
|---|---|---|
| S1 | One notice desk in main: dedupe across windows, sound gate and pacing | ◐ 2026-10-23 (branch `round1/sounds`): notifications are the `notifications` section of the one settings.json (`@hivemind/core/notification-settings`), migration 0006 moves the app data folder's blob in; `hive config get/set notifications` work, person-only |
| S2 | The sound player, built-in sounds, Notifications ▸ Sounds, `hive notifications` | ☐ |
| S3 | Pop-ups grouped in a burst ("10 agents finished") | ☐ (needs a yes, see Decisions) |
| T0 | HiveHub works out "needs Hivemind X or newer" for packages and views | ☐ |
| T1 | Fonts that apply (the system font by default, CSS, terminal, `@font-face` from `hivemedia:`) | ☑ 2026-10-22 except `@font-face` (comes with T2's font files): the settings drive the app, terminals (live, atlas redrawn), diffs and the editor; no migration (a file holding the old default `system-ui, sans-serif` is read as the system font, so nothing on disk changes); Settings ▸ Appearance has Interface font and Code font |
| T2 | The theme member: `theme.json`, its checks, a custom accent | ☐ |
| T3 | Apply, revert and update a theme: app, CLI, files copied | ☐ |
| T4 | A theme's sounds | ☐ |
| T5 | Light mode audited, a light preset, light themes allowed | ◐ 2026-10-22: the app's dark-only sites follow the mode (page, toaster, editor, diffs, PatchView, diagrams, fullscreen chrome), main sets `nativeTheme` and the window background, light tokens for shadows, grid and syntax; **Clean Light** ships. 2026-10-23: an audit of the 41 views, widgets and tools found 38 colour bugs in Signal and Clean Light, 28 in hivemind-plugins (branch `feat/focus-view`) and 10 in the app; all fixed, with one more found while checking (Island's and Archipelago's ring round a calling agent faded to black on a sunlit sea). Open: a diff's page (Known gaps). Light themes from packages come with T2 |
| T6 | Archipelago ships the **Harbour** theme (hivemind-plugins) | ☐ (after a release with T0–T4) |
| C | **Clean** and **Clean Light** presets; corners (`appearance.radius`) that apply; a preset `look` (glass, wallpaper, corners), put back on leaving it (`appearance.lookBefore`) | ☑ 2026-10-23 (branch `feat/round0-clean-look`). Rebuilt the same day to `apps/desktop/DESIGN.md` after a review with the design-taste-frontend, Impeccable and Hallmark skills read the first version (Tailwind zinc, Geist, 8px) as the stock generated look: Clean is Signal's palette made flat, Clean Light its light twin on the same hue-250 graphite, corners stay the person's |
| W | Widget workers: measured, ceiling written, no build | ☑ (2026-10-22, design §4c) |
| R0 | Round 0 of the [gap review](../design/customization-gaps-2026-10-22.md): permission handlers (Browser tile asks, views and tools get nothing), forms in views (app and phone page), status by shape with one word list and a screen-reader line, shortcuts made from the keymap, sections that keep unknown keys, `hive config set` refusing unknown paths, theme files without media, widget notices through main; the canvas box clipped, never scrolled, so a press on a tile past its edge lands where aimed | ☑ 2026-10-23 (branch `feat/round0-clean-look`) |
| L1 | The last line, slice 1 ([design](../design/last-line-2026-10-23.md) §6): the daemon's cursor-aware rule, `TileLines` in main with `tile.watchLines` / `tile.lines` (Workspace API 0.34), and a terminal's Layers row saying what its screen last showed, or in amber what its agent waits on; View ▸ Lines | ☑ 2026-10-23 (branch `feat/round0-clean-look`). Not done: steps 2–6 of the design (Allow / Deny in the row, toasts, "last said" and Home through `TileLines`, `detect.chrome`, view `lineSlots`, guests, the CLI); a two-row prompt the shell does not mark shows its top row; a command's question shows on Linux only; not measured on a real GPU |

### Known gaps after Round 0

- **Files a site opens in a Browser tile.** Electron checks the file system right even after the person
  picked a file (the File System Access API), and the check answers no until the site is allowed, so a
  web app that reads a picked file without asking first gets an error. Decide whether a picked file is
  readable without asking, with its own e2e.
- **Font keys in a terminal and on the canvas on other layouts.** The keymap matches `-`, `=` and `0`
  by their place on a US keyboard, so Ctrl+- on a German or French layout and the numpad's keys do not
  size a terminal's text (they always did not). Editors, diffs and plans take what the key types too.
- **`hive config set` under an id.** A wrong key below a valid view id (`views.chrome.canvas.bogus`) still
  prints "normalised" and exits 0.
- **Agents and Browser tile permissions.** With Agent browser control on, an agent can grant a site a
  right over the DevTools protocol (said on the security page).
- Settings keep unknown keys directly under a section only; groups this build rebuilds (`glass`,
  `wallpaper`, `terminal`, `views.layers`) still drop keys a newer build added. Round 1 step 1.
- **A diff's page.** The Diff tile, the Code Workbench's diff, a conflicted file and a tool's diff
  (`PatchView`) keep the diff library's own page: #0a0a0a on every dark preset, a black slab in a
  Dracula, Nord, Solarized Dark or One Dark tile, and white on the light one. Their lines, counts
  and font follow the preset already (`PIERRE_CSS_VARS`).
  - Nothing outside can set the page. Pierre writes `--diffs-dark-bg` from its theme on `:host`
    inside each shadow root, and reads `--diffs-bg-override` nowhere in 1.5.1, so the glass rule
    that clears it (`styles.css`, `html.content-glass [data-pierre-tile]`) does nothing.
  - Pierre's syntax colours are drawn for its page. On a preset's bg2 they fall below 4.5:1: the
    keyword is 3.50:1 on Nord, comments 2.63 to 3.17:1.
  - The change, in `pierre-codeview.ts` for all four: a CSS-variables theme
    (`registerCustomCSSVariableTheme`, for both modes) whose page and syntax are the app's tokens
    (`--color-bg2`, `--color-syntax-*`, comments in fg2, since fg3 is 3.4:1 on Solarized Dark's
    bg2). Then retune `--color-diff-added` / `--color-diff-removed` for that page (−N needs L 0.72
    for 4.5:1 on Nord's bg2) and the row tints, under which syntax already reads 3.7 to 4.6:1 on
    Pierre's page (2.2 to 3.9:1 on a changed word).

## Rounds and PRs

Ready work lands as one combined PR per round (CLAUDE.md):

1. **Sounds**: S1 and S2 in one PR; S3 in its own PR once decided.
2. **Themes in the app**: T0 to T4 in one PR. HiveHub's part of T0 deploys first (see Order of
   deploys).
3. **Light and Harbour**: T5 in hivemind; T6 in hivemind-plugins after a release that carries round 2.

## Decisions

The defaults below are what gets built unless the maintainer says otherwise.

| Question | Default chosen | Why |
|---|---|---|
| Sounds on for everyone after the upgrade? | **No.** `notifications.sound` stays `false` until switched on. Switched on, **needs you** plays; **finished** and **failed** are off until chosen. | A sound nobody asked for after an update is the fastest way to make people switch the app's sounds off for good. |
| Group pop-ups in a burst (S3)? | **Ask first.** It changes what people see: ten pop-ups become one. | A visible change to notifications, so the maintainer says yes before it ships. |
| A theme's accent | **Any colour** (`accent: "custom"` with `accentCustom`), not only the 10 built-in ids. | A brand needs its own colour. Three call sites move to one owner (`accentOf`). |
| Light themes | **Not until T5.** | No light preset exists, and light-mode CSS is one line (`styles.css:501`). |
| Who may change sounds from the CLI | **The person only** (`personOnly`, as `hive plugins set`). | An agent should not be able to make its person's computer chime. |

## S1 — One notice desk in main

**What.** Every window's renderer sends each agent change that matters (`notify:agent`: needs,
done, error) to main. Today main shows a pop-up for each, so two windows double them, and a burst of
ten makes ten. Main gets one owner that:

1. **dedupes**: the first notice for `(tileId, kind)` in 2 s is an event; later copies from other
   windows only merge into it (`selected ||= copy.selected`);
2. **gates the OS pop-up** on the deduped event only (the existing `shouldNotify` and focus rules);
3. **decides a sound**: `shouldNotify(s, kind, "sound")`, a new surface that needs `s.sound`
   and `s.sounds[kind]`. A **finished** sound is skipped while the person is focused on that tile
   (it is selected in the focused window). **Needs you** always plays, and DND never mutes it,
   as today.
4. **paces sounds**:
   - a sound offered waits 150 ms, so copies and a burst gather;
   - the highest pending wins (needs > error > done), counted (`count`);
   - at most one sound every 1200 ms;
   - the rest are dropped, not queued.
5. **sends** `notify:sound {moment, count}` to one window: `userWindow()` (focused, else last
   focused, else any open window).
6. **keeps the last 10 sounds**, played or blocked, for Settings and the CLI
   (`notify:recent-sounds`).

The OS pop-up gets `silent: true` whenever the app plays its own sound for that kind, so the two
never double up.

**Files.**

| File | Change |
|---|---|
| `apps/desktop/src/shared/notification-settings.ts` | `NoticeSurface` gains `"sound"`. `NotificationSettings` gains `sounds: { needs, done, error }` (defaults true/false/false) and `volume` (0–1, 0.6); `sound` keeps its meaning as the master switch. `normalizeNotificationSettings` reads them, an older blob reading as the defaults. The "Reserved … wired later" comment goes. |
| `apps/desktop/src/main/notice-desk-core.ts` (new) | Electron-free: `NoticeDesk` (`admit`, `merge`) and `SoundPacer` (`offer`, `due`). They take `now` and `schedule`, as `CommunityLink` does. The dedupe map is pruned on each admit and capped at 1024. |
| `apps/desktop/src/main/notice-desk.ts` (new) | Wires the core to `notify:agent`, the pop-up (moved from `agent-notify.ts`) and `notify:sound`. |
| `apps/desktop/src/main/agent-notify.ts` | Becomes the pop-up half the desk calls; `silent` set as above. |
| `apps/desktop/src/shared/ipc.ts`, `hive-ipc.ts`, preload | `AgentNotice.selected?: boolean`; channels `notify:sound` (main → one window), `notify:sound-result` (window → main: played or blocked, and why), `notify:recent-sounds` (request). |
| `apps/desktop/src/renderer/src/useAgentAwareness.ts` | Adds `selected` to the notice it already sends. |
| `apps/desktop/src/main/notification-settings-store.ts` | The cache is dropped on the drive socket's `settings.reload`, so a CLI change applies at once. |

**Per-event cost.** One `Map` get and set per notable change; at most one timer. Nothing rescans.
Stated in the commit: a burst of 1500 notices takes under 1 ms (measured in the unit test).

**Done when.**
- Unit tests (`notice-desk-core.test.ts`), each shown failing with what it guards removed:
  - two windows' copies make one event, and one pop-up;
  - 10 done in 1 s make 1 sound with `count` 10;
  - an error and a done together play the error;
  - a second burst inside 1.2 s waits for the gap;
  - DND mutes done and error, never needs;
  - a done for a selected tile in the focused window makes no sound;
  - the map stays at most 1024 entries.
- `notification-settings.test.ts`: an old blob gets the new defaults; bad values fall back.

## S2 — The player, the built-in sounds, Settings and the CLI

**What.**

- **The player.** One player per window (`renderer/src/sounds/player.ts`):
  - a lazily created `AudioContext`, resumed on the first `pointerdown` or `keydown`;
  - one `GainNode` set to `volume`;
  - each sound decoded or rendered once and cached;
  - every request answered over `notify:sound-result`: played, or blocked and why (`suspended`,
    `no audio device`).
- **Built-in sounds.** `renderer/src/sounds/synth.ts` renders them once with an
  `OfflineAudioContext`, so there are no asset files:
  - **needs you**: two rising sine notes, E5 then A5, 90 ms each with a 5 ms attack and a soft
    tail;
  - **finished**: one bell (A5 with a quiet octave, 0.6 s decay);
  - **failed**: two falling triangle notes, A3 then E3.

  Each peaks at −6 dBFS.
- **Notifications ▸ Sounds.** `NotificationPrefs` moves out of `App.tsx` into
  `renderer/src/settings-notifications.tsx` (modular code), with:
  - a master switch, **Play a sound**;
  - a switch per moment, each with a **Play** button;
  - **Volume** on a slider;
  - **Recent sounds** (the last 10: moment, how many agents, when, played or blocked and why).

  It uses `components/ui` only.
- **`hive notifications`.** A new command (`apps/cli/src/commands/notifications.ts`), person-only,
  reading and writing the top-level `notifications` key through the same normalizer:
  - `show [--json]`
  - `set <key> <value>`, where key is one of `enabled`, `inApp`, `osPopups`, `sound`,
    `sounds.needs`, `sounds.done`, `sounds.error`, `volume`, `kinds.*` or `dnd.*`
  - `play <needs|done|error>`: asks the running app over the drive socket and prints the result;
    `UNAVAILABLE` with a fix line when no app is running.
  - `set` calls `settings.reload`.
- **The drive socket.** Gains `notifications.play` (person-only role) and
  `notifications.recentSounds`. `spec/workspace-api.md` gets one line each.

**Files.** The player and synth (new); `settings-notifications.tsx` (new, out of `App.tsx`); the
App root mounts `useSounds()` once per window; `apps/cli/src/commands/notifications.ts` (new,
registered in the CLI index); the drive socket handler for the two methods.

**Done when.**
- An e2e spec, `tests/e2e/sounds.spec.ts`:
  - Turn sounds on in Settings and switch **finished** on.
  - Open a second window.
  - Ten stand-in agents (the `fake-agent.cjs` fixture) finish together.
  - **Recent sounds** shows one entry: finished, 10 agents, played.
  - **Play** on **needs you** adds a played entry.
  - `hive notifications play error --json` answers played.
  - Screenshots of the Sounds section, light and dark (dark until T5).
- Unit tests:
  - the synth's recipe: lengths and peak, read from a rendered buffer where `OfflineAudioContext`
    exists, else skipped and said so;
  - the CLI: `set` checks each key and value, and `play` without an app says `UNAVAILABLE`.
- Guide:
  - **Know who is waiting** gets a Sounds section;
  - the settings reference gets the `notifications.*` keys;
  - the CLI reference gets `hive notifications`.
- CHANGELOG: one line.

## S3 — Pop-ups grouped in a burst (after a yes)

**What.**
- The first pop-up in a burst shows at once.
- Others within 1.5 s gather into one: "9 more agents finished" or "2 agents need you". Its click
  focuses the first agent.
- **Needs you** is never folded into a **finished** pop-up.

**Files.** The `notice-desk*` modules only.

**Done when.**
- Unit tests for grouping by kind and the window.
- One e2e assertion on the pop-ups the desk recorded, the same Recent list, with a pop-ups column.

## T0 — "Needs Hivemind X or newer" for packages and views

**What.** HiveHub records `minAppVersion` for agents and tools today. Views and widgets get `null`
(`plugin-checks.ts:169,194`), and a package takes the highest of its members. An app that does not
know a field refuses the whole manifest (`validateViewManifest` refuses unknown fields; the package
manifest is a `z.strictObject`).

The fix: the version that first accepts each field or member kind lives in one table,
`packages/hive-hub/src/since.ts`:
- `view.widgets` → 2026.10.6
- `view.tokens` → the release with view protocol 1.16
- `package.themes` → the release with T2

The hub sets a view's, widget's and package's `minAppVersion` to the highest entry it uses. The
app's existing install check (`plugin-catalog-ipc.ts:141`, `registry.ts:20`) then says "needs
Hivemind X or newer" before downloading.

**Done when.**
- Hub tests: a view using `widgets` lists 2026.10.6; a package with a theme lists T2's version;
  a package of old-style members lists none.
- An install test on an older app version refuses with that message.
- `docs/operations.md` in the hub says to deploy it before any package with themes is published.

## T1 — Fonts that apply

**What.**
- `uiFont` and `monoFont` are stored but never painted. `--font-ui-user` and `--font-mono-user`
  are set (`theme-store.ts:154-155`) and nothing reads them. The terminal hard-codes JetBrains Mono
  (`TerminalTile.tsx:357`).
- The fix:
  - `--font-sans` and `--font-mono` read the user variables first (`styles.css:164-165`);
  - terminals take `monoFont` (an option change on open terminals, never a remount).
- **Not a trap after all.** The stored default `uiFont` is `"system-ui, sans-serif"` while the app
  drew Geist, and wiring it turns everyone's interface into the system font. That is what
  `apps/desktop/DESIGN.md` decided ("the UI font moves from bundled Geist Sans to the operating
  system's own UI font"), so `DEFAULT_APPEARANCE.uiFont` is the DESIGN.md system stack, the old
  value reads as **System** in the font row, and no migration rewrites anything. (A migration 0005
  that kept Geist was written and removed before release, 2026-10-23.)
- **Fonts from files.**
  - `appearance.fontFaces`: up to 4 entries of `{family, src, weight?, style?}`, each `src` a
    `hivemedia://media/…` woff2.
  - `theme-store` keeps one `<style id="hm-font-faces">` of `@font-face` rules.
  - CSP `font-src` adds `hivemedia:`; `connect-src` adds it for T4's audio fetch.

**Done when.**
- The migration test: the fixture of an old settings.json, the run, the run killed at 20 points
  (`fixtures/runs.ts`), and a run that changes nothing for a custom font.
- An e2e check: a font set through `hive config set appearance.uiFont` is the computed font of a
  button and of a terminal's rows.
- `mergeAppearance` tests for `fontFaces` (a non-`hivemedia:` source refused).

## T2 — The theme member

**What.**
- A package lists `themes`, each a folder with `theme.json`.
- Format, checked by `packages/hive-core/src/theme-format.ts` (pure):

| Field | Required | What |
|---|---|---|
| `name` | yes | up to 60 characters |
| `mode` | yes | `"dark"` (`"light"` from T5) |
| `palette` | yes | all 13 `PALETTE_KEYS`, each a colour `COLOR_RE` takes |
| `accent` | yes | one of the 10 accent ids, or `{brand, accent, working?}` colours |
| `terminal` | no | `background`, `foreground`, `cursor`, `selection` and 16 `ansi`; without it the person's stays |
| `radius` | no | 0–24 |
| `fonts` | no | `{ui?, mono?}`, each `{family, files: [{path, weight?, style?}]}`, `.woff2` only, at most 400 KB each |
| `wallpaper` | no | a built-in kind, or `{image}` / `{video}` with a path in the folder; `brightness` 0.4–1.1 |
| `sounds` | no | `{needs?, done?, error?}`, each `.ogg` or `.mp3`, at most 400 KB (cut to 3 s when played) |

- **Contrast**, checked here: `fg` on `bg` and on `bg2` at least 4.5:1, and `fg2` on `bg` at
  least 3:1. A theme below either is refused, naming the pair. Colour parsing for hex, rgb and
  oklch lives in the same file, with its own tests, because the core has no DOM.
- **Package plumbing.**
  - `MEMBER_FORMATS` gains `{kind: "theme", list: "themes", most: 8, manifest: "theme.json", runs: "nothing: it is data"}`. `MemberRuns` gains that value.
  - `MEMBER_KINDS` gains `inFolders("theme", readThemeMember)`.
  - The hub's package reader lists a theme's files and says what it does: "Changes how the app
    looks and sounds".
- **The custom accent.**
  - `Appearance.accent` may be `"custom"`, with `accentCustom: {brand, accent, working?}`.
  - One owner, `accentOf(appearance)`, replaces the three `ACCENTS[...]` lookups:
    `theme-store.ts:156`, `plugin-theme.ts:19`, `appearance-controls.tsx:111`.
  - `mergeAppearance` takes it; an older app falls back to its default accent, with nothing lost
    in the file.
- **Scaffold.** `hive plugins new theme <name>` writes a `theme.json` from the current look.

**Done when.**
- Format tests: every field, every refusal, the contrast pairs and oklch parsing.
- `hive plugins check` and the hub check on a package with a theme.
- The scaffold test.

## T3 — Apply, revert and update

**What.** One owner, `packages/hive-core/src/theme-apply.ts`, used by both the app (through main)
and the CLI:

- **`applyTheme(settingsFile, pkg, themeName)`**:
  - copies the theme's files into `<settings dir>/media/theme-<digest8>-<file>`;
  - writes `appearance` from the theme on top of the current look (fields it leaves out are kept);
  - sets `fontFaces`;
  - records `appearance.theme = {id, version, appliedAt, before}`, where `before` is the
    appearance before, without its own `theme`, so it never nests.
- **`revertTheme`** puts `before` back.
- **Files.** Those of the applied look and of `before` are kept; older `theme-*` files are removed.

The app:
- **Appearance** lists installed themes next to the presets, with a five-colour swatch as presets
  have, **Apply**, and **Revert to previous look** while `theme` is set.
- **An update notice**: "Harbour 1.2 is installed; you have 1.1 applied. **Apply 1.2**".
- **A removed package** leaves the look, with "(its package was removed)".

The CLI:
- `hive theme list` shows presets and installed themes (`@owner/package/theme`).
- `hive theme use <id>` applies either kind.
- `hive theme revert` goes back one look.
- Each calls `settings.reload`.

A guest in a shared workspace gets the applied colours through `sharedAppearance`, as with
presets; fonts and image wallpaper stay theirs, as today.

**Done when.**
- An e2e spec, `tests/e2e/themes.spec.ts`:
  - install a fixture package with a dark theme (palette, custom accent, a woff2, an image
    wallpaper);
  - apply it from Appearance: the computed `--color-bg`, the UI font and the wallpaper are the
    theme's;
  - revert: they are as before;
  - apply again, remove the package: the look stays;
  - `hive theme use` and `hive theme revert` do the same.
  - Screenshots.
- Unit tests for `applyTheme` and `revertTheme` (partial themes keep the person's fields; `before`
  never nests; file cleanup keeps exactly two looks).
- Guide: the Appearance page (themes) and the Packages page (the theme member). Agent briefs: the
  plugin brief names `hive plugins new theme`.

## T4 — A theme's sounds

**What.**
- Applying a theme with `sounds` copies them like its other files. `appearance.theme.sounds` maps
  each moment to its `hivemedia:` URL.
- The player plays a theme sound when there is one, else the built-in. It fetches and decodes each
  sound once, cuts it to 3 s and scales its peak to −6 dBFS, so a pack cannot be louder than the
  built-in sounds.
- **Recent sounds** says which pack played.

**Done when.**
- An e2e assertion: a theme with a `needs` sound plays it (**Recent sounds** names the pack), and
  the built-in sound plays after revert.
- The loudness cap unit-tested on a decoded buffer, where the test runner has an audio context.

## T5 — Light mode

**What.**
- Add one built-in light preset (`paper`).
- Fix what breaks in light mode, found from screenshots of every Settings page, the canvas, a
  terminal, the Add menu and a widget.
- Then `theme.json` takes `"light"`, and a package may pair a light theme with a dark one.

**Done when.**
- Light screenshots of each of those surfaces, looked at.
- A test that a light theme passes the same contrast pairs.

## T6 — Harbour (hivemind-plugins, after a release with T0–T4)

**What.**
- Archipelago's package gains `themes/harbour`:
  - the sea's blues;
  - a wood accent (custom);
  - a rounded display font (a CC0 or OFL woff2, with its licence in `ASSETS.md`);
  - a still of the islands as wallpaper;
  - three sounds rendered from a script in the repo (`themes/harbour/make-sounds.mjs`): a bell
    for done, two gull-like rising notes for needs, a low horn for error.
- `types/view-sdk` is refreshed.

**Done when.**
- The real app with Archipelago's view, its widgets and Harbour applied, in screenshots.
- `hive plugins check` passes, and the package's `minAppVersion` is what T0 says.

## Order of deploys

1. The hub with T0, before any package lists `themes`.
2. The app release with round 2.
3. Then Harbour is published.

An app older than that release sees "needs Hivemind X or newer" for Archipelago, never a failed
install.

## Definition of done, walked (feature-done)

| # | Surface | This project |
|---|---|---|
| 1 | CLI | `hive notifications show/set/play`; `hive theme list/use/revert` with package themes; `hive plugins new theme`. |
| 2 | App UI | Notifications ▸ Sounds with Recent sounds; Appearance lists themes, with Apply, Revert and the update notice. Screenshots of every state. |
| 3 | Phone | Sounds: n/a, since the phone's push uses the phone's own sound. Themes: do not reach the phone (its colours are native, `ViewLook.swift`, `ViewLook.kt`). Said on the Appearance page. |
| 4 | Guide | Know who is waiting (Sounds); Appearance (themes); Packages (theme member); settings and CLI references. |
| 5 | Agent briefs | The plugin brief: how to make a theme. Agents cannot change the person's sounds or theme (person-only), and the briefs say so. |
| 6 | READMEs | hivemind-plugins README: packages can hold themes. Archipelago's README: Harbour. |
| 7 | HiveHub | T0 (`since.ts`), the theme member checked and listed, deploy order in its `docs/operations.md`. |
| 8 | hivemind-plugins | Harbour, the SDK copy refreshed, CI against main and the release. |
| 9 | Local data | No migration: the stored font default already names the system font. New fields are additive and read as defaults when absent: `notifications.sounds` and `volume`; `appearance.theme`, `fontFaces` and `accentCustom`. No migration needed for those, since no stored value changes meaning. |
| 10 | Contracts | The package manifest gains `themes`; older apps are handled by T0. No protocol bump. The drive socket gains two methods, an API minor version. |
| 11 | Security | Themes carry no code. Each file is typed and sized at install and copied into the media folder at apply. CSP adds `hivemedia:` to `font-src` and `connect-src` only. Sounds are capped for length and loudness. Notification and theme changes from the CLI are person-only. |
| 12 | Tests | As each step's **Done when**. Each new test is shown failing with what it guards removed, and the e2e specs run once per round. |
| 13 | CHANGELOG and release | One line per round. Release after round 2, before T6. |
| 14 | Cleanup | The "Reserved … wired later" comment. `importWallpaper` (exposed, no caller, per audit) is removed once a theme's wallpaper copy owns that job, if still unused. `NotificationPrefs` out of `App.tsx`. |

## How to resume in a new session

1. Read this file, then the design's section for the step in progress.
2. `git fetch origin && git log --oneline origin/main..HEAD` on the round's branch.
3. `pnpm install`, then the checks.
4. Work the step. When it moves, update **Status** here in the same commit.

## Checks

```bash
pnpm --filter @hivemind/desktop exec tsc --noEmit -p tsconfig.web.json   # and tsconfig.node.json
cd apps/desktop && npx tsx --tsconfig tsconfig.web.json --test tests/unit/<touched>.test.ts
cd packages/hive-core && bun test src/<touched>.test.ts
cd apps/cli && bun test tests/<touched>.test.ts
cd apps/desktop && scripts/e2e.sh sounds themes      # once per round, on a quiet machine
cd site && npm run guide && node scripts/check-links.mjs
```
