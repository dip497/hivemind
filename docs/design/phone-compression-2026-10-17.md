# What a phone is sent large, deflated (2026-10-17)

**Verdict.** Deflate each frame over 16 KB that a desktop sends on a phone's `api` stream, when the
phone's first frame offers it, as `z:` + base64; inflate it in the phone's Rust core, which
Android, iOS and the phone page share. No change to hive-net or its daemon protocol. A long
conversation arrives in about a third of the bytes; a terminal's history in less.

## Problem

**Goal.** The first open of a long conversation or a terminal's history on a phone, over a mobile
network, waits on bytes the network carries as they are.

**Constraints.**
- Phones and desktops update apart: an old phone must still read a new desktop, and the reverse.
- The phone page runs the Rust core as WebAssembly, so the phone's decoder has to be pure Rust.
- The desktop's host runs in Electron's main process and, as `hive host`, under Bun. Neither may stall.
- The app and hive-net come from one release, but a phone does not.

**The path (read from the code).**
- The desktop's `servePeer` (`packages/workspace-api/src/peers.ts`) sends text frames on a `TextChannel`.
- `peer-links.ts` maps that onto a hive-net stream.
- Main hands each frame to the daemon as a JSON string (`{t:"send", data}`), and the daemon writes its bytes as a QUIC frame.
- The phone core reads `api` frames in four places (`workspace.rs` twice, `conversation.rs`, `views.rs`).
- Nothing on the path compresses; only the phone page's wasm is shipped pre-compressed.

**Numbers (measured here, `scratchpad/zbench.js` on this session's own transcript).** The last
2,000 lines of a long Claude session, 781 KB of JSON:

| Encoding | Size | vs raw | as base64 | Time (Node 22) |
|---|---|---|---|---|
| none | 781 KB | 1× | — | — |
| deflate level 1 | 208 KB | 3.8× | 2.8× | 10.6 ms |
| deflate level 6 | 181 KB | 4.3× | 3.2× | 15.9 ms |
| zstd level 3 | 156 KB | 5.0× | 3.7× | 7.6 ms |
| zstd level 9 | 145 KB | 5.4× | 4.0× | 21.8 ms |

- **Small frames:** 500 frames averaging 3.4 KB compress 2.8× each, and 4.2× with one context shared across them.
- **Typical frames:** a call's answer or a moment's events are well under 16 KB.
- **Which known problem this is:** content-encoding negotiation on a message stream, which is what HTTP's `Accept-Encoding` and WebSocket's permessage-deflate do.

## What others do

- **WebSocket permessage-deflate** ([RFC 7692](https://www.rfc-editor.org/rfc/rfc7692), and the
  [websockets docs](https://websockets.readthedocs.io/en/16.1/reference/extensions.html)): the
  client offers in the handshake and the server accepts. By default each message continues the
  previous one's LZ77 window (context takeover); `server_no_context_takeover` drops that state to
  save memory. Teaches: offer it in the opening message; a shared context is a memory and state
  cost per stream.
- **BREACH and CRIME** ([breachattack.com](https://breachattack.com/),
  [Alawatugoda, Stebila, Boyd](https://www.douglas.stebila.ca/files/research/papers/FC-AlaSteBoy15.pdf),
  [CTX](https://www.blackhat.com/docs/eu-16/materials/eu-16-Karakostas-Ctx-Eliminating-BREACH-With-Context-Hiding-wp.pdf)):
  compression before encryption leaks, in the ciphertext's length, how much a secret and text an
  attacker chose have in common. Mitigations keep secrets and attacker text in separate
  compression contexts, or do not compress them. Teaches: no context shared across frames.
- **Node and Electron:** Node's `zlib` has zstd, and Electron 44, which the app ships, carries it.
  Bun's `node:zlib` has both.

## Every side

| View | What it worries about here |
|---|---|
| **User** | Opening a long chat on cellular waits on bytes: about 1.25 s for 781 KB today. A broken frame must fail loudly, not show half a history. An inflate error fails the read, as a malformed frame already does. |
| **Data** | Nothing is stored compressed. The desktop's store, the transcript and the spec's messages are unchanged; only bytes on the wire are. Each frame stands alone, so a lost or reordered stream cannot corrupt the next. |
| **Operator at 3am** | A mismatch shows up as a phone that cannot read a frame. That needs a phone that offers `z` and a desktop that sends `z:` it cannot read, which the format makes impossible: the phone writes the offer and reads the only frames that start with `z:`. Recovery is to drop the offer from the phone; the desktop then sends plain frames, with no desktop change. |
| **Security** | BREACH-class length leaks (pre-mortem 3). A decompression bomb is capped at the 64 MB frame limit. Only the owner's paired phone reaches an `api` stream, so no new party is added. |
| **Cost** | CPU: 16 ms of deflate per 781 KB, off the main thread. Bytes: about 70% less on the largest frames a phone receives; cellular data saved for the person. No servers are involved. |
| **Next year** | (1) Paging long histories: independent of this, and it makes frames smaller. (2) Binary frames in the daemon protocol: B, a drop-in upgrade behind the same offer. (3) Compression for the other streams (`agents`, `home`): the same `squeezed()` applies once their openers offer it. |

## Options

**A. Deflate a large frame, alone, as base64 text (chosen).** The phone offers `z: "deflate"` in
its `api` open frame. The desktop deflates frames over 16 KB off the main thread, keeps their order,
and sends `z:` + base64. The phone inflates any frame that starts with `z:`.

```
phone ──{t:open, z:deflate}──► desktop: servePeer → squeezed(api) ──"z:…"──► daemon ──QUIC──► phone core: unsqueezed
```

Where it first breaks: base64 costs a third on top of the compressed size (3.2× instead of 4.3×).

**B. Binary frames through the daemon.** The same deflate, but main tells the daemon to send bytes,
not a string, and the phone reads bytes. Where it first breaks: the daemon's JSON protocol
carries strings, so the bytes would cross the main↔daemon socket as base64 anyway. It needs a
daemon protocol change for a gain on the network hop alone.

**C. zstd, with one context per stream.** The best ratio (5.0×; 4.2× on small frames with a shared
context). Where it first breaks:
- the phone needs a pure-Rust zstd decoder (`ruzstd`) beside the tools already in its wasm;
- a shared context keeps state per stream on both ends;
- a shared context mixes text across frames, which is BREACH's precondition.

**Scale.** First open of a long conversation over 5 Mbit/s of mobile throughput (an assumption: LTE in use, not the peak):

| Design | Today (781 KB history) | 10× (7.8 MB) | 100× (64 MB, the frame limit) |
|---|---|---|---|
| none | 1.25 s | 12.5 s | 102 s |
| A | 0.39 s (244 KB) + 16 ms deflate | 3.9 s + 160 ms | 32 s + 1.6 s, its later frames waiting behind it |
| B | 0.29 s (181 KB) | 2.9 s | 23 s; needs a daemon change |
| C | 0.25 s (156 KB) + 8 ms | 2.5 s | 20 s; a second decoder in the phone page |

Arithmetic:
- Time on the wire is bytes × 8 / 5,000,000 s. For A at today's size: 244 × 1024 × 8 / 5e6 = 0.40 s.
- Deflate time scales with size from the 15.9 ms per 781 KB measured.
- At 100× no design is good: what has to change then is paging the history (`agent.conversation` already takes a cursor), not the encoding.

## Choice

**A.**
- It takes the first and largest step: over 3× smaller, about 0.9 s off today's long open.
- It touches only the two ends that already change together with the phone's protocol (the host and the phone core), negotiated in the frame the phone already sends.
- Neither the daemon, its protocol nor hive-net changes.
- B lost because its gain (3.2× to 4.3×) needs a daemon protocol change, and the main↔daemon hop would still carry base64.
- C lost because the further 15% costs a second decoder in every phone build, and its shared context opens the BREACH precondition that per-frame deflate avoids.

**What was surprising.**
- The base64 penalty is larger than the gap between deflate and zstd: B's gain over A is bigger than C's.
- The daemon protocol, not the codec, is the next limit.
- A shared context buys most on small frames, which are the ones least worth compressing.

## Pre-mortem

A year on, it failed. Likely reasons, and what changed:

1. **A phone and a desktop of different releases.**
   - A phone that does not offer is never sent `z:`.
   - A desktop that does not know `z` ignores it: before this change, `opened()` read only `t` and `workspace`.
   - The phone inflates only frames that start with `z:`, which JSON never does.
   - Covered by a desktop test with two phones on one terminal, and by the conformance file.
2. **A crafted frame exhausting the phone's memory (a decompression bomb).** The phone inflates up to
   hive-net's 64 MB frame limit and refuses past it (`decompress_to_vec_with_limit`).
3. **Leaking a secret by length (BREACH-class).** Each frame is deflated alone, so no secret is
   compressed together with text from another frame, and only frames over 16 KB are compressed.
   - Within one frame, a terminal's output can still hold a secret and text an attacker caused, such as a page an agent fetched.
   - Exploiting that needs an on-path observer and many adaptive repeats of the same frame, which a phone's one-off history load does not give.
   - Written down as a known ceiling. If it ever matters, the upgrade is not to compress terminal output.

**Ceiling.** At 64 MB a single frame deflates in about 1.3 s, and the frames sent after it on that
stream wait behind it in order. Each terminal and each conversation is its own stream, so nothing
else waits. Paging the history is the upgrade.

## Build order

1. **The phone's decoder** (`crates/hive-phone/src/squeeze.rs`) and `read_message` for every `api`
   reader. Checked by `crates/hive-phone/tests/squeeze.rs` against `conformance/squeeze.json`,
   made with Python's zlib: frames inflate to their text; plain frames pass; malformed ones are refused.
2. **The offer** in the phone's open frame (`workspace.rs`).
3. **The desktop's encoder** (`packages/host/src/squeeze.ts`): async, ordered, over 16 KB.
   `peer-links.ts` applies it to a phone that offers. Checked by `packages/host/tests/peer-links.test.ts`:
   - two phones on one terminal, one offering;
   - a long output then a short one, in order;
   - deflated to under a third for the one that offers, plain for the other.
4. **The spec**: `spec/workspace-api.md` 0.27 states the offer and the frame.

Each test is shown to fail with the code it guards broken.

## Unknown

- Real mobile throughput for the people using it. 5 Mbit/s is an assumption; the gain in seconds
  scales with it. Check: time `agent.conversation` on a phone on cellular, before and after.
- How large real conversations get before a phone opens them. The 781 KB here is one long session.
  Check: the size of `agent.conversation` answers in the desktop's log over a week.
