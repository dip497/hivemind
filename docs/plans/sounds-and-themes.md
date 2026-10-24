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
   - **Decided 2026-10-23 (T2):** a theme's accent, or a colour the person picks for the accent,
     also colours the primary button, the focus ring and a switch that is on (`html.accent-marks`,
     `--primary`, `--ring`); the built-in presets with a built-in accent keep the monochrome look.
     The button's text is the palette's fg or bg, whichever reads at 4.5:1 on the accent. A theme's
     accent must read 3:1 on its page and its panels, `bg` and `bg2` (a mark; `bg2` from 2026-10-24)
     and is never amber or the colour of "needs you"
     (palette.warn, within 0.05 in OKLab): the accent is not a signal (DESIGN.md).

## Status

| Step | What | State |
|---|---|---|
| S1 | One notice desk in main: dedupe across windows, sound gate and pacing | ☑ 2026-10-23 (branch `round1/sounds`): notifications are the `notifications` section of the one settings.json (`@hivemind/core/notification-settings`), migration 0006 moves the app data folder's blob in; `hive config get/set notifications` work, person-only. `notice-desk-core.ts` (dedupe, `SoundPacer`, Recent) and `notice-desk.ts` in main; `agent-notify.ts` is the pop-up half (`silent` while the app plays its own sound). Last line step 4: `notifications.popupText` (off by default) puts the wait or the last line in a single agent's pop-up (`popupTextOf`, `lineFor` shared). 1500 notices: 2–6 ms in the unit test on a loaded shared container (the 1 ms target not shown there). Review fixes 2026-10-24 (branch `fix/sounds-review`): copies carry the host's `since`, so a window that sees a change seconds late no longer counts it again (the e2e showed 2–4.5 s between two windows); 0006 backs up nothing where it moves nothing; the theme's sound comes from the settings owner's typed record, its file stat'ed before it is read; Play and Recent go over the workspace API, not IPC of their own. Cost: 1500 changes from two windows (3000 notices) and their timers 6–7.5 ms in the unit test; in the built app (xvfb, 4 CPUs) the `notify:agent` handler took 37–43 ms for those 3000, against 10–16 ms for 3000 refused at the door; the base's desk took 26–48 ms, the same within noise |
| S2 | The sound player, built-in sounds, Notifications ▸ Sounds, `hive notifications` | ◐ 2026-10-23 (branch `round1/sounds`): `sounds/player.ts`, `synth.ts` (pure sample math, not `OfflineAudioContext`: the same in every window and tested without one), `level.ts`, `useSounds()` in App; `settings-notifications.tsx` (out of `App.tsx`) with Sounds, Play, Volume, Recent and "Show commands and questions"; `hive notifications show/set/play`, person-only; drive socket `notifications.play` / `notifications.recentSounds` (0.35). ☑ 2026-10-24: `sounds.spec.ts` ran (2 passed, xvfb): ten agents in two windows make one burst, played in one window for all ten, one of them selected in a window without the focus; Play and `hive notifications play` played. It had never passed: its agents were spawned `--no-report`, as background workers, which tell no one. `hive notifications set` and `hive config set notifications.*` share one check (`notificationSettingProblem`) |
| S3 | Pop-ups grouped in a burst ("10 agents finished") | ☑ 2026-10-23 (branch `round1/sounds`; the person's "complete all the rounds" is the yes): the first pop-up of a kind at once, the rest within 1.5 s as one ("9 more agents finished"), each kind on its own, the click on the first gathered; Recent counts each burst's pop-ups. Its e2e assertion (2 pop-ups for the ten) ran 2026-10-24 |
| T0 | HiveHub works out "needs Hivemind X or newer" for packages and views | ☑ 2026-10-23 (branch `round2/hub-views`): `packages/hive-hub/src/since.ts` (`view.widgets`, `view.tokens`, `package.themes`, and from 2026-10-24 `view.files`, all 2026.10.6) gives views, widgets and packages a `minAppVersion`; one message for the app and `hive plugins install` (`needsNewerApp`); a package lists only its own and its members' files. HiveHub needs no code change (branch `t0/since` there: a test and the deploy order in `docs/operations.md`). A package with `themes` is checked through `sinceOf` until Track C's member lands; then add a folder test |
| T1 | Fonts that apply (the system font by default, CSS, terminal, `@font-face` from `hivemedia:`) | ☑ 2026-10-22; `@font-face` from `hivemedia:` 2026-10-23 with T2's font files (branch `round2/themes`: one `<style id="hm-font-faces">`, rewritten only when the faces change; CSP `font-src`/`connect-src` gain `hivemedia:`; views get the bytes in `hello` and a `fonts` message, view protocol 1.17, since `new FontFace(name, bytes)` loads in a sandboxed frame even under `font-src 'none'`, probed in Chromium). Before that: the settings drive the app, terminals (live, atlas redrawn), diffs and the editor; no migration (a file holding the old default `system-ui, sans-serif` is read as the system font, so nothing on disk changes); Settings ▸ Appearance has Interface font and Code font |
| T2 | The theme member: `theme.json`, its checks, a custom accent | ☑ 2026-10-23 (branch `round2/themes`): `theme-format.ts` (format 1, reserved parts, every field, contrast pairs, accent never amber or warn and 3:1 as a mark), `MEMBER_FORMATS` `themes` (runs: nothing, it is data), the hub's reader, `hive plugins new theme`, `hive plugins check`. Custom accent in `appearanceExtra.accent`, one owner `accentOf()`, a picker for any colour. Review fixes 2026-10-24 (branch `fix/themes-review`): `cssColorToRgb` strict (three parts, the units CSS takes, hue units, nothing after; `parseCssColor` reports alpha, any refused); contrast floors pinned a step either side; one theme reader `readTheme` (+ `THEME_FOLDER_RE`, `THEME_DEPTH`) for the app and HiveHub; one member-id rule per kind (`memberIdRe`) so the hub index takes `@owner/package/theme`; picture and video capped at HiveHub's 2 MB, and `hive plugins check` sizes a package as the hub does (`sizeProblem`); `hive plugins new package` writes no empty member list; `hive plugins add` takes a theme folder; export/import carry `accentCustom`. 2026-10-24 (branch `fix/theme-polish`, from Harbour's real-app screenshots): the accent's mark is held to 3:1 on `bg2`, the panels and menus where a switch that is on and a slider's thumb are drawn, as well as on `bg` (`ACCENT_SURFACES`, `accentMark`, also behind Appearance's "hard to see" note, which names the surface); a stricter check, said in the CHANGELOG. Refusal rows a step either side of 3:1 on each surface, each shown failing with its surface left out; the note's e2e (`settings-appearance`) shown failing with bg only. `themeSwatches` is the strip for presets too and shows bg, fg, accent, ok and err (it was bg, bg3 and the terminal's ground, 0.008 apart in OKLab in Harbour); unit-tested that no two of a strip are within 0.05 in OKLab in any preset or theme, shown failing with the old choice |
| T3 | Apply, revert and update a theme: app, CLI, files copied | ☑ 2026-10-23 (branch `round2/themes`): `theme-apply.ts` for main and the CLI; files to `media/theme-<digest8>-<file>`; record and `before` in `appearanceExtra.theme`; cleanup keeps two looks; Appearance lists themes with Apply, Revert, the update notice and "(its package was removed)"; `hive theme list/use/revert`; guests get the custom accent's colours. A theme's wallpaper draws without glass. `tests/e2e/themes.spec.ts`: 4 passed under xvfb 2026-10-23 (caught with `hivemedia:`'s CORS removed). Not measured on a real GPU. Review fixes 2026-10-24 (branch `fix/themes-review`): the record names what the theme set (`set`, `THEME_SET_PATHS`), applying writes only those and Revert puts back only those; faces merge one by one; the old record is replaced (`{ replace }` touched path); apply and revert run under a media lock (`media/.lock`) and cleanup reads the file on disk; a face is read only while its font names its family; one owner for what a preset clears (`PRESET_CLEARS`). Every custom scheme is now registered in main's one `registerSchemesAsPrivileged` call: the view scheme's second call had dropped `hivemedia:`'s Fetch API, so no view got a theme's font bytes. themes.spec: 6 passed under xvfb 2026-10-24 (the view's faces caught with `fonts` or the hello spread removed, and with the second scheme call back; the wallpaper with `wallpaper-on` removed; CORS with the origin check removed). The packages diagram shows themes |
| T4 | A theme's sounds | ☑ 2026-10-23. File half (branch `round2/themes`): copied on apply, `appearanceExtra.theme.sounds` maps each moment to its `hivemedia:` URL; 2026-10-24 the copy and cleanup run under the media lock, so two applies at once keep the applied theme's sounds. Player half (branch `round1/sounds`): `appearanceExtra.theme.sounds[moment]` plays instead of the built-in: main hands its bytes to the window (`notify:theme-sound`, the applied theme's URLs only; a window cannot fetch `hivemedia:`), decoded once per URL, cut to 3 s and leveled to −6 dBFS; Recent names the pack, and says why when the built-in played instead. 2026-10-24 e2e: the pack plays, a file that does not decode plays the built-in and says why, and a window is refused any file but the applied theme's (a `file:` URL, another media file, one over 1 MiB). The "suspended" answer is not driven: the spec runs with autoplay allowed |
| T5 | Light mode audited, a light preset, light themes allowed | ◐ 2026-10-22: the app's dark-only sites follow the mode (page, toaster, editor, diffs, PatchView, diagrams, fullscreen chrome), main sets `nativeTheme` and the window background, light tokens for shadows, grid and syntax; **Clean Light** ships. 2026-10-23: an audit of the 41 views, widgets and tools found 38 colour bugs in Signal and Clean Light, 28 in hivemind-plugins (branch `feat/focus-view`) and 10 in the app; all fixed, with one more found while checking (Island's and Archipelago's ring round a calling agent faded to black on a sunlit sea). Open: a diff's page (Known gaps). 2026-10-23: light themes from packages (`mode: "light"`, the same contrast pairs, tested; a package may hold a light and a dark theme). 2026-10-23 (branch `round2/hub-views`): agent TUIs follow a light/dark change, at the terminal tile's xterm (`theme-notify.ts`): mode 2031 (`CSI ? 2031 h/l`, `CSI ? 996 n`, `CSI ? 997 ; 1/2 n` on a change, kept per session across a remount, sent by the window holding the keys) and `COLORFGBG` at spawn. Probed: Claude Code 2.1.309 sends `CSI ? 2031 h` at launch and parses `997`; Codex 0.164.0 and Gemini CLI 0.65.0 send OSC 11 once at launch, enable no 2031 and query nothing on focus-in (signed out, first screen), so they follow on a restart only. An unasked OSC 11 reply was not built: no terminal sends one and a program reads it as input. The phone page's terminal does not answer 2031. 2026-10-24 (branch `fix/themes-review`): light screenshots, in Clean Light under xvfb, of every Settings page (10), the canvas, a terminal with the 6 ANSI colours, the Add menu and a sticky note, looked at: nothing reads wrong; the note's "Write something" placeholder is faint on its yellow, as a placeholder is. 2026-10-24 (branch `fix/hub-views-review`, review items 2 and 4): the daemon's screen worker keeps 2031 per screen and replays `CSI ? 2031 h` with the attach modes, so a window that attaches after a restart, a reload or in another window learns it; the renderer keeps one `ThemeNotify` per mounted terminal (the module map is gone), reset in place when the program exits so Enter's next program is followed; a set, and a window gaining the keys, tells the program where the background is now. xterm 6.1 answers 2031 itself (`vtExtensions.colorSchemeQuery`, on by default): turned off, since it reported on every colour change and read a glass terminal as dark, and it doubled every report. e2e `theme-notify` (a probe that turns 2031 on): a switch reported after a reload, and once after the shell restarts; shown failing without the replay, with the split instance, and with xterm's own on. The gaining-keys report is unit-tested only |
| VF | A view fetches its own files ([gap review](../design/customization-gaps-2026-10-22.md) §7 item 12) | ☑ 2026-10-23 (branch `round2/hub-views`): `connect-src` names the view's own origin (`ownFiles`, `hm-view://<host>`), and in a browser tab its own path on the server (`withOwnFiles` in `browser-server.ts`); `'none'` on the phone page, which the guide says. HiveHub lists only a package's own and its members' files (T0). e2e `view-sandbox`: own JSON read, a neighbour's refused, the network refused; shown failing with `connect-src hm-view:`. 2026-10-24 (branch `fix/hub-views-review`, review items 3, 11, 16, 18): every source list (script, style, img, font, media) names the view's own address, not `'self' hm-view:` (kept only on the phone page, which knows no address), and `withOwnFiles` rewrites each in a tab; the entry page's module script carries no nonce (a module's imports inherit it, so `import()` reached any address); a view declares `"files": true` to fetch at all and is told `ownFiles` in `hello.features` (protocol 1.17; the app's window and a tab, not the phone nor a guest window), `SINCE["view.files"]`; `viewBase` in `browser-socket.ts` owns a view's tab path. e2e `view-sandbox`: a neighbour's picture, stylesheet and module refused, encoded `..%2f` reads give a status; shown failing with the old source lists and with the nonce back |
| OV | "Open Archipelago?" after a package with `startup.view` is installed (gap review §7 item 11, app side) | ☑ 2026-10-23 (branch `round2/hub-views`): `PackageReview.opens` (main reads `startup.view`), `plugins/open-start-view.tsx` offers it in Settings → Plugins after an install from HiveHub or a folder, only when the package is on; **Open** switches the view and closes Settings. Not offered from the Add menu or `hive plugins install`. e2e `packages-tab`, shown failing with `opens: null`. 2026-10-24 (branch `fix/hub-views-review`, review items 12, 13, 15): core's install result carries `startView` (from the manifest `readPackage` checked), so main no longer reads and parses the manifest a second time; e2e rows for an install from the HiveHub list (a staged catalog package) and for a package that arrives switched off (no offer), each shown failing. Not built: an offer on a plugin's own page, because a package has none (the library lists a HiveHub package on its own row, and plugin pages are for agents, views, widgets and tools). 2026-10-24 (branch `fix/start-view-cli`): offered after `hive plugins install` too, while the app runs or before it started. One owner in main, `start-view-offers.ts`: a window asks after it loads its views (naming the views it has and the one it shows), main offers each on package whose start view it has not offered and records it per package (version and view) in userData `start-view-offers.json`; Settings' own installs record theirs. An update is offered again only when it opens with another view. Shown as a toast with the same `OpenStartView`, in the window the person is at. The CLI prints the view and `hive ctl plugin open view:<id>`; `--json` carries `startView`. The Add menu installs only tools and widgets, so it has no offer to make. Unit `start-view-offers.test.ts`, CLI `plugin-packages.test.ts`, e2e `start-view-cli`, each shown failing |
| T6 | Archipelago ships the **Harbour** theme (hivemind-plugins) | ◐ 2026-10-24: built in hivemind-plugins (branch `feat/focus-view`, `packages/archipelago/themes/harbour`), checked by `tests/harbour-theme.test.ts` and in the real app by `e2e/harbour.spec.ts` (Apply, the view, Revert, `hive theme use/revert`; screenshots). Its real-app screenshots found five things, fixed the same day (branch `fix/theme-polish` here, plugins commit `6e85b75`): the wood accent read 3.16:1 on bg but 2.92:1 on bg2, which the app's check did not look at (now it does, T2), and the wood is raised to `oklch(0.53 0.075 45)`, 3.30:1 on bg and 3.05:1 on bg2, the main button's words (fg) 4.55:1 on it; the selected tile's handle read 1.98:1 against the pixels touching it over an island, now 3.05:1 on a ring of the panel colour, and the tile count and a frame's name sat on bare wallpaper (2.10:1 and 1.27:1 over the brightest foam) and now sit on the panel colour, whenever a wallpaper is drawn, glass or not (`html.wallpaper-drawn`, CSS only; e2e `themes`, shown failing with the class, each of the three rules, and the backing see-through); the five swatches showed three near-identical navies (now bg, fg, accent, ok, err, none within 0.17 in OKLab); a grey cloud in the wallpaper's top-left corner (2.47:1 against the sea between the Layers panel and the toolbar) is cropped out, 1.02:1 there now. Measured on screenshots at 1440×900 under xvfb, before and after. Not published: waits for the release with T0–T4 |
| C | **Clean** and **Clean Light** presets; corners (`appearance.radius`) that apply; a preset `look` (glass, wallpaper, corners), put back on leaving it (`appearance.lookBefore`) | ☑ 2026-10-23 (branch `feat/round0-clean-look`). Rebuilt the same day to `apps/desktop/DESIGN.md` after a review with the design-taste-frontend, Impeccable and Hallmark skills read the first version (Tailwind zinc, Geist, 8px) as the stock generated look: Clean is Signal's palette made flat, Clean Light its light twin on the same hue-250 graphite, corners stay the person's |
| W | Widget workers: measured, ceiling written, no build | ☑ (2026-10-22, design §4c) |
| R0 | Round 0 of the [gap review](../design/customization-gaps-2026-10-22.md): permission handlers (Browser tile asks, views and tools get nothing), forms in views (app and phone page), status by shape with one word list and a screen-reader line, shortcuts made from the keymap, sections that keep unknown keys, `hive config set` refusing unknown paths, theme files without media, widget notices through main; the canvas box clipped, never scrolled, so a press on a tile past its edge lands where aimed | ☑ 2026-10-23 (branch `feat/round0-clean-look`) |
| L1 | The last line, slice 1 ([design](../design/last-line-2026-10-23.md) §6): the daemon's cursor-aware rule, `TileLines` in main with `tile.watchLines` / `tile.lines` (Workspace API 0.34), and a terminal's Layers row saying what its screen last showed, or in amber what its agent waits on; View ▸ Lines | ☑ 2026-10-23 (branch `feat/round0-clean-look`). Not done: steps 2–6 of the design (Allow / Deny in the row, toasts, "last said" and Home through `TileLines`, `detect.chrome`, view `lineSlots`, guests, the CLI); a two-row prompt the shell does not mark shows its top row; a command's question shows on Linux only; not measured on a real GPU |
| R1 | Round 1 foundation ([gap review](../design/customization-gaps-2026-10-22.md) §7 items 6–7, branch `round1/foundation`): `feat/tokens-settings-v2` merged (plugin settings v2, a view's own colours, view protocol 1.16); settings.json written by one owner (`settings-write.ts`): a write applies only the paths it changed onto the file's own JSON and normalising happens on read, so every key and value a newer build wrote survives (top level, sections, every group), `v` read and never lowered; `hive config set` checks keys below a view or plugin id; the plugin contract frozen | ☑ 2026-10-23: the tokens branch merged; settings writer done with unit tests; plugin contract frozen with unit tests and e2e `plugin-contract.spec.ts`. 2026-10-24 review fixes (`fix/foundation-review`): a removal deletes only what this build read, a touched object is diffed (lists written only when changed), only `__proto__` refused, `patchSettingsExtras` merges; one rule for presets (`presetPaths`) and imports (`themeImportPaths`) in the CLI and the app; the app writes plugin records, toolbars, chrome and notifications at their narrowest paths; Theme on a colour setting stores ""; token defaults own keys only. e2e `plugin-contract.spec.ts` (now also: a fixture view told all 15 colours as #rrggbb in its hello and each theme, dark and light, glass on and off) and `plugin-looks.spec.ts` (its light check now asserted via `dataset.themeMode`; a colour field with a colour default reaches the theme's) both passed under `xvfb-run -a`, and both failed with their fix removed. Not done: the app does not tell the person in its window that settings.json is from a newer version (only `hive config get` does); the web phone page's colour map is still written by hand (the iOS and Android tests hold all 15) |
| L2 | The last line, steps 2, 3, 5 and 6 ([design](../design/last-line-2026-10-23.md) §6), Workspace API 0.35 (branch `lastline/steps-2-6`) | ◐ 2026-10-23. Step 3: "last said" moved into `TileLines` (read asynchronously, one at a time, only for followed tiles, as each agent reports, and only what it wrote since), Home works out only its lines on a line change, `tile.readLines` one-shot read; the old per-refresh `LastSaid` and both adapters' rules deleted. Step 2: Deny / Allow (or Review) in the row band, the review popover, the hover card's whole line, toasts filled in place (same id per tile), done toasts with the line (`tile.readLines`); e2e `layers-decide` run green (the row at the panel's width offers Review for Claude's usual command). Slice 1's gaps: an unmarked two-row prompt whose last row opens with `❯` or `╰─` is passed over whole (another shape still shows its top row); a command's question on macOS through the pty's foreground name (written, not run on a Mac; Windows cannot tell); `detect.chrome` in manifests, Claude's probed (2.1.309), every other agent not installed here, so not probed. Step 5: view protocol 1.17 `lineSlots` (`lineRects`, `hm.setLineRects`, the fake host, the desktop's `LineSlots`; phone and remote screens do not say it), the custom-view skill and the view reference; `round1/foundation` (1.16) merged first. Focus adopting it is in hivemind-plugins. Step 6: `terminal.watchActivity` kept per connection (`TileActivity` in packages/host, the meter moved there); `line` in `hive ctl agents` (one `tile.readLines`); guest windows get the host's lines and activity on their own stream (`watch-split.ts`; e2e `multiplayer-lines` run green with a debug hive-net; a reconnect does not send the watch again). Step 4 (the OS-notification opt-in) is another track's. Not measured on a real GPU. Review fixed 2026-10-24 (branch `fix/lastline-review`): inline Allow only for input that is one short line of plain text as written (`inSight`), Review and the hover card show raw lines to 4,000 characters; buttons keyed by the wait's `since` and armed after 500 ms; line slots offer Review only, naming the tile; a report of an unfollowed tile marks it stale, read by `tile.readLines`, Home and a new watch; a catch-up read more than 1 MiB behind reads the tail (50 MiB gap: 300 ms read, 265–292 ms loop stall → 2–3 ms, ≤2 ms); `runsHere` keeps a remote agent's screen line and stops per-event lookups (a local agent with no file yet is looked for per new session or every 3 s); "last said" through `oneLine`; `hive host` measures activity. Open: Claude's `detect.chrome` is only in the test fixture (`packages/hive-agents/tests/fixtures/published-agents/claude/agent.yaml`); the published manifest in hivemind-plugins waits for an app release that reads the key (until then no installed app would use it) |

### Known gaps after Round 0

- **Files a site opens in a Browser tile.** Electron checks the file system right even after the person
  picked a file (the File System Access API), and the check answers no until the site is allowed, so a
  web app that reads a picked file without asking first gets an error. Decide whether a picked file is
  readable without asking, with its own e2e.
  - Not decided yet (2026-10-23, branch `round2/hub-views`): the e2e cannot pick the file. With
    Playwright's file chooser on, Chromium aborts the site's `showOpenFilePicker()` ("Intercepted
    by Page.setInterceptFileChooserDialog()", measured on Electron 44.5.1); without it a native GTK
    dialog opens, which nothing in the harness answers (no xdotool), and the JS `dialog` module is
    not the picker's. A drop gives no handle either (a synthetic `DataTransfer`). Next: answer the
    GTK dialog from the harness, or find the request's `details` (`fileAccessType`, `isDirectory`)
    on a real desktop first; the likely rule is Chrome's, a picked file readable at once, writing
    and a picked folder asked.
- ~~**Font keys in a terminal and on the canvas on other layouts.**~~ Closed 2026-10-23 (branch
  `round2/hub-views`): `pressIs` in `@hivemind/view-sdk/commands` matches a sign as the layout types
  it, its US place only when the layout types no other sign there or shift made its US pair, and a
  digit on the top row or the number pad. 2026-10-24 (branch `fix/hub-views-review`): a pad key is a
  digit only while Num Lock makes it type one, and `actionsFor` lets a row named by a sign win over a
  digit's place, so French Ctrl+6 (`-`) sizes text and tile 6 has no key on AZERTY; the editor's font
  keys follow the terminal's rule only.
- **Agents and Browser tile permissions.** With Agent browser control on, an agent can grant a site a
  right over the DevTools protocol (said on the security page).
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
| Group pop-ups in a burst (S3)? | **Yes** (2026-10-23: "complete all the rounds"). It changes what people see: ten pop-ups become one. | A visible change to notifications, so the maintainer said yes before it shipped. |
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
   (`notifications.recentSounds` on the workspace API).

The OS pop-up gets `silent: true` whenever the app plays its own sound for that kind, so the two
never double up.

**Files.**

| File | Change |
|---|---|
| `apps/desktop/src/shared/notification-settings.ts` | `NoticeSurface` gains `"sound"`. `NotificationSettings` gains `sounds: { needs, done, error }` (defaults true/false/false) and `volume` (0–1, 0.6); `sound` keeps its meaning as the master switch. `normalizeNotificationSettings` reads them, an older blob reading as the defaults. The "Reserved … wired later" comment goes. |
| `apps/desktop/src/main/notice-desk-core.ts` (new) | Electron-free: `NoticeDesk` (`admit`, `merge`) and `SoundPacer` (`offer`, `due`). They take `now` and `schedule`, as `CommunityLink` does. The dedupe map is pruned on each admit and capped at 1024. |
| `apps/desktop/src/main/notice-desk.ts` (new) | Wires the core to `notify:agent`, the pop-up (moved from `agent-notify.ts`) and `notify:sound`. |
| `apps/desktop/src/main/agent-notify.ts` | Becomes the pop-up half the desk calls; `silent` set as above. |
| `apps/desktop/src/shared/ipc.ts`, `hive-ipc.ts`, preload | `AgentNotice.selected?: boolean`; channels `notify:sound` (main → one window), `notify:sound-result` (window → main: played or blocked, and why), `notify:theme-sound` (a theme's file). Recent and Play are the workspace API's `notifications.recentSounds` and `notifications.play`. |
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
| 5 | Agent briefs | The plugin brief: how to make a theme, its file sizes, `hive plugins add` for a theme folder. Sounds are person-only. Looks stay agent-drivable when the person asks (Read first §5): an agent builds, checks and previews a theme, and Revert is one step. |
| 6 | READMEs | hivemind-plugins README: packages can hold themes. Archipelago's README: Harbour. |
| 7 | HiveHub | T0 (`since.ts`), the theme member checked and listed, deploy order in its `docs/operations.md`. |
| 8 | hivemind-plugins | Harbour, the SDK copy refreshed, CI against main and the release. |
| 9 | Local data | Migration 0006 moves the notification blob from the app data folder's settings.json into the one settings.json (0005 skipped: dropped before release). The stored font default already names the system font. Themes add one top-level key, `appearanceExtra` (`accent`, `fontFaces`, `theme`), which older builds keep (Read first §1); `appearance.accent` keeps a built-in id they read, so nothing stored changes meaning. New notification fields are additive and read as defaults when absent: `notifications.sounds`, `volume` and `popupText`. Files a theme brings go to `media/theme-*` and are removed at the next apply or revert when neither the look nor `before` names them; a preset that drops the record leaves them until then. |
| 10 | Contracts | The package manifest gains `themes`; older apps are handled by T0. `theme.json` carries `format: 1`. View protocol 1.17: feature `fontFaces` (`hello.fontFaces`, message `fonts`) and feature `lineSlots` (`setLineRects`). Workspace API 0.35: `notifications.play`, `notifications.recentSounds` and `tile.readLines`; `appearance.get` and `appearance.changed` are `SharedAppearance`, gaining `accentCustom` (additive). |
| 11 | Security | Themes carry no code. Each file is typed and sized at install and copied into the media folder at apply. CSP adds `hivemedia:` to `font-src` and `connect-src` only. Sounds are capped for length and loudness. Notification changes from the CLI are person-only; looks stay agent-drivable when the person asks (Read first §5). `hivemedia:` answers CORS for the app's page only (tested with Origin null and another site). |
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
