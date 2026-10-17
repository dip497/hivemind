# An edit costs what it changed: workspace sync (2026-10-17)

Status: proposed. Track 2 of the root-cause performance round. Owner files: `packages/workspace-doc`,
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

History growth (Loro 1.16.4, `facts.ts`): 100,000 one-character commits by one peer grew the full
snapshot to 1.2 KB (consecutive changes of one peer merge) and RSS by 4.6 MB; 100,000 map sets grew
the full snapshot to 399 KB and RSS by 0.8 MB.

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
7. **Bounded welcome, and start-over.** The host answers a hello with the updates the guest lacks
   when its history reaches back to the guest's version and they are smaller than 64 KB or the
   state, else with a shallow snapshot at its current version (the state). A guest that receives a
   snapshot, or cannot take an update (fact 1), **starts over**: a new document from the host's
   snapshot, then its own unsent changes written again on top as an edit made from the version the
   two last shared (core, each view, the board's changed objects), which reach the host as ordinary
   changes. A host that cannot take a guest's update because it builds on history the host no
   longer keeps answers with a snapshot welcome, which makes the guest start over. To know the
   shared version after its own restart, a replica's file keeps its history back to the version the
   host last confirmed (each update from the host now carries the host's version; a few bytes).

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
3. **A guest looped on start-over.** A guest whose start-over writes are refused (its role does
   not allow its offline core change) would get a snapshot, write again, be refused again. Change:
   a refused change is answered with nothing (as now: a refusal is a role rule, not lost history);
   only "builds on history the host no longer keeps" answers with a snapshot, and a guest starts
   over at most once per welcome it is given. The written ceiling: an offline guest's change that
   the host refuses is lost on the guest at its next start-over.

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
5. Bounded welcome and start-over, replica keeps history back to the confirmed version. Check:
   doc-sync tests for: new guest welcome is the state; offline guest across a host restart merges
   both ways; guest that cannot take an update starts over; bench welcome row.
6. CHANGELOG, plan status, the e2e specs to run listed in the report.

## Unknown

- Absolute numbers on an idle machine (load stayed 56–106): rerun the bench when `uptime` < 16.
- Whether the React render of a 5000-object board dominates a keystroke once these costs go (the
  renderer track's): profile the built app after merge.
- Whether a real offline window of hours produces start-overs that users notice (a flash of the
  host's state, then their own edits): the e2e of two machines with one asleep, run after merge.
