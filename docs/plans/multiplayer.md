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
| R5 | Main fans out to many clients; canvas verbs run in main | ☑ | Mapped 2026-09-29 (steps and decisions below). Decisions: "with no window" means the verbs never call a renderer, shown by tests at the control plane's dispatch with a real store and no window; an app left running with no window open is R14's `hive host` (closing the last window quits the app today). The in-process PTY path (`HIVEMIND_PTY_DAEMON=0`: an id per mount, detach is kill) stays one window. Carried: from R2, a window writes from the document's current state, and per-person view state (the canvas camera, the Windows view's active tab and minimized tiles) leaves the document; from the known issues, a read of a tile that is gone answers `TILE_NOT_FOUND`. ☑ Step 1: one tile list. `@hivemind/workspace-doc/tile-list` (no Node, no Loro): `frameFor` finds a frame by its id, title in any case, the folder it runs in, then a title containing the name; `tileName` (moved from the window); `listTiles` and `listFrames` build what `hive ctl list` and `hive ctl frames` print, from the frames, tiles, memberships and names a workspace holds, plus what only the running app knows (status, agent titles, which agent runs in a tile). The window's `tile.list`, `tile.list_frames` and spawn's frame targeting use it (they were three copies); `Workspace.tsx`'s three copies of "which agent runs in a tile" are one `agentOfTile`. No behaviour changes: an unknown `--frame` still lists everything (step 3 decides that, where errors have exit codes). The core layout's full frame and tile shapes move to the package with their first reader in main (step 3). Proof: 4 tests, 13 mutations each caught; full e2e 153 passed, 10 skipped. ☑ Step 2: a second writer, safely. `@hivemind/workspace-doc`: `writeCore(doc, layout, base)` writes only what changed from `base` (`rebase.ts`, pure: records by id and field by field; the writer's additions, changes and removals; what others changed, added or removed since stays; the writer's order, then others' additions) and `writeTileName` names one tile. The store: `setCore(repo, core, { base, writer })`, a `writer` on every write, `renameTile(tileId, name, …)` for the workspace that holds the tile, and `onChange` told once per write that changed something (none for one that did not, which also writes no file). Main: `workspaceStore()`, each window writing as `window:<id>`, every other window told `workspace:changed`; the window's store client sends the core it last read or wrote as the base; `Workspace.tsx` flushes its pending save and reads the core again (a plan review, never saved, stays open). The first other writer: `tile.rename` in main (`hive ctl rename <tile> ["name"]`, names cleaned as a person's are). Proof: 3 rebase tests (12 mutations), 2 store tests (7), a client test with a real store (3), and an e2e in `hcp-cross-provider.spec.ts` (4 wiring mutations: the window ignoring the change, main telling no window, the rename not written, the CLI dropping the name); full e2e 154 passed, 10 skipped. A new tile reached the store with the window's debounced save, up to 250 ms after `spawn` returned, so a rename that quick found no tile; step 3 fixed that. ☑ Step 3: the rest of the canvas verbs in main. ☑ Close: `tile.close` (and a workflow's `--close`) needs no window. The dispatch takes the tile out of the store (`removeTile` in the document, with its order entries, name, tabs and frame, and in the store, for whichever open workspace holds it) and ends the session it runs, not one it adopted (`hive run`, another device); then its control-plane state goes. A close of a tile no open workspace holds answers `TILE_NOT_FOUND` (exit 5); it used to answer ok. The window takes another writer's change by merging, not replacing: `reloadLayout` keeps what the window changed since it last read or wrote, so an edit it has not yet saved, or not yet rendered, survives (the store's rebase run the other way; `rebaseRecords` and `rebaseFields` are exported for it), and a tile another writer closed is closed as its × closes it, which forgets its place on the canvas and ends a session still starting. A tile the window makes for `spawn` is saved as it first renders, just after `spawn` answers (which keeps the terminal starting after main has wired the spawn, supervision included), so a rename or close straight after finds it. The tile kinds and `isTerminalKind` moved to `@hivemind/workspace-doc/shapes`, where main reads them; `TileRecord` has `session`, and the window's `TileInstance` extends it. Proof: `removeTile` (6 mutations) and the store's (5), the window's merge against a real store (10), the dispatch closing with a real store and no window (7); in `hcp-cross-provider.spec.ts`, a tile closed straight after its spawn leaves the canvas, its processes end and a second close is not found, the reporter's close leaves no place for it in the saved canvas, and the rename test renames straight after the spawn (4 wiring mutations caught: the window not closing what another writer closed, ignoring the change, saving a spawned tile only at its debounced save, and main removing nothing). ☑ List: `tile.list` and `tile.list_frames` run in the dispatch from main's store and status store, with no window. The workspace is the one holding the caller's tile (the CLI now sends it), else the one the window the user is at shows (each window tells main with `workspace:shown`), else none. `@hivemind/workspace-doc/shapes` has the frame and tile fields main reads (a frame's title and where its tiles run; a tile's label, program and task), and the window's `FrameState` and `TileInstance` extend them; `tileStatusOf` moved to `@hivemind/agent-host/tile-status`, shared by the window and the list; the store has `workspaceOf(tileId)`, which its rename and close now use. An unknown `--frame` is refused with a new `NOT_FOUND` code, which the CLI already maps to exit 5. The dispatch takes the store as one narrowed dependency and writes it as `control`. Banner names (`names.ts`) are read from the store with the shared `tileName`, cleaned to one line, so the window's `tile:names` pushes and main's copy of the names are gone. Proof: the dispatch listing with a real store and status store and no window (13 mutations, 12 caught; the one missed is equivalent: a workspace that holds a tile always lists it), the store's lookup (5), the CLI's socket test (the caller's tile is sent; an unknown frame exits 5), and 3 e2e wiring mutations (the window not saying which workspace it shows, main not knowing it, an unknown frame listing everything). A read of a tile no workspace holds answering `TILE_NOT_FOUND` moved to step 4: a workflow reads a worker the moment `spawn` answers, before the window's save can land. ☑ Step 4: spawning writes the tile in main (`tile.spawn_agent`, workflow workers, `tool.open`). The dispatch picks the workspace (the caller's, else the one the user's window shows), the frame (the one named, as list names one; else the caller's; else the one the user is in, which each window reports with `workspace:shown`; else the first bound to a folder; else the first; in a workspace with none, the tile is loose and the window that lays it out makes the frame), the label, arguments and task (`agentLaunch` and `nextOrdinal` in `@hivemind/agents`, `defaultFrame` in `@hivemind/workspace-doc/tile-list`, shared with the window's own spawns), and writes the tile, its frame and its name (`addTile` in the document and the store) before `spawn` answers. Each window hears `hcp:spawned` first (the prompt, and whether it is a background worker), then lays the tile out when it arrives, as it does its own, and still starts the session and delivers the prompt. An unknown `--frame` on spawn or open-tool is refused (exit 5). Gone: the window's `tile.spawn_agent` and `tool.open` handlers, its `hcpSpawnAgent`, and the save-on-render. `mintId` adds a random 0–999 to the millisecond, since main and the window both mint. Proof: 23 mutations over the dispatch's spawn, `addTile`, `defaultFrame` and `agentLaunch`, all caught once three test gaps were closed; the dispatch tests now spawn into a real store (a shared `tests/unit/hcp-workspace.ts`); the golden provider fixture changed only in its four supervised-spawn ids; an e2e spawns into a frame by its title, sees the window lay it out, and has an unknown frame refused. A read of a tile no workspace holds answering `TILE_NOT_FOUND` moved to step 5: after a restart, agents in a project the window does not show still run, in workspaces the store has not opened, so only main knowing every live session can tell gone from unopened. ☑ Step 5: a read of a tile that is gone answers `TILE_NOT_FOUND` (exit 5) at once instead of waiting out its timeout: the dispatch refuses a read of a tile no open workspace holds while main holds no session for it, the rule `send` already follows; a tile still starting is in its workspace already, so it is waited on. Proof: a dispatch test (3 mutations) and an e2e in the structured-failures test. Decided while doing it: main starting each session itself, and typing a first prompt for agents without argv delivery, have no caller while the app always has a window (the tile host mounts every terminal, shown or not, so every session starts), so they move to R14's `hive host`, the first place a spawn has no window; the per-window fan-out moves to step 6, with its first caller, the second window. ☑ Step 6: many windows. ☑ Relay: `@hivemind/agent-host/session-relay` (`SessionRelay`) replaces main's one-window pty plumbing: main holds one attach per session and fans its coalesced output out to every window that shows it, recording it for the control plane once; a window that mounts a session main holds joins it, its screen first, in order with the live bytes; each window has its own interest; an exit reaches every window; a closed window leaves its sessions, and one nobody shows is let go of; while several windows show a session, the one that typed last sizes it (until R4). Proof: 5 relay tests, 9 mutations each caught. ☑ Windows: `main/windows.ts` replaces `mainWindow`: `broadcast` for what concerns everyone (statuses, pipes and wires, spawns, settings, errors, update progress), `userWindow` for what concerns the user (dialogs, a plan review, `hive ctl focus`), and plugin and view installs taken from the main frame of any window. **New window** (in Open recent, Ctrl+R) opens another window on the workspace the asking one shows. `hive views install` and `hive agents install` rescan in every window, each for its own workspace. A window that opens or reloads asks main for the pipes and spawn wires there are (`hcp:links`), then follows the pushes. Two windows mounting one tile at once start it once (`SessionRelay.open`: the second waits for the start and joins it), and a window that joins a session another window started drops its copy of the first task, so a typed first prompt is typed once. Proof: `many-windows.spec.ts` (its own app, so its spawns do not count against another spec's rate limit): a second window opens on the workspace the first shows though another project was opened last, shows a terminal as it is and then live, and draws the wire drawn before it opened; a control-plane spawn mounts in both with its wire, its typed first task runs once, and a rename and a close show in both; a view installed from the CLI appears and goes in both; closing the second window lets go of nothing the first shows. 10 wiring mutations, 9 caught; the tenth, two windows mounting at once, cannot be forced from an e2e, so it lives in `SessionRelay.open` with 2 tests (9 mutations, each caught). `PipeManager.edges()` in the unit test (3 mutations). ☑ Shared layout, per-person state: a view's layout and the board are written from what the window last read or wrote, as the core is (`writeView` and `writeObjects` take a base; `rebaseFields` merges a changed field that holds fields a level down, so a view's places merge tile by tile; `rebaseView`), and a window takes another window's change to the canvas's places (`reloadCanvasLayout`) or the board (`reloadBoardObjects`) over what it has not saved. Board undo is per writer: one Loro `UndoManager` per writer, each skipping the others' board edits (a writer's origin is `board:<writer>;`), so ⌘Z takes back the window's own edit. What is one person's own leaves the document for this device (`personal` view layouts in localStorage, starting once from what the document held): the canvas camera (`canvas-camera`), the Windows view's tab and minimized tiles, and pins (`workspace/pins.ts`; the pin fields leave the tile records, and the window's next save takes them out of the document). Proof: 3 doc tests and 2 store tests (21 mutations, each caught once one test gap was closed), 5 client tests (19 mutations, each caught once one gap was closed), and `many-windows.spec.ts`: a tile moved in one window moves in the other, a camera and a pin stay in the window that made them and out of the workspace, a note from either window shows in both, a save from before either change (sent through the window's own IPC) keeps it, and ⌘Z takes back only the window's own (7 wiring mutations, each caught once that save was added). |
| R6 | One status per session, from its host | ☑ | Mapped 2026-09-29. Local sessions already have one: main's `StatusStore` folds the hooks (which report to main), the local daemon's screen readings and titles, typed interrupts, exits, and plan and approval waits, and every window mirrors it (`hcp:status` pushes, `hcpStatusAll` when it mounts); a window derives only how a tile's process exited and a plain shell's activity. Left: a remote machine's sessions, whose daemon forwards raw events that each desktop folds on its own, so a desktop that connects later, or misses an event, shows another status; and a shell's activity, which each window reads from the bytes it is sent, so a window that does not show the shell reads it idle. ☑ Step 1: a machine's daemon (standalone: no desktop there, so the hooks report to it) keeps the status of its sessions, from the hook events it is sent, its own screen readings and titles, the input it is sent and exits (`SessionManager`'s new `onEnd`), and sends every viewer `agent.status` on each change and every session's on hello. A desktop mirrors it (`StatusStore.mirror`: from then on that session's local reports are ignored, except its end) and still uses the raw events for turns, the mailbox and pipes. Only a machine's own report mirrors: `agent.status` is taken from the remote sink alone, never from a client of the control-plane socket, where it would freeze a local tile's status. A desktop's own daemon leaves status to the desktop, as before. Proof: the real daemon with two viewers, one connecting mid-turn, a Ctrl+C and a kill (both see working, interrupted, exited), and a throwaway agent read from its screen and title (8 mutations, each caught); the store's mirroring and the wire check (13 mutations, each caught once one test gap was closed). Not covered by a test that runs here: the one line in `index.ts` that hands a machine's `agent.status` to the store; `machines.spec.ts` covers the remote path where sshd and a built `hive` are, and this container has no sshd. ☑ Step 2: two windows show one status for an agent: `many-windows.spec.ts` sees a worker working in both windows' Layers rail while its turn runs, then not (caught when main tells one window only). Decided while doing it: a shell's working/idle moves to M2. It is painted only in its own tile's header, from the bytes the window that shows the tile is sent; the rail and the notices take agent statuses only, so no two surfaces disagree today, and a host-side reading of it would have no caller until M2 shares terminals between people. |
| R7 | Intents: one checked, logged path for every side effect | ◐ | Mapped 2026-09-29 from a survey of main: 116 IPC channels (77 change something, 39 only read) and 19 control-plane verbs with effects; checks are spread over a dozen places (the spawn pacer and rate limit, spawn depth, supervision, an agent confined to its repo, the browser switch, paths kept in the repo, the plugin and view review tokens), and there is no check of who calls: most channels take any sender, the control plane has one token that every tile holds, and `callerTile` is what the caller says it is, so a supervised worker can answer its own approval. Decisions: layout, view and board writes are the document's own edits (attributed by writer, R3 peer ids later), not intents; keystrokes, resizes, flow control and interest are not intents (R4's input lease is); the audit is `<userData>/audit.jsonl`, one line per intent (time, actor, intent, target, outcome), rotated at 5 MB with one old file kept; idempotency ids wait for M1, whose peers retry across a network (approvals already take the first answer). ☐ Step 1: `packages/workspace-host/src/intents.ts` (`perform(actor, intent, run)`: the policy, the run, the audit) and the control plane's verbs with effects through it. ☐ Step 2: actors the app knows rather than is told: each tile's own control-plane token names its tile, the app's token is a person at a terminal; the policy then refuses a worker answering its own approval, and a late answer says it came too late instead of reporting success. ☐ Step 3: the window's effects through it (tiles, files, git, issues, settings, installs, machines), each channel accepting only an app window's main frame; `browser:register` checks the page it names is a browser tile's. |
| R8 | Workspace API that is not Electron IPC | ☐ | After R7 |
| R9 | Machines by id, not by ssh uri | ☐ | |
| R10 | `hive-net` (Rust, iroh): profiles, local mode, `serve` roles | ☐ | After R3 |
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
