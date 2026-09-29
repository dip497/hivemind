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
| R2 | Store backed by a Loro document (schema incl. board objects) | ◐ | ☑ Step 1: `packages/workspace-doc` (no Node, no Electron; `loro-crdt` 1.16.3): `shapes.ts` (types and guards the window may import: no Loro), `schema.ts` (root containers, schema 1), `fields.ts` (a record's fields in a Loro map: only changes recorded, nested objects as mergeable maps to a given depth, values kept as JSON keeps them, containers told by `kind()` not `instanceof`), `core.ts` (a whole layout written as edits: frames → Tree, tiles → mergeable records with `frame`/`name`/`tabs`, order → MovableList; read back), `views.ts` (`{ v, data }`, data merging two levels deep). 9 bun tests, each shown to fail when what it guards breaks (12 mutations). Costs on 100 tiles and 20 frames: a structural write 3.5–5 ms, a canvas move 0.5 ms, a shallow snapshot 1.7 ms. ☑ Step 2: `WorkspaceStore` keeps its API and holds one document per repo, loaded on first use and written through on every change. `doc-file.ts` owns the file: `workspaces/<first 32 hex of sha256(repo)>.loro`, a header line (`{"format":"hivemind-workspace","v":1,"repo":…}`; the repo path stays out of the document, which will be shared) and then a Loro shallow snapshot; atomic 0600 writes; a file that is not this repo's document is set aside. R1's `.json` files are not read: R1 never reached `main` or a release (`install.sh --dev` builds `main`), so only this branch wrote them. The window's old localStorage layouts are still imported, checked by the document's writers; a refused entry is skipped and reported. `layout.ts` keeps only `LegacyLayout`. Desktop: `loro-crdt` is an app dependency, external in main's bundle; the window imports only `shapes` (no Loro in the renderer bundle). Proof: 12 store tests, 20 mutations each caught; a golden `.loro` fixture pins the name, the header and the schema (renaming a container fails it); `shipped-persistence.spec.ts` asks main's store over IPC instead of reading the file, and fails when the stored document is not loaded; the 28 layout-related e2e tests pass. ◐ Step 3: design text done (R2's What, what waits for a first caller, per-person state, migration, files, done-when; §8 as built; R1's pointers to R2); the full e2e run and a packaged-app check (main loads Loro's wasm from inside `app.asar`) are next, then R2 ☑. |
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
| R15 | Canvas renders board objects | ☐ | After R2 |
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

None open. Two found while verifying R1 were fixed on 2026-09-29 (see the log).

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
