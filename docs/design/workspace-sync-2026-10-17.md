# An edit costs what it changed: workspace sync (2026-10-17)

Status: accepted (the coordinator, 2026-10-17: start-over from the last shared version is right,
and the ceiling "a refused offline edit is lost" is acceptable). Track 2 of the root-cause performance round. Owner files: `packages/workspace-doc`,
`packages/workspace-host`, `packages/workspace-api` (board and layout methods), the renderer's
board and layout client.

## Verdict

Today one typed character in a note costs the whole board, in the writing window, on Electron
main, in every other window, and again on disk; a guest's character costs a copy of the whole
document on the host; and a new guest is sent all history since the host started. The cause is one
assumption carried from R1: **a writer hands over a whole part and the store works out what
changed**. The design below moves the "what changed" to the writer, which already knows it, and
carries it unchanged through every layer: the window's save, the store's write, the change event,
the other windows' reads, the disk and the guest check. Three things that are not perf are built
with it because the new design depends on them: a replica that cannot continue the host's history
starts over from the host's state and makes its own changes again (today it parts from the host
for good, proven below), the welcome is bounded by the state, and the layout echo is removed at
the one place every save passes.

## Problem

**Goal.** An edit costs in proportion to what it changed, for every window, phone browser and guest.

**Done when.** Per typed character: the store write, the other window's read and the disk write are
flat across 50, 800 and 5000 board objects; a guest's update is checked and taken at a cost flat in
board size; a new guest's welcome is at most the state plus a stated margin; the multiplayer unit
tests pass.

**Constraints.** Store calls from a window are synchronous IPC to Electron main (a window builds
its first state in one pass, `workspace-store-ipc.ts`); main and `hive host` run the same
`WorkspaceStore`; a guest's change is taken only when its role allows it, and nothing of a refused
change is taken (`edit-rules.ts`); ⌘Z undoes only the writer's own board edits; no data migration
(no customer data; `CLAUDE.md`), everyone updates (break the protocol, say **Breaking:**).

**Known problems in disguise.** (1) Delta sync of a record store (tldraw, Figma, Excalidraw). (2)
Append-only log with compaction (y-indexeddb, Loro's own persistence guide). (3) Validate-before-
commit on a CRDT (no Loro primitive: a trial copy). (4) Bounded history with a catch-up-or-reset
rule (tldraw's "wipe", Git shallow clones).

### Real numbers (measured, before)

Machine load was 56–106 on 16 CPUs for every run below; absolute times are inflated 2–5× and only
ratios between runs at the same load mean anything. Benches: `bench/` in this track's scratch
(`before-bench.ts`, `facts.ts`, `facts2.ts`); the committed bench is `packages/workspace-host/bench/sync.bench.ts`
(step 0).

| Board objects | 50 | 800 | 5000 |
|---|---|---|---|
| One typed character, store write incl. persist (median, load 77) | 177 ms | 1002 ms | see step 0 |
| Another window's re-read of the board (`getObjects`) | 44 ms | 320 ms | |
| Structured clone of board + base (the IPC copy, each way) | 0.8 ms | 57 ms | |
| A guest's one-character update, checked and taken by the host | 197 ms | 368 ms | |
| Welcome to a new guest (bytes, before base64 and JSON) | 9.3 KB | 119 KB | |
| Disk file (shallow snapshot) | 6.0 KB | 78 KB | |
| Loro: import of a one-character update (load 77) | 16 ms (warm-up) | 0.44 ms | 0.33 ms |
| Loro: `fork()` (the guest check's copy) | | 8.2 ms | 44 ms |
| Loro: shallow-snapshot export (every persist) | | 157 ms | 746 ms |
| Loro: import + `diff` of what changed (partsChanged) | | 0.15 ms | 0.16 ms |

History growth (Loro 1.16.4, `facts.ts`; corrected by the review): typing random characters keeps
about 1 byte of history per character (100,000 characters: 200 KB full against 100 KB shallow;
100,000 copies of one letter compress to 1.2 KB, which is why the first figure misled); 100,000 map
sets (moves, resizes) grew the full snapshot to 399 KB, about 4 bytes each.

### Facts (each with its evidence)

1. **A shallow document cannot take a change built on history before its start.** `import` throws
   "The dependencies of the importing updates are not included in the shallow history of the doc"
   (`facts.ts` P1, `facts2.ts` E3). Loro's docs say the same: "concurrent updates to the snapshot's
   start version cannot be imported".
2. **A shallow snapshot imported into a document that is behind it is silently not applied.**
   `import` returns success with nothing pending and the state stays old (`facts2.ts` E1: state
   equal = false; E2: the host's five inserts are missing). A snapshot can only start a new document.
3. **Every host restart makes the host shallow** at its last save (`doc-file.ts` writes
   `shallow-snapshot`; 681a528 hit fact 1 on the partsChanged diff).
4. **So today a guest that edited offline parts from its host for good after the host restarts.**
   Probe on the real `serveReplica`/`replicate` (this track, deleted after): the host dropped the
   guest's update (fact 1), the guest kept its own state and never took the host's change (fact 2),
   and every later guest edit was dropped too, because it builds on the dropped one.
5. **Import of a small update and the diff of what it changed are flat in board size** (0.3–0.4 ms
   and 0.15 ms at 800 and 5000, table). **`fork` and shallow export are linear** (table).
6. **Loro's `UndoManager` is bound to one `LoroDoc` instance and undoes from that instance's
   history** (its steps are id spans of the oplog; there is no in-place trim, only a new document
   from a shallow snapshot). Replacing the document drops every undo step.
7. **Only the core layout is checked on a guest's change** (`refusedEdit(before, after)` reads only
   frames, tiles and frameOf). A change that touches no core container needs no check.
8. **The window already knows which objects an edit touched**: every board edit in `useBoard` maps
   the array and replaces only the changed objects (`update`, `moveTo`, `resize`, `place`, …), so the
   rest keep their identity.

### Dropped (choices and habits, for the coordinator to confirm)

| Dropped | Where it came from | Why it no longer holds |
|---|---|---|
| A window writes a whole part; the store diffs it | R1 (design-2026-09-28 §R1): "Whole layouts stay the way a window writes until there are several writers (R5): then each window … sends operations" | R5 shipped several writers; the doc itself names this as the next step. For the board, the changed objects with their bases replace the whole board. Core and views stay whole: they are bounded by tiles (≤ ~50), not by the board. |
| Every write rewrites the whole file | R1: "written through on every change", so an exit a moment after keeps it | The reason holds; the habit (rewrite all) does not. An append of the change keeps the same guarantee at the cost of the change (Loro's and y-indexeddb's pattern). |
| "Full history kept locally by the host" (§8 "History: from M1, shallow snapshots after 30 days, full history kept locally by the host") | Planned, never built: the disk file has been shallow since R2, so the host's history already ends at each restart | Fact 3/4: the plan was never true. What the product needs from history is (a) undo steps of live writers and (b) merging a guest that comes back; (b) is served by the start-over rule for any guest older than the host's history, so history is a cache, not the record. |
| The welcome sends the host's whole snapshot with history | 0c6e80a era: `exportSince` falls back to `mode: "snapshot"` | A new guest needs the state only; with the start-over rule an older history buys it nothing. |
| The guest check copies the whole document per update | 369f41b: only owner devices skip it | Fact 5 and 7: one trial document kept per workspace takes each update at the update's cost, and the check runs only when core changed. |

## What others do

- **tldraw sync** ([tldraw.dev TLSyncClient](https://tldraw.dev/reference/sync-core/TLSyncClient), [research write-up](https://grida.co/docs/wg/research/crdt/tldraw)): the client pushes a diff of records (put a record, patch some of its fields, remove it), never the store; the server's "changes since" is a forward diff; when the client's clock is older than the tombstone history the server keeps, the server tells it to wipe and reload, and the client rebases its pending changes onto the new state. Teaches: changes as records, and **a bounded history with a reset rule instead of keeping everything**.
- **Figma multiplayer** ([figma.com blog](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/)): the server keeps the latest value per object and property; clients send property changes; undo is history-free: "an undo operation modifies redo history at the time of the undo". Teaches: per-object, per-field writes; **undo needs no document history**, which is the upgrade path below.
- **Loro persistence guide** ([loro.dev encoding](https://loro.dev/docs/tutorial/encoding), persistence tutorial via ctx7): export updates often (after each keystroke, debounced), snapshots periodically; on load import the snapshot and the updates, then write a new snapshot; shallow snapshots for documents whose old history can go. Teaches: the append log, from the library's own authors.
- **y-indexeddb** ([source](https://raw.githubusercontent.com/yjs/y-indexeddb/master/src/y-indexeddb.js)): appends every update; once 500 are stored (`PREFERRED_TRIM_SIZE`), 1 s later it writes one merged state and deletes the older rows. Teaches: append, compact by count, write the merged state before deleting what it replaces.
- **Loro shallow snapshots** ([loro.dev tutorial](https://loro.dev/docs/tutorial/loro_doc), ctx7 `/websites/loro_dev`): "like `git clone --depth=1`"; "coordinate with all peers to ensure synchronization is complete before trimming". Teaches: trimming is safe only with a rule for peers that are older.
- **Excalidraw** (scene reconciliation by element `version`/`versionNonce`, open source): broadcasts only elements whose version changed since last sent. Teaches: identity/version per element is enough to find what to send without comparing everything deeply.

## Options

Shown for the main decision, how a board edit travels. The other parts each had one clear primitive
(append log; trial document; start-over), with alternatives listed under Choice.

**A. Boring: whole board, cheaper.** The window still sends the board; main diffs it once by id and
`sameJson`, persists on an idle timer.

```
window ──board(n)──▶ main: clone n, diff n, write k ──changed{part}──▶ other windows ──read(n)──▶
```
First breaks: the synchronous IPC clone and the diff on main are O(n) per keystroke (57 ms each way
at 800 under load), and every other window re-reads n.

**B. Changes as records (chosen).** The window sends the objects it changed with the ones it made
them from; the store rebases and writes each one; the change event names the ids; readers read
those ids; the disk gets the Loro update appended.

```
window ──{id: obj|null}, {id: base}(k)──▶ main: read k, rebase k, write k, append Δ
        ──changed{board, ids k}──▶ other windows ──read(k)──▶ rebase k
host ──Δ──▶ guest import Δ (flat) ──changed{board, ids}──▶ guest windows read(k)
guest ──Δ──▶ host trial doc import Δ → core touched? → check → import Δ
```
First breaks: the window's own React render of the board (another track) and its O(n) identity
scan (pointer compares) to find what changed.

**C. Bold: every window holds a Loro replica.** Each renderer keeps the workspace's `LoroDoc` and
syncs with main by Loro updates, as guests do; edits are Loro ops, reads are local.

```
window(LoroDoc) ──Δ──▶ main(LoroDoc) ──Δ──▶ other windows(LoroDoc), guests
```
First breaks: memory, one document per window per open workspace (wasm heap, 66 KB state at 800
plus history), the guest check and role rules duplicated or moved, every synchronous read
(`settingsSync`-style first pass) redesigned around a replica that may not be loaded yet.

### Scale table: main-thread work per typed character, the limiting number

Today = 800 objects, 2 windows, 1 guest. 10× = 8000 objects or 10 windows. 100× = 80,000 objects or 100 viewers.

| Design | Today | 10× | 100× |
|---|---|---|---|
| Now | ~1000 ms per char (load 77) — **fails** | ~10 s — fails | fails |
| A | clone 2×57 ms + diff ~20 ms ≈ 134 ms — fails | ~1.3 s — fails | fails |
| B | read+rebase+write 1 object ≈ 0.5 ms + append ≈ 0.1 ms; per other window read 1 object; per guest import ≈ 0.4 ms — **holds** | same per char; 10 windows × 0.1 ms — holds | same per char; 100 viewers × ~0.4 ms fan-out ≈ 40 ms per burst — holds at the 250 ms debounce |
| C | Loro op ≈ 0.4 ms per replica, but memory 3 windows × doc — holds | memory 10 × doc — holds | 100 renderer docs on one machine is not the case; guests already are replicas — holds, at large rewrite cost |

Arithmetic: Now: measured 1002 ms at 800 (table), and the measured rows grow ~linearly (50→800: 177→1002 ms; 44→320 ms re-read), so 10× ≈ 10 s. A: the IPC clone is the measured 57 ms for board+base at 800 each way, linear in n. B: Loro import of a one-character update measured 0.33–0.44 ms flat (800, 5000); one object's read and rebase is the per-object share of `readObjects` (320 ms / 800 ≈ 0.4 ms under load 77, ≈ 0.1 ms unloaded); append = one `export({mode:"update"})` of a few hundred bytes plus one `appendFileSync`. Fan-out at 100×: 100 × one update send ≈ 100 × 0.4 ms.

## Choice

**B**, built in every layer, and nothing of A or C:

- A lost: it keeps the O(n) synchronous IPC clone and the O(n) reads in every other window; it is
  the current design with a debounce.
- C lost: it is the ideal end state for a window that must work offline, but here every window sits
  next to main on the same machine; it moves the role checks and the synchronous first pass, and
  costs a document per window. B gives the same per-edit cost with one document per workspace.

The parts of B:

1. **Board edits.** `BoardEdit = { objects: Record<id, BoardObject | null>; base: Record<id,
   BoardObject | null> }` (null object: removed; null base: it was not there; no base for an id:
   written as given). `WorkspaceStore.editObjects(repo, edit, from)` reads, rebases (`rebaseObject`,
   the per-object step `rebaseBoard` already does), and writes only those objects. What a widget
   keeps (`state`) is written apart under `sys:widgets`, as now. `setObjects` (whole board) goes:
   `boardEdit(base, next)` in workspace-doc makes the edit from two boards for whoever has two
   (tests, the window). API: `store.editObjects`, `store.objectsWithIds(repo, ids)`;
   `store.setObjects` is removed (**Breaking:** for `hive ctl`-free API clients only; the window,
   the browser bridge and the replica client move with it).
2. **Change events name the objects.** `WorkspaceChange.objects?: string[]` for `board`: the ids
   written, or, for an import, the objects under `objects/<id>` that the import's diff touched
   (`partsChanged` already walks those paths). No ids (a whole-document import, undo): read all.
3. **Readers read what changed.** The window's client keeps its base per object; on a change it
   reads those ids, rebases each with what it has not saved, and replaces only them. The replica
   client (`StoreReplica`, the browser and phone page) patches its held board the same way. The
   widget watcher reads only on board changes and only the ids, and no longer overwrites the
   window's write base (audit #13).
4. **No echo.** The window's client sends nothing when what it would send equals what it last read
   or wrote (`sameJson` with its base, per object for the board): the debounced save after a reload
   is then no write at all. One rule, in the one module every layout save goes through.
5. **Disk: append, then compact.** Each write appends the Loro update since the last save to
   `<hash>.updates` (length-prefixed records); loading imports the snapshot then the records, and
   drops a torn last record. When the records outgrow `max(256 KB, the snapshot)`, the snapshot is
   rewritten (temp file, rename) and only then the records file removed, so a crash between leaves
   records that re-import harmlessly. A failed append falls back to a full rewrite at the next write.
6. **Guest check on a trial document.** One trial copy per workspace, made on the first guest
   update that needs a check and caught up by `update` exports at each use (cost: what happened
   since). The update is imported into it; if the core containers did not change, there is nothing
   to check; else `refusedEdit(getCore, readCore(trial))`. A refused update spoils the trial, which
   is dropped and copied again on the next check (the one O(document) path, paid per refusal).
7. **Bounded welcome and start-over** (replaces the "floor" of the first draft, which review
   round 2 broke; see below). The host keeps its whole in-memory history for its uptime (the
   ceiling below), so it can take any change a guest built on it. What it hands out is bounded:
   - *Welcome.* A new guest (`seen` null) gets a shallow snapshot at the host's version: the
     state, no history. A returning guest whose `seen` is within the host's history gets the
     updates it lacks; any other gets the same snapshot.
   - *Start-over* (built first, its own commit `afa750f`, because a guest's offline edits were
     lost for good, fact 4). A replica given a snapshot while its document holds changes cannot
     take it (fact 2), and the host cannot take changes built on history it does not keep
     (fact 1). So it starts a new document from the snapshot, and writes again on top what it
     wrote since the version the two share: its old document checked out at
     (its version ∩ the host's), which is exact, so nothing the host has is written twice. Undo
     histories, the core and tile caches and what is stored on disk start over with it; the
     sync's own "host has" is set from the welcome. The rewrite goes as the welcome's answer,
     the update since the host's version.
   - *What the replica keeps.* Each update from the host says the host's version (`seen`). A
     replica's file keeps the history since (its version ∩ the host's), so after its own app
     restarts it can still start over; before any host has spoken, it keeps what it loaded.
   - *A replica that cannot take an update* (its shallow root is after the update's
     dependencies: another guest's offline change built on history from before this one joined)
     says `hello` again with no `seen`, ignores updates until the welcome, and starts over from
     it. The host answers a `hello` in the middle of a stream as at its start.
   - *Moving a workspace* to another device (`hosting.ts`: `take`, `yieldTo`, `adopt`) keeps
     today's whole-document export (`exportSince(repo, null)`), not the welcome's.
   - *Which, as the coordinator asked:* a guest that was offline is **handed a snapshot it
     actually takes** (it starts over), not kept mergeable by trimming nothing: the host's disk
     keeps only the state since its last start, so a guest's offline change is mergeable after a
     host restart only through start-over. Tested at the doc-sync boundary: both offline cases
     (guest app open, guest app restarted) in `doc-sync.test.ts`.
   Written ceiling (accepted): an offline change the host refuses (the guest's role does not
   allow it) is not written; the guest keeps it until its start-over, which drops it.

8. **No update while the stream has no room** (with perf-links' "has room / room returned" on the
   link streams, which that track adds; it does not touch `doc-sync.ts`). `serveReplica` already
   sends each update from what that replica was last sent (`theirs`), not from what it confirmed.
   So while the sync stream has no room it sends nothing and leaves `theirs` as it was; when room
   returns it sends one update from `theirs`, which holds every change made meanwhile. A slow
   guest then costs the host one export per time it catches up, whatever was typed meanwhile,
   and nothing is queued for it. The welcome is sent whatever the room (it is the first frame).
   Check: a doc-sync test with a channel that has no room for a while: no frame meanwhile, then
   one update, and the guest ends with every change.

What was surprising: the offline-guest split (fact 4) is not a corner of this round's change but a
bug since the first host restart; and fact 2, that Loro reports success while dropping a snapshot,
means today's snapshot fallback in `exportSince` silently loses the host's changes on any replica
that is not empty.

### In-memory history: a written ceiling, not trimmed

The host keeps its in-memory history for its uptime, because Loro's `UndoManager` needs it (fact 6)
and trimming means a new document. Measured growth: ~5–50 bytes and ~10–50 bytes of RSS per edit
(table above; consecutive edits of one peer merge), so 1,000,000 board edits in one uptime cost
roughly 5–50 MB. The welcome no longer carries it (part 7), so it only costs host memory. It bites
at roughly 10⁷ edits in one uptime of an always-on `hive host`. **Upgrade path**: history-free undo
(Figma's: an undo step is the writer's objects before and after; undo writes "before" made from
"after", so others' later edits survive, and redo is rewritten at undo time), then the host
compacts to a shallow document when idle; with part 7 every guest older than that start-over is
already handled.

## Review (a fresh agent asked to break it) and answers

Round 1 found these; each changed the design above or is answered here.

1. *Start-over replays text the host already has* (a stale "confirmed" version as base, and
   `mergeText` keeps both insertions). Answer: the base is the old document checked out at (its
   version ∩ the snapshot's version), exact by construction.
2. *Two snapshot welcomes in flight make a guest start over twice* and Loro keeps both re-writes.
   Answer: a second start-over's base is the version shared with the second snapshot, which
   already holds the first rewrite, so the rewrite is not written again; a guest's updates sent
   before a welcome land on the host before it (one ordered stream).
3. *A shallow welcome makes later new guests fail on an offline guest's old change*, and a guest
   has no message to ask again. Answer: it says `hello` again with no `seen` and starts over
   (part 7).
4. *Starting over swaps the document under live undo histories, caches, the trial document and
   the sync's version.* Answer: all reset with it (part 7).
5. *Skipping the check when "core" is untouched leaves a hole: `partsChanged` counts `meta` as
   core, and `refusedEdit` never looks at `meta`, so a guest at edit can already rewrite the owner.*
   Answer: true today; a guest's change that touches `meta` is refused (only the owner's devices
   may), and the role check runs only when frames, tiles or order changed.
6. *Callers left O(board)*: `index.ts`/`headless.ts` forward only `{repo, part}`; `host/widgets.ts`
   reads the whole board and stringifies it per change of any part; `useBoard` stringifies the
   stored board per edit; `toStored`/`toCanvas` make a new object for every framed box, so the
   identity scan degrades to a deep compare; a fold is an O(document) export on main. Answers:
   ids pass through both publishers; the widget watchers read only changed ids on board changes;
   `useBoard` drops the stringify; `toStored`/`toCanvas` keep each object's identity while its box
   and frame did not move; a fold runs after two idle seconds (or on flush), not inside a write.
7. *Frames*: a frame's removal leaves its boxes with frame-relative positions, and another
   window's frame move may write its boxes back shifted. Answer: not caused by this design; to be
   checked with a test in step 3 and fixed there if real, else listed as found.
8. *`hosting.ts` uses `exportSince(repo, null)`*: a shallow export there would lose changes in a
   move. Answer: the welcome gets its own export; `exportSince` keeps its whole-document meaning.
9. Minor: a bad record keeps the good ones before it (it does: they are imported, then the next
   write is whole); `removeDoc` takes the updates file too (it does); fact 1 is thrown as a
   string, so "builds on history before the floor" is told by the trial import failing on bytes
   whose header decodes (`decodeImportBlobMeta`), not by the message; the growth figure corrected.

Round 2 found these, against the "floor" of the first draft, which is dropped for part 7 as it
stands now:

1. *`hosting.ts` imports bypass the trial document*, so the floor's "the host takes nothing a
   replica could not" did not hold. Answer: no floor; the host takes what it can and a replica
   that cannot asks again (part 7).
2. *A start-over replays changes its role refused.* Answer: they are refused again, not looped:
   a refusal is answered with nothing, never with a snapshot (pre-mortem 3).
3. *Start-over must reset what is on disk* and write the new document whole before anything is
   sent. Answer: built so (`startOver` writes whole, then rewrites).
4. *Loro roots a shallow snapshot earlier than asked* when changes are concurrent, and *`forkAt`
   is not supported on a shallow document.* Answer: nothing depends on the root being exact; the
   base is a `checkout`, which works on a shallow document at or after its root.
5. *Welcome numbers are per connection.* Answer: no numbers (point 2 above).
6. *A guest window loses its undo across a start-over.* Answer: accepted; the document it would
   undo in is gone.

## Pre-mortem (a year later it failed; why)

1. **Two windows lost each other's edits to one note.** A per-object base that is wrong (the window
   rebases against an object it never read) reverts the other writer's fields. Change: the client's
   base is set only from what it read or wrote for that id, never from a whole re-read made for
   another purpose (the widget watcher reads through a function that does not touch bases); unit
   tests drive two writers on one note through the real store and client.
2. **A crash left a workspace that will not load.** A torn append or a compaction cut short.
   Change: records are length-prefixed and a torn tail is dropped on load (and truncated before the
   next append); the snapshot is renamed into place before the records it replaces are removed; a
   records file that does not import is set aside like a bad snapshot, never deleted.
3. **A guest looped on start-over.** A guest whose rewrite is refused (its role does not allow
   its offline core change) would be sent a snapshot, write again, be refused again. Change: a
   refusal is answered with nothing (as now: a role rule, not lost history); only a replica that
   cannot take what it is sent asks for a snapshot. Written ceiling (accepted): a change the host
   refuses stays on that guest only until its next start-over.

## Build order (each step leaves the app working, each checked)

0. Bench committed (`packages/workspace-host/bench/sync.bench.ts`): typed character, other
   window's read, guest update, welcome, disk write, at 50/800/5000. Run on HEAD for "before".
1. Disk: append log + compaction (`doc-file.ts`, `store.ts persist`). Check: store tests (restart
   keeps every change, torn tail, failed write retried), bench disk row flat.
2. Board edits in the store and the API (`editObjects`, `objectsWithIds`, `WorkspaceChange.objects`,
   `partsChanged` ids, `boardEdit`, `rebaseObject`), callers and tests moved, `setObjects` removed.
   Check: workspace-doc/host/api/host tests; bench typed-character and read rows flat.
3. Window and replica clients send edits and read ids; widget watcher; no-echo rule for core, views
   and board. Check: desktop unit tests (`workspace-store-client`, useBoard merge), replica tests.
4. Guest check on a trial document. Check: doc-sync and edit-rules tests (refused update takes
   nothing, a later good one is taken), bench guest row flat.
5. Start-over (done first, `afa750f`); then the bounded welcome and asking again; `meta` refused
   from guests. Check: doc-sync tests for: an offline guest across a host restart merges both ways
   with nothing doubled (done); a new guest's welcome is the state alone; a guest that cannot take
   another's relayed change asks again and ends with both; a guest at edit cannot change the
   owner; bench welcome row.
6. CHANGELOG, plan status, the e2e specs to run listed in the report.

## Unknown

- Absolute numbers on an idle machine (load stayed 56–106): rerun the bench when `uptime` < 16.
- Whether the React render of a 5000-object board dominates a keystroke once these costs go (the
  renderer track's): profile the built app after merge.
- Whether a real offline window of hours produces start-overs that users notice (a flash of the
  host's state, then their own edits): the e2e of two machines with one asleep, run after merge.
