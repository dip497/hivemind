# Multiplayer — progress (start here)

The working record for multiplayer, other devices and the phone. **A new session starts
here**, then reads the design section for the current item.

| | |
|---|---|
| Design (what and why) | [`docs/design/multiplayer-2026-09-28.md`](../design/multiplayer-2026-09-28.md) — accepted, rev 4 |
| Research (facts behind it) | [`docs/design/multiplayer-2026-09-28-research.md`](../design/multiplayer-2026-09-28-research.md) |
| Branch | `claude/gpui-kit-performance-2whq9z` (no PR yet) |
| Order | Phase 0 (R1–R16) → M1 multiplayer board → M2 terminals → M3 your devices + always-on hosting → M4 agents on your machine in their workspace → M5 phone |

## How to resume in a new session

1. Read this file (the **Working rules** apply to every item), then the design's
   **§3 Phase 0** entry for the next item below (its **What / Files / Done when**).
2. `git fetch origin && git log --oneline origin/main..HEAD` on the branch to see what
   landed since.
3. `pnpm install` (set `ELECTRON_SKIP_BINARY_DOWNLOAD=1` when only running typecheck and
   unit tests), then the checks below.
4. Work on the item; when it moves, **update the table here in the same commit**.

## Checks

```bash
pnpm typecheck                                  # every package
pnpm -F @hivemind/desktop test:unit             # desktop unit tests (tsx --test)
pnpm -F @hivemind/workspace-host test           # the workspace store (bun test)
pnpm -F @hivemind/workspace-doc test            # the workspace document (bun test)
git diff --check
# e2e (needs Electron + xvfb; see apps/desktop/AGENTS.md and CLAUDE.md). Rebuild first:
cd apps/desktop && pnpm exec electron-vite build
unset ELECTRON_RUN_AS_NODE && xvfb-run -a --server-args="-screen 0 1600x1000x24" pnpm test:e2e --retries=0
```

CI (`.github/workflows/ci.yml`) typechecks and unit-tests every package, the store included;
the e2e suite is yours to run before pushing.

## Working rules (every item)

The maintainer's standing rules for this work: the code is modular and maintainable, and
every test passes the test-audit gate.

- **One module, one job.** A module that shapes data does not also decide where it is kept:
  `canvas-persistence.ts` shapes the core blob, `workspace-store-client.ts` decides where it
  lives, `doc-file.ts` owns the file format, `store.ts` the rules, `@hivemind/workspace-doc`
  how a layout lives in the document.
- **Logic in packages, adapters in the app.** Domain code lives in a package with no Electron
  import (`packages/workspace-host`, `packages/workspace-doc`), so the headless host (R14)
  runs the same code. Electron
  main and the window hold thin adapters.
- **Input is checked once**, by the module that owns the data, whatever transport it came
  over. Adapters forward and always answer.
- **A shape that crosses processes is defined once**, in a Node-free module of the package
  that owns it (`@hivemind/workspace-doc/shapes`), and imported everywhere else.
- **Nothing for tests alone**: no option, export, clock or hook that no production caller
  needs, and no API before its first production caller (change events wait for R5).
- **Match the code around it**: relative imports end in `.js` inside packages, comments say
  why, and every package keeps its own `typecheck` and `test` scripts.
- **Tests** pass the gate in `.claude/skills/test-audit/SKILL.md` (adapted from openclaw's
  test-audit skill): one owner test per contract at the strongest boundary, a literal spelled
  out only when it is the contract, and each new test shown to fail when the behaviour it
  guards is broken.

## Status

Legend: ☐ not started · ◐ in progress · ☑ done (its "Done when" passes)

### Phase 0 — refactors (design §3)

| # | Refactor | Status | Notes |
|---|---|---|---|
| R1 | Workspace store out of the renderer, into `packages/workspace-host` | ☑ | `packages/workspace-host/src`: `layout.ts` (shapes shared with the window, Node-free), `record-file.ts` (file format: hashed name, atomic 0600 writes, an unreadable file set aside; R2 replaced it with `doc-file.ts` before either shipped), `store.ts` (checks input, writes each change through, `flush()` retries failed writes, legacy import fills only what is empty). Main: `main/workspace-store-ipc.ts` (sync IPC, flushed on quit). Window: `workspace/workspace-store-client.ts` decides where layouts live and imports a window's old localStorage once; `canvas-persistence.ts` and `view-layout-store.ts` only shape data. Proof: every new or changed test (10 store cases, 7 renderer persistence cases) shown to fail when its behaviour is broken; `shipped-persistence.spec.ts` restarts with the window's Local Storage deleted and fails if the window ignores the store; full e2e on the final build: two runs of 155, every spec passed in a full run, and each run had one intermittent failure outside R1 (see **Known issues**). `tile.list` without a window moved to R5. |
| R2 | Store backed by a Loro document (schema incl. board objects) | ☑ | ☑ Step 1: `packages/workspace-doc` (no Node, no Electron; `loro-crdt` 1.16.3): `shapes.ts` (types and guards the window may import: no Loro), `schema.ts` (root containers, schema 1), `fields.ts` (a record's fields in a Loro map: only changes recorded, nested objects as mergeable maps to a given depth, values kept as JSON keeps them, containers told by `kind()` not `instanceof`), `core.ts` (a whole layout written as edits: frames → Tree, tiles → mergeable records with `frame`/`name`/`tabs`, order → MovableList; read back), `views.ts` (`{ v, data }`, data merging two levels deep). 9 bun tests, each shown to fail when what it guards breaks (12 mutations). Costs on 100 tiles and 20 frames: a structural write 3.5–5 ms, a canvas move 0.5 ms, a shallow snapshot 1.7 ms. ☑ Step 2: `WorkspaceStore` keeps its API and holds one document per repo, loaded on first use and written through on every change. `doc-file.ts` owns the file: `workspaces/<first 32 hex of sha256(repo)>.loro`, a header line (`{"format":"hivemind-workspace","v":1,"repo":…}`; the repo path stays out of the document, which will be shared) and then a Loro shallow snapshot; atomic 0600 writes; a file that is not this repo's document is set aside. R1's `.json` files are not read: R1 never reached `main` or a release (`install.sh --dev` builds `main`), so only this branch wrote them. The window's old localStorage layouts are still imported, checked by the document's writers; a refused entry is skipped and reported. `layout.ts` keeps only `LegacyLayout`. Desktop: `loro-crdt` is an app dependency, external in main's bundle; the window imports only `shapes` (no Loro in the renderer bundle). Proof: 12 store tests, 20 mutations each caught; a golden `.loro` fixture pins the name, the header and the schema (renaming a container fails it); `shipped-persistence.spec.ts` asks main's store over IPC instead of reading the file, and fails when the stored document is not loaded; the 28 layout-related e2e tests pass. ☑ Step 3: design text (R2's What, what waits for a first caller, per-person state, migration, files, done-when; §8 as built; R1's pointers to R2). Full e2e green: 147 passed, 10 skipped (the first run's one failure was a race in `workspace-zones.spec.ts`, fixed; see the log). A packaged build made as the release job makes it starts, loads Loro's wasm from inside `app.asar`, and keeps a layout through a restart. Undo and update export/import move to M1 with their first callers; R5 carries two items (its row). |
| R3 | Identity: device key, person key, workspace key, profile | ☐ | |
| R4 | Daemon: size announcements, input lease, write attribution | ☐ | |
| R5 | Main fans out to many clients; canvas verbs run in main | ☐ | After R1. Carries two items from R2 (design R2): with several writers, a window writes from the document's current state or sends operations; per-person view state (the canvas camera, the Windows view's active tab and minimized tiles) leaves the document. |
| R6 | One status per session, from its host | ☐ | After R5 |
| R7 | Intents: one checked, logged path for every side effect | ☐ | After R5 |
| R8 | Workspace API that is not Electron IPC | ☐ | After R7 |
| R9 | Machines by id, not by ssh uri | ☐ | |
| R10 | `hive-net` (Rust, iroh): profiles, local mode, `serve` roles | ☐ | After R3 |
| R11 | Access list (owner-only, replicated) and audit | ☐ | After R3 |
| R12 | View protocol 1.5 | ☐ | |
| R13 | Our relays, lookup and relay access (used only by choice) | ☐ | Before M1 ships |
| R14 | Headless host: `hive host` | ☐ | After R1, R7, R10, R11 |
| R15 | Canvas renders board objects | ☑ | ☑ Step 1: `packages/workspace-doc/src/objects.ts` (`writeObjects` / `readObjects`: notes, checklists, text labels, arrows in `objects` by id; text as Loro text updated by a diff, so typing merges by character; a checklist's items as records by id plus `itemOrder`; a framed object's `x`, `y` relative to its frame; input checked, unknown fields kept), shapes in `shapes.ts`; `order.ts` and `input.ts` now shared with `core.ts`. 6 bun tests, plus board objects in the other-copy test; 16 mutations, each caught. ☑ Step 2: `WorkspaceStore.getObjects` / `setObjects` / `undo` / `redo`: undo through Loro's `UndoManager`, board edits only (the layout, views and imports are committed as `sys:` and never undone), edits within a second one step; sync IPC (`workspace:objects-sync`, `set-objects-sync`, `undo-sync`, `redo-sync`) and `readBoard` / `writeBoard` / `undoBoard` / `redoBoard` in the window's store client. Found: redo of a record undo had taken back wrote a mergeable record's text twice ("draftdraft"); records are now made fresh with the document's own classes. 1 new store test plus rows; 10 mutations, each caught. ☑ Step 3: the canvas draws, adds and edits them. `board-objects/`: `board-model.ts` (pure: where a box is kept and where it is drawn, a new box, a copy, what a delete takes, an arrow's sides), `useBoard.ts` (a window's board: selection, the object being written in, an arrow being drawn, saving, undo and redo through the store), `TextDraft.tsx` (a field's draft: saved after 400 ms idle, on leaving it and on ⌘Z), `BoardNodes.tsx` (note, text, checklist nodes), `Arrows.tsx` (arrows in their own layer: react-flow draws no edge between nodes without handles); wired into the canvas's nodes, a frame's drag, arrange and auto-fit, placing a spawned tile, the shortcuts and the toolbar's **Board** menu. Changed in the store: one undo step per board save (`mergeInterval: 0`; a second's merging folded separate edits into one), and the schema is stamped on load, so the first board write is not an empty step. Proof: 5 unit tests (`board-model.test.ts`, 12 mutations each caught) and 2 changed (node build, frame layout); `board-objects.spec.ts`, 4 e2e tests, green three runs in a row, 8 mutations each caught (a note that never takes focus, a frame drag that leaves its boxes, a drop that keeps the old frame, a draft that keeps undone text, undo steps merged, a reorder that goes nowhere, arrows left behind by a delete, ⌘D doing nothing). `toolbar-actions.spec.ts` expects the Board button on the canvas (and not in other views); the renderer entry-size guard is re-baselined (905 418 → 947 213 bytes: the board is drawn on the first frame and a new note takes the next key, so it is not a lazy chunk). ☑ Step 4: design text (R15 as built: arrows by two clicks from the menu, no drag handle yet; undo per save), tracker, changelog. Full e2e green on the first run: 151 passed, 10 skipped. |
| R16 | Network profiles (Local network default), reach chooser, admission, update-check switch | ☐ | With R10 |

### Milestones (design §11)

| # | Milestone | Status |
|---|---|---|
| M0 | Phase 0 complete; local network mode first | ☐ |
| M1 | Multiplayer board, incl. sticky notes, checklists, text, arrows | ☐ |
| M2 | Multiplayer terminals | ☐ |
| M3 | Your devices and always-on hosting | ☐ |
| M4 | Agents on my machine in their workspace | ☐ |
| M5 | Phone (iOS first; Android with FCM and UnifiedPush) | ☐ |

**Before M5:** an Apple Developer Program membership and a Firebase project (design §12.4).

### Known issues

None open. Agent pipes and spawn wires not being drawn (found in R15) and two issues found while
verifying R1 were fixed on 2026-09-29 (see the log).

## Decisions so far

- rev 1 — iroh for every link (Rust `hive-net` sidecar), Loro for the shared document, one
  authority (the host) per workspace, permissions outside the document, one keyboard holder
  per terminal.
- rev 2 — run our own relay, lookup and push servers; a workspace outlives its host
  (`hive host`, moving and taking over hosting); board objects in M1.
- rev 3 — open source: every server role in `hive-net serve`, self-hosting and
  "this device serves", network profiles, vouchers for guests from other networks.
- rev 4 — **the local network is the default**; our servers are used only when someone
  chooses them in the reach chooser.
- Open questions: design §14.

## Log

- 2026-09-28 — design written and accepted (rev 1–4); research notes saved; this tracker
  added; R1 started.
- 2026-09-28 — R1 step 1: `@hivemind/workspace-host` with `WorkspaceStore` and its tests.
  Design R1 clarified: whole snapshots in R1, edit operations with R2.
- 2026-09-28 — R1 step 2: the app reads and writes layouts through main's store;
  CHANGELOG entry added. `tile.list` without a window moved from R1 to R5 in the design.
- 2026-09-28 — Maintainer's rules added: modular, maintainable code, and the test-audit gate
  (`.claude/skills/test-audit/`, now shipped with the repo). R1 reworked to them: the store
  split into shapes / file format / rules; test-only seams removed (change events, origin,
  `load`, `close`, the clock and debounce options); writes go through at once so a quit a
  moment after a change keeps it; input checked only in the store; tests trimmed from 17 to
  12 and each mutation-checked. R1 step 3 done: the restart spec deletes the window's
  storage. `agent-plugin.spec.ts` now stubs `codex`, so it no longer needs a real Codex on the
  machine (it failed on one without it). Two intermittent failures outside R1 recorded under
  **Known issues**. R1 done.
- 2026-09-29 — Fixed the first of those known issues: the Windows view lost a tab restored from
  the rail when the view switched before the render that followed the click (a view unmounting
  saved its last *rendered* layout). The restore now happens in the click handler
  (`WindowsView.tsx`), and `useViewLayout`'s setter hands every new layout to the save at once
  (`useDebouncedSave` returns `schedule`), so a view closing mid-edit keeps the edit. Regression
  test `windows-view.spec.ts` "a restored tab stays restored when the view switches at once"
  fails on the old code, and with either half of the fix undone. Full e2e green: 146 passed,
  10 skipped.
- 2026-09-29 — Fixed the second: `toolbar-actions.spec.ts` failing on "settings.json is locked
  by another writer (…; the holder could not be read)". Not contention: the app had quit in
  the middle of a settings write, between creating the lock and writing its owner into it, and
  a lock naming nobody is never broken. Now `@hivemind/core` publishes the lock with its token
  already in it (a private file hard-linked into place), and the app waits (up to 6 s) for
  settings writes still running before it exits, in both quit paths. Regression tests: a
  settings writer killed at its first written byte (`ulimit -f 0`) no longer blocks the next
  (`settings.test.ts`), and `settings-at-quit.spec.ts` quits while another writer holds the lock
  and expects the change written. Both fail on the old code.
- 2026-09-29 — Fixed a quirk seen while reviewing the save hook: on a project switch,
  `useDebouncedSave` queued the value rendered with the new key, which is still the old
  project's (the Workspace and every view load the new project's layout on the next render),
  so a window closing in between saved one project's layout under the other's name. The hook
  now skips that one value, and its key follows a switch to "no project" too. No regression
  test: the window is one render wide, and no test here can land inside it (there is no hook
  renderer in the unit tests); `init-workspace`, persistence, view and frame specs pass.
- 2026-09-29 — R2 step 1: `@hivemind/workspace-doc`. Decisions: there is no canvas undo to
  move (only the editor's own), so `UndoManager` arrives with its first caller, ⌘Z on board
  objects (M1); incremental update export arrives with sync (M1); the store keeps whole-layout
  writes, each diffed into per-field edits, so a writer must write from the document's current
  state once there are several (R5: change events refresh a window, or it sends operations).
  Found while measuring: readers that told containers apart with `instanceof` saw an empty
  document made by another copy of loro-crdt; they read through `toJSON()` and `kind()` now.
- 2026-09-29 — Also fixed: `hive-agents`' "a probe that hangs is killed with everything it
  started" failed wherever PID 1 does not reap orphans (this container), because a killed
  child stays a zombie and its `/proc` entry remains; it now checks that the process is
  running. CI now typechecks and unit-tests every package (`pnpm typecheck`, `pnpm test`), not
  only the desktop. Stale e2e counts and a wrong `--user-data-dir` claim corrected in
  `CLAUDE.md` and `apps/desktop/AGENTS.md`. Full e2e green: 147 passed, 10 skipped.
- 2026-09-29 — R2 step 2: the store is backed by one Loro document per workspace
  (`doc-file.ts`: header line, then a shallow snapshot, in `<hash>.loro`). Decisions: R1's JSON
  files are not imported, because R1 never left this branch; a legacy entry that cannot be a
  layout is skipped and reported, and the rest of the offer still comes across (the store no
  longer checks views itself: `writeView` does). Found: Loro throws strings, not `Error`s, so
  a warning built from `.message` read "undefined"; both warnings print the thrown value now.
- 2026-09-29 — R2 done. Step 3: the design's R2 and §8 say what was built and what waits
  for a first caller. The first full e2e run had one failure: `workspace-zones.spec.ts` read
  a frame's box and the box of the agent just spawned into it in two calls while the spawn
  flew the camera to the tile, so on a busy machine the frame was read mid-flight and the
  terminal after it (a trace showed the terminal 28 px inside the frame at every instant).
  Both are read at one instant now, and the test still fails when a spawn ignores the frame.
  Second full run: 147 passed, 10 skipped. A packaged build (`pnpm deploy`, then
  `electron-builder --linux dir`, as in the release job) starts, loads Loro's wasm from
  inside `app.asar`, writes `<hash>.loro`, and reads the layout back after a restart.
- 2026-09-29 — R15 done: the canvas draws, adds and edits notes, checklists, text and arrows
  (design R15, as built). Decisions: arrows are drawn in a layer of their own, because
  react-flow draws no edge between nodes without handles, and are made from the Board menu
  with two clicks (dragging one from a hover handle is not built). Undo takes back one board
  save per step: merging a second's edits folded separate edits into one. The store stamps
  its schema on load; the first writer used to commit it with its own edit, an empty first
  step. `⌘D` and `⌫` act on the selection wherever focus is, except in a text field. A frame
  is never narrower than an empty one (a lone note squeezed its header out). The renderer's
  entry-size guard is re-baselined (+42 kB): the board is on the first frame. Found and
  fixed: react-flow hides a node it has not measured, so a note added with `8` could not take
  focus and the first keys typed were lost or ran as tools. Boxes are now sized before they are
  measured, their field takes focus as it mounts, and no single key fires while one is being
  written in. Tailwind v4 drops `@theme` colours no class uses, and the note colours are read
  from inline styles, so they are plain variables. A field kept its draft after `⌘Z` took it
  back: the undone text equals the text last shown, so nothing told the field. It now
  re-reads on every new reading of its object. Also found, older than R15 and not fixed:
  agent pipes and spawn wires are never drawn (**Known issues**). Full e2e: 151 passed,
  10 skipped.
- 2026-09-29 — Fixed that known issue: agent pipes and spawn wires are drawn. Every tile now
  carries one hidden, non-connectable handle of each kind (`TileShell` in `canvas-nodes.tsx`);
  the edges still find their ends on the tiles' borders (`canvas-pipe-edge.tsx`). They had
  never shown since they were added: react-flow keeps a measured node's handles from its DOM
  only, so declaring them in node data would not do. `agent-links.spec.ts` sends `hcp:spawn`
  and `hcp:pipe` from main and checks each line runs from one tile's border to the other's
  and goes when it ends. It fails without the handles, and when a pipe's end is ignored.
  Full e2e: 152 passed, 10 skipped.
