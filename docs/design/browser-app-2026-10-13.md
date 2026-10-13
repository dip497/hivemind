# The app in a browser (2026-10-13)

Status: proposed. Branch `feat/browser-app`.

**Verdict.** The running app's main process serves the built renderer and one WebSocket on
127.0.0.1. The socket carries the window's own IPC contract, channel for channel: the browser's
`window.hive` is the preload's, made over the socket instead of `ipcRenderer`. Main answers it
from the same handler table its windows use, so nothing about a call can differ but the
transport. The dev-bridge, a second host that drifted, is deleted and the harness runs on this.

## 1. Problem

**Goal.** The person opens the whole app (canvas, terminals, agents, git, issues) in a browser
tab, and it behaves as a window of the app: same build, same host, realtime.

**Hard constraints (the maintainer's).**

1. One host. Main serves `out/renderer` and one WebSocket with the IPC contract (calls, events,
   terminal streams). No browser-only UI logic. The dev-bridge goes, with `dev:bridge`.
2. The port is remote control of the person's terminals. 127.0.0.1 only, off until turned on in
   Settings → Your devices, a random token per launch carried in the URL's fragment and traded for an
   HttpOnly SameSite=Strict cookie, checked on every request and on the upgrade; Host and Origin
   checked against DNS rebinding; constant-time compares. Other devices reach it only through the
   person's Tailscale (`tailscale serve`) or hive-net serve, never a 0.0.0.0 bind.
3. Local-only calls (R8: folder picker, open in app, window, updates, clipboard, browser tiles)
   are hidden or have a browser path. No crash, no dead button.
4. Lag free: terminal output paced by the phone's ack window; echo latency measured in the tab
   and in the window, p50 and p95.

**What is there today (read, not assumed).**

| Fact | Where | Number |
|---|---|---|
| Every channel main listens on is registered through one module | `apps/desktop/src/main/app-ipc.ts` (`handle`, `on`, `answer`, `handleEffect`) | 92 `handle`, 6 `on`, 10 `answer` (sync) channels |
| The window's `window.hive` is one object over `ipcRenderer` | `apps/desktop/src/preload/index.ts` | ~150 members |
| Handlers that read who called (`e.sender`) | `workspace-ipc.ts:41,45`, `workspace-store-ipc.ts:63`, `index.ts:499,545,790,792`, `tool-packages.ts:162`, `widgets.ts:20`, `view-packages.ts:198` | 10 sites |
| Pushes to every window | `windows.ts:broadcast`, plus two loops of their own (`widgets.ts:14`, `tool-packages.ts:84`) | 3 paths |
| Sync calls | `settings:get-sync` and the store's nine `workspace:*-sync` | 10 |
| A stream client's store | `StoreReplica` (`packages/workspace-api/src/store-replica.ts`), R8 step 4 | in use by the dev-bridge page |
| Ack pacing | `terminal.open {acks}` + `terminal.ack(tile, taken)`, window `PACED_WINDOW` = 128 KiB (`packages/agent-host/src/session-relay.ts:35`) | used by the phone (`crates/hive-phone/src/workspace.rs:229,332`) |
| Non-JSON values in the contract | `viewSharePrepare(png: ArrayBuffer)` only (`shared/ipc.ts:603`) | 1 |
| App keys main takes before xterm | `index.ts:332-380` `before-input-event`, `main/shortcuts.ts` | 10 actions |
| Cost on main of one 16 KiB output batch to one client | `JSON.stringify`, measured on this machine (Node 22.18, 16 cores) | 80 µs |
| Cost of one token check (two SHA-256 + `timingSafeEqual`) | measured | 8.7 µs |

**Which known problem.** A local web IDE: a single-user server on loopback whose bearer token is
remote code execution, reached by a browser (VS Code `serve-web`, Jupyter, code-server, Theia).
Underneath it is an RPC relay with server push and a flow-controlled byte stream.

## 2. What others do

Each line read in the source at the tag named; details in §9.

- **VS Code `serve-web`** (vscode@1.141.0): a UUID connection token, `?tkn=` traded at `/` for a
  `vscode-tkn` cookie and a 302 that drops it from the URL; every HTTP request needs it; the
  socket upgrades with no Origin or Host check and checks the token in its first message. Its
  compare is `===`, its cookie SameSite=Lax with no HttpOnly. Teaches: one workbench, two
  transports; a first-frame token on the socket; and what to tighten (cookie flags, compare).
- **Jupyter Server** (v2.21.1): 192-bit token, traded for an HttpOnly login cookie; a Host
  allow-list (loopback plus `local_hostnames`) against DNS rebinding; websocket Origin must equal
  Host, but a missing Origin passes and a token request skips the Origin check. Teaches: the Host
  check, and not to let the token bypass Origin.
- **code-server** (v4.141.0): constant-time compares (`safe-compare`), rate-limited login; Origin's
  host must equal Host (from `Forwarded`, `X-Forwarded-Host`, `Host`) on the upgrade; cookie Lax,
  no HttpOnly. Teaches: Origin == Host is the upgrade rule, and it passes through a reverse proxy.
- **Theia** (v1.76.0): an Origin check on every upgrade, and a `theia-connection-token` cookie
  (HttpOnly, Strict, `timingSafeEqual`) handed to anyone who loads the page: cross-site
  protection, not authentication. Teaches what not to copy: a loopback port whose cookie is free.
- **`tailscale serve`** (v1.104.1) keeps the browser's Host (`<machine>.<tailnet>.ts.net`) and adds
  `X-Forwarded-Proto: https`; Origin passes through. So Origin == Host holds behind it, and the
  person adds the tailnet name to the Host allow-list once.

Where this design is stricter than all four: the token never reaches the server in a URL (the
fragment is posted, then dropped with `history.replaceState`); a missing Origin is refused on a
POST and on the upgrade; the cookie is HttpOnly and Strict; and the socket needs the token in its
first frame as well as the cookie (§5.2).

## 3. Every side

| View | Worry | Answer here |
|---|---|---|
| Person | A tab that lags or drops keys; a button that does nothing in the tab | Same relay, same coalescing, ack pacing; local-only calls absent from `window.hive`, and the renderer hides what is absent |
| Data | Two writers (window and tab) on one layout | Already solved by R5: each is a connection, the store merges, `store.changed` tells the others. The tab holds a `StoreReplica`, as the spec says a stream client does |
| Operator at 3am | Port busy, token lost, app restarted | Settings shows the URL or the bind error; a restart mints a new token, the tab's socket closes and it shows the 401 page, which asks for the new link |
| Security | Another local user, a web page, DNS rebinding, a leaked link | §6 |
| Cost | Main's one thread serving tabs | §4 scale table: fine to 10 tabs, a known ceiling at 100 |
| Next year | `hive host` serving the app headless; phone layout in the tab; a guest (not the person) in a tab | The gate and socket server are Electron-free modules; a guest needs roles on channels, which today are all the person's (§8) |

## 4. Options

### A. Keep a second host (the dev-bridge, made proper)

```
browser ──HTTP/SSE──▶ dev-bridge (tsx) ──▶ own store, own daemon, own domains
```

The boring one, and the one that failed: it answered from its own store and daemon, so it
answered differently (no agents, no plugins, fake settings) and went stale. Breaks at the first
channel it forgets. Out by constraint 1.

### B. Main serves the renderer; the socket carries the IPC channels (chosen)

```
tab ── HTTPS (tailscale serve) or http://127.0.0.1 ──▶ main
         GET /…           static out/renderer, cookie checked
         WS /socket       {id, ch, args} → {id, ok, value|error}     (invoke)
                          {ch, args}                                  (send)
                          ◀ {ch, args}                                (events, broadcast)
main: app-ipc's table ─▶ the same handler the window's ipcRenderer.invoke reaches
```

The preload's `window.hive` becomes `hiveOverIpc(port)`, where `port` is `{invoke, send, on}`:
Electron's `ipcRenderer` in the window, the socket in the tab. Sync channels are the one thing a
socket cannot carry: the store's go to a `StoreReplica` (spec, R8 step 4) and settings are read
once before the renderer boots and then kept by `settings:changed`. First break: main's thread
at many tabs times heavy output (scale table).

### C. The tab speaks only the workspace API

```
tab ──WS──▶ main: WorkspaceServer (spec/workspace-api.md) only
```

Cleanest protocol (the phone and peers already speak it), but the 100-odd machine channels
(settings, plugins, devices, machines, views) are not in the API. Each would first become a
method with a spec entry, roles and tests: weeks, and the tab is useless until the last one
lands. It is where B can go channel by channel, not where to start.

### D. The tab reaches the app over hive-net (iroh in wasm), as the phone page does

```
tab ──iroh/wasm──▶ person's relay ──▶ app's daemon ──▶ main
```

No port at all, works from anywhere without Tailscale. But the full renderer over a relay adds a
relay round trip to every keystroke, and still needs B's channel mapping on top. It is the
transport the phone page chose for a phone-sized UI, not the first one for the full app.

### Scale

Load: one busy terminal at 1 MiB/s (a build log), every tab showing it. Limit: main's one thread.

| Design | 1 tab (today) | 10 tabs | 100 tabs |
|---|---|---|---|
| A | n/a: wrong answers, not slow | n/a | n/a |
| B | 64 batches/s × 80 µs = 5 ms/s, 0.5 % of main: holds | 51 ms/s, 5 %: holds | 512 ms/s, 51 % of main: breaks (keystroke echo queues behind it) |
| C | as B | as B | as B, same serialisation per connection |
| D | + one relay round trip per echo (B0 measured it, phone doc §9) | relay bandwidth × 10 | relay bandwidth × 100 |

Arithmetic: 1 MiB/s ÷ 16 KiB batches = 64 batches/s; each costs 80 µs of `JSON.stringify` per
client (measured above), so 64 × 80 µs = 5.1 ms per second per tab. Ack pacing caps what is in
flight at 128 KiB per tab per terminal (`PACED_WINDOW`), so memory is 100 × 128 KiB = 12.5 MiB
at 100 tabs, not the limit. Token checks are per request, 8.7 µs: not the limit either.

**Ceiling (written, not built):** at ~50 tabs on one busy terminal, serialise each batch once and
send the same frame to every tab. Nobody needs 50 tabs on one machine today.

## 5. Choice

**B.** It is the only design that satisfies "one host, same contract" today, and it makes the
contract itself the test: the harness specs run in the tab against the real main.

Why the others lost: A is the failure being removed. C is the right destination for channels a
peer needs, and B moves there one channel at a time without blocking. D is a second transport for
a different product (the phone page) and costs a relay round trip per keystroke.

**What was surprising, and changes the design:**

1. **Local-only is a property of a channel's registration, not of the UI.** Every channel is
   registered in `app-ipc.ts`; a local-only one is registered with `local` and is never served on
   the socket. The socket's hello lists what it serves, `hiveOverIpc` leaves out any member whose
   channel is not served, and `HiveApi` types those members optional. The compiler then lists
   every call site of a local-only call (about 40), each of which hides its control or takes the
   browser path. One fact, one owner; no `isBrowser` anywhere in the renderer.
2. **Cookies are not port-scoped** (RFC 6265 §8.5). Any other web server on 127.0.0.1, on any
   port, is sent this cookie when the browser visits it, and so is another local user's. A cookie
   alone would let such a server replay it. So the cookie gates every request and the upgrade, as
   asked, and the socket's first frame must also carry the token, which the page keeps in
   origin-scoped `localStorage` (port-scoped, never sent by the browser on its own; kept so a reload
   or a second tab signs in again, cleared when the socket says the token is not this launch's). A cookie
   that leaks to another port opens static files only. The cookie's name carries the port, so two
   apps on one host (the dev app and the installed one) do not overwrite each other.
3. **The 401 body is the sign-in page.** Every request without the cookie gets 401; for `GET /`
   the 401's body is a few lines that read the fragment, post it, store it, and drop it from the
   address bar (`history.replaceState`). So "without the token it gets nothing" holds for every
   path, `/` included, and the token is never in history, logs or a Referer.
4. **The app's keys need no copy.** Main takes ten app keys before xterm sees them. The table
   moves to `shared/` and the tab applies it in a capture-phase key listener that raises the same
   `menu:*` events the window gets: one table, two places that read keys.
5. **Sync calls need no new mechanism.** The store's are the `StoreReplica` the spec already
   prescribes for a stream; settings are the one other sync read, made once before boot.

## 6. Security

| Threat | Defence | Checked by |
|---|---|---|
| Another machine on the LAN | Bind 127.0.0.1 only; other devices through `tailscale serve` (TLS, tailnet ACLs) or hive-net serve | unit: server address is 127.0.0.1 |
| A web page the person visits (CSRF, cross-site WS) | SameSite=Strict cookie (not sent cross-site); Origin must be the page's own (`http(s)://<Host>`) on every POST and the upgrade; `frame-ancestors 'none'` | unit: wrong Origin → 403, upgrade refused |
| DNS rebinding (`evil.example` → 127.0.0.1) | Host must be `127.0.0.1`, `localhost` or a name the person configured; anything else → 403 | unit: foreign Host → 403 |
| Another local user, or a server on another local port | 256-bit token per launch; cookie and the socket's first-frame token (port-scoped storage), §5.2 | unit: cookie without frame token → socket closed |
| Guessing | 256 bits; compare by SHA-256 then `timingSafeEqual` (equal length, constant time) | unit |
| Link in history, logs, Referer | token only in the fragment; stripped on arrival; `Referrer-Policy: no-referrer` | e2e reads `location.href` after sign-in |
| Path traversal | resolved path must stay under `out/renderer` (`path.relative`, not `startsWith`) | unit |
| Forgotten open port | off by default; the switch and the URL are on one panel; a restart invalidates every link | Settings toggle test |
| The tab calling what only the machine should | local-only channels are not served (§5.1); everything else is the person's, as in a window (the phone doc's rule: a browser of the person's is the person) | unit: local channel → refused |

Behind `tailscale serve` the Host and Origin are the tailnet name: the person adds it under
"Names" next to the switch. TLS there is Tailscale's.

## 7. Pre-mortem (a year on, it failed)

1. **A channel behaved differently in the tab.** JSON is not structured clone: an `ArrayBuffer`,
   a `Date` or a `Map` arrives changed. Today one channel carries one (`viewSharePrepare`, the
   share sheet, which is local-only). Change: the socket refuses to send a value JSON would change
   (a check on the way out, in the server, failing loudly in development), and the harness runs
   the canvas, terminal, git and issue specs in the tab, so drift shows as a red spec.
2. **The tab lagged.** Echo waited behind output for other tabs, or the socket buffered without
   bound on a slow link. Change: output to the tab is ack-paced (128 KiB window, screen in place
   of what it missed, as the phone); echo skips batching (`markInput`) as in the window; the
   latency of both is measured and kept in this doc. Ceiling: §4, ~50 tabs on one busy terminal.
3. **Someone else drove the person's terminals.** A leaked link, a forgotten switch, a local
   server replaying the cookie. Change: per-launch token, off by default, first-frame token in
   port-scoped storage, Host and Origin checks, and the panel shows when it is on. Known ceiling:
   anyone who can read the app's window (or its settings panel) has the link: the boundary is the
   OS user, as R7 says for tile tokens.

## 8. Build order

Each step is a commit with a test that fails first (test-audit gate, mutation noted).

1. **The gate and the server** (`main/browser-gate.ts`, `main/browser-server.ts`, Electron-free):
   static files, sign-in, cookie, Host and Origin, upgrade, first-frame token, dispatch to a
   channel table. Unit: no cookie → 401 with the sign-in page; foreign Host → 403; wrong Origin
   → 403 and no upgrade; right token → cookie HttpOnly SameSite=Strict, then the page; socket
   without the frame token → closed; a channel not served → refused.
2. **One handler table** (`app-ipc.ts`): `handle`/`on` record each channel; `local` ones are
   Electron-only; a handler's caller is a `Client` (a window's `WebContents` or a tab), so the
   10 `e.sender` sites are typed for both. `broadcast` reaches tabs; the two private loops use it.
3. **The transport adapter**: `shared/hive-ipc.ts` (`hiveOverIpc(port)`), the preload made from
   it, and `src/browser/` (the socket port, the replica, settings before boot, ack pacing,
   reconnect). Unit: the adapter over the real server in Node: a call answers, an event arrives,
   a terminal's output is acked cumulatively, an unserved channel's member is absent.
4. **Settings → Your devices, "In a browser on this computer"**: switch, port, names, the URL with a copy button,
   the bind error. Setting `browserApp: {enabled, port, names}`; main starts and stops the server
   as it changes.
5. **Local-only calls in the tab**: `HiveApi` members optional; each site hides or takes the
   browser path (a typed folder path for the picker, `navigator.clipboard`, `window.open` for a
   new window, no update or browser-tile controls). App keys from the shared table.
6. **The harness moved**: `tests/e2e/helpers/window.ts` launches the app, turns the setting on as
   a person would, and opens Chromium on the URL; `terminal-io.spec.ts` and the rest of the
   harness list run there. Then `src/dev-bridge` and `dev:bridge` are deleted, with the docs that
   name them.
7. **The e2e spec** `browser-app.spec.ts`: setting on, Chromium opens the URL, sees the canvas,
   starts a shell tile, types, reads the echo; without the token it gets 401 and no canvas.
8. **Latency**: echo p50/p95 in the tab and in the window on one machine, recorded here.
9. **Plugins in the tab** (§11): the app's schemes as paths on the same server, one handler each
   for windows and tabs; views in sandboxed frames behind a key; tool plugins' host modules by
   import map. Unit: each path's gate; e2e: a note and a plugin widget pressed in the tab, the
   Windows view and a widget view shown there, a view that cannot read the cookie or open the
   socket.

## 9. Prior art (source)

| Project | Mechanism | Source |
|---|---|---|
| VS Code | token: UUID, file mode 0600, `[0-9A-Za-z_-]` | `microsoft/vscode@1.141.0/src/vs/server/node/serverConnectionToken.ts:110,114,15` |
| VS Code | compare is `===` | `serverConnectionToken.ts:38` |
| VS Code | names `tkn` (query), `vscode-tkn` (cookie) | `src/vs/base/common/network.ts:192-193` |
| VS Code | every HTTP request but `/version`, `/delay-shutdown` needs it, else 403 | `src/vs/server/node/remoteExtensionHostAgentServer.ts:157`; `serverConnectionToken.ts:122-131` |
| VS Code | `?tkn=` → Set-Cookie (Lax, a week, no HttpOnly or Secure) + 302 without it | `src/vs/server/node/webClientServer.ts:313-334,489-496` |
| VS Code | upgrade unchecked; token in first message `msg1.auth` | `src/server-main.ts:99`; `remoteExtensionHostAgentServer.ts:201-236,308` |
| VS Code | binds `localhost` | `src/server-main.ts:113` |
| Jupyter | token `hexlify(os.urandom(24))` | `jupyter-server/jupyter_server@v2.21.1/jupyter_server/auth/identity.py:224` |
| Jupyter | `?token=` / `Authorization: token`, compared `==` | `identity.py:476-479,497` |
| Jupyter | token → login cookie (HttpOnly; Secure over HTTPS) | `identity.py:270-279,386-400` |
| Jupyter | Host allow-list against DNS rebinding | `jupyter_server/base/handlers.py:556-596,603-605`; `serverapp.py:1352-1370` |
| Jupyter | websocket Origin == Host; missing Origin passes; token skips it | `jupyter_server/base/websocket.py:44-84`; `identity.py:533-542` |
| code-server | constant-time compare | `coder/code-server@v4.141.0/src/node/util.ts:134,236,285` |
| code-server | login rate limit 2/min, 12/h | `src/node/routes/login.ts:12-14,96` |
| code-server | cookie `{domain, path, sameSite: "lax"}` | `src/node/http.ts:320-323` |
| code-server | Origin host == Host (Forwarded, X-Forwarded-Host, Host) | `src/node/http.ts:376-408,414-438`; `src/node/routes/vscode.ts:245` |
| Theia | Origin check on every upgrade (`THEIA_HOSTS` or Origin == Host) | `eclipse-theia/theia@v1.76.0/packages/core/src/node/hosting/ws-origin-validator.ts:28-54`; `messaging/websocket-endpoint.ts:52-55` |
| Theia | `theia-connection-token` cookie, HttpOnly Strict, given on any request, `timingSafeEqual` on upgrade | `packages/core/src/node/hosting/browser-connection-token.ts:31,103-114,140-144,164-168,179-181` |
| tailscale | proxy keeps `Host` for TCP targets | `tailscale/tailscale@v1.104.1/ipn/ipnlocal/serve.go:992-996` |
| tailscale | adds `X-Forwarded-Host`, `X-Forwarded-Proto: https`, `X-Forwarded-For` | `serve.go:1088-1095` |
| tailscale | strips inbound `Tailscale-User-*`, sets them from WhoIs | `serve.go:1098-1126` |

Not used: `Tailscale-User-*` as identity. Any local process can reach 127.0.0.1 and forge them;
only a connection proven to come from tailscaled could trust them.

## 10. Unknown

- Whether Safari's CSP treats `connect-src 'self'` as allowing `ws:` to the same host (Chromium
  and Firefox do). Check: open the tab in Safari behind `tailscale serve`.
- `platform` in the tab is the host's (paths, shells); keyboard labels follow it, which is wrong
  for a Mac browsing a Linux host. Check: the key hints in a tab from another OS.
- hive-net serve does not proxy a local port today; until it does, other devices reach the tab
  through Tailscale only.

## 11. Plugins in the tab

Notes, checklists and every widget, the Windows view and the Issues tile are plugins, so a tab
without the app's schemes is not the app. What the window reaches by scheme:

| Scheme | What | Loaded by | In the tab |
|---|---|---|---|
| `hm-view://<host>/…` | a view's files | a sandboxed frame (`allow-scripts`, no `allow-same-origin`) | `/hm-view/<key>/<host>/…` |
| `hm-plugin://<id>/…`, `hm-plugin://host/<m>.js` | a tool plugin's module; the app's React and kits it imports | the page itself (`import()`) | `/hm-plugin/<id>/…` |
| `hm-media://v/…`, `hivemedia://media/…` | wallpapers and the person's media | the page itself (`<img>`, `<video>`) | `/hm-media/…`, `/hivemedia/…` |

Widgets need none: their code runs in a worker made from a `blob:` URL and comes over a channel
(`widgets:list`), their images as `data:` URLs.

**One handler per scheme.** Each is a function from a `Request` to a `Response` already; main
registers it once (`main/schemes.ts`), for Electron's protocol and for the browser server, which
turns `/<scheme>/<host>/<path>` back into `<scheme>://<host>/<path>` and calls it. Nothing is
served twice or differently: a view's CSP, a tool's switch, a wallpaper's folder are the
handler's.

**Who may ask.** Measured in Chromium 1223 against a test server (probe kept out of the repo):

| Request | Cookie sent | `Sec-Fetch-Site` |
|---|---|---|
| the frame's own document (`<iframe src>` from the page) | yes | same-origin |
| a module script or image the sandboxed frame loads | **no** | cross-site |
| `document.cookie` inside the frame | throws `SecurityError` | — |

And inside such a frame, under a view's policy (`pluginCsp`) served over http from this server:
its `'self'` covers its own files (its module and the SDK through a relative import map ran),
while `new WebSocket` to the socket and `fetch("/")` are blocked as `connect-src` violations.

So a view's files cannot be gated by the cookie: its own requests come from an opaque origin and
carry none. They are gated by a **views key**, HMAC-SHA256 of the launch token over `hm-view`,
in the path. The tab is told it in `hello`, after the socket's token check; the server compares
it in constant time. The key opens view files only: not the page, not `/session` (which takes the
token itself), not the socket (cookie, `Origin` equal to `Host`, and the token in the first frame;
a frame's `Origin` is `null`). A view knows the key (it is in its own address), so it could load
another view's published code into itself, which it could ship anyway; it cannot read it
(`connect-src 'none'`). Everything else under a scheme path is the page's own request and needs
the cookie, as every other path does.

**A view's own origin.** The app gives each view `hm-view://<host>`; the sandbox makes the
frame's origin opaque anyway, so in the tab every view is cross-origin to the page and to every
other view without a host each. What changes is the root: a view's import map named the SDK at
`/__sdk.js`, which in the tab is the server's root. The map now names it relative to the page it
is in (`./__sdk.js`, `../__sdk.js` for a page one folder down), which resolves to the same file on
`hm-view://`, on the phone's view server and in the tab. A view that names its own files from the
root (`/app.js`) still breaks in the tab; the built-in views do not, and the view guide says to
name files relatively.

**Tool plugins' imports.** A tool plugin is built against `hm-plugin://host/react.js` and three
more host modules (`packages/tile-sdk`'s list), literal URLs in its code. A browser's import map
remaps them, but only by exact key: a prefix key for a non-special scheme (`hm-plugin://host/`)
does not match in Chromium (measured above). The four keys are exact, in `browser.html`, whose CSP
allows that one inline script by its hash; a unit test holds the keys to the SDK's list and the
hash to the map. The plugin's own entry is imported through the URL the tab maps.

**Mapping once.** `window.hive.resourceUrl(url)` is the URL this window loads `url` at: itself in
an app window, the path above in a tab. The renderer calls it where it hands a scheme URL to the
DOM or to `import()` (a view's frame, a tool's module, a wallpaper), and nowhere else.

**Rejected.** A host per view (`<id>.localhost:<port>`) keeps root-relative paths working, but
`*.localhost` is not resolved everywhere (Safari, older Firefox) and does not survive `tailscale
serve`, which forwards one name. A second port for views, as the phone server has, is a second
listener to secure and forward. Rewriting plugin code on the way out is a parser in the server.

