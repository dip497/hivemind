# View protocol 1.5 — people, the device, and a host for tests

Builds on 1.4 (`view-protocol-1.4-2026-09-26.md`) for the multiplayer plan's R12
(`multiplayer-2026-09-28.md`). `PROTOCOL_VERSION` stays 1; a host lists what it wired in
`hello.features`, as in 1.3 §4.0.

## 1. Why

A workspace is shared now (M1, M2), and every view shows the same one: each person picks their
own (design §4.2 C.6). A view could not tell who else is there, what they point at or what they
selected. The phone (M5) runs views too, so one view has to know whether it is on a desktop or on
a phone. A view docked from a saved layout could name a tile that is gone, and eight such rects
disabled it. And a view author had no host to test against but the app.

## 2. The additions

| Feature | Wire | Permission |
|---|---|---|
| `participants` | `subscribeParticipants` / `unsubscribeParticipants`; `participants [{id, person, name, color, cursor, selection}]` on each change | none |
| — | `hello.device {touch, compact}` | none |
| — | the SDK holds back a surface rect until a `structure` names its tile | — |
| — | `@hivemind/view-sdk/testing`: `fakeHost()` | — |

### 2.1 `participants`

Everyone else in the workspace, one per window or device (`id`), `person` their person (the same
at each of their devices), `name`, and `color` as the app draws them (`#rrggbb`: theirs, or the one
they get for not choosing). `cursor` is `{ tileId }` of the tile their pointer is over, and
`selection` the tiles and frames they selected; both only ever name what the view was told of in
`structure`, so a board object or another workspace's tile never shows. The person at the view is
never in the list. A message goes when what the view would see changes: who is there, the tile
under a pointer, a selection — not a pointer moving within its tile.

The pointer's tile comes from the person's own window: presence (`presence.set`) carries `over`,
the tile, frame or board object under their pointer, next to its board coordinates, which mean
nothing to a view with a layout of its own. A person is here whichever view they are in: the
window says so from the workspace, and the canvas adds where the pointer is (before 1.5, leaving
the canvas for a view read to everyone else as leaving).

No permission: the names and colours are what every person in the workspace sees by Share, and a
view has no way out of its sandbox to send them anywhere.

### 2.2 `hello.device`

`touch`: the pointer is a finger, so what it taps needs room. `compact`: a phone's screen, one
column. The desktop app sends `touch` from `(pointer: coarse)` and never `compact`; the phone's
view host (M5) sends both. `hm.device` reads `{ touch: false, compact: false }` from a host that
predates it.

### 2.3 Surface rects for tiles the host has not named

`setSurfaceRects` keeps what the view asked for and sends the host the rects whose tile the last
`structure` named: one restored from a saved layout for a tile that is gone is never sent, one for
a tile not heard of yet goes when a `structure` names it, and one whose tile closed leaves. The
host still refuses a rect for a tile it never named, and no longer refuses one for a tile it
named and has closed since: the view had not heard yet.

### 2.4 A host for tests

`fakeHost(options)` gives a view's tests the handshake and `hello` the options describe
(capabilities, features, device, layout, viewport), sends what the test scripts, answers requests
from `options.answers` (else `UNSUPPORTED`), and asks where a tile is (`reveal`). What the view
sends is checked as the app checks it — `parsePluginMessage`, then `refusal`, which the app's host
link applies too — and kept: `commands`, `rects`, `layout`, `subscribed`, and `refused` with the
app's reason for each. It runs without a window (bun, node) and in a page (`handshake(window)`).
`hive views new` ships it in `types/view-sdk/` with a `paths` entry, like the rest of the SDK.

## 3. Deliberately not in 1.5

- **A person's pointer in board coordinates.** A view does not lay tiles out where the canvas
  does; the tile under the pointer is what it can show.
- **A view saying where its own person points.** Their selection reaches others from the
  workspace whatever the view; a pointer inside a view has no meaning outside it.
- **A manifest field declaring phone support.** It waits for its first caller, the phone's view
  list (M5).
