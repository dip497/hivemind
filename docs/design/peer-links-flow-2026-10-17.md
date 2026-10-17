# Flow control on peer links

Status: accepted, 2026-10-17. Being built on `perf/peer-links`.

## Verdict

Count, per link, the bytes main handed the hive-net daemon that the network has not taken yet,
and give each link and stream two plain questions: **`hasRoom()`** (fewer than `LINK_ROOM`,
512 KB, wait) and **`whenRoom(listener)`** (told once, when room returns). Bound what "taken" means
by lowering QUIC's `send_window` to 1 MB, so taken is within 1 MB of what the peer acknowledged.
What the peer acknowledged and its app has not read is held by the peer, up to its own windows
(1.25 MB a stream, `receive_window` 2 MB a connection), not by the host.
Then each producer uses room by what it sends:

1. **State** (the agents list, Home, the document): while there is no room nothing is made; when
   room returns, the newest state is sent, worked out then, from what that peer was last sent.
   Nothing queues; a peer that wakes gets the difference to now (Mosh's state synchronization).
2. **Terminal output**: every remote viewer is paced by the session relay's 128 K window, as
   phones are today. A desktop guest's main owns its acks: it opens every terminal it forwards to
   the host with `acks`, counts each tile's output as it arrives from that open, and says
   `terminal.ack`; acks its windows or tabs send are not forwarded.
3. **The rest of the `api` stream, answers, small notices**: sent as they come, in order, packed
   in frames of up to 256 KB; an event larger than that goes alone.

One owner holds the ceiling: main closes a link "too slow" once more than `WAITING_AT_MOST` (16 MB)
waits beyond the largest frame of the backlog. It is the safety net for a producer that ignores
room, never the mechanism.

The daemon writes each stream from a task of its own, so a blocked stream holds up no sibling; it
reads a peer only while main has taken what it read before (1 MB per connection), and QUIC's own
receive buffers are bounded (`receive_window` 2 MB, no uni streams); and main and the daemon pass
a frame's bytes as bytes, not re-escaped inside JSON.

## Problem

**Goal.** A slow or far peer (a phone on mobile data, a guest across the world, a laptop asleep
with its connection up) costs the host bounded memory and no time, and never delays another peer.

**Constraints.**
- The app, `hive host` and hive-net ship as one release (the daemon protocol check). The protocol
  between main and the daemon may change.
- A remote viewer never pauses a program (docs/design/remote-machines-2026-09-11.md §3b: "slow
  viewers drop frames, never producers").
- Phones and the browser (crates/hive-phone, hive-web) speak `hive/ws/1` over their own QUIC stack
  and are not changed.
- doc-sync.ts belongs to the workspace-sync track: it uses `hasRoom`/`whenRoom` there.

**What the host sends on a link** (from the code):

| Stream | Sends | Paced today |
|---|---|---|
| `sync` | a welcome, then a delta per store change (doc-sync.ts:84-112) | no |
| `api` | each 25 ms, a frame of events; call answers after the events before them (peers.ts:206-231, 338) | 25 ms tick; terminal output only for clients opening with `acks` (phones, the browser tab) |
| `agents` | the whole list on each change, at most every 100 ms (peer-links.ts:477-499) | 100 ms timer |
| `home` | Home's changes, at most every 250 ms (home.ts:127-154) | 250 ms timer |
| `pty` | the PTY daemon's protocol, carried both ways (peer-links.ts:596-625) | no |
| `machine` (guest → host) | the participant's PTY daemon output (machine-share.ts:115-127) | no |
| `files`, `device`, `hosting`, `list` | answers and small notices | no |

**Where a backlog goes today.** Main writes every frame to the daemon's socket and ignores
`write()`'s return (hive-net.ts:349). The daemon reads its socket without pause onto the
connection's `unbounded_channel` (daemon.rs:295, 527). One writer task per connection merges what
queued and `write_all`s stream after stream while holding the lock on every stream's half
(daemon.rs:303-342); a stream accepted meanwhile waits on that lock to be announced (daemon.rs:409).
quinn's `write_all` returns once its send buffer takes the bytes, which holds up to `send_window`
(10 MB) unacknowledged per connection; the peer's daemon reads every stream eagerly
(daemon.rs:425-431), so stream credit returns as fast as bytes land. Past 10 MB the queue grows
without limit, and every stream of the connection waits behind the blocked one.

**Measured before.** `bench/links-bench.ts stopped`: one peer's daemon SIGSTOPped while the host
sends it 16 KB frames for 8 s; another peer echoes the host's pings meanwhile.

| | release daemon, load 92 | debug daemon, load 95 |
|---|---|---|
| Sent to the stopped peer | 74 MB | 61 MB |
| Host daemon RSS | 25 → 98 MB, one for one with what was sent | 50 → 71 MB, the rest in main |
| Host main RSS | 105 MB | 170 MB |
| The other peer's echo, p50 / max | 79 / 112 ms before; 106 / 292 ms during | 81 / 352 ms before; 430 / 2,232 ms during |

With the debug daemon the fast peer was slowed because the daemon's one loop reading main's socket
was CPU-bound (parsing doubly escaped JSON), and the stopped peer's frames were ahead in that
socket; with the release daemon the cost is the memory. The stopped peer's writer costs nothing while it waits. A SIGSTOPped peer is closed
by iroh's idle timeout within 30 s; the case that lasts is a peer alive but slow, or one whose app
stops reading. The tests use the second: the peer's main SIGSTOPped, its daemon alive and ACKing.

**Broadcast cost before.** `bench/links-bench.ts broadcast`: one event to N guests through the real
`servePeer` and daemon, one event per 25 ms tick, 400 events. Host main's time per event (p50) from
the fan-out to the write into the daemon's socket, and the host daemon's CPU per event. Release
daemon, load 70–90.

| Peers | 4 KB of terminal output: main / daemon | `status.changed`: main / daemon | a small event: main / daemon |
|---|---|---|---|
| 1 | 1.0 ms / 1.3 ms | 0.6 ms / 1.2 ms | 0.8 ms / 1.4 ms |
| 10 | 8.2 ms / 3.8 ms | 1.1 ms / 2.4 ms | 0.9 ms / 2.6 ms |
| 50 | 37.7 ms / 12.0 ms | 10.2 ms / 9.5 ms | 5.6 ms / 7.4 ms |

At 50 peers one terminal batch costs main 0.75 ms per peer: more than a 25 ms tick for one busy
terminal. Most of it is the daemon message's `JSON.stringify` of the 4 KB (every `\x1b` becomes
six bytes) and its copy, per peer.

**Known problem.** Slow consumers of a broadcast server: credit flow control (QUIC/HTTP2), state
synchronization (Mosh), drop and redraw for terminals (tmux), a slow-consumer close as the last
resort (NATS, Redis).

## What others do

- RFC 9000 §4 — QUIC credits per stream (MAX_STREAM_DATA) and per connection (MAX_DATA). Main and
  the daemon are a hop of their own and need a credit of their own.
- RFC 9113 §5.2 — HTTP/2: the same, per hop; the connection window is shared by every stream.
- quinn-proto `config/transport.rs` (iroh 1.3 runs n0's fork noq, same defaults) —
  `stream_receive_window` 1.25 MB, `send_window` 10 MB, `receive_window` unbounded,
  `send_fairness` on (round robin between a connection's streams). `streams/state.rs`:
  `write_limit = min(max_data − sent, send_window − unacked)`: a write is taken while less than
  `send_window` is unacknowledged, so `send_window` is what "taken" is within.
- iroh `endpoint/quic.rs` — iroh overrides only keep-alive (5 s) and idle timeouts; its
  `QuicTransportConfig::send_window` sets ours.
- Mosh, USENIX ATC 2012 (mosh.org/mosh-paper.pdf) — send the difference from the state the receiver
  has to the current state; about one frame in flight; "not required to send every octet".
- tmux `tty.c` — a client that cannot keep up has its output discarded and its screen redrawn;
  `control.c` exits a control client "too far behind" past 64 MB or 5 minutes.
- VS Code `terminal.ts` — an ack window (100,000 characters high, 5,000 low, acks every 5,000)
  that pauses the pty. Ours (session-relay.ts, 128 K) never pauses the program.
- Phoenix `channel/server.ex` — a broadcast "encoded once per serializer"; no outbound limit, a slow
  socket's mailbox grows until its heap limit kills it.
- Figma (figma.com/blog/how-figmas-multiplayer-technology-works, 2019) — a client that reconnects
  downloads a fresh copy and replays its offline edits; no queue is kept for it.
- Linear, "Rebuilding delta sync" (linear.app/now, 2026-08) — a client resumes from the id of the
  last change it applied; the server keeps a log, not a queue per client.
- NATS `const.go` — `MAX_PENDING_SIZE` 64 MB per client, then a slow consumer is closed. Redis
  `client-output-buffer-limit pubsub 32mb 8mb 60`.
- Tokio `Semaphore` — `acquire_many` is FIFO; a byte budget is permits taken before a frame goes on
  and given back once it is written. Taken before a body arrives, permits deadlock a connection
  whose other streams fill the receive window; the budget here is a gate on beginning a frame
  instead (`tokio::sync::watch`).

## Looked at from each side

- **The person on the phone.** A phone that slept wakes to the newest agents list, Home and
  screens, not to minutes of queued history.
- **The person at the host.** Their windows and terminals never wait for a guest.
- **Data.** State resent new is never lost: Loro deltas compose, Home answers from a sequence, a
  terminal sends its screen, a closed link is welcomed again from what the replica has (`seen`).
- **Operator.** A close for being too slow is logged with its link and what waited. The guest
  reconnects with its backoff.
- **Security.** A peer cannot make the host buffer without limit by not reading, nor by sending
  faster than main reads (the inbound budget).
- **Next year.** 50 people in a workspace (10x the M2 gate of 5), phones far away, a host serving
  many workspaces. Room and the policies do not change with the count; what is left per peer is
  the copy into its QUIC connection.

## Options

**A. A bounded queue in the daemon, and close past it (the boring one).**

```
main ──every frame──▶ daemon [link queue ≤ N MB] ──▶ QUIC (≤ 10 MB unacked)
                          └─ over N: close "too slow"
```

No change in main. Breaks first: a phone on a slow link watching a busy terminal is closed every
few seconds, and its next connection is as slow. The agents list and Home stay as stale as 10 MB
of backlog at the link's speed.

**B. Room per link, policies in main (chosen).**

```
producer ─ hasRoom? ─▶ link {sent, taken} ─▶ daemon [a queue per stream] ─▶ writer per stream ─▶ QUIC (≤ 1 MB unacked)
    ▲                          ▲                                                   │
    └── whenRoom: the newest ──┴───────────────── took {conn, stream, n} ◀─────────┘
```

**C. Latest-value slots in the daemon (the bold one).** Main tags a frame with a key; a newer frame
of that key replaces the queued one (herdr's render slot). Breaks first: only whole snapshots can
replace each other; the document, Home and terminals send deltas only main can recompute.

**D. Multicast to the daemon** (on top of B): one message for every peer of a workspace, the daemon
sharing one buffer across their streams. Removes the per-peer copy over main's socket. Built only if
B's numbers show main's per-peer cost matters.

**Scale.** Host memory held for slow peers. Today = 5 peers (the M2 gate), 10x = 50, 100x = 500,
all slow at once (the worst case).

| Design | Today (5) | 10x (50) | 100x (500) |
|---|---|---|---|
| Now | unbounded per slow peer | unbounded | unbounded |
| A (4 MB cap) | 5 × (4 + 10) = 70 MB | 700 MB | 7 GB: does not hold |
| B | 5 × (0.5 + f + 1 + 3) ≈ 25 MB | 250 MB | 2.5 GB: holds only on a big host; the ceiling is the QUIC windows |
| C | as B for snapshots; unbounded for deltas | — | — |

Arithmetic: a slow peer under B holds at most `LINK_ROOM` (0.5 MB) plus the largest frame a
producer sent while it had room (f: an agents list, a Home change, an update; under 0.1 MB in use,
a welcome when it joins) waiting in main and the daemon; what QUIC holds unacknowledged, ≤
`send_window` (1 MB); and inbound, ≤ the 1 MB budget plus QUIC's `receive_window` (2 MB). The
peer's events on `api` go as they come and count in `waiting`; a peer that does not keep up with
them meets the ceiling, 16 MB plus one frame, and is closed. Under A: its cap (4 MB) plus the
default 10 MB `send_window`, plus today's unbounded receive side.

**What lowering `send_window` costs.** One connection sends at most `send_window` per round trip:
1 MB / 100 ms = 10 MB/s, 1 MB / 300 ms = 3.3 MB/s. A 5 MB welcome to a guest 300 ms away takes
1.5 s more at worst. State is at most `LINK_ROOM` + `send_window` = 1.5 MB stale: 12 s on a
1 Mbit/s link that something else fills, 1.2 s on 10 Mbit/s. `receive_window` 2 MB bounds a peer's
uploads the same way: 2 MB per round trip.

## Choice

**B**, with the ceiling in main as its safety net. A lost because closing is its only tool and it
leaves state a full 10 MB stale. C lost because the streams that matter send deltas. D waits for
numbers.

Room is per link, not per stream: a phone opens an `api` stream for every terminal, conversation
and call, so room per stream would add up past any ceiling, and producers on a stream of a name
would lose their room when the newest stream of that name changes. A link is also one congestion
window: when it is slow, all its streams are.

What surprised: QUIC's buffer, not ours, was the deep queue. Today a slow phone is up to 10 MB
behind before anything of ours even sees a backlog; the knob that bounds staleness is one number in
iroh's transport config.

## The design

### Daemon (crates/hive-net/src/daemon.rs)

- **A writer per stream, owning its half.** Each stream has a queue and a task that opens it
  (main's streams), merges what queued, and writes. A blocked stream blocks only its own task; no
  lock is held across a write. Its end is reported to main as `ended`, by whichever of its reader
  or writer sees it first.
- **`took {conn, stream, n}`**: bytes of frames no longer waiting in the daemon: written to QUIC, or
  dropped because the stream ended or was never open. Main's count always comes back down.
- **`Close`** drops every stream's queue; each writer writes what it has, at most 256 KB at a
  time, finishes, and the connection closes once they are done, or once `CLOSE_WAIT` (2 s) passes
  with nothing more written. A fixed 2 s in all lost the tail of 6.4 MB sent before a close at
  load 80, since the 1 MB window paces the writes too; a peer that takes nothing still holds a
  close only 2 s.
- **An inbound budget per connection.** What is handed to main counts until it is written to
  main's socket; while more than 1 MB counts, no stream of that connection begins a new frame, and
  QUIC stops crediting the peer. A frame already begun is read to its end, so one frame always
  fits and no budget is held while a body is still on the network. A stream's name (its first
  frame) is at most 256 bytes.
- **QUIC's windows** on every endpoint's transport config (net.rs, so phones' too): `send_window`
  1 MB, `receive_window` 2 MB, `max_concurrent_uni_streams` 0 (nothing uses them).
- **Frames as bytes.** Every frame between main and the daemon starts with a tag byte: `0` JSON,
  `1` a frame on a stream (connection u64, stream u64, its bytes). `send` and `recv` go as `1`, the
  rest as `0`. `PROTOCOL` becomes 3. Main checks a frame against `MAX_FRAME` before it sends it:
  an oversize frame from main fails that send, not the daemon.

### Protocol 3: main and the daemon

The contract both sides build to (`PROTOCOL` 3 in daemon.rs and hive-net.ts).

- **Frame:** a u32 big-endian length `L`, then `L` bytes. `L` is at most `MAX_FRAME`
  (64 MiB, frames.rs). The first byte of the body is a tag.
- **Tag 0, a message:** JSON, tagged by `t`. These are every message of protocol 2 except `send`
  and `recv`.
- **Tag 1, a frame on a stream:** connection (u64 BE), stream (u64 BE), then the frame's bytes.
  The 17-byte header counts in `L`. Main sends `send` like this, and the daemon hands main `recv`
  like this. Main encodes the text as UTF-8 once, and it is not escaped again.
- **Version check:** the daemon says `ready {v: 3}` (tag 0) first, and main says `hello {v: 3}`
  (tag 0) first. Each side reads an untagged first frame (`{`) as protocol 2 or before, whatever
  `v` it carries, only to say which protocol the other speaks and stop.
- **Oversize:** main throws in `send` when `17 + bytes > MAX_FRAME`, before it opens the stream.
  The daemon refuses a length over `MAX_FRAME` on main's socket. On a stream it takes at most
  `MAX_FRAME - 17` (what still fits main's socket with its header): a longer frame ends that
  stream, both ways, and the others go on.
- **Stream name:** the first frame of a stream the other device opens. At most `NAME_AT_MOST`
  (256) bytes; a longer one is not opened, and main hears nothing of it.
- **Inbound budget:** `BUDGET` (1 MiB) per connection, a gate rather than permits. A frame handed
  to main counts until it is written to main's socket. A stream's reader begins no new frame while
  more than `BUDGET` counts; a frame it has begun it reads to the end. Holding budget while a body
  is still on its way deadlocks: other streams' unread bytes fill the receive window, and the
  body's tail never comes. While main is behind, the daemon begins no more frames of that
  connection. Ceiling: the frames begun when the gate shuts, at most one per stream.
- **`closed`** (the other side closed, or the connection was lost) reaches main only after every
  stream's reader has handed over what arrived before it.
- **QUIC windows** (net.rs, every endpoint): `send_window` 1 MiB, `receive_window` 2 MiB,
  `max_concurrent_uni_streams` 0.
- **Main's ceiling:** when a link's `waiting` passes `WAITING_AT_MOST` (16 MiB) plus the largest
  frame that may still wait (the largest sent, at most `waiting` once the network takes some),
  main closes the link `too slow (N MB waiting)`, warns
  (`onWarn`), and sends nothing more on it.

### Main (packages/workspace-host/src/hive-net.ts)

- A link counts `waiting`: bytes sent and not yet taken (`took`), over all its streams.
- `Link.hasRoom()`, `Link.whenRoom(listener)`, and the same on `Stream`: `hasRoom()` while
  `waiting < LINK_ROOM`; `whenRoom` is told once, when `waiting` falls under `LINK_ROOM` (in a
  microtask when there is room now). Listeners are dropped when the link goes; its producers hear
  `closed`.
- `send` never refuses. Past `WAITING_AT_MOST` beyond the largest frame waiting, the link is closed,
  "too slow (N MB waiting)", and warned of.
- The daemon's socket is read without the quadratic `Buffer.concat` (audit #10).

`streamOf` gives a named stream's link room, for producers on a stream by name (the document).

### Producers

| Stream | Side | Policy |
|---|---|---|
| `agents` | host | the list is worked out once per change; a follower with room is sent it when it changed; one without is marked and sent the newest when room returns |
| `home` | host | each follower keeps the two sequences it was sent (layout, lines); with room it is sent what came after them, or both whole when it is too far behind; without, nothing. `answer()` no longer pushes to every follower |
| `sync` | both | (workspace-sync track) no update is made while there is no room; when room returns, one update from what the other side was last sent |
| `api` | host | as today: each 25 ms tick's events in order, an answer after the events before it; a frame at most 256 KB (several when more queued). Counted in `waiting`, so the ceiling bounds a peer that cannot keep up |
| `api` terminal output | guest | the guest's main owns the acks for what it forwards: every `terminal.open` goes with `acks`, each tile's output is counted as it arrives from that open, and `terminal.ack` from its windows or tabs is not forwarded (prior art: the browser tab, browser/hive.ts:85-100). The drive socket (`hive ctl`, programs here) is not paced, as today: it reads at a socket's speed and its `--json` must not get screens in place of output |
| `pty` (host) | host | the bridge pauses reading the PTY daemon's socket while the link has no room; the PTY daemon sends that viewer a screen instead of what it missed (pty-daemon.ts:512, `BEHIND_BYTES`) |
| `machine` | guest | the same as `pty`: `serveMachine` pauses its daemon's socket while the link has no room |
| `files`, `device`, `hosting`, `list` | both | sent as they come |

### Once per broadcast

What is left per peer after the change: routing the event (already cached by object for terminal
output and conversations, peers.ts:154), the frame's UTF-8 bytes into main's socket, and the
daemon's copy and encryption into that peer's QUIC connection. Binary frames remove the second JSON
escape on both sides (each `\x1b` was six bytes). Encoding once per workspace group saves little
(batches differ per peer by time and room) and is not built; option D is the next step if the
numbers ask for it.

## Answers to the review (2026-10-17)

| # | Point | Answer |
|---|---|---|
| 1 | A frame over the budget or the ceiling stalls or closes for ever; an oversize message stops the daemon | budget takes `min(len, budget)`; the ceiling is beyond the largest frame waiting; main checks `MAX_FRAME` before sending |
| 2 | "Taken" is 10 MB deep | `send_window` 1 MB, in step 3; scale table redone |
| 3 | The bench blamed the wrong cause; SIGSTOP is cut by the idle timeout | cause restated; release build measured; tests stop the peer's main, not its daemon |
| 4 | Room per stream adds up past the ceiling | room is per link |
| 5 | Room per producer reorders the `api` stream | one ordered queue per `api` stream; room only says when it flushes |
| 6 | Lost wakeups and leaks when a stream ends or is replaced | room per link; the daemon reports dropped bytes as taken |
| 7 | Transport acks freeze a terminal when a stream ends; units differ | acks counted in the relay's units per tile; a peer that asked for `acks` is left alone; the viewer goes with its link |
| 8 | Producers not listed: `serveMachine`, the replica's sends, squeeze | listed above; the replica is the sync track's |
| 9 | The shared lock across writes defeats per-stream writers | each writer owns its half; ends reported by message |
| 10 | The ceiling left main's buffer unbounded | the ceiling is in main and counts what is in its socket too |
| 11 | Home's `answer()` pushes to everyone | changed |
| 12 | Encode once per group saves little | agreed; not built |
| 13 | Tag frames explicitly; u64 in JS | a tag byte; ids as u32 |
| 14 | `took` is coarse | one `took` per write of merged frames; with a 1 MB window that is fine |
| 15 | Repeated "too slow" closes redial every 500 ms | known: the guest's backoff resets on a welcome; with producers on room the ceiling is not reached in use. Written down below |
| 16 | Missing tests | added to the build order |

Round 2:

| # | Point | Answer |
|---|---|---|
| 1 | `servePeer`'s queue is invisible to the ceiling, and a whole-queue flush can pass `MAX_FRAME` | it does not wait for room: it flushes on its tick as today, so what queues is in `waiting`; frames of at most 256 KB |
| 2 | A peer pipelining calls grows main | written ceiling below: calls in flight are not bounded; upgrade: main credits the daemon per handled frame and `servePeer` caps calls in flight |
| 3 | QUIC's receive buffers and stream names are unbounded | `receive_window` 2 MB, no uni streams, a name at most 256 bytes, the budget taken before a body is read |
| 4 | Transport acks break on every reopen and under squeeze | replaced: the guest acks what it received, counting from each open |
| 5 | Pacing the drive socket breaks `hive ctl` | the drive socket is not paced |
| 6 | The scale numbers leave out inbound, frames and room | redone |

Round 3:

| # | Point | Answer |
|---|---|---|
| 1 | A window or tab with its own acks and main's count fight over one viewer | the guest's main owns every ack it forwards; its windows' are dropped |
| 2 | Paced terminals bound each tile, not the link: many busy tiles plus their screens can pass 8 MB | the ceiling is 16 MB; written ceiling below, with the upgrade (the relay asks the link for room) |
| 3 | Two windows on a guest share one viewer: one detaching, hiding or asking history changes the other's (a bug today) | found, not caused here; reported to the coordinator as its own fix (the guest's main counts windows per tile) |

## Ceilings, written

- **Calls in flight.** A peer that sends calls faster than main answers them grows main's pending
  answers. Upgrade: main gives the daemon credit back per frame it handled (`read {conn, stream,
  n}`), and `servePeer` stops crediting past 64 calls in flight.
- **Terminal output to one link** is bounded per tile (128 K plus a screen), not per link. Ten busy
  tiles on a slow link hold a few MB. Upgrade: the session relay's viewer asks its link for room
  and goes behind when there is none (the relay's own pacing is not changed in this track).
- **One stream the peer's app stops reading** holds its link's room until the link closes: room is
  per link. Phones and the browser read every stream they open; a one-shot call that drops its
  stream makes the host's write fail, and its bytes are counted taken.

## Pre-mortem

1. **A producer forgot room, and a busy guest is closed "too slow" over and over.** Every producer
   is listed; the close names the link and what waited, and the guest's backoff resets on each
   welcome, so it would redial every 500 ms. Ceiling, written: if a close is seen in use, the
   guest's backoff keeps growing across "too slow" closes.
2. **A guest's acks stop and its terminals freeze.** The relay sends a viewer that is behind its
   screen once it has taken all it was sent; acks counted from each open keep that true across
   reopens (a second window, a reload). A test reopens a tile and checks output still flows.
3. **A long-RTT guest's big welcome is slow.** 1 MB per round trip. Upgrade: raise `send_window`
   for a link that has room for long (a window that grows), measured first.

## Build order

1. Design doc (this), challenged, committed.
2. Main reads the daemon's socket without the quadratic copy. Check: one 32 MB frame costs main no
   more than 32 frames of 1 MB.
3. **Room** (its own commit, for the sync track): daemon writers per stream owning their half,
   `took` (written or dropped), `send_window` 1 MB; main's `waiting`, `hasRoom`, `whenRoom` on
   `Link`, `Stream` and `streamOf`. Check: daemon test — a stream the peer stops reading leaves a
   sibling flowing and a stream accepted meanwhile is announced; `took` stops within the window;
   client test — a peer whose main is stopped leaves the link without room, and room returns when
   it reads again.
4. Frames as bytes, the inbound budget, main's ceiling, `MAX_FRAME` checked in main. Check: a frame
   over the budget passes; a link past the ceiling closes saying why; a frame of 32 MB to a slow
   peer does not close it.
5. `servePeer` frames of at most 256 KB; the guest acks its terminals (shared-workspaces.ts). Check:
   peers tests; a guest terminal that falls behind gets its screen and then output again, also
   after the tile is opened again.
6. Producers in peer-links (agents, home, pty bridge) and `serveMachine`. Check: a follower whose
   main is stopped is sent nothing and then the newest list; the host's memory and `waiting` flat;
   a fast peer's echo unchanged.
7. Bench after, release build; numbers in the commit and the CHANGELOG.

## Unknown

- How a real slow link (not a stopped peer) behaves: no `netem` without root here. The coordinator's
  e2e on two machines is the check; listed in the report.
- A desktop guest's terminal under transport acks on a slow link: no e2e covers a slow link.
