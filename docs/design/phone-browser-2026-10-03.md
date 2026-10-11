# The phone in a browser (2026-10-03)

Status: accepted (2026-10-11), with these decisions: the browser reaches the computer through
iroh compiled to wasm, relay only (a browser cannot send UDP), end-to-end encrypted, on the same
`hive/ws/1` streams as the native phone; the relay is the person's own `hive-net serve` (public
with `--domain`, or on their Tailscale behind `tailscale serve` for HTTPS); there is no hosted
relay. Later steps add ack-window flow control (as Orca does) and a needs-you-first PWA. B0's
results are in §9; B1's and B2's (pairing, and the agents and needs live) and B3's (the phone app,
and where its page is served from) in §10.

It parks the native phone apps (`apps/ios`, `apps/android`,
[`phone-app-2026-10-02.md`](phone-app-2026-10-02.md)) and puts the phone in the browser first. The
native work stays in the tree and its CI keeps running; nothing is deleted.

The person's words: *"drop native phone device for now and give browser support"*. Their earlier
rule still holds: *"lag free and realtime is must"*. Every step below has a latency check.

**The browser is in full control** (*"i want to controll from broswer"*): a paired browser is the
person's own device, with owner access, as their computer is. It starts, stops and closes agents,
types into terminals, approves, edits the board. It still runs no agents itself. Any browser, a
phone's or a laptop's: the layout follows the screen.

## 1. What we already have

| Piece | Where | Runs in a browser? |
|---|---|---|
| The connection: named streams (`sync`, `presence`, `api`) on `hive/ws/1` | `crates/hive-net/src/ws.rs`, daemon | No: the daemon is native. **iroh itself compiles to wasm** (§2) |
| The shared board (Loro) | `packages/workspace-doc` | Yes: no Node or Electron, written for this |
| Doc and list replication | `packages/workspace-host/src/doc-sync.ts`, `list-sync.ts` | Yes, minus `node:` imports to check |
| The workspace API client (`ClientTransport`) | `packages/workspace-api/src/client.ts` | Yes: transport is a seam already |
| The UI: canvas, xterm terminals, views, theme | `apps/desktop/src/renderer` | Yes: it is a web page; the dev bridge already serves it to a browser with `window.hive` shimmed over HTTP (`src/dev-bridge`) |
| Touch and small screen | view protocol 1.5, `hello.device {touch, compact}` (R12) | Yes |
| Phone logic: pairing, needs, agents, terminal grid | `crates/hive-phone` | Not as is: tokio multi-thread, hyper server, files |

So a browser phone is **a desktop guest without Electron**: the same packages the desktop's guest
side uses, a transport that speaks `hive/ws/1` from wasm, and a phone-sized UI on the renderer.

## 2. How a browser reaches the host

**iroh in wasm, relay only.** iroh compiles to `wasm32-unknown-unknown` (default features off,
`getrandom` `wasm_js`); a browser cannot send UDP, so every connection goes through the relay,
over a WebSocket. It is still end-to-end encrypted: the relay carries bytes it cannot read. The
host does not change: it already accepts `hive/ws/1` from any device its gate admits, and a
browser is one more device with its own key. The person's own relay (`hive-net serve`) already
runs iroh's relay server, so no new server role.

Considered and not chosen:

| | Why not now |
|---|---|
| Host serves a web page over HTTPS (zellij web, code-server, claudecodeui) | Needs a public port or a tunnel and a certificate on the person's machine; a second auth system beside device keys |
| WebRTC data channel | A signalling server and STUN/TURN beside the relay we have; direct paths would be a later gain, not a need |
| WebTransport with `serverCertificateHashes` | Direct, but the host needs a reachable UDP port; iroh may add it later (its docs say so) |
| hive-phone core to wasm, whole | Rewrites its runtime (single-thread, no hyper server, no files) before anything shows; the TS packages already work as a guest. Its pairing and its reading of agents and needs do compile to wasm as they are (§10), and the browser uses those |

**Cost**: one extra hop through the relay. Terminal echo is the number to watch (§5).

## 3. Pairing and trust

Same model as the native phone, no new auth:

1. The browser makes its device key on first open and keeps it in IndexedDB (the wasm crate holds
   the ed25519 secret; the page never sends it anywhere). iroh signs with the key's bytes, so a
   non-extractable WebCrypto key cannot be the device key; the seed is kept sealed (AES-GCM) under
   a non-extractable one, so a copy of the browser's storage alone does not carry it (§10).
2. The desktop shows a QR / link: `https://<relay>/phone/#pair=<link>` (`spec/pairing.md`, §10).
   The link is in the **fragment**, so it never reaches the server that serves the page (sshx
   shares its key this way).
3. The browser dials the desktop on `hive/pair/1` through the relay; the person confirms on the
   desktop; the gate admits that key from then on.
4. Revoking it is revoking a device, as today.

Where the page comes from: the person's own `hive-net serve`, as a file server beside the relay
(`--phone`; decided in §10). It holds no secrets and talks only to devices it is paired with.
Pinning (not built yet): the bundle's hash shown in the desktop's pairing dialog, so a swapped page
is noticed.

## 4. The UI

Not the full canvas on a 6-inch screen. The phone design's screens, drawn with the renderer's
components:

- **Needs you**: agents waiting on approval or input, answered in one tap.
- **Agents**: every agent, live state; start, stop, close.
- **Terminal**: xterm.js (WebGL addon), the session the host already sends; a key bar for Ctrl,
  Esc, Tab, arrows (zellij's mobile modifier bar); swipe scrolls. The phone never sizes the
  terminal (rule from the native design), so the desktop's layout does not jump.
- **Changes**: the diff an agent made, read-only.
- **Board**: the canvas, fit to screen; move, add and close tiles by touch. On a large screen
  the browser shows the full desktop layout.

Layout follows `visualViewport` so the on-screen keyboard does not cover the prompt (zellij does
the same). It is a PWA: a manifest, icons, the iOS meta tags, so "Add to Home Screen" gives a full
screen app and unlocks push on iPhone.

## 5. Real-time checks

| Check | Target | How |
|---|---|---|
| Keystroke echo, phone → host → phone, same region relay | p50 ≤ 60 ms, p95 ≤ 120 ms | the echo-latency probe from the desktop, run in the browser |
| Cold open to "needs you" visible | ≤ 1.5 s on 4G | last state from IndexedDB first, live replaces it (native rule 1) |
| wasm bundle | ≤ 2 MB gzipped | `opt-level = "z"`, LTO; no `wasm-opt`, which grows the compressed file (§9) |
| Reconnect after the tab sleeps | redial on `visibilitychange`, no stale screen | resume from the last sequence, as sshx does with chunk numbers |

If the echo misses its target on the relay, that is when WebTransport/WebRTC direct paths earn a
place, measured.

## 6. Notifications

Web Push with the **declarative** format (`web_push: 8030`): Android browsers always; iPhone
from iOS 16.4 when added to the Home Screen, declarative from iOS 18.4. The push role in
`hive-net serve` (`crates/hive-net/src/push`) gains a Web Push sender (VAPID) beside the existing
ones. The message says only "an agent needs you" with a link; the content is read after the page
opens, over the encrypted connection.

## 7. Steps

Each ends green and checked before the next starts.

| Step | What | Done when |
|---|---|---|
| B0 | Spike: a wasm crate (`crates/hive-web`) wrapping iroh, exposing `dial(host) → open(name) → frames` to JS; a test page opens an `api` stream to a running host through the relay | the echo probe meets §5 on the real relay |
| B1 | Pairing from the browser (§3), device key in IndexedDB, QR in the desktop's device list | a browser pairs, is listed, revoked, refused after |
| B2 | Owner core in the browser (owner access, every method the desktop has): `workspace-doc`, `doc-sync`, `list-sync`, `workspace-api` client over the B0 transport; `node:` imports removed where found | the board's shapes and the agents list match the desktop's, live |
| B3 | Phone UI (§4): plain TypeScript and DOM in `crates/hive-web/www` (no framework), served by `hive-net serve --phone`; PWA | the screens work on Android Chrome and iPhone Safari, touch only |
| B4 | Terminal: watch and type, key bar, keyboard-aware layout | echo target met on a phone on 4G |
| B5 | Web Push (§6) | an approval reaches a locked Android phone and an iPhone home-screen app |

Not in this plan: running agents in the browser itself (they run on the host), voice and video.

## 8. What the research found

- **iroh in browsers**: supported, relay only, end-to-end encrypted; examples `browser-echo`,
  `browser-chat` in n0-computer/iroh-examples; no npm package, write an app-specific wasm-bindgen
  crate (iroh's own advice).
- **sshx** (Rust + Svelte): browser over a WebSocket to its server, CBOR frames, xterm.js with the
  WebGL addon, key in the URL fragment, terminal output kept in numbered chunks so a reconnect
  resumes where it stopped. We take: fragment for secrets, sequence-numbered resume.
- **Zellij web client** (0.43): a web server built in, two WebSockets (terminal bytes, control),
  xterm.js, login token exchanged for an http-only session cookie, HTTPS required off localhost;
  mobile mode with a modifier bar, `visualViewport` tracking of the keyboard, swipe to scroll, PWA.
  We take: the mobile details. We skip: a web server on the person's machine.
- **claudecodeui / CloudCLI**: a Node server on the machine, WebSocket to the UI, PWA with a
  service worker, approvals as a banner. Same split as ours, but it needs the machine reachable
  from the phone (LAN or a tunnel); our relay removes that.
- **Web Push on iPhone**: only for Home Screen web apps (16.4+); declarative push (18.4+) needs no
  service worker to show a notification.

## 9. B0 results (2026-10-11)

**Built.** `crates/hive-web`, a `wasm32-unknown-unknown` crate on iroh 1.3 (`default-features =
false`, `tls-ring`), exposing to JS `Device.start(relay)` → `dial(hostId)` → `open(name)` →
`send(frame)` / `recv()`. The device has a new key per page load (B1 keeps it), one relay and no
lookup server, and dials the host by its id through that relay on `hive/ws/1`; frames are
hive-net's (`frames.rs`: u32 big-endian length, then the bytes; the first names the stream).
Beside it:

- `examples/echo.rs`, a native host built from hive-net's own `net::endpoint`, `ws::ALPN` and
  `frames`, that sends every frame back on its stream. It lives in hive-web, not in `hive-net`,
  so the product binary gains no test-only role.
- `www/echo.html`: N round trips of small random frames, checked byte for byte, timed with
  `performance.now()` around `send` + `recv` (so the JS↔wasm crossing is counted), p50/p95/max,
  the dial time, and the `.wasm` size raw and gzipped (`CompressionStream`). It takes `relay`,
  `host`, `n`, `size` from the query or the fragment, and `run=1` starts it.
- `build.sh` (cargo, `wasm-bindgen --target web` into `www/pkg`, sizes) and `measure.mjs` (the page
  in headless Chromium through the desktop's Playwright, results as JSON).

**Measured** on one loaded machine (load 12–17 on 16 CPUs), all on loopback: `hive-net serve
--relay --bind 127.0.0.1:3340` (plain HTTP), the echo host, the page in headless Chromium
(chrome-headless-shell 1223), 1000 frames of 32 bytes after 10 warm-up, three runs:

| | Result | §5 target |
|---|---|---|
| wasm, raw | 2,707,654 B (2.6 MiB) | |
| wasm, gzip -9 | 983,348 B (0.94 MiB); the page's `CompressionStream` gzip: 992,254 B | ≤ 2 MB |
| wasm, brotli -q 11 | 769,093 B (0.73 MiB) | |
| echo p50 | 0.9 / 1.0 / 1.3 ms | ≤ 60 ms |
| echo p95 | 1.8 / 2.6 / 3.2 ms | ≤ 120 ms |
| echo max | 9.7 / 12.5 / 10.6 ms | |
| dial (start → connected) | 80–98 ms | |

An earlier build with `wasm-opt -Oz` gave p50 1.4–1.9 ms, p95 2.9–5.2 ms over three runs of
1000: the same within this machine's noise.

So the wasm path itself costs about a millisecond per round trip; what the browser adds on a phone
is the network to the relay and back, twice (phone → relay → host → relay → phone). The §5
targets are for that, and are **not yet measured**: the loopback numbers only show the browser side
is not where the budget goes. B0 is done when the same page meets them from a phone on the real
relay (below).

**Found along the way:**

- **ring needs a C compiler for wasm32.** iroh's `tls-ring` builds ring, whose build script needs
  clang targeting wasm32. GitHub's Ubuntu runners have clang; this machine had none and used zig
  as the compiler (`CC_wasm32_unknown_unknown` = a wrapper running `zig cc -target
  wasm32-freestanding`, dropping the `--target=wasm32-unknown-unknown` the build passes).
- **`wasm-opt` makes the download bigger.** On rustc's `opt-level = "z"` + LTO output, `-Oz`,
  `-Os` and `-O2` all cut the raw file (to 2.39–2.46 MB) and grew it gzipped by 2.5–3.3 % and
  brotli'd by 3–4 %. `build.sh` does not run it.
- **wasm-bindgen 0.2.129 takes `async fn` on `&self`**, so a stream's `send` and `recv` can be
  awaited at once from JS (each half has its own lock); no `Promise` plumbing by hand.
- **Nothing in iroh 1.3's wasm build was missing** for this: `presets::Minimal`, a custom relay
  map, `connect`, `open_bi`, `read_exact` / `write_all` all compile and run in the browser. Its
  getrandom (0.4, `wasm_js`) needs no `--cfg` flag.
- Dialling takes 80–120 ms on loopback, before any network: the relay's WebSocket and the QUIC
  handshake carried over it. Cold open (§5) pays it once.

**Rerun on loopback** (from the repo; tools: the wasm target, clang or another wasm32 C compiler,
wasm-bindgen 0.2.129, the desktop's dependencies installed for Playwright):

```bash
(cd crates/hive-net && cargo build --release --locked --bin hive-net)
crates/hive-web/build.sh
(cd crates/hive-web && cargo build --release --example echo)
crates/hive-net/target/release/hive-net serve --relay --bind 127.0.0.1:3340 &
crates/hive-web/target/release/examples/echo --relay http://127.0.0.1:3340 > /tmp/echo-id &
(cd crates/hive-web/www && python3 -m http.server 8765 --bind 127.0.0.1) &
sleep 5
node crates/hive-web/measure.mjs http://127.0.0.1:8765/echo.html http://127.0.0.1:3340 "$(cat /tmp/echo-id)" 1000
```

`CHROMIUM=<path>` uses a browser other than the one Playwright pins. The page opened by hand in
any browser does the same.

**From a phone, through a relay on Tailscale** (not run yet). On the computer, with the relay, the
echo host and the page:

```bash
hive-net serve --relay --bind 127.0.0.1:3340 &
tailscale serve --bg 3340                                # https://<machine>.<tailnet>.ts.net → the relay
tailscale serve --bg --https 8443 http://127.0.0.1:8765  # the page, over HTTPS too
echo --relay http://127.0.0.1:3340                       # the host may use the relay's local address: the relay routes by id
```

then open on the phone, over the tailnet:
`https://<machine>.<tailnet>.ts.net:8443/echo.html#relay=https://<machine>.<tailnet>.ts.net&host=<echo id>&n=200&run=1`.
For the cost of distance, run the relay on a machine elsewhere (a small VPS) and the host at home.

**Through a public relay**: `hive-net serve --relay --domain relay.example.com --contact
you@example.com` (ports 443 and 80 open: Let's Encrypt and the captive-portal check), the echo
host with `--relay https://relay.example.com`, the page from any HTTPS host (GitHub Pages works:
it is static), and the same fragment with `relay=https://relay.example.com`. `--relay` alone admits
every device; a lasting relay runs the access role beside it.

## 10. B1, B2 and B3 results (2026-10-11)

### B1 and B2

**Works**, end to end in `apps/desktop/tests/e2e/phone-browser.spec.ts`: the desktop on a closed
network of its own (relay, lookup, access) offers its link in Settings → Devices → Pair a phone; a
headless Chromium page running hive-web, opened with that link in its fragment, gets onto the
network with the voucher the link carries, pairs with the desktop through the relay, and is listed
there as the person's phone. It follows the desktop's agents: the agent waiting on a permission
(listed, and asked outright as `needs`, `decide: true`), then working once answered on the desktop,
live. Reloaded, it is the same device, still paired, without the code. Unpaired on the desktop, it
is refused: `not admitted (code 403)`, the desktop's gate. 15.5 s on a loaded machine.

**One owner for each rule.** No pairing rule is written again for the browser: hive-web links
hive-phone and hive-net and calls their own code.

- **hive-net and hive-phone build for `wasm32-unknown-unknown`.** Their native-only dependencies
  (tokio's runtime, mDNS, native certificates, rustls for reqwest, hyper, alacritty) are target
  dependencies now, and the modules that need them are left out of a wasm build: hive-net's
  `daemon`, `doctor`, `host_record`, `push`; hive-phone's `connections`, `pacing`, `push`,
  `screen`, `talking`, `viewing`, `watching`, and `Identity::unpair_from`. Timers and the clock go
  through `n0-future`, tokio on native and the browser's on wasm, so `pairing::pair`,
  `needs::ask_on`, `agents::follow` and `hive_net::access::client` run in both. The native builds
  and tests are unchanged.
- **Admission** (`spec/pairing.md` 0.6): hive-phone's `Identity::let_in` became
  `network::admit(admission, key)`, which the phone's `pair_with` and the browser both call.
- **The access service answers browsers**: `Access-Control-Allow-Origin: *` and the preflight.
  Every request to it is signed by a device key and none rides on a cookie, so any origin may ask.
  Without it a browser cannot read the answer and never gets onto a closed or open-pow network.

**The JS surface** (`crates/hive-web`): the wasm exports `pair(seed, link, name)` →
`{with, certificate, network, admission}`, `deviceId(seed)`, `Device.start(seed, relays)` →
`reach(id, relay)` → `Host.follow(listed)` (each list as `{agents, needs, working}`, the phone's own
order of what waits), `Host.open(name)` (B0's streams); B3 added the actions (below). The page
keeps the key and what pairing gave in IndexedDB (`www/app/store.ts`; B1's `hive-web.js` and its
test page `pair.html` are gone, the app replaced them).

**Size**: 3,179,290 B raw, 1,149,919 B gzip -9, 885,957 B brotli (B0: 983,348 gzipped); reqwest
and hive-phone's readers are the growth. Within §5's 2 MB.

**Proved to fail** (`scripts/mutate.sh`): the phone's proof computed over the ids swapped
(hive-phone `pairing::prove`): never paired; the sealed key not read back (`hive-web.js`): a new
device on reload; the access service's CORS header removed: never let onto the network, never
paired.

**Not done, for later steps:**

- ~~The desktop shows `hivemind://pair/<…>` only~~: B3 shows the page's address when there is one.
  The bundle hash in the dialog (§3) is still to do.
- A computer on the local network alone has no relay in its link, and the browser says it cannot
  reach it. Only one paired computer is kept; the person's other devices (`spec/pairing.md` 0.7),
  the network profile kept for later dials, and unpairing from the browser are not there yet.
- The doc's B2 also names the board (`workspace-doc`, `doc-sync`, `list-sync`, the
  `workspace-api` client) in the browser; `Host.open("api")` carries it, and none of it is wired.
- ~~Answering, sending, starting and stopping not exported~~: done in B3.

**Rerun:**

```bash
(cd crates/hive-net && cargo build --bin hive-net)
crates/hive-web/build.sh        # CC_wasm32_unknown_unknown as in §9 where there is no clang
apps/desktop/scripts/e2e.sh phone-browser
```

### B3: the phone app in a browser

**Where the page is served from (decided).** From the person's own server: `hive-net serve
--phone <dir>` serves the built page at `<relay>/phone/`, beside the relay, on the same port and
under the same certificate. That server already exists on every network a browser can use (a
browser reaches the computer only through a relay, §2), so the page needs nothing more: HTTPS
comes from `--domain` (Let's Encrypt) or `--cert`/`--key`, or from `tailscale serve` in front of a
relay on a tailnet. There is no hosted page, as there is no hosted relay. The desktop's pairing
offer asks the relay for `phone/manifest.webmanifest` (3 s at most); when it is there, Pair a phone
offers "Open in the phone's browser", off by default and naming the server, and turned on, the
QR code and Copy button carry `https://<relay>/phone/#pair=hivemind://pair/<…>`. A phone's camera
opens it in the browser; hivemind's own phone app reads the same QR, as the link inside the
address is now one of the link's forms (`spec/pairing.md`, held to `conformance/pairing.json` by
hive-phone and workspace-host alike). Without the page, the QR is the bare link, as before. The
release does not ship the built page yet: build it with `crates/hive-web/build.sh` and pass its
`www` folder (B4 puts it in the release and in `infra/compose.yml`).

**Works**, end to end in `apps/desktop/tests/e2e/phone-browser.spec.ts`, in a 390×844 touch
browser: asked for the browser, the desktop's QR names the page on the network's own server;
opened, the page names the computer and pairs on a tap, and is listed as the person's phone;
opened again with another link, it says the pairing it would replace, and Keep leaves it. **Needs you**: the agent waiting on a permission, as a card with
an amber rail, Deny and Allow; Allow from the browser, and the computer answers the agent as that
device (`agent.answer` in its audit log, by the peer device) and it works. **Agents**: by machine
and workspace, a state dot, status and how long. **One agent**: its chat; a message sent from the
browser is typed in by the computer as that device (`agent.send` in its audit log), the agent hears
it (its session file), and the chat shows both sides. Reopened offline, with the relay's WebSocket
refused, the page shows what waited from what it kept, says the computer is not reached, and
reconnects when the network is back. Unpaired on the computer, it is refused. 34–52 s.

**The app** (`crates/hive-web/www`): plain TypeScript compiled by the repo's `tsc` into `www/js`
(no framework, no bundler), one module per screen (`needs.ts`, `agents.ts`, `agent.ts`, `chat.ts`,
`pair.ts`, `devices.ts`), the connection in `phone.ts`, the kit in `dom.ts`. Lists are kept by key
(`Keyed`): an element is made once per item, made again only when what it shows changed, moved only
when out of place; the ages tick in place. The look is the Android app's (`Theme.kt`, `Kit.kt`):
its palette dark and light, Geist and JetBrains Mono, pills, cards with an amber rail, the
composer, the floating tab bar (Needs you, Agents, Devices; Views waits on views in the browser).
Installable: `manifest.webmanifest`, icons from the launcher mark, the iOS meta tags, safe areas;
`sw.js` keeps every file `build.sh` lists in `shell.json` and serves it at once, fetching it again
behind (the same ETag is not written again).

**The actions, one owner**: the wasm's `Host` now also has `answer(workspace, tile, since, reply)`
(`{text}`, `{allow}` or `{approve, feedback?}` mapped onto hive-phone's `Reply`), `send`, `stop`
(`control::interrupt`), `closeAgent`, `startable`, `start` and `conversation(workspace, tile, said,
until)` (hive-phone's `conversation::follow` until the promise settles). The page calls them; no
rule is written again in JS. Close and start have no screen yet.

**Found and fixed on the computer's side**: asked for an agent's conversation before the agent had
written its session file, the host answered nothing and never followed it, so a phone (native or
browser) that opened a fresh agent's chat heard nothing of it. It now follows the agent's first
session once its file is there (`packages/host/src/conversations.ts`, with a test). And the page
gives up a dial after 10 s and says the computer is not reached; iroh's dial would wait on.

**Security review** (of the B3 commit), each fixed:

- *A link pairs on its own.* Opening `…/phone/#pair=<link>` paired at once, over any pairing the
  page had: whoever got a person to open a link of theirs had that phone answering their
  computer. The page now reads the link through the wasm (`readLink`, hive-phone's `parse_link`),
  asks "Pair with <computer>?", pairs only on a tap, and says what it would replace (Keep leaves it).
- *The page's server gets the pairing secret.* The page's JS comes from whoever runs the network's
  server, and it is handed the link: its code and voucher, and the browser's key it keeps. A server
  that is not the person's own could pair as them, with everything a phone may do. A member's
  desktop cannot tell who runs the server (a visit voucher is signed by any member), so the
  browser's link is never the default: Pair a phone shows the hivemind link, and "Open in the
  phone's browser" names the server and says that whoever runs it could pair as the person. A bundle
  hash cannot close this (nothing pins the top-level document a browser loads); a page served
  from elsewhere would need a host the person trusts more than their own server.
- *A tile with no agent is asked again and again.* The host's conversation follower polled the
  transcript of a tile no agent keeps one for, every second, for as long as the phone listened. A
  tile whose agent keeps no conversation now answers nothing once and is not looked at again; one
  whose file is not written yet is followed from when it is (`packages/host/src/conversations.ts`).

**Measured** (load 12–35 on 16 CPUs, headless Chromium, CPU throttled 4× as a mid phone):

| What | Budget | Measured |
|---|---|---|
| First screen from what the page kept, offline, the files from the service worker | 500 ms | 291–445 ms in the spec over four runs (load 19–35); 255–344 ms over 5 reloads at load 14 (40–178 ms unthrottled). It was 366–655 ms until the first screen's modules were preloaded and the wasm's glue loaded after it. After the security fixes, at load 8–19: 387–896 ms over 8 runs, and the B3 commit's own page 475–758 ms in the same hour; the budget is not held on this machine at that load |
| One update applied to the three screens (one wait answered), layout included, 40 agents | one frame, 16.7 ms | median 7.7 ms, p95 15.8 ms |
| The same, 200 agents | | median 24 ms, p95 53 ms: over a frame |
| wasm | 2 MB gzipped (§5) | 3,239,975 B raw, 1,166,205 B gzip, 895,743 B brotli; `hive-net serve --phone` serves the brotli copy build.sh makes |
| wasm compiled | `instantiateStreaming`, cached | wasm-bindgen's `init()` streams it (`application/wasm`); the module comes from the service worker's cache |

**Proved to fail** (`scripts/mutate.sh`, the spec unless named): the desktop offering no page
link; Allow sent as Deny (`reply_of` in the wasm); the message sent empty; the service worker never
serving its cache; the kept overview not shown on open; no limit on a dial; the host not following
a session begun after it was asked (its unit test); the conformance cases with either parser not
reading the page's address; the page pairing on its own from a link; not saying the pairing a link
would replace; the desktop offering the browser's link by default, or not naming its server;
the host looking again at a tile no agent keeps a conversation for (its unit test); `pages.rs` serving a dotfile, a wasm without its type, or a stale
compressed copy (its unit test).

**Not done, for B4:**

- The terminal (watch and type, the key bar), and the keyboard-aware layout beyond
  `interactive-widget=resizes-content` and `visualViewport`; redial on `visibilitychange` is there,
  resuming a stream from a sequence is not.
- Not run on a real iPhone or Android phone yet: only Chromium at a phone's size and touch. Safari's
  service worker, IndexedDB sealing (WebCrypto non-extractable keys) and Add to Home Screen need a
  real device, over HTTPS (`--domain` or `tailscale serve`).
- The built page in the release and in `infra/compose.yml`.
- Close and start from the page (exported, no screen); Views; the person's other devices; unpairing
  that tells the computer (the page only forgets it); a refused page offering to pair again.
- Lists of hundreds of agents take more than a frame to apply at 4× (above).

**Rerun:**

```bash
(cd crates/hive-net && cargo build --bin hive-net)
crates/hive-web/build.sh                   # as above; it also compiles the app and lists the shell
apps/desktop/scripts/e2e.sh phone-browser  # prints the first-screen time
node crates/hive-web/measure-screens.mjs 40 200
```

To open it from a phone: `hive-net serve --all --domain relay.example.com --phone
crates/hive-web/www …`, the desktop on that network, Settings → Devices → Pair a phone, and scan
turn on Open in the phone's browser, and scan the QR code with the phone's camera.
