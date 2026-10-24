# Sounds, shippable themes, and widget workers — plan (2026-10-22)

Status: proposal. Written with the `lets-build-pyramids` review. Continues
`customization-2026-10-21.md`; it corrects that doc's widget-worker estimate with a measurement.

## Verdict

| Feature | Decision |
|---|---|
| **Sounds** | Build it. Main already receives every window's "agent needs you / finished / failed". It becomes the one place that dedupes those across windows, keeps a burst to at most one sound every 1.2 s, and tells **one** window to play. That window decodes each sound once and plays it through one shared audio player. The built-in sounds are synthesized, so there are no audio files and no licences. A theme can replace them later. |
| **Themes a package ships** | Build it, the way presets work today: **copy on apply**. Choosing a theme writes its values into `appearance` and copies its fonts, wallpaper and sounds into the app's media folder. It also keeps the look you had before, so **Revert** is one click. |
| **One worker per widget kind** | **Don't build it now.** Measured in the built app, a placed code widget costs **2.0–2.7 MB**, not the ~10 MB the earlier design estimated. Thirty cost about 78 MB. Sharing a worker would save that, but one widget's error or busy loop would then stall every copy of it. Instead, write the ceiling down and set the trigger for building it. |

What the review turned up:

1. **Ten agents finishing makes ten pop-ups and ten dock bounces today**, and with two windows open, possibly twenty. Nothing coalesces them. The sound work fixes this for pop-ups too, because the same dedupe sits in front of both.
2. **The font settings have never worked.** `uiFont` and `monoFont` are stored and set as `--font-ui-user` and `--font-mono-user` (`theme-store.ts:154-155`), but no CSS reads either variable. Theme fonts need that fixed first.
3. **There is no light theme.** All six presets are dark, and the only CSS for light mode is `color-scheme: light` (`styles.css:501`). The first light theme a package ships would also be the first test of light mode. So themes start dark-only, and allowing light ones is its own step.
4. **Copy on apply suits sharing.** When you share your workspace, guests get your look as values (`sharedAppearance`), not as a package id. A theme applied by reference would show nothing to a guest who lacks the package. A theme applied by copy shows the same as a preset.

## 1. Problem

**Goals.**
1. An agent that needs you, finishes or fails can make a short sound, once, however many windows are open and however many agents change at the same moment.
2. A package can ship a look: colours, fonts, wallpaper and sounds. The person applies it in one click and undoes it in one.
3. Widgets cost memory in proportion to what they do, not to how many copies are placed.

**Constraints.**
- Agent status is per-event work (CLAUDE.md, "Work that runs per event"): no rescanning, bounded work, and nothing new that is N at once.
- A theme carries no code.
- The person's choice always wins, and undo is one step.
- Appearance is per machine (settings.json). Guests in a shared workspace get the host's look as values (`sharedAppearance`, `packages/host/src/appearance.ts`).

**Real numbers.**

| What | Number | Source |
|---|---|---|
| Window process memory with 0 / 1 / 10 / 30 Ship's log widgets placed | 180.5 / 185.6 / 203.7 / 258.5 MB | measured: built app, `app.getAppMetrics()` "Tab" working set, median of 5 reads after 8 s |
| Cost of one code widget | 5.2 MB for the first, about 2.0 MB each up to 10, about 2.7 MB each up to 30 | same |
| Windows that run widget workers | one, the runner window, not each window | `widget-runtime.ts` (`runner`) |
| Published widgets that touch worker globals directly (`self.`, `postMessage`, `onmessage`) | 0 of 15 | grep of hivemind-plugins |
| Published widgets that use timers | 13 of 15 | same |
| Sounds the app plays today | none | no `AudioContext` or `Audio(` in the app |
| Where "needs / done / error" is decided | in each window's renderer (`useAgentAwareness.ts:149-222`) | audit |
| What main receives | `notify:agent` from every window, not deduped and not coalesced (`agent-notify.ts:31-67`) | audit |
| OS pop-up | not `silent`, so the OS may play its own sound (`agent-notify.ts:48`) | read |
| Notification settings | top-level `notifications` in settings.json, outside the schema; `sound` stored but unused (`notification-settings.ts:32`) | read |
| Appearance tokens the theme writes | about 21 of 155 custom properties; palette 13 keys, accent one of 10 ids, 11 wallpaper kinds, 6 presets (all dark) | `settings-schema.ts:48-222`, `theme-store.ts:126-161` |
| Hub limits a theme lives within | 2 MB per file, 8 MB per package | `plugin-checks.ts:12-14` |
| Which schemes the renderer may load media and fonts from | media: `hm-media:` and `hivemedia:`; fonts: `'self'` and `data:` only | `renderer/index.html:14` |

**Which known problems these are.**
1. **Notification coalescing**: debounce and priority, with one place that decides.
2. **Theme distribution**: a theme as a package of values, as VS Code and Zed do it, applied as a snapshot or by reference.
3. **Isolate-per-instance against isolate-per-kind**: the cost of an isolate against how far a fault spreads.

## 2. What others do

- **Electron `Notification`** ([API](https://electronjs.org/pt/docs/latest/api/notification)).
  - What it does: `silent` mutes the OS sound. `sound` picks a named or custom sound, on macOS only.
  - What it teaches here: OS sounds can't be themed across platforms, so the app plays its own audio and sets `silent: true` on its pop-ups so they don't double up.
- **Cursor's forum** ([report](https://forum.cursor.com/t/macos-notification-banners-from-cursor-have-no-sound-despite-all-settings-enabled/158073)).
  - What it does: a user reports that Electron banners on macOS arrive with no sound whatever the user's settings.
  - What it teaches here: relying on the OS for the sound fails silently.
- **Chromium autoplay policy** ([rationale](https://chromium.org/audio-video/autoplay/autoplay-policy-design-rationale),
  [MDN](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay)).
  - What it does: Web Audio may need a user gesture before it plays.
  - What it teaches here: the app's window counts as a trusted page. Resume the shared audio player on the first click, and set `autoplayPolicy` if testing shows it's needed.
- **Slack and Discord** ([Slack](https://thebricks.com/resources/how-to-change-slack-notification-sound),
  [Discord request](https://support.discord.com/hc/vi/community/posts/15231288464919-Customizable-Notifications)).
  - What they do: a sound per event type, with Do Not Disturb.
  - What it teaches here: Discord users ask for custom sounds, and others warn about packs that blast loud sounds. Cap a theme's sounds for length and loudness.
- **Zed themes** ([themes](https://zed.dev/docs/extensions/themes)).
  - What it does: a theme file has an `appearance` of light or dark and `style` colours. A theme extension can ship several, and the user picks one for light and one for dark.
  - What it teaches here: a theme is data. One package carries both modes, and fonts are separate settings.
- **VS Code themes** ([contribution points](https://code.visualstudio.com/api/references/contribution-points)).
  - What it does: a theme is referenced by id and resolved live. Uninstalling it falls back to a default.
  - What it teaches here: referencing a theme keeps updates flowing, but a missing package means a broken look. Hivemind shares its look with guests, which pushes us toward copying.

## 3. From every side

| View | What worries them |
|---|---|
| Person using it | A sound that's too loud or too frequent. A theme that makes text unreadable. Undo must be one step. They want a sound when an agent needs them even while the app is focused, but not a "done" sound for the tile they're watching (the existing toast rule). |
| Data | `notifications.sound` exists but is unused. Adding per-moment switches and a volume is additive. `appearance.theme` (provenance plus the look from before) and an accent written as hex are additive too. Old files read as before, so no migration is needed. |
| Operator at 3am | No sound at all must be diagnosable: settings show which window plays and when the last sound played. A theme whose files are missing falls back to the built-in look with a notice. |
| Security | Themes carry no code. Their files are copied into the media folder and served from there through the existing `hivemedia:`. Sound clips are capped at 3 s and 400 KB, and peak-normalized when decoded. Fonts load through `@font-face` from `hivemedia:`, so `font-src` grows by that one scheme. |
| Cost | Sound: O(1) per notify event in main, and at most 1 sound per 1.2 s. Theme apply: one copy of at most 8 MB, then about 21 CSS variables. Widgets: about 2.7 MB per placed code widget. |
| Next year | (1) Phone push sounds. (2) Brand editions shipping a theme, sounds and widgets together. (3) Sharing your look in multiplayer, which works already as values. |

## 4. Options and scale

### 4a. Sounds

```
A. each window plays      renderer(n) ──detect──► play          (n windows → n sounds)
B. main decides, one plays renderer(n) ──notify:agent──► main: dedupe(tile,kind,2s) + coalesce(1.2s, needs>error>done)
                                                        └──► userWindow(): play(moment)   ◄── also gates OS pop-ups
C. host decides           StatusStore (host) ──► main ──► userWindow(): play   (rules moved out of the renderer)
D. OS sound only          Notification{sound} (macOS only; banners can arrive silent)
```

Load: a burst is many agents finishing within 10 s. Today that's 15 agents, at 10× it's 150 and at 100× it's 1500, with 2 windows open.

| Design | Today | 10× | 100× |
|---|---|---|---|
| A | 15 × 2 = 30 sounds. Breaks. | 300. Breaks. | 3000. Breaks. |
| B | ≤ 9 sounds (10 s ÷ 1.2 s); 30 events × O(1). Holds. | ≤ 9; 300 map hits. Holds. | ≤ 9; 3000 map hits, under 1 ms. Holds. |
| C | ≤ 9. Holds, but needs the decision rules moved. | Holds. | Holds. |
| D | 15–30 OS sounds, macOS only. Breaks. | Breaks. | Breaks. |

Arithmetic: ≤ 9 is 10 s ÷ 1.2 s, rounded up. A "map hit" is one `Map.get`/`set` per event, keyed `tile:kind`.

**Choice: B.**
- **A** duplicates sounds and never coalesces a burst.
- **D** is macOS-only and unreliable.
- **C** is the long-term owner, since it would also serve phone push and remote screens. But it needs the "done" rules (synthetic idles, exit codes, background workers) moved out of the renderer. B gets the same behaviour now, and C can replace B's input later without changing what B outputs.

### 4b. Themes

```
A. copy on apply   theme.json ──apply──► appearance (values) + media/ (files) ; appearance.theme = {id, version, before}
B. by reference    appearance.theme = id ──paint──► resolve package values each time, the person's edits on top
C. CSS             theme.css injected into the app (rejected in customization-2026-10-21.md)
```

Load: themes installed, 1 / 10 / 100. Guests in a shared workspace, 0 / 5 / 50.

| Design | Today | 10× | 100× |
|---|---|---|---|
| A | apply: ≤ 8 MB copied once, 21 variables. Guests get values. Holds. | Appearance lists 10 small `theme.json` from the install index. Holds. | 100 entries. Holds. |
| B | Painting reads the package each time. A guest without it sees nothing. Breaks for guests. | Breaks for guests. | Breaks. |
| C | About 9 renderer commits a day can break it (276 in 30 days). Breaks. | Breaks. | Breaks. |

**Choice: A.**
- **B lost** on sharing, and on the theme vanishing when its package goes. The cost of A is that a theme update doesn't flow by itself. The fix is a notice: "Harbour 1.2 is installed; you have 1.1 applied. Apply the new one?"
- **C lost** as before.

### 4c. Widget workers

Load: placed code widgets, 6 / 60 / 600 (draw-only widgets such as notes have no worker).

| Design | Today (6) | 10× (60) | 100× (600) |
|---|---|---|---|
| A. one per instance (today) | 6 × 2.7 = 16 MB. Holds. | 162 MB. Strained. | 1.6 GB. Breaks. |
| B. one per kind, instances as closures | ≤ 15 kinds × 2.7 = 40 MB, bounded. Holds. One instance's fault reaches its kind. | 40 MB. Holds. | 40 MB. Holds. |
| C. one for all widgets | 2.7 MB. Breaks on security: different authors' code with different permissions shares globals. | Breaks. | Breaks. |

**Choice: stay on A, with a written ceiling.**
- **The ceiling:** at about 40 placed code widgets (about 110 MB), build B.
- **The trigger:** a real board passes 20.
- **B's design is ready:**
  - Each instance's code runs inside a function scope.
  - Timers and handlers are tracked per instance.
  - An instance that throws is removed alone.
  - An instance that runs long is moved to a worker of its own.
- **Why not now:** the saving (about 13 MB on today's board) is small next to the isolation it gives up.

## 5. Pre-mortem

It is October 2027. The three likeliest failures:

1. **Sounds annoyed people and they switched them off.**
   - By default only **needs you** plays. **Finished** and **failed** are off until switched on.
   - There's one volume control and a sound switch per moment.
   - Do Not Disturb keeps its rule: it never mutes **needs you**.
   - No **finished** sound plays for a tile the person has selected (the toast rule).
2. **No sound played, and nobody could tell why.**
   - The window chosen to play was minimised, or the audio player was blocked by autoplay.
   - **Change:** main falls back to any open window. Each window resumes its audio player on the first click.
   - The Notifications settings show "Last sound: needs you, 2 min ago, in window 1", and so does `hive config get notifications`.
3. **A theme looked broken or unreadable.**
   - Applying refuses a theme whose `fg` on `bg` is below 4.5:1, or `fg2` below 3:1, and says which pair failed. It never corrects silently.
   - Themes are **dark-only** until light mode is audited. That's step 6.
   - A theme whose files are missing applies its colours and keeps the current wallpaper and fonts, with a notice.

## 6. Build order

Foundation first. Each step lists how it is checked.

1. **The sound director in main.**
   - Every `notify:agent` passes through one dedupe, keyed by tile and kind over 2 s, so two windows make one event.
   - A coalescer keeps at most 1 sound per 1.2 s, with priority needs > error > done.
   - The same gate drives the OS pop-up and the dock bounce, so ten agents finishing make one pop-up that says "10 agents finished".
   - `silent: true` while app sounds are on.
   - *Check:* unit tests with a fake clock (burst, priority, dedupe across windows) and an e2e test where 10 stand-in agents finish and the app records one sound and one pop-up.
2. **The renderer sound player.**
   - One audio player per window, with every sound decoded once and cached.
   - The built-in sounds are rendered at start-up by a small synthesizer (needs you: two rising notes; finished: one soft bell; failed: one low note). No asset files.
   - Notifications settings gain a switch per moment, a volume control and a **Play** button for each, and the CLI's `hive config` gets the same keys.
   - *Check:* the e2e test reads the played-sound log; a screenshot of the settings.
3. **Fonts that actually apply.**
   - CSS reads `--font-ui-user` and `--font-mono-user`, and so does the terminal's font.
   - `@font-face` loads from `hivemedia:`, and `font-src` grows by `hivemedia:`.
   - *Check:* an e2e test that a chosen font is the computed font of the UI and of a terminal.
4. **The theme member.**
   - A package's `themes/<name>/theme.json` holds `name`, `mode: "dark"`, the 13 `palette` keys, `accent` as hex, an optional `terminal`, `radius`, `fonts` (woff2 files), `wallpaper` (a built-in kind, or an image or video file) and `sounds` (needs, done and error files: ogg or mp3, at most 3 s and 400 KB).
   - It's added to `MEMBER_FORMATS` and `MEMBER_KINDS`, and checked by HiveHub and `hive plugins check`.
   - *Check:* format tests, including refusals, and the hub listing.
5. **Apply and revert.**
   - Appearance lists installed themes beside the presets.
   - **Apply** copies the theme's files into `media/`, writes `appearance` along with `appearance.theme = {id, version, before}`, and plays nothing.
   - **Revert** restores `before`. The CLI gets `hive theme use @owner/name` and `hive theme revert`.
   - The contrast check runs on apply. An update notice appears when the installed version is newer than the applied one.
   - *Check:* an e2e test of apply, revert and remove-the-package (the look stays, because it was copied). The contrast refusal test. A guest in a shared workspace sees the applied colours.
6. **Light themes.**
   - Audit light mode: add one built-in light preset and fix what breaks.
   - Then allow `mode: "light"`, and let a package pair a light theme with a dark one.
   - *Check:* screenshots of every settings page and the canvas in light mode.
7. **Archipelago ships "Harbour"**, the first real theme: sea colours, a wood accent, waves and bells.
   - *Check:* the real app with Archipelago's view and widgets, and the theme applied.

Steps 1–2 stand alone. Step 5 needs 3 and 4. Step 7 needs 5. Widget workers have no step: their trigger is in 4c.

## 7. Unknown

- **Whether the window's audio player starts without a click in Electron with no autoplay policy set.**
  Test it in step 2 on Linux, macOS and Windows. If it doesn't, set `autoplayPolicy: "no-user-gesture-required"` on the app's own windows only.
- **The real size of boards.**
  Count placed code widgets on real boards, from the people who will report them, before building 4c-B.
- **How much light mode breaks.**
  Step 6 measures it: screenshots of each page with a light palette.
- **Whether guests should hear the host's theme sounds.**
  `sharedAppearance` sends no files today. Leave guest sounds as their own until someone asks.
