# The phone in a browser (2026-10-03)

Status: accepted (2026-10-11), with these decisions: the browser reaches the computer through
iroh compiled to wasm, relay only (a browser cannot send UDP), end-to-end encrypted, on the same
`hive/ws/1` streams as the native phone; the relay is the person's own `hive-net serve` (public
with `--domain`, or on their Tailscale behind `tailscale serve` for HTTPS); there is no hosted
relay. Later steps add ack-window flow control (as Orca does) and a needs-you-first PWA. B0's
results are in §9; B1's and B2's (pairing, and the agents and needs live), B3's (the phone app,
and where its page is served from) and B4's in §10.

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
crates/target/release/examples/echo --relay http://127.0.0.1:3340 > /tmp/echo-id &
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

## 10. B1 to B4 results (2026-10-11)

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
node crates/hive-web/measure-screens.mjs 200 200 agents   # and needs; JSON: apply, frame, styled, laidOut
```

To open it from a phone: `hive-net serve --all --domain relay.example.com --phone
crates/hive-web/www …`, the desktop on that network, Settings → Devices → Pair a phone, turn on
Open in the phone's browser, and scan the QR code with the phone's camera.

### B4: hundreds of agents, release, the rest of the screens, the terminal

**1. 200 agents inside a frame.** Profiled first (`measure-screens.mjs`, a Chrome trace and a CPU
profile at 4× throttle). The 16–24 ms was not script: it was style and layout of whole lists, and
the cause was the keyed list itself. `Keyed.set` removed the rows that had gone only after its walk,
so while it walked, a row about to go sat where the next row belonged, and every row after it was
moved: answering one wait moved 49 of the 50 cards, and each move restyled and laid out the list.
Rows gone are now removed first; an answer removes one card and remakes one agent row and moves
nothing (`phone-page.spec.ts`). Then, for what the browser does after the script: rows and cards
carry `content-visibility: auto`, so those away from the screen are not styled, laid out or painted
until scrolled near (the card's rail, on its border, kept inside the clip: screenshots identical);
and the working dots, which breathe as on Android (`Kit.kt`), go still past 40 working agents,
each breathing dot being a layer the browser recomposes on every change (the person's choice,
2026-10-12). No layout is read while writing.

`measure-screens.mjs` now shows one screen at a time, as the app does, at a phone's size and touch,
and reports, besides the update and its layout (`apply`), the main thread's own time for the
whole frame (`frame`: styles, layout, paint, commit; thread time, so another process's load is
counted less) and what the update touched (elements styled, objects laid out), which no load
changes. B3's page and this one, run in turn, three times each, 200 agents, 4× throttle, on a
shared machine at load 11–29 on 16 CPUs (medians of the runs):

| Screen | | apply median | apply p95 | frame median | styled | laid out |
|---|---|---|---|---|---|---|
| Needs you | B3 | 56.2 ms | 119.9 ms | 81.4 ms | 343 | 565 |
| | now | 9.9 ms | 14.7 ms | 27.2 ms | 17 | 33 |
| Agents | B3 | 14.1 ms | 24.1 ms | 61.8 ms | 181 | 12 |
| | now | 9.9 ms | 17.4 ms | 29.9 ms | 2 | 4 |

At load 14, all three screens shown at once, the update was 4.5 ms median and 7.0 ms p95 (B3:
16.3–17.5 and 35.6–41.1). The update is inside a frame; at load 20–29 the Agents p95 is at the
frame's edge (14.9–33.2 ms over the runs) and the whole frame is over it. What is left of a frame,
measured: `content-visibility`'s own check of which rows are near, pre-paint, and a hit test for a
mouse a phone does not have (the harness's). Not measured on a phone yet.

**Proved to fail** (`scripts/mutate.sh`, `phone-page.spec.ts`): B3's `Keyed.set` (rows gone
removed after the walk); no `content-visibility`; dots that never go still.

**2. CI, the release and the stack.** The page is the same bytes wherever it is built, so a hash
says which page a server serves. `crates/hive-web/tools.sh` fetches, checked against their hashes,
what `build.sh` needs at the versions the repository pins: the Rust `rust-toolchain.toml` names
(1.93.1), wasm-bindgen at `Cargo.lock`'s version (its project's own build), zig 0.17.0 as the C
compiler for wasm (ring's), and, where there is no `node_modules`, tsc and the fonts at
`pnpm-lock.yaml`'s. `build.sh` maps this checkout's and Cargo's paths to fixed ones and lists the
shell in byte order. hive-web's workspace is `crates/` (`crates/Cargo.toml`, the other crates
excluded): Cargo hashes a path dependency outside the workspace by its absolute path, and with
hive-phone and hive-net at `../` the wasm differed with the checkout's path (3,221,770 bytes here,
3,221,793 in a copy elsewhere, 3,221,795 in the image). With all of it, this checkout, a copy in
another folder and the image's stage all give page `4dd5eb16…`.

- **The page's hash.** `build.sh` writes `www/page.sha256`: the sha256 of `sha256sum`'s list of
  `index.html`, `sw.js` and every file `shell.json` names, in name order. The desktop works it out
  the same way from what a server serves (`apps/desktop/src/main/phone-page.ts`) when the person
  turns on Open in the phone's browser, and Pair a phone says whether it is the page this build
  goes with (its hash built in: `HIVEMIND_PHONE_PAGE` in a release, `www/page.sha256` in a local
  build), another one, or, for a build made without one, to compare it with the release's. It
  cannot see a server that serves the desktop one page and a phone another.
- **CI** (`ci.yml`, job `phone-page`): builds the page with `tools.sh` and `build.sh`, checks that
  the desktop's hash of it served is `build.sh`'s, and runs `phone-page.spec.ts` in Chromium.
- **Release** (`release.yml`, job `build-phone-page`): builds the page once, runs the same spec,
  publishes `hive-phone-page.tar.gz` (what the server serves, under `phone/`) and
  `hive-phone-page.sha256`, and hands the hash to the Linux, macOS and Windows desktop builds,
  which wait for it.
- **The stack** (`infra/Dockerfile`, `compose.yml`, `compose.public.yml`): a stage builds the page
  as CI does; the image serves it at `/phone/` (`--phone /phone`); `infra/check.sh` checks the page
  and its wasm's type.

Checked here: actionlint on `ci.yml` and `release.yml` (clean; it reports `nightly.yml:33`, a
string passed to a string input, which HEAD has too); `tools.sh` from an empty folder and
`build.sh` with what it fetched; the image built, the stack's checks run against it, and the hash
of what it serves at `/phone/` worked out as the desktop does: `4dd5eb16…`, this build's. Not run:
the workflows themselves, which need the branch on GitHub. Once it is pushed:
`gh workflow run release.yml --ref feat/hive-web-b0 -f tag=v0.0.0-web-test` (build only).

**3. The rest of the screens.** Each through hive-phone's core, as the Android app does it:

- **Start and close an agent.** Agents has Start: a workspace the computer holds (one is
  chosen for you), its folder when it has several, the agent and its model and mode when it lists
  them, a prompt; Start opens the new agent in place of the screen that started it. An agent's
  screen has Close, asked in place ("Close …? It stops, and its tile closes on …"). The Android app
  asks the phone's screen lock for both; a browser has none, so Close asks and Start is the tap on
  Start. WebAuthn user verification could stand in for the lock later.
- **The person's other devices.** Devices asks the computer (`{t:"devices"}`) and lists the
  computers and hosts it tells of, each whose certificate verifies and names the person, as the
  phone learns them (`devices::told_of`, the one filter both use), titled with whose they are. They
  are listed, not reached: the page keeps one connection, to the computer it paired with.
- **Forget tells the computer.** Forget this computer, once confirmed, asks it to forget this
  browser (`{t:"unpair"}` on the `device` stream), then forgets it here; when the computer is not
  reached the page says it was not told.
- **A refused page pairs again.** A computer that no longer admits this browser closes on it with
  hive-net's gate code (403, "not admitted" or "removed"); the wasm tells that apart from a dropped
  connection (an error named `Unpaired`), the page forgets the pairing and shows Pair again, saying
  why.
- **Scan.** The pairing screen has Scan: the rear camera (`getUserMedia`, `facingMode:
  environment`), a frame every 150 ms at most 640 px wide, read in the page's wasm with `rqrr`
  (Safari has no BarcodeDetector). A code scanned is asked about before pairing, as a link the page
  was opened with is. It costs the wasm 181 KB raw, 82 KB brotli'd (3,244,706 → 3,425,541 bytes).
- **The QR code a camera reads.** The page's link carried the app's whole link, with every
  address the computer has (each docker bridge, each IPv6): a browser reaches the computer only
  through the relay, so the page's link now leaves them out (`pageLink`, `phone-page.ts`); the app's
  own link keeps them. In the spec, the page's link went from 1,354 characters (QR version 26,
  121×121 modules) to 882 (version 21, 101×101); in the unit test with 14 addresses, from 1,349 to
  868. What is left is mostly the closed network's voucher (its signer, nonce and signature, ~300
  characters before base64): a smaller code needs a denser encoding of the link, a format change.

Proved to fail when broken (`phone-browser.spec.ts`, which drives each on the real computer, the
audit naming the browser's device; `phone-page.test.ts`): the prompt not sent (caught at the new
agent's chat); Close calling Stop (the computer still had three terminals); a refusal taken as any
failure, and the gate's code misread in the wasm (no Pair again); Forget telling nobody (first
survived: `toBeHidden` waited out the notice, and the computer's list was read before it loaded;
now read at once, and through `window.hive.devices()`); a scanned code ignored (no "Pair with …?");
the page's link keeping the addresses (unit test and spec).

**Views, not done: a decision.** Android shows a community view in a WebView whose files come
from the computer through the phone (`views::file`), the view kept apart from the app. In a
browser the same isolation is a sandboxed iframe (no `allow-same-origin`), whose files would come
through the page's service worker. Tried in Chromium: a sandboxed iframe is not controlled by any
service worker, neither its navigation nor what it loads; both went to the network. So a view
cannot get its files from the wasm without an origin of its own. The options:

1. A second origin on the network's server (another host name or port, with its own
   certificate) serving only a view shell: a service worker there asks the page, by
   `postMessage`, for each file, and the page gets it with `views::file`. The view keeps its
   isolation; each server needs a second name and certificate. Recommended.
2. The page makes a view one document (scripts and styles inlined, assets as `data:` URLs) and
   loads it as the sandboxed frame's `srcdoc`: no second origin, but a view that loads files as it
   runs (`fetch`, a dynamic `import`) breaks.
3. No views in the browser; the phone apps show them.

**4. The terminal.** Not built in B4: B5 draws the core's own screen instead of a second emulator
in the page (§11.4).

## 11. B5: the phone is the desktop in your pocket (brief, 2026-10-12)

What the person sees and can do on the desktop's Layers panel, they see and can do on the phone,
with what needs them first. The browser app first; the phone apps follow the same design
(docs/design/phone-app-2026-10-02.md §6.2). Order: §11.1 to §11.6, each step with a test that fails
first (the test-audit gate, mutation-checked), a commit per section.

**What it replaces in B4.** The terminal (B4 item 4: watch and type, the key bar, the
keyboard-aware layout, the stream resuming after the tab sleeps) becomes §11.4, which draws the
core's own screen rather than a second emulator in the page. Views, left as a decision in B4 item
3, is §11.6, with option 1 taken (a sandboxed frame on an origin of its own). The iPhone findings
are taken in: an Allow that did nothing and a status left on "needs you" (§11.1), a question shown
as Allow/Deny (§11.1), and the reading list, tables, links, `dir=auto`, the composer's placeholder
(§11.5). B4 items 1 to 3 stand as committed.

**Data, decided.**
- Home is built from the view protocol's `structure` (`packages/view-host/src/structure.ts`, the
  one builder the window and a device's remote screen already share) plus `agent.since` changes,
  not the whole agent list on every change (spec/agents.md:19 today). Measured on the live canvas:
  42 tiles are 6.4 KB a list; state changes p99 11 a minute, at peak 33 in one second.
- The desktop owns order, pins and each row's last line, sent as fields on the row; the phone only
  groups and draws. The last line comes from the core's screen (alacritty), not a second parser.
- Sync: a snapshot with a sequence, then changes after it; on reconnect the phone asks `since` its
  last sequence; the host caps the replay (count and bytes) and answers "too far behind" with a
  fresh snapshot. No polling. Layout changes and terminal output in separate sequences.

**11.1 Answer what it actually asks** (first: the bugs the person hit).
- A question (AskUserQuestion, Elicitation) shows its question and options as buttons, never
  Allow/Deny. A permission shows the tool and the exact command or diff (the permission-detail
  design, spec/needs.md 0.7: coordinated with it, not duplicated).
- Typed-key answers get four guards, in the host, in the one function every answer goes through:
  each wait carries an id (a revision) and an answer names it, a stale one refused, so an old card
  cannot type into the next prompt; keys are sent only while the screen rules still say this wait
  is showing; one write lock per terminal; the answer goes only to the machine that owns the tile
  and is never replayed after a reconnect, and when it cannot be confirmed the phone says "Not
  confirmed: check the chat" and offers no retry.
- After an answer the status leaves "needs you" on the desktop and the phone, and the audit records
  the decision. Seen on "perm probe" (Claude 2.1.296, mode acceptEdits): Allow from one device was
  audited ok and did nothing for 90 s; a later answer from the iPhone left Claude at "Interrupted ·
  What should Claude do instead?" while the desktop and the phone still said it waited, 1,397 s
  on. First, probe the real binary: does `1` still allow in 2.1.296's chooser?
- Regression tests that fail on today's code: Allow on a fresh chooser lands; a second Allow with
  the old id is refused; the wait clears after the answer.
- Done (2026-10-12): the lost Allow was a race. Claude Code's `PermissionRequest` hook reports the
  wait before its chooser takes keys, and a fast tap's `1` arrived first, was lost, and was audited
  ok. A stand-in agent that draws its chooser 2 s after its hook shows it
  (`apps/desktop/tests/e2e/answer-lands.spec.ts`): before the fix `{answered: true}` with the
  chooser still asking. Now, for an agent whose screen rules read its waits, the keys go in once
  the screen shows the chooser (4 s at most, else `TIMEOUT`, nothing typed), and it is answered
  once the screen moves on (3 s, else `TIMEOUT`, not confirmed: the keys went in, so that wait is
  never typed again);
  spec/needs.md 0.8. Open: the wait still listed after "Interrupted" is not reproduced by the
  stand-in (an early key, then Esc on the chooser, clears it); it needs that tile's status and
  screen.

*Done (2026-10-12):*
- The probe. `1` allows on Claude 2.1.296's chooser, with its kitty keyboard on and off (a pty
  driven by hand), and from the paired page on the real binary three times: default mode with an
  ask rule, started from the page, and acceptEdits through `hive ctl spawn`. Each time the command
  ran and the wait cleared. The person's own log agrees: an Allow from their phone at 19:07 on
  another Claude tile ran its command. The 18:52 Allow that did nothing is not reproduced, and
  nothing kept says what the screen showed then; the guards below are what stops a key going into
  a screen that is not the wait.
- The status left on "needs you": the answers typed their keys into the terminal around the
  agent's status (the desktop's and the headless host's `answers()` wiring wrote straight to the
  session), so only a later hook could end the wait, and a Deny (Esc) fires none. Seen on the real
  binary: denied from the page, the card was still there a minute later with Claude at its prompt.
  Now the control plane has one way to type as the person (`ControlPlane.typed`), which a window's
  keys, a phone's answer and a phone's Stop all go through, and `answers()` is given the plane
  rather than a write. Denied again on the real binary: the card goes at once, the agent
  `interrupted`; allowed, it ran and finished.
- The guards, in `answers()` and the plane: a wait's `since` is its id and now strictly increases
  per session (two waits within a millisecond were one id); keys are not typed while the screen,
  read since the wait began, shows the agent's prompt or another screen (a screen the rules cannot
  place reads as working and does not stop it, so an unrecognised chooser can still be answered);
  an answer of several keys holds the terminal until its last key is in, another answer refused
  and a program's write queued behind it; the page sends an answer once, waits 10 s for the
  computer to say, and else says "Not confirmed: check the chat." with no buttons for that wait.
- The audit: `detail` is `allow`, `deny`, `choice <n>` or `reply` (never a reply's words), `, not
  answered` when it did not land.
- The question and the permission detail. Hook events carry none of the agent's words, so what a
  wait is about comes from its session file: the tool use it waits on is the first since it last
  said anything that nothing was given back for, read from the last 256 KB, its `about` whole (to
  4000 characters). The manifest's transcript maps a tool's questions (`asks`), so nothing about
  AskUserQuestion is in the host. Claude 2.1.296's chooser for AskUserQuestion also fires the
  PermissionRequest hook ("Waiting for permission…"), so a wait whose tool asks questions is a
  `question` whatever its hooks say, and Allow (`1`) would have chosen the first option. A
  question is never decided; for one question with one answer, and a manifest that says the keys
  that choose (`choose: ['{n}']`, read from 2.1.296: a digit chooses and sends), `{choice: n}`
  types them. Several questions, or several answers, take a reply, the options listed above it.
  The page: question text and one button per option; a permission's tool and its command, whole,
  in mono above Deny/Allow. Proven in `phone-browser.spec.ts` with the talker stand-in, which
  writes Claude's records for `ask` and `run`. Found on the way: an answer's single key (`2`) was
  taken by the mailbox for the person's unsent draft on an agent that reports no turns, holding
  the next message; an answer's keys are now never a draft. Claude's catalog manifest needs the
  same `asks` and `choose` (hivemind-plugins, `agents/claude/agent.yaml`).
- Proved to fail: the status not told (answers test 11), the screen check dropped or loosened (13,
  twice), the hold dropped or not queueing (12, twice), the audit detail dropped (11), `since` not
  strictly increasing (status-store), and the page retrying an unconfirmed answer (phone-browser
  spec:154).

**11.1b Answering through the agent's own hook (designed 2026-10-12).** The person chose it after
the late-reading fix: an agent whose `PermissionRequest` hook can carry the decision is answered
there, as hapi does (`localPermissionProtocol.ts`, `startHookServer.ts`), and typed keys stay the
way for every other agent. Nothing waits on a screen reading, and nothing is typed into a chooser
that may not be drawn yet.

What the real binaries do (probed 2026-10-12, a pty driven by hand, own HOME):

| | Claude Code 2.1.296 | Codex 0.160.1 and 0.162.1 |
|---|---|---|
| Hook vs. its own prompt | chooser drawn 0.2 s after the hook starts; they race | prompt drawn only after the hook returns; held, the screen says "Running hook" |
| `allow` printed | tool ran 0.9 to 1.3 s later (after 30 s and 200 s held) | ran |
| `deny` + `message` | 0.8 s, the message reaches the model | "Blocked by hook", the message reaches the model |
| AskUserQuestion | `allow` + `updatedInput.answers` (by question text) answered it in 0.5 s | — |
| Nothing printed | its own chooser decides | its own prompt is drawn then, `y` allows |
| Answered at its own prompt first | the tool ran; the hook is not closed (alive 60 s later), a later decision is ignored | Esc ends the turn; the hook is not closed, a later decision is ignored |
| Payload | `tool_name`, `tool_input`, `agent_id` for a subagent; no `tool_use_id` | `tool_name`, `tool_input`, `turn_id`; no `tool_use_id` |

Codex's wire (`PermissionRequestDecisionWire`: `behavior`, `message`, `updatedInput`,
`updatedPermissions`, `interrupt`) is Claude's. But a held Codex hook hides its own prompt, so the
person at the desktop could only press Esc, and updating Codex does not change it (0.162.1, the
latest release, the same). So Codex stays on typed keys; the manifest can turn it on when that
changes. The design:

- **Declared by the manifest, no agent in the host.** The `emit: input.requested` entry of the
  event that asks gains `answer:` (manifest 2 stays: an app before this ignores the key and only
  reports the event, so it answers with keys as before):
  ```yaml
  PermissionRequest:
    emit: input.requested
    kind: permission
    timeout: 3600
    answer:
      allow: {hookSpecificOutput: {hookEventName: PermissionRequest, decision: {behavior: allow}}}
      deny: {hookSpecificOutput: {hookEventName: PermissionRequest, decision: {behavior: deny, message: '{message}'}}}
      choose: {hookSpecificOutput: {hookEventName: PermissionRequest, decision: {behavior: allow, updatedInput: '{input}'}}}
      asks: {list: questions, question: question, options: options, label: label}
      chosen: answers
      leave: [ExitPlanMode]
  ```
  What the hook prints is one of these, filled: `{message}` is the reason the person gave (the key
  goes when they gave none), `{input}` the tool's input with the chosen option's label, or the
  line typed, set at `chosen`, keyed by its question's text as `asks` reads it from the input.
  `leave` are tools left to the agent's own prompt (a plan is reviewed by its own hook). A subagent's
  request (`agent_id`) is always left to it: the wait on the person is the main agent's.
- **Held until an answer, or until the agent stops waiting.** The generic event script, told by
  its entry (`HIVE_EVENT_ANSWER=1`), sends the `agent.event` as always, then
  `agent.await_answer` on the same connection, and prints what comes back. The host holds it as a
  wait (`waits.ts`, beside the plan and the supervised tool use) named by the status the event just
  set: same tile, same `since`. The phone lists it as it lists that status today.
- **The host resolves it.** `agent.answer` finds the held wait first. `{decision}` on a permission
  prints `allow` or `deny`; `{text}` on a permission denies with the line as `message` (Claude's
  "tell Claude what to do differently"); `{choice: n}` on a question prints `choose` with option
  `n`; `{text}` on a question prints `choose` with the line. A question is never allowed or denied,
  and one with several questions or several answers is still answered by a line. It answers
  `{answered: true}` once the hook has it: the agent's own prompt may still have won (Claude settles
  the race), and the status says which.
- **The desktop's own prompt wins the race.** Claude does not close the hook when its chooser is
  answered, so the host lets go of it: the wait lasts while the agent's status waits with that
  `since`, and ends, the hook printing nothing, when it does not (a key typed at its chooser sets it
  working, Esc or Ctrl+C ends the turn, `PostToolUse` or `PermissionDenied` resolves it), or the
  hook's connection closes, or the tile goes. An answer after that is `{answered: false}`. Holding
  the hook changes nothing on the screen: its chooser is drawn and answered as before.
- **Where no desktop answers** (a machine with a daemon and no control plane): `agent.await_answer`
  is refused at once, the hook prints nothing, and the agent's own prompt decides.
- **Memory.** One held hook per waiting tile: 26 MB PSS measured with the app running (67 to 71 MB
  standalone; the script is run by the app's binary as node). Three tiles waiting at once, about
  80 MB.
- **Not in it.** `always` (`updatedPermissions`): typed keys never had it either. A tool use
  matched to its `PostToolUse` by id (hapi keys by `tool_use_id` through `PreToolUse`): a parallel
  tool that finishes while another waits sets the status working and so lets go of the hook; the
  person then answers at the desktop, as with typed keys today.

**11.2 Home mirrors the Layers panel.** The same tree, names and order as the desktop: machines,
then projects (the panel's groupings), then tiles, agents first; frames as the desktop names them.
"Needs you" on top (permission, question, plan), then Working, then the rest; it folds the Needs
tab into Home. Pinned first; search; machine chips when there is more than one machine. Each row:
state, name, last line (what it said, or the exact command or question it waits on). Budget: a
200-tile canvas opens Home in under 500 ms at 4× CPU throttle, and one change redraws one row.

*Design (2026-10-12).* Three facts the brief assumed otherwise: `structure` has no sequence (the
device host re-sends it whole when it changes, `packages/host/src/views.ts`); the core's screen is
the daemon's headless xterm (`viewport()`, read by `ScreenWatcher` for status), alacritty is the
phone's own terminal; and pins are the person's, kept per workspace on the computer (the Layers
panel's personal layout), not in the document.
- **One feed, two sequences** (`packages/host/src/home.ts`, spec/home.md). Rows are workspaces,
  frames and tiles, keyed by workspace and id. A frame and a tile row are what the one builder,
  `boardStructure` (the one `views.ts` uses for `structure`), makes of them, plus each frame's
  board order and project. A tile row adds what the agent list says of an agent (state, since,
  its wait with `tool`, `asks`, `choose`, program, machine, interrupt, conversation), so the page
  follows Home alone, and the desktop's `order` and `pinned`: the Layers panel sends what it lists
  (`layers:shown`, pinned first, then each frame's tiles and what they started) for each
  workspace it shows, as the person set it up. The *layout* sequence numbers each row that
  changed or went; the *lines* sequence numbers each tile's last line. The feed works rows out
  at most every 250 ms, the first change at once, and tells only rows that changed: a status
  change is one row.
- **Sync.** The phone follows the `home` stream on its device link: `{t:"follow", layout?, lines?}`.
  Given positions the host still keeps, it answers the changes after them; else, or given none,
  a snapshot with both positions. The host keeps 2000 changes and 256 KB per sequence; past that
  a follower is too far behind and gets a snapshot. No polling: each change goes out as it is
  worked out, at most ten answers a second, as the `agents` stream does.
- **The last line.** An agent with a conversation: what it last said (`lastSaid`, the tail of its
  transcript, re-read only when the file grew), or the tool it last used and what about. Real
  Claude at rest shows a statusline, rules, its prompt and a footer below its reply, so its
  screen says nothing useful. Anything else: the daemon's `ScreenWatcher`, which already reads a
  session's screen after it prints, reports the last line with text (`tile.line`), at most 160
  characters, as it changes. A row that waits shows its wait instead: the command or file, or the
  question.
- **The phone groups and draws** (`crates/hive-phone/src/home.rs`, wasm `Host.home`). Machines
  (the frame's machine, else the computer), then projects (the frame's project, the workspace's
  own first), then frames, then tiles, agents first, each list in the desktop's `order`, pinned
  on top and only there. Above the tree: Needs you (the cards that answer, folding the Needs tab
  in), then Working. A search box filters by name and agent; machine chips show when there is
  more than one. The Agents tab goes: the tree is the list. The page keeps what it held and
  follows on from its positions after a reload.

*Done (2026-10-12):*
- The computer: `home` stream on the device link (`PeerLinks.followHome`, owner's devices only),
  `HomeFeed` over two `KeyedFeed`s, rows from `boardStructure` plus the agent list plus what the
  Layers panel lists (`layers:shown`). Last lines: `LastSaid` (transcript) else the daemon's
  `tile.line`. `spec/home.md` 0.1, `conformance/home.json` (computer and phone cases).
- The phone: `crates/hive-phone/src/home.rs` holds and groups (wasm `HomeView`, `Host.home`); the
  page's Home screen replaces the Needs you and Agents tabs and keeps what it held, to follow on
  from its positions.
- Budget, `phone-page.spec.ts`: 200 tiles taken in whole, grouped and drawn to the next frame in
  374 ms at 4x CPU throttle (500 ms budget); a new last line redraws that tile's row in each list
  it is in, an answered wait removes one card, redraws one row and adds one to Working, nothing
  else moves.
- Found on the way: Home asked for an agent's transcript before its session was tracked and kept
  the miss for 5 s, and nothing asked again; a miss is no longer kept.
- Not done: a Working list as long as the board when most agents work (it repeats the tree's rows);
  folding a frame; tapping a terminal row (§11.4 gives it the terminal).

**11.3 Start an agent.** New agent on Home and inside a project: machine, folder, the agents
installed there, model and permission mode as the desktop offers them, a prompt (photos
attachable). Folders: the machine's known projects and recent folders, plus a listing scoped inside
a known project (directories only, capped); no browsing the whole disk. Close and stop from the
row.

**11.4 The terminal, one tap from the chat.** The chat stays the default. Draw the core's screen
(`crates/hive-phone/src/screen.rs`) in the browser. Never resize the phone's emulator locally:
render at the PTY's columns and scale or pan to fit; an explicit "Fit to phone" resizes the real
PTY and restores it when the phone leaves. A late join gets a snapshot of the rendered screen, not
a byte tail; output is flow-controlled by acknowledgements, and on overflow a replacing snapshot is
sent instead of queued bytes. Key bar: Esc, Tab, arrows, Ctrl-C.

**11.5 Reading.** Markdown tables, tappable https links (`javascript:` stays inert), `dir=auto`
paragraphs, images in the conversation, tool calls that unfold to their full input and output.

**11.6 Views and widgets.** A view switcher as on the desktop: the installed views that declare
phone support (P8: the view protocol's `surfaces`, the workspace API's `view.*`). The browser's
view host is a sandboxed iframe on its own origin under the view's CSP. Widgets through the same
plugin contract (`widget.drawn`, `widget.press`); no widget gets a code path of its own.

Out of scope, a separate B6 design: answering from the notification itself (end-to-end encrypted
Web Push with Allow and Deny actions; on an iPhone only once the page is on the Home Screen).
