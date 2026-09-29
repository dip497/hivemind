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
git diff --check
# e2e (needs Electron + xvfb; see apps/desktop/AGENTS.md and CLAUDE.md). Rebuild first:
cd apps/desktop && pnpm exec electron-vite build
unset ELECTRON_RUN_AS_NODE && xvfb-run -a --server-args="-screen 0 1600x1000x24" pnpm test:e2e --retries=0
```

CI (`.github/workflows/ci.yml`) runs only the desktop typecheck and desktop unit tests, so
the package tests and the e2e suite above are yours to run before pushing.

## Working rules (every item)

The maintainer's standing rules for this work: the code is modular and maintainable, and
every test passes the test-audit gate.

- **One module, one job.** A module that shapes data does not also decide where it is kept:
  `canvas-persistence.ts` shapes the core blob, `workspace-store-client.ts` decides where it
  lives, `record-file.ts` owns the file format, `store.ts` the rules.
- **Logic in packages, adapters in the app.** Domain code lives in a package with no Electron
  import (`packages/workspace-host`), so the headless host (R14) runs the same code. Electron
  main and the window hold thin adapters.
- **Input is checked once**, by the module that owns the data, whatever transport it came
  over. Adapters forward and always answer.
- **A shape that crosses processes is defined once**, in a Node-free module of the package
  that owns it (`@hivemind/workspace-host/layout`), and imported everywhere else.
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
| R1 | Workspace store out of the renderer, into `packages/workspace-host` | ☑ | `packages/workspace-host/src`: `layout.ts` (shapes shared with the window, Node-free), `record-file.ts` (file format: hashed name, atomic 0600 writes, an unreadable file set aside), `store.ts` (checks input, writes each change through, `flush()` retries failed writes, legacy import fills only what is empty). Main: `main/workspace-store-ipc.ts` (sync IPC, flushed on quit). Window: `workspace/workspace-store-client.ts` decides where layouts live and imports a window's old localStorage once; `canvas-persistence.ts` and `view-layout-store.ts` only shape data. Proof: every new or changed test (10 store cases, 7 renderer persistence cases) shown to fail when its behaviour is broken; `shipped-persistence.spec.ts` restarts with the window's Local Storage deleted and fails if the window ignores the store; full e2e on the final build: two runs of 155, every spec passed in a full run, and each run had one intermittent failure outside R1 (see **Known issues**). `tile.list` without a window moved to R5. |
| R2 | Store backed by a Loro document (schema incl. board objects) | ☐ | **Next** (R1 done). R3 and R4 can run beside it. |
| R3 | Identity: device key, person key, workspace key, profile | ☐ | |
| R4 | Daemon: size announcements, input lease, write attribution | ☐ | |
| R5 | Main fans out to many clients; canvas verbs run in main | ☐ | After R1 |
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

### Known issues (found while verifying R1, not caused by it)

- **`settings.json` lock contention between the app and the CLI.** `toolbar-actions.spec.ts`
  "CLI preferences persist…" failed once: `hive config set` found `settings.json.lock` held
  ("the holder could not be read") while the app was running. It passes alone and in the other
  full run. A short retry in the CLI on a held lock would cover it.

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
