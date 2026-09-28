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

1. Read this file, then the design's **§3 Phase 0** entry for the item marked
   *in progress* below (its **What / Files / Done when**).
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
# e2e (needs Electron + xvfb; see apps/desktop/AGENTS.md and CLAUDE.md):
cd apps/desktop && unset ELECTRON_RUN_AS_NODE && xvfb-run -a --server-args="-screen 0 1600x1000x24" pnpm test:e2e --retries=0
```

## Status

Legend: ☐ not started · ◐ in progress · ☑ done (its "Done when" passes)

### Phase 0 — refactors (design §3)

| # | Refactor | Status | Notes |
|---|---|---|---|
| R1 | Workspace store out of the renderer, into `packages/workspace-host` | ◐ | ☑ Step 1: `WorkspaceStore` (`packages/workspace-host/src/store.ts`) — sync reads, debounced atomic writes, one-time legacy import, change events with origin; 11 bun tests. ☑ Step 2 (code): main embeds it (`main/workspace-store-ipc.ts`, `<userData>/workspaces/`, flushed on quit); preload `workspaceCoreSync`/`workspaceViewSync`/`workspaceSetCoreSync`/`workspaceSetViewSync`/`workspaceImportSync`; `canvas-persistence.ts` and `view-layout-store.ts` go through `workspace/workspace-store-client.ts` (localStorage only without the bridge; old localStorage imported once); the two e2e specs that read localStorage now read the store. Verified: typecheck (all packages), desktop unit tests 607 pass / 1 skipped (6 new), e2e for persistence, browser plugin, community views, tile move and frames (15/15). ☐ Full e2e suite run (was running when committed — check it first). ☐ Step 3: `shipped-persistence.spec.ts` deletes the window's `Local Storage` between its two launches, proving the store alone restores the canvas. Then R1 is done. (`tile.list` without a window moved to R5.) |
| R2 | Store backed by a Loro document (schema incl. board objects) | ☐ | After R1 |
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
  Full e2e run started (155 tests; log in the session scratchpad, not the repo).
