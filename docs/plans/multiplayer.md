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
# a step: only the specs it touches
unset ELECTRON_RUN_AS_NODE && xvfb-run -a --server-args="-screen 0 1600x1000x24" pnpm exec playwright test <spec>.spec.ts --retries=0
# an item done (and before a release): the whole suite, about ten minutes
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
- **E2e cadence** (the maintainer's ask, 2026-09-30; it replaces one full run per step): a step
  runs the typecheck, the unit and package tests, and only the e2e specs it touches. Mutation
  checks run in unit tests where they can; through the e2e (a rebuild each) only for wiring
  nothing else reaches, in one batch. The whole suite runs once per item, when it is done, and
  before a release.

## Status

Legend: ☐ not started · ◐ in progress · ☑ done (its "Done when" passes)

### Phase 0 — refactors (design §3)

| # | Refactor | Status | Notes |
|---|---|---|---|
| R1 | Workspace store out of the renderer, into `packages/workspace-host` | ☑ | `packages/workspace-host/src`: `layout.ts` (shapes shared with the window, Node-free), `record-file.ts` (file format: hashed name, atomic 0600 writes, an unreadable file set aside; R2 replaced it with `doc-file.ts` before either shipped), `store.ts` (checks input, writes each change through, `flush()` retries failed writes, legacy import fills only what is empty). Main: `main/workspace-store-ipc.ts` (sync IPC, flushed on quit). Window: `workspace/workspace-store-client.ts` decides where layouts live and imports a window's old localStorage once; `canvas-persistence.ts` and `view-layout-store.ts` only shape data. Proof: every new or changed test (10 store cases, 7 renderer persistence cases) shown to fail when its behaviour is broken; `shipped-persistence.spec.ts` restarts with the window's Local Storage deleted and fails if the window ignores the store; full e2e on the final build: two runs of 155, every spec passed in a full run, and each run had one intermittent failure outside R1 (see **Known issues**). `tile.list` without a window moved to R5. |
| R2 | Store backed by a Loro document (schema incl. board objects) | ☑ | ☑ Step 1: `packages/workspace-doc` (no Node, no Electron; `loro-crdt` 1.16.3): `shapes.ts` (types and guards the window may import: no Loro), `schema.ts` (root containers, schema 1), `fields.ts` (a record's fields in a Loro map: only changes recorded, nested objects as mergeable maps to a given depth, values kept as JSON keeps them, containers told by `kind()` not `instanceof`), `core.ts` (a whole layout written as edits: frames → Tree, tiles → mergeable records with `frame`/`name`/`tabs`, order → MovableList; read back), `views.ts` (`{ v, data }`, data merging two levels deep). 9 bun tests, each shown to fail when what it guards breaks (12 mutations). Costs on 100 tiles and 20 frames: a structural write 3.5–5 ms, a canvas move 0.5 ms, a shallow snapshot 1.7 ms. ☑ Step 2: `WorkspaceStore` keeps its API and holds one document per repo, loaded on first use and written through on every change. `doc-file.ts` owns the file: `workspaces/<first 32 hex of sha256(repo)>.loro`, a header line (`{"format":"hivemind-workspace","v":1,"repo":…}`; the repo path stays out of the document, which will be shared) and then a Loro shallow snapshot; atomic 0600 writes; a file that is not this repo's document is set aside. R1's `.json` files are not read: R1 never reached `main` or a release (`install.sh --dev` builds `main`), so only this branch wrote them. The window's old localStorage layouts are still imported, checked by the document's writers; a refused entry is skipped and reported. `layout.ts` keeps only `LegacyLayout`. Desktop: `loro-crdt` is an app dependency, external in main's bundle; the window imports only `shapes` (no Loro in the renderer bundle). Proof: 12 store tests, 20 mutations each caught; a golden `.loro` fixture pins the name, the header and the schema (renaming a container fails it); `shipped-persistence.spec.ts` asks main's store over IPC instead of reading the file, and fails when the stored document is not loaded; the 28 layout-related e2e tests pass. ☑ Step 3: design text (R2's What, what waits for a first caller, per-person state, migration, files, done-when; §8 as built; R1's pointers to R2). Full e2e green: 147 passed, 10 skipped (the first run's one failure was a race in `workspace-zones.spec.ts`, fixed; see the log). A packaged build made as the release job makes it starts, loads Loro's wasm from inside `app.asar`, and keeps a layout through a restart. Undo and update export/import move to M1 with their first callers; R5 carries two items (its row). |
| R3 | Identity: device key, person key, workspace key, profile | ☐ | |
| R4 | Daemon: size announcements, input lease, write attribution | ☐ | |
| R5 | Main fans out to many clients; canvas verbs run in main | ☑ | Mapped 2026-09-29 (steps and decisions below). Decisions: "with no window" means the verbs never call a renderer, shown by tests at the control plane's dispatch with a real store and no window; an app left running with no window open is R14's `hive host` (closing the last window quits the app today). The in-process PTY path (`HIVEMIND_PTY_DAEMON=0`: an id per mount, detach is kill) stays one window. Carried: from R2, a window writes from the document's current state, and per-person view state (the canvas camera, the Windows view's active tab and minimized tiles) leaves the document; from the known issues, a read of a tile that is gone answers `TILE_NOT_FOUND`. ☑ Step 1: one tile list. `@hivemind/workspace-doc/tile-list` (no Node, no Loro): `frameFor` finds a frame by its id, title in any case, the folder it runs in, then a title containing the name; `tileName` (moved from the window); `listTiles` and `listFrames` build what `hive ctl list` and `hive ctl frames` print, from the frames, tiles, memberships and names a workspace holds, plus what only the running app knows (status, agent titles, which agent runs in a tile). The window's `tile.list`, `tile.list_frames` and spawn's frame targeting use it (they were three copies); `Workspace.tsx`'s three copies of "which agent runs in a tile" are one `agentOfTile`. No behaviour changes: an unknown `--frame` still lists everything (step 3 decides that, where errors have exit codes). The core layout's full frame and tile shapes move to the package with their first reader in main (step 3). Proof: 4 tests, 13 mutations each caught; full e2e 153 passed, 10 skipped. ☑ Step 2: a second writer, safely. `@hivemind/workspace-doc`: `writeCore(doc, layout, base)` writes only what changed from `base` (`rebase.ts`, pure: records by id and field by field; the writer's additions, changes and removals; what others changed, added or removed since stays; the writer's order, then others' additions) and `writeTileName` names one tile. The store: `setCore(repo, core, { base, writer })`, a `writer` on every write, `renameTile(tileId, name, …)` for the workspace that holds the tile, and `onChange` told once per write that changed something (none for one that did not, which also writes no file). Main: `workspaceStore()`, each window writing as `window:<id>`, every other window told `workspace:changed`; the window's store client sends the core it last read or wrote as the base; `Workspace.tsx` flushes its pending save and reads the core again (a plan review, never saved, stays open). The first other writer: `tile.rename` in main (`hive ctl rename <tile> ["name"]`, names cleaned as a person's are). Proof: 3 rebase tests (12 mutations), 2 store tests (7), a client test with a real store (3), and an e2e in `hcp-cross-provider.spec.ts` (4 wiring mutations: the window ignoring the change, main telling no window, the rename not written, the CLI dropping the name); full e2e 154 passed, 10 skipped. A new tile reached the store with the window's debounced save, up to 250 ms after `spawn` returned, so a rename that quick found no tile; step 3 fixed that. ☑ Step 3: the rest of the canvas verbs in main. ☑ Close: `tile.close` (and a workflow's `--close`) needs no window. The dispatch takes the tile out of the store (`removeTile` in the document, with its order entries, name, tabs and frame, and in the store, for whichever open workspace holds it) and ends the session it runs, not one it adopted (`hive run`, another device); then its control-plane state goes. A close of a tile no open workspace holds answers `TILE_NOT_FOUND` (exit 5); it used to answer ok. The window takes another writer's change by merging, not replacing: `reloadLayout` keeps what the window changed since it last read or wrote, so an edit it has not yet saved, or not yet rendered, survives (the store's rebase run the other way; `rebaseRecords` and `rebaseFields` are exported for it), and a tile another writer closed is closed as its × closes it, which forgets its place on the canvas and ends a session still starting. A tile the window makes for `spawn` is saved as it first renders, just after `spawn` answers (which keeps the terminal starting after main has wired the spawn, supervision included), so a rename or close straight after finds it. The tile kinds and `isTerminalKind` moved to `@hivemind/workspace-doc/shapes`, where main reads them; `TileRecord` has `session`, and the window's `TileInstance` extends it. Proof: `removeTile` (6 mutations) and the store's (5), the window's merge against a real store (10), the dispatch closing with a real store and no window (7); in `hcp-cross-provider.spec.ts`, a tile closed straight after its spawn leaves the canvas, its processes end and a second close is not found, the reporter's close leaves no place for it in the saved canvas, and the rename test renames straight after the spawn (4 wiring mutations caught: the window not closing what another writer closed, ignoring the change, saving a spawned tile only at its debounced save, and main removing nothing). ☑ List: `tile.list` and `tile.list_frames` run in the dispatch from main's store and status store, with no window. The workspace is the one holding the caller's tile (the CLI now sends it), else the one the window the user is at shows (each window tells main with `workspace:shown`), else none. `@hivemind/workspace-doc/shapes` has the frame and tile fields main reads (a frame's title and where its tiles run; a tile's label, program and task), and the window's `FrameState` and `TileInstance` extend them; `tileStatusOf` moved to `@hivemind/agent-host/tile-status`, shared by the window and the list; the store has `workspaceOf(tileId)`, which its rename and close now use. An unknown `--frame` is refused with a new `NOT_FOUND` code, which the CLI already maps to exit 5. The dispatch takes the store as one narrowed dependency and writes it as `control`. Banner names (`names.ts`) are read from the store with the shared `tileName`, cleaned to one line, so the window's `tile:names` pushes and main's copy of the names are gone. Proof: the dispatch listing with a real store and status store and no window (13 mutations, 12 caught; the one missed is equivalent: a workspace that holds a tile always lists it), the store's lookup (5), the CLI's socket test (the caller's tile is sent; an unknown frame exits 5), and 3 e2e wiring mutations (the window not saying which workspace it shows, main not knowing it, an unknown frame listing everything). A read of a tile no workspace holds answering `TILE_NOT_FOUND` moved to step 4: a workflow reads a worker the moment `spawn` answers, before the window's save can land. ☑ Step 4: spawning writes the tile in main (`tile.spawn_agent`, workflow workers, `tool.open`). The dispatch picks the workspace (the caller's, else the one the user's window shows), the frame (the one named, as list names one; else the caller's; else the one the user is in, which each window reports with `workspace:shown`; else the first bound to a folder; else the first; in a workspace with none, the tile is loose and the window that lays it out makes the frame), the label, arguments and task (`agentLaunch` and `nextOrdinal` in `@hivemind/agents`, `defaultFrame` in `@hivemind/workspace-doc/tile-list`, shared with the window's own spawns), and writes the tile, its frame and its name (`addTile` in the document and the store) before `spawn` answers. Each window hears `hcp:spawned` first (the prompt, and whether it is a background worker), then lays the tile out when it arrives, as it does its own, and still starts the session and delivers the prompt. An unknown `--frame` on spawn or open-tool is refused (exit 5). Gone: the window's `tile.spawn_agent` and `tool.open` handlers, its `hcpSpawnAgent`, and the save-on-render. `mintId` adds a random 0–999 to the millisecond, since main and the window both mint. Proof: 23 mutations over the dispatch's spawn, `addTile`, `defaultFrame` and `agentLaunch`, all caught once three test gaps were closed; the dispatch tests now spawn into a real store (a shared `tests/unit/hcp-workspace.ts`); the golden provider fixture changed only in its four supervised-spawn ids; an e2e spawns into a frame by its title, sees the window lay it out, and has an unknown frame refused. A read of a tile no workspace holds answering `TILE_NOT_FOUND` moved to step 5: after a restart, agents in a project the window does not show still run, in workspaces the store has not opened, so only main knowing every live session can tell gone from unopened. ☑ Step 5: a read of a tile that is gone answers `TILE_NOT_FOUND` (exit 5) at once instead of waiting out its timeout: the dispatch refuses a read of a tile no open workspace holds while main holds no session for it, the rule `send` already follows; a tile still starting is in its workspace already, so it is waited on. Proof: a dispatch test (3 mutations) and an e2e in the structured-failures test. Decided while doing it: main starting each session itself, and typing a first prompt for agents without argv delivery, have no caller while the app always has a window (the tile host mounts every terminal, shown or not, so every session starts), so they move to R14's `hive host`, the first place a spawn has no window; the per-window fan-out moves to step 6, with its first caller, the second window. ☑ Step 6: many windows. ☑ Relay: `@hivemind/agent-host/session-relay` (`SessionRelay`) replaces main's one-window pty plumbing: main holds one attach per session and fans its coalesced output out to every window that shows it, recording it for the control plane once; a window that mounts a session main holds joins it, its screen first, in order with the live bytes; each window has its own interest; an exit reaches every window; a closed window leaves its sessions, and one nobody shows is let go of; while several windows show a session, the one that typed last sizes it (until R4). Proof: 5 relay tests, 9 mutations each caught. ☑ Windows: `main/windows.ts` replaces `mainWindow`: `broadcast` for what concerns everyone (statuses, pipes and wires, spawns, settings, errors, update progress), `userWindow` for what concerns the user (dialogs, a plan review, `hive ctl focus`), and plugin and view installs taken from the main frame of any window. **New window** (in Open recent, Ctrl+R) opens another window on the workspace the asking one shows. `hive views install` and `hive agents install` rescan in every window, each for its own workspace. A window that opens or reloads asks main for the pipes and spawn wires there are (`hcp:links`), then follows the pushes. Two windows mounting one tile at once start it once (`SessionRelay.open`: the second waits for the start and joins it), and a window that joins a session another window started drops its copy of the first task, so a typed first prompt is typed once. Proof: `many-windows.spec.ts` (its own app, so its spawns do not count against another spec's rate limit): a second window opens on the workspace the first shows though another project was opened last, shows a terminal as it is and then live, and draws the wire drawn before it opened; a control-plane spawn mounts in both with its wire, its typed first task runs once, and a rename and a close show in both; a view installed from the CLI appears and goes in both; closing the second window lets go of nothing the first shows. 10 wiring mutations, 9 caught; the tenth, two windows mounting at once, cannot be forced from an e2e, so it lives in `SessionRelay.open` with 2 tests (9 mutations, each caught). `PipeManager.edges()` in the unit test (3 mutations). ☑ Shared layout, per-person state: a view's layout and the board are written from what the window last read or wrote, as the core is (`writeView` and `writeObjects` take a base; `rebaseFields` merges a changed field that holds fields a level down, so a view's places merge tile by tile; `rebaseView`), and a window takes another window's change to the canvas's places (`reloadCanvasLayout`) or the board (`reloadBoardObjects`) over what it has not saved. Board undo is per writer: one Loro `UndoManager` per writer, each skipping the others' board edits (a writer's origin is `board:<writer>;`), so ⌘Z takes back the window's own edit. What is one person's own leaves the document for this device (`personal` view layouts in localStorage, starting once from what the document held): the canvas camera (`canvas-camera`), the Windows view's tab and minimized tiles, and pins (`workspace/pins.ts`; the pin fields leave the tile records, and the window's next save takes them out of the document). Proof: 3 doc tests and 2 store tests (21 mutations, each caught once one test gap was closed), 5 client tests (19 mutations, each caught once one gap was closed), and `many-windows.spec.ts`: a tile moved in one window moves in the other, a camera and a pin stay in the window that made them and out of the workspace, a note from either window shows in both, a save from before either change (sent through the window's own IPC) keeps it, and ⌘Z takes back only the window's own (7 wiring mutations, each caught once that save was added). |
| R6 | One status per session, from its host | ☑ | Mapped 2026-09-29. Local sessions already have one: main's `StatusStore` folds the hooks (which report to main), the local daemon's screen readings and titles, typed interrupts, exits, and plan and approval waits, and every window mirrors it (`hcp:status` pushes, `hcpStatusAll` when it mounts); a window derives only how a tile's process exited and a plain shell's activity. Left: a remote machine's sessions, whose daemon forwards raw events that each desktop folds on its own, so a desktop that connects later, or misses an event, shows another status; and a shell's activity, which each window reads from the bytes it is sent, so a window that does not show the shell reads it idle. ☑ Step 1: a machine's daemon (standalone: no desktop there, so the hooks report to it) keeps the status of its sessions, from the hook events it is sent, its own screen readings and titles, the input it is sent and exits (`SessionManager`'s new `onEnd`), and sends every viewer `agent.status` on each change and every session's on hello. A desktop mirrors it (`StatusStore.mirror`: from then on that session's local reports are ignored, except its end) and still uses the raw events for turns, the mailbox and pipes. Only a machine's own report mirrors: `agent.status` is taken from the remote sink alone, never from a client of the control-plane socket, where it would freeze a local tile's status. A desktop's own daemon leaves status to the desktop, as before. Proof: the real daemon with two viewers, one connecting mid-turn, a Ctrl+C and a kill (both see working, interrupted, exited), and a throwaway agent read from its screen and title (8 mutations, each caught); the store's mirroring and the wire check (13 mutations, each caught once one test gap was closed). Not covered by a test that runs here: the one line in `index.ts` that hands a machine's `agent.status` to the store; `machines.spec.ts` covers the remote path where sshd and a built `hive` are, and this container has no sshd. ☑ Step 2: two windows show one status for an agent: `many-windows.spec.ts` sees a worker working in both windows' Layers rail while its turn runs, then not (caught when main tells one window only). Decided while doing it: a shell's working/idle moves to M2. It is painted only in its own tile's header, from the bytes the window that shows the tile is sent; the rail and the notices take agent statuses only, so no two surfaces disagree today, and a host-side reading of it would have no caller until M2 shares terminals between people. |
| R7 | Intents: one checked, logged path for every side effect | ☑ | Mapped 2026-09-29 from a survey of main: 116 IPC channels (77 change something, 39 only read) and 19 control-plane verbs with effects; checks are spread over a dozen places (the spawn pacer and rate limit, spawn depth, supervision, an agent confined to its repo, the browser switch, paths kept in the repo, the plugin and view review tokens), and there is no check of who calls: most channels take any sender, the control plane has one token that every tile holds, and `callerTile` is what the caller says it is, so a supervised worker can answer its own approval. Decisions: layout, view and board writes are the document's own edits (attributed by writer, R3 peer ids later), not intents; keystrokes, resizes, flow control and interest are not intents (R4's input lease is); the audit is `<userData>/audit.jsonl`, one line per intent (time, actor, intent, target, outcome), rotated at 5 MB with one old file kept; idempotency ids wait for M1, whose peers retry across a network (approvals already take the first answer). ☑ Step 1 (2026-09-30): `Intents.perform(actor, intent, run)` (`packages/workspace-host/src/intents.ts`) carries out an effect and writes one line to the host's `AuditLog` (`audit-log.ts`, `<userData>/audit.jsonl`, created 0600, moved to `audit.jsonl.1` past 5 MB, never throws): when it was asked, the actor (`{kind:"tile",tile}` or `{kind:"person"}`), the verb (the control plane's method name), the target (a tile, a pipe `src->dst`, or the tile a spawn opened), a detail (an approval's decision, the tool asked about) and `ok` or `error` with the error's code. Through it: spawn, `tool.open`, send, send-keys, report, a supervised worker's question and the answer to it, rename, close, connect, disconnect, the rescans, `settings.reload`, `review.open`, and `workflow.run` with each spawn and close it makes. Not intents: reads, a hook reporting (`agent.reply`), focus, view events, and a question the worker's standing answer settles (nobody is asked). The actor is what the call says (`callerTile`); `hive ctl` now names its tile on every call (`hcpCall`), not on some. The policy comes with step 2, with its first rule and actors the app knows. Tests: `packages/workspace-host/tests/intents.test.ts`, `apps/desktop/tests/unit/hcp-audit.test.ts`, the CLI's `ctl-hcp.test.ts`, and the audit lines of `hcp-cross-provider.spec.ts`'s report test. ☑ Step 2 (2026-09-30): actors the app knows rather than is told. Each agent the daemon starts is given a token of its own, `<tile>.<HMAC of the tile under the install's token>` (`tileToken`, `holderOf` in `packages/agent-host/src/hooks/token.ts`): main checks it at `initialize` without storing anything, a restored session is given the same one, a machine with no desktop accepts it too, and neither the CLI nor the SDK changed. The server passes the dispatch the call (`HcpCall`: the actor, and a signal that fires when the caller's connection closes). A tile acts only as itself: a `callerTile` naming another tile is refused, one naming none is taken as its own; the person (the install's token) may act for any tile. The policy (`Intent.onlyBy`, outcome `refused`): an approval is answered by the supervisor it was asked of, or a person, never the worker nor another worker; speaking as a tile is that tile's. A question ends when the hook that asked stops waiting, so an answer after that is refused as late (`BAD_REQUEST`) instead of reported as done. Limits: any process of this user can read `hcp.token` and act as the person (tile tokens make the actor right; they do not wall an agent off); hook notifications (`agent.event`, `agent.reply`) are not checked against the tile they name; a daemon still running from before the upgrade gives new agents the install's token, so their calls are the person's until it restarts; the token a restored session is given back (`rehydrateSnapshot`) is not caught by a test (the restore transform gives an installed agent its tile's token anyway). Tests: `packages/agent-host/tests/token.test.ts`, the policy in `intents.test.ts`, `hcp-audit.test.ts` (a tile speaks only for itself), `hcp-approval.test.ts` (rules 3 and 4, and an answered question's hook closing leaves the next one waiting), the server's actor and signal in `hcp.test.ts`, per-tile tokens in the droid and kiro launch tests and the provider golden, the standalone daemon's tile token, and the e2e's report, made with the worker's own token. Step 3, mapped 2026-09-30 from a survey of the 116 channels (60 change something, 6 write the document, 6 are streams, 44 read; only the 9 plugin and view installs checked their sender): ☑ 3a (2026-09-30): every channel is registered through `apps/desktop/src/main/app-ipc.ts` (`handle`, `on`, `answer`), which answers only the main frame of one of the app's windows; the two `assertSender` copies went. `browser:register` trusted any page id, so the window could bind its own page, or another window's, to a browser tile, and `browserCdp` then drove it with any command: a registration now names one of the calling window's own `<webview>` pages (recorded as they attach), and goes when that page does, so `browser-targets.json` drops closed tiles (it kept them: nothing called `browser:unregister`, which is gone). Tests: `tests/e2e/app-ipc.spec.ts`, each of whose three tests failed before the change (a window that is not the app's is refused a request and a synchronous read; the app's page cannot be registered, a tile's own can until it closes; a window that is not the app's cannot type into a terminal). Not caught by a test: the main-frame half of the gate, since no page but a window's main frame has the preload, so nothing can call from a subframe. ☑ 3b (2026-09-30): the window's effects go through the host's intents as the person at the window (`handleEffect`, `onEffect`, `performed` in `app-ipc.ts`), from one `Intents` that the control plane shares (`apps/desktop/src/main/audit.ts`): tiles (a session the window starts, not one it joins or reattaches after a restart; its end; a plan decision; the browser tile's self-test), files (write, a resolved conflict, open in an app, a new workspace, the agentic stack, review notes), git (stage, unstage, discard, commit, push, pull, worktree create, remove and prune), issues (create, update, state, comment, link, unlink, move, delete), settings (replace, set, patch: which settings, never their values; notifications; the browser bridge switch), installs (a view, an agent, their removal, the auto-install, the upgrade) and machines (add, check, install, update, edit, remove, a password (never the password itself), reconnect). Not intents: reads, the document's own edits, streams, and the app's own presentation and bookkeeping (a new window, wallpaper and media, sharing a view's picture, diagnostics, the status ledger, notifications, a browser page's registration, the window's replies to the control plane). A review opened with `hive ctl open-review` is recorded with the person's decision (an intent's `detail` can be read from its result, like its target). Tests: `tests/e2e/window-audit.spec.ts` (twenty effects across workspaces, issues, files, git, worktrees, reviews and settings, recorded in order with what each acted on, a refused write as failed, reads not at all; a terminal the window starts and ends, and a second window joining it starts nothing), the review's decision in `hcp-audit.test.ts`, and the result-read detail in `intents.test.ts`. Not exercised by a test: machines (they need an ssh host), the catalog installs and the upgrade (network), a plan decision, opening a file in an app. |
| R8 | Workspace API that is not Electron IPC | ☑ | Done 2026-09-30 (steps below). Mapped 2026-09-30. The window calls about 120 functions on `window.hive`: the 116 channels main answers, 22 kinds of push, and per-session (`pty:data:<id>`, `pty:exit:<id>`) and per-repo (`fs:changed:<repo>`) channels. The dev-bridge (`src/dev-bridge/server.ts`) answers a subset over HTTP with copies of main's handlers, outside the gate and the audit, and without main's checks (its `gitStage` takes a path outside the repo). Decisions: the **workspace API** is what a workspace's host is asked for by a window, a peer or another device: terminals (and their output, exit and activity), status (and its pushes), git and worktrees, files (and their changes), issues and reviews, the workspace store, views' sessions, prompts and ledger, plan decisions and the control plane's window verbs. The rest is **local-only**: dialogs, open in an app, windows, updates, the clipboard, the browser tile and its bridge, notifications, wallpaper, diagnostics, settings, machines, installs, presence and menus. A call is `{method, params}` and its answer `{result}` or `{error: {code, message}}`, the bodies of a JSON-RPC 2.0 request and response with a code a client branches on (`BAD_REQUEST`, `UNKNOWN_METHOD`, `FAILED`); positional params, dotted method names (`git.stage`), which are also the audit log's verbs for them on every transport. A transport that pairs an answer with its call (an IPC invoke, an HTTP request) carries them as they are; the stream in step 5 adds an `id`. Defined once: `spec/workspace-api.md`, and `packages/workspace-api` (TypeScript: the method types, a client over any transport, a server that runs a method through the intents and records it), so a Rust client (hive-net's bridge in R10, the phone in M5) implements the same spec; no Rust crate before its first caller, and conformance cases come with that second implementation (until then they would restate the TypeScript tests). Each domain's handlers live in one Electron-free module that main and the dev-bridge both serve. The window renders from what it holds: over Electron it reads its own main as now; over a stream it keeps the layouts it opened, so it never waits on a network to draw (M1 turns that into a Loro replica on `hive/ws/1`). Steps: ☑ 1 the package, and git and worktrees through it on both transports: main answers the window on one gated channel (`workspace`), the dev-bridge at `POST /workspace` with its token, from the same module (`src/main/workspace-git.ts`), as the person, recorded under the dotted verbs. Each method checks its params where the call comes in (moved there from the adapter): a file outside the repo, and anything git would read as an option, is `BAD_REQUEST`. Two holes it closed: a diff's `sha` of `--output=<path>` made git write the diff to that path, and a file named `--all` staged everything (`git add` now takes `--`). The dev-bridge's git had none of main's checks and no audit; the audit log now makes its directory when there is none; ☑ 2 files, issues and reviews, as domains beside git's in `src/main/workspace/` (one list, `workspaceDomains`, that main and the dev-bridge both serve). What only the machine at hand answers stays a channel of its own: opening a folder (`resolveProject`), making a workspace there (`initWorkspace`, `installAgentic`), the machine's list of workspaces (`listWorkspaces`, `resolveIssueRoot`) and opening a file in another app. An issue a call asks for is checked against core's schemas (`IssuePatchZ`, `NewIssueZ`, each field as the frontmatter holds it): a malformed one is `BAD_REQUEST` naming the field, before anything is read (core refused it only as it wrote, with zod's raw error, which came back `FAILED`; a `labels` that was not a list failed on a `TypeError`). Two holes closed: a new issue's `who` was the caller's to name, so any caller could sign its activity; and saving review comments with anything but a list replaced every comment with none. The dev-bridge's own copy of the state change, which wrote the activity by hand, is gone; ☑ 3 terminals and status, with their events. 3a: connections, notices and events in the protocol; each window is a connection (`src/main/workspace-ipc.ts`: `workspace`, `workspace:notice`, `workspace:event`), and a dev-bridge page's is its event stream (`GET /workspace/events`); agents' status and links are methods (`status.all`, `link.list`) and events (`status.changed`, `link.pipe`, `link.spawn`, `tile.opened`) from `src/main/workspace/agents.ts`. 3b: terminals are `src/main/workspace/terminals.ts`, Electron-free: each connection a viewer of the sessions it shows, the typer rule, the pause lease, and which starts and ends are intents (`terminal.open`, `terminal.close`), over a `SessionBackend` that is main's (daemon, this process, ssh, with the control plane's taps) or the dev-bridge's (this process); keystrokes, resizes, flow, showing and detaching are notices; output, exits and activity are events. The file watcher sends `file.changed` over a connection and stops when it closes; the window's watch still starts where it did (opening a project). The dev-bridge lost its own terminal code, its two event streams and its RPC notifications, and is typechecked with the app now. Found and fixed: in a git repo with no `.hivemind`, no working-tree change was ever reported (chokidar 4 missed the tree added after a missing `.hivemind` was watched); ☑ 4 the store, held by the client: `src/main/workspace/store.ts` (`Layouts`) serves `store.*` over a `WorkspaceStore`, each connection a writer of its own, told of every other writer's change (`store.changed`) and never its own, and says where it is with `store.shown`; the window's `sendSync` channels answer from it as the window's connection, so a window still builds its first state in one pass. A client over a stream holds what it opened (`StoreReplica` in the package): writes held at once and sent in order, another's change read again after its own writes land, a reading its own write overtook read again rather than held, and an undo that answers false and arrives as a change. Its first caller is the dev-bridge page, whose inline script became `src/dev-bridge/page.ts`, bundled by vite as the bridge starts, over a store of the bridge's own. That page had been broken for a while (the renderer calls machine-local functions it never had, `getNotificationSettings` first); it now answers those as a machine with nothing configured, and in Chromium it draws the canvas, runs a terminal (typing, output) and keeps its layout across a reload; ☑ 5 the harness: `playwright.harness.config.ts` (`pnpm test:e2e:harness`) runs the canvas, terminal, git and issue specs (tile-move, resize, frame, keyboard-gate, terminal-io, editor, shipped-features, issue-create, issues-tile) against the renderer in Chromium on the dev-bridge, each launching its window through `tests/e2e/helpers/window.ts` (the app, or the browser); they pass as they do in the app. `terminal-io.spec.ts` was written for it: nothing else carried keys to a shell and its output back to the window. The local socket main was to serve goes with R10, where hive-net is its first caller. |
| R9 | Machines by id, not by ssh uri | ☐ | |
| R10 | `hive-net` (Rust, iroh): profiles, local mode, `serve` roles | ☐ | After R3. Brings the workspace API's local socket (0600) main serves, which hive-net bridges: moved here from R8 step 5, as hive-net is its first caller. The framing is the spec's (`spec/workspace-api.md`) with an `id` pairing each answer with its call. |
| R11 | Access list (owner-only, replicated) and audit | ☐ | After R3 |
| R12 | View protocol 1.5 | ☐ | |
| R13 | Our relays, lookup and relay access (used only by choice) | ☐ | Before M1 ships |
| R14 | Headless host: `hive host` | ☐ | After R1, R7, R10, R11. Carried from R5: main starts each tile's session itself, and types the first prompt for agents without argv delivery (reading the host's screen), so a spawn needs no window. |
| R15 | Canvas renders board objects | ☑ | ☑ Step 1: `packages/workspace-doc/src/objects.ts` (`writeObjects` / `readObjects`: notes, checklists, text labels, arrows in `objects` by id; text as Loro text updated by a diff, so typing merges by character; a checklist's items as records by id plus `itemOrder`; a framed object's `x`, `y` relative to its frame; input checked, unknown fields kept), shapes in `shapes.ts`; `order.ts` and `input.ts` now shared with `core.ts`. 6 bun tests, plus board objects in the other-copy test; 16 mutations, each caught. ☑ Step 2: `WorkspaceStore.getObjects` / `setObjects` / `undo` / `redo`: undo through Loro's `UndoManager`, board edits only (the layout, views and imports are committed as `sys:` and never undone), edits within a second one step; sync IPC (`workspace:objects-sync`, `set-objects-sync`, `undo-sync`, `redo-sync`) and `readBoard` / `writeBoard` / `undoBoard` / `redoBoard` in the window's store client. Found: redo of a record undo had taken back wrote a mergeable record's text twice ("draftdraft"); records are now made fresh with the document's own classes. 1 new store test plus rows; 10 mutations, each caught. ☑ Step 3: the canvas draws, adds and edits them. `board-objects/`: `board-model.ts` (pure: where a box is kept and where it is drawn, a new box, a copy, what a delete takes, an arrow's sides), `useBoard.ts` (a window's board: selection, the object being written in, an arrow being drawn, saving, undo and redo through the store), `TextDraft.tsx` (a field's draft: saved after 400 ms idle, on leaving it and on ⌘Z), `BoardNodes.tsx` (note, text, checklist nodes), `Arrows.tsx` (arrows in their own layer: react-flow draws no edge between nodes without handles); wired into the canvas's nodes, a frame's drag, arrange and auto-fit, placing a spawned tile, the shortcuts and the toolbar's **Board** menu. Changed in the store: one undo step per board save (`mergeInterval: 0`; a second's merging folded separate edits into one), and the schema is stamped on load, so the first board write is not an empty step. Proof: 5 unit tests (`board-model.test.ts`, 12 mutations each caught) and 2 changed (node build, frame layout); `board-objects.spec.ts`, 4 e2e tests, green three runs in a row, 8 mutations each caught (a note that never takes focus, a frame drag that leaves its boxes, a drop that keeps the old frame, a draft that keeps undone text, undo steps merged, a reorder that goes nowhere, arrows left behind by a delete, ⌘D doing nothing). `toolbar-actions.spec.ts` expects the Board button on the canvas (and not in other views); the renderer entry-size guard is re-baselined (905 418 → 947 213 bytes: the board is drawn on the first frame and a new note takes the next key, so it is not a lazy chunk). ☑ Step 4: design text (R15 as built: arrows by two clicks from the menu, no drag handle yet; undo per save), tracker, changelog. Full e2e green on the first run: 151 passed, 10 skipped. |
| R16 | Network profiles (Local network default), reach chooser, admission, update-check switch | ☐ | With R10 |

### Milestones (design §11)

| # | Milestone | Status |
|---|---|---|
| M0 | Phase 0 complete; local network mode first | ☐ |
| M1 | Multiplayer board, incl. sticky notes, checklists, text, arrows | ☐ |
| M2 | Multiplayer terminals | ☐ | Carried from R6: a shell's working/idle read by its host (every byte passes the relay) and shown to everyone who views it, not from the bytes each viewer is sent. |
| M3 | Your devices and always-on hosting | ☐ |
| M4 | Agents on my machine in their workspace | ☐ |
| M5 | Phone (iOS first; Android with FCM and UnifiedPush) | ☐ |

**Before M5:** an Apple Developer Program membership and a Firebase project (design §12.4).

### Known issues

None open. Fixed on 2026-09-29 (see the log): a read of a gone tile waiting out its timeout, closed tiles leaving their processes running, agent pipes and
spawn wires not being drawn, and two issues found while verifying R1.

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
- 2026-09-29 — Fixed, found while mapping R5: a tile closed any way but its own × left its
  session running. With the PTY daemon on (the default), `closeTile` let the terminal unmount,
  and an unmount detaches, because a project switch unmounts every tile and the daemon keeps
  their sessions. Closing with ⌘W, in the Windows view, with `hive ctl close` or a workflow's
  `--close` therefore left the process running, unseen, with nothing to reach it by. Now
  `closeTile` tells the terminal (`endTileSession`), which kills its session as it unmounts, or
  kills it directly when none is mounted; an adopted session is still only let go. Also, a kill
  now runs main's exit teardown (a daemon tells its killer nothing), so a read or an approval
  waiting on the tile is answered at once. And `hive ctl read` stops when main answers
  `closed` (exit 5): its short polls used to go on to the full timeout and report `timeout`,
  and the shipped skill says a timeout means "read again". `hcp-cross-provider.spec.ts` checks
  that no process is left for a worker closed by `hive ctl close` or in the Windows view, and
  that a read already waiting is told `closed` with exit 5. Each of the three fixes, undone,
  fails it.
- 2026-09-29 — R5 step 1: one tile list (`@hivemind/workspace-doc/tile-list`; see the row).
  The full e2e run after the close fixes: 153 passed, 10 skipped. Found while running a subset:
  `zz-sixth-provider.spec.ts` failed after `hcp-cross-provider.spec.ts` when no daemon-mode
  spec ran between them. Both use the run's shared profile, and each spec's teardown killed its
  PTY daemon and then closed the app. The closing app found its daemon gone and started
  another, so the next spec's tiles ran in the previous spec's environment (its stand-in agents
  deleted, so a spawned agent exited at once). Both specs now reap the daemon again after the
  app closes. The standard full order hid it: a daemon with no sessions exits by itself after
  8 s, and more than that passes between the two specs in a full run.
- 2026-09-29 — R5 step 3, close (see the row). Decisions: the dispatch owns what a close ends
  (index.ts only hands it the store's `removeTile` and the session kill), so it is tested with a
  real store and no window. The window merges another writer's change instead of re-reading
  it: re-reading dropped an edit it had made and not yet rendered, and replacing the tiles with
  a fresh read would have lost a tile the window opened a moment before. A tile made for
  `spawn` is saved at its first render rather than before the answer: saving first would have
  rendered it first, and its terminal would start before main set the worker's supervision,
  which rides the start. A read of a tile no workspace holds stays on its timeout until step 4
  (why: **Known issues**). Full e2e on the close commit: 154 passed, 10 skipped, 1 failed:
  `windows-view.spec.ts` "a restored tab stays restored when the view switches at once", while
  mutation runs shared the machine; that spec passed three times alone on the same build.
- 2026-09-29 — R5 step 3, list (see the row). Decisions: a caller in no tile (a terminal, a
  script) gets the workspace the window the user is at shows, which each window tells main as it
  changes, rather than main guessing from the last layout a window read (a window that closes
  its project reads none). Banners use the name every surface shows, down to the tile's label.
  Full e2e on the list commit, on a quiet machine: 155 passed, 10 skipped (the Windows view test
  that failed under load passed). Step 3 done; steps 4 and 5 re-sliced (see the row).
- 2026-09-29 — R5 step 4: spawning writes the tile in main (see the row). Full e2e: 156
  passed, 10 skipped. Working rule adopted at the maintainer's ask to move faster: one full e2e
  per step, run in the background while the next is written, specs the change touches in
  between, and each step's mutation checks in one batch.
- 2026-09-29 — R5 step 5: a read of a gone tile answers `TILE_NOT_FOUND` at once (see the
  row; the last known issue). Steps re-sliced by the rule of no API before its first caller:
  main-started sessions and typed first prompts go to R14, the fan-out to step 6.
- 2026-09-29 — R5 step 6, relay and windows (see the row). The relay commit (`d9d128c`) left
  this tracker unchanged; it is recorded here. Found while writing the two-window e2e: two
  windows mounting a control-plane spawn at once each attached (the second attach replays the
  screen into the first) and each typed a typed first prompt; both fixed as the row says. A
  window's link listeners mount after its page has loaded, so pushing the links at
  `did-finish-load` lost them; the window asks instead, as it asks for statuses. A same-window
  remount keeps its task: `joined` means another window started the session. The two-window e2e
  first ran inside `hcp-cross-provider.spec.ts` and pushed that spec past the control plane's
  16 spawns a minute, so its last test was refused; it has an app of its own now. Full e2e on
  the windows commit (`6d0ae0c`): 156 passed, 10 skipped, 1 failed, `zz-sixth-provider.spec.ts`'s
  lifecycle test (a read with no reply text) while unit tests and typechecks ran beside it; it
  passed twice alone on the same build. Next: per-person view state and the shared layout.
- 2026-09-29 — R5 step 6, shared layout and per-person state (see the row). Decisions: a pin is
  one person's (it floats at a place on their screen), so pins joined the camera and the Windows
  view's tab on this device. One person's state lives in the window's localStorage, not main's
  store: nothing outside the window reads it, and each window keeps its own while it is open (the
  one saved last is where the next window starts). A shared view layout that no window shows
  twice (a community view's) is written from a base but not merged live: no caller has two
  windows on one community view yet. Board undo per writer came with the second window: one
  history for the workspace let one window's ⌘Z take back another's note.
- 2026-09-29 — Full e2e on the shared-layout commit: 157 passed, 10 skipped, 1 failed, the same
  `zz-sixth-provider.spec.ts` lifecycle test as on the windows commit, on a quiet machine this
  time. Root cause: `many-windows.spec.ts` opens a second window on its project, which Open
  recent saves as the last project; the spec then deletes that folder, and every later spec on
  the run's shared profile started on a folder that no longer existed, so its agents could not
  start. Fixed twice: the spec leaves the last project as it found it, and the app opens the
  folder it was started in when the last project is gone (`projectDir`, which also covers a
  user who moved or deleted it).
- 2026-09-29 — R6 (see the row). Full e2e on the R6 step 1 commit (`c6b34b7`): 159 passed, 10
  skipped. Decided: a shell's activity moves to M2 (why: the row). R6 is done; next by the
  order and the dependencies: R7 (intents), after R5.
- 2026-09-29 — Leaks fixed (asked for by the maintainer). Each window's board history (R5 step
  6c) outlived the window: 1,500 windows' histories held 1.68 GB against 34.5 MB freed, and every
  live history observes every later edit; the store now forgets a writer (`forgetWriter`) when
  its window closes. Main's status store never forgot a session, so every agent ever run stayed
  and each window that opened was sent them all; a closed tile's status and agent now go when its
  session ends (`endSession`). A machine's daemon kept ended sessions' screen and title readings
  and told a desktop that connected later of a screen nothing shows; it forgets them when a session
  ends, with each connection's sequence and typing marks. The relay forgets a session's typing
  mark at its exit, and each window's status bus a closed tile's status. Not caught by a test,
  being memory only: the daemon's title book entry (a later desktop is never sent an empty title),
  the relay's typing mark, the window's own wiring of `forgetWriter` and of `forgetStatus`.
  Bounded, not a leak: main's store keeps each project it has opened (tens at most), since the
  control plane reads the workspaces of tiles that run in a project no window shows. Full e2e on
  the leak commit (`e48dded`): 159 passed, 10 skipped. R7 mapped (see the row).
- 2026-09-30 — R7 step 1 (see the row). Mutations, all caught: 16 on the package (no line on
  ok or on error, no code, an error swallowed, a spawn's tile or the detail left out, `at` taken
  when it ended, the actor lost, a world-readable file, no rotation or rotation at 4 MB or only
  once past 5 MB, a write that throws, a warning on every failure or only ever once, the file
  overwritten), 27 on the dispatch (each of the 16 verbs taken off the path, the caller ignored or
  its pty id kept, a spawn's tile, a pipe reversed, an approval's worker or decision or tool left
  out, an answer from the cache recorded, a workflow's spawn or close taken off the path, a read
  recorded), 2 on the CLI (no tile named; a named one overridden), and 2 on main through the e2e
  (the log written elsewhere; a report's actor lost). Also fixed: `@hivemind/agents`'
  `launch.test.ts` (R5 step 4) seeded the process's agent catalog and never emptied it, so
  `registry.test.ts`'s "the catalog starts empty" failed in the package's full run. CI runs on
  main and on pull requests only, so no run showed it. Each file that seeds the catalog now does
  so in `beforeAll` and empties it in `afterAll`.
  Full e2e on the step 1 commit (`a59ec1e`): 159 passed, 10 skipped.
- 2026-09-30 — R7 step 2 (see the row). Mutations, all caught: 6 on the token (a MAC under
  another key or of another string, any tile accepted, the person unknown, an install with no
  token knowing everyone, the first dot taken), 4 on the policy (none, the person refused, a
  refusal unrecorded, a refused intent run), 11 on the dispatch and server (impersonation allowed
  or unrecorded, a tile's own id not filled in, anyone answering, a refusal as INTERNAL, a question
  outliving its asker, an answered question's close clearing the next one's waiting, which the
  first run missed and a test now catches, a vague late message, every caller the person, no
  abort on close, any token accepted), 1 on the standalone daemon (the install's token only) and
  1 through the e2e (agents given the install's token).
  Full e2e on the step 2 commit (`fa1c5a9`): 159 passed, 10 skipped.
- 2026-09-30 — R7 step 3a (see the row). Mutations through the e2e, all caught but one: a
  request, a synchronous read or a message answered from anywhere; the gate refusing the app's
  own window; any page registered; a page's registration kept after it goes; pages not recorded.
  The survivor is the main-frame half of the gate (see the row). Full e2e on the 3a commit
  (`4a16e6d`): 162 passed, 10 skipped.
- 2026-09-30 — R7 step 3b, and with it R7 (see the row). Found while testing it: a worker the
  control plane spawns has its session started by the window, and a tile the control plane
  closes is closed again by every window showing it (which also ends a session still starting),
  so both would have been recorded as the person's too; a session started for a control-plane
  spawn, and an end that follows one already made, are not intents of their own. Mutations, all
  caught: 11 through the e2e (the window's effects unrouted; a session started, joined or
  reattached recorded wrongly; a control-plane spawn's session recorded as the person's; an end
  that follows another recorded, from a window and from the control plane; an end not recorded;
  a count's wording; a created issue, a workspace's prefix or a setting not named) and 3 in unit
  tests (a detail read from the result ignored, or guessed on a failure; a review's decision not
  recorded). Next by the order: R8 (a workspace API that is not Electron IPC), after R7.
  Full e2e on the 3b commit (`1b6e10b`): 164 passed, 10 skipped. From here the whole suite runs
  once per item, not per step (see **Working rules**).
- 2026-09-30 — R8 step 1 (see the row). Mutations, all caught: 6 on the package (an error's code
  not kept, or its system code dropped; params that are not a list run; effects not through the
  intents; reads recorded; the client throwing without the code), 6 in the desktop's security
  tests with real git (no containment; a diff's `sha`, `base` or `head` unchecked; `git add`
  without `--`; a branch's shape or a list's entries unchecked), 2 on the audit log (no directory
  made, or one others can read) and 2 through the e2e in one build (the window's unstage sent as a
  stage; main answering as a tile). The dev-bridge was driven by hand: no token is 401, a path
  outside the repo `BAD_REQUEST`, an unknown method `UNKNOWN_METHOD`. Targeted e2e (audit,
  worktree frame, diff tile, editor, review comments): 21 passed.
- 2026-09-30 — R8 step 2 (see the row). Mutations, all caught: 7 in unit tests through the server
  (an update's patch, a new issue or a state unchecked; an empty title or a `github` of 0 allowed
  by the patch's schema; review comments saved from what is not a list; files not kept in the
  repo) and
  1 through the e2e (main serving the git domain only). Targeted e2e (audit, init workspace,
  issue create, issues tile, review comments, editor): 18 passed.
- 2026-09-30 — R8 step 3a (see the row). Mutations, all caught: 6 on the package (a connection
  kept after it goes, or connected twice; domains not told it went; a listener's failure stopping
  the rest; a stopped listener still called) and 2 through the e2e, each in its own build (status
  changes, and the control plane's tile opens, not published). The first run of the double
  connect survived: the test connected twice the connection it never closed; it now closes that
  one. Targeted e2e (agent links, app IPC, cross-provider, many windows, view agents, audit): 21
  passed, once `agent-links.spec.ts` sent the API's event rather than the old channel.
- 2026-09-30 — R8 step 3b, and with it step 3 (see the row). Mutations, all caught: 9 in unit
  tests of the terminals (every start recorded, or none; a close that follows another's
  recorded; ends not remembered; anyone sizing; typing not noted; a pause kept as a latch; a
  client that goes letting go of nothing; a detach letting go though another client shows it,
  which the first run missed and a check now catches), 1 on the file watcher (a closed client
  still watching) plus its regression test failing on the code before the fix, and 2 through the
  e2e (the window's close sent as a detach; the control plane's recorder not fed, caught by the
  droid and sixth-provider specs but not by the claude one, which reads through hooks). Targeted
  e2e (18 terminal specs, remote machines and persistence among them): 60 passed, 10 skipped.
- 2026-09-30 — R8 step 4 (see the row). Mutations, all caught: 5 on the replica, through a
  transport that answers late and lets every other call overtake the one before (writes not
  queued, a reading its own write overtook held, an undo not read again, a read that opens
  nothing, a reread not after the writes), 4 on the store's domain (every client told of its own
  change, one writer for all, a bad layout a failure, a gone client still shown), 1 on the store
  (`getViews` keeping one view) and 2 through the e2e, each in its own build (changes told to no
  window; the window never saying what it shows, which fails 12 control-plane tests). Targeted
  e2e (13 store specs): 46 passed.
- 2026-09-30 — R8 step 5, and with it R8 (see the row). Mutations, all caught: 2 on the browser
  page (keystrokes sent nowhere; output never listened for) and 1 on the app's preload (output
  never listened for), each failing `terminal-io.spec.ts`. The harness was shown to run in the
  browser: pointed at a Chromium that does not exist, it fails. Harness (9 specs in Chromium on
  the dev-bridge): 32 passed. Full e2e on the step 5 tree: 165 passed, 10 skipped. Next by the
  order: R3 (identity: device, person and workspace keys), which R10 and R11 wait on; R4, R9
  and R12 can go at any time.
