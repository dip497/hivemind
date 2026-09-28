# Multiplayer — research notes

Companion to `multiplayer-2026-09-28.md`. What was found before the design was written, so
nobody has to find it again. Collected 2026-09-28 against commit `7f0c4da` (v2026.9.8).
Line numbers drift; re-check them before relying on one.

- **Part 1** — where things live in this codebase today.
- **Part 2** — iroh, Loro, and how other products do multiplayer, shared terminals, remote
  agents and phones.
- **Part 3** — running our own relays, address lookup and push.

Marks: **[V]** confirmed in a primary source · **[S]** secondary source only · **[I]** our
inference.

---

## Part 1 — the codebase

Paths: main = `apps/desktop/src/main`, renderer = `apps/desktop/src/renderer/src`,
agent-host = `packages/agent-host/src`.

### 1.1 Workspace state

**Renderer `localStorage` (one machine, one Electron profile) — the canvas lives here.**
- Core blob `hivemind:canvas-layout:<repoPath>` (`canvas-persistence.ts:110`):
  `frames: FrameState[]`, `tileNames`, `tiles: TileInstance[]`, `editorTabs`, `frameOf`
  (tile→frame membership, authoritative, `:97-102`).
  - `FrameState` (`:59-83`): x/y/w/h, title, color, z, branch, worktreePath, head,
    `workspacePath` (local path or `ssh://` uri), `parentFrameId`.
  - `TileInstance` (`:28-57`): id, kind, label, cmd/args, task, url, `session` (adopt an
    existing daemon session), pinned/pinAnchor/pinSize.
  - `saveLayout` (`:137`) is the only writer; it drops planReview tiles; persisted only when
    there is a repoPath or cwd (`Workspace.tsx:128`).
- Per-view blobs `hivemind:view-layout:<viewId>:<repo>` as `{v, data}`
  (`workspace/view-layout-store.ts:16-48`), debounced 250 ms (`:57-81`). Canvas:
  positions, sizes, viewport (`workspace/views/canvas-layout.ts:14-24`); Windows view
  (`windows-layout.ts`); community views via `loadViewLayout`/`saveViewLayout`.
- Owner: `Workspace.tsx` holds it all as React state — tiles (`:143`), editorTabs
  (`:150`), sizes (`:156`), tileNames + `renameTile` (`:159-172`), positions +
  `commitPosition` (`:224-236`). Selection (`selectedTileId :239`, `selectedFrameId :361`)
  is memory only. Pipes and spawn links are ephemeral (`:145-148`).
- Other keys: DiffTile panels, IssuesTile view, per-tile font, zen, layers panel,
  workbench panels, recent machine dirs, recent projects, last project.

**Main process:** `tile:names` pushed by the renderer (`Workspace.tsx:175`,
`index.ts:1103`); `settings.json` in userData or `$XDG_CONFIG_HOME/hivemind`, shared with
the CLI (`settings-store.ts`); `machines.json`; ssh passwords via safeStorage
(`remote/saved-hosts.ts`); status ledger JSONL (`status-ledger.ts`); `hcp.token`.

**Repo files:** issues `.hivemind/issues/*.md` (`@hivemind/core`, watched by chokidar,
`fs-watcher.ts:52`); review comments under `.hivemind`, else
`~/.config/hivemind/review/<mangled>` (`packages/hive-core/src/review.ts:48-53`).

**Daemon (per machine):** session snapshots `<userData>/sessions/<id>.json`
(`pty-daemon.ts:83`), tracked session ids per tile, OSC titles in `titleBook`
(`pty-daemon.ts:327`).

**Gap:** no workspace document outside one profile's localStorage; HCP `tile.list` asks
the renderer (`Workspace.tsx:785-826`).

### 1.2 The PTY daemon

- Protocol (`pty-protocol.ts`), NDJSON over a 0600 unix socket. Client: `attach{id, spec,
  noSpawn, liveOnly, since{seq, epoch}}`, `hello{caps: ["resync","events"]}`, write,
  resize, detach, kill, pause, resume, `list{detail}`, ping, screen, shutdown. Server:
  `attached{replay, seq, epoch, delta}`, `data{seq}`, `resync`, `event{topic, data}`,
  exit, sessions, pong, screen, error. `SessionInfo` includes `viewers`.
- **Many viewers per session** (`pty-session-manager.ts`): `clients: Set`; `sizes: Map` in
  interaction order — "the last entry owns the PTY size" (`:103-108`). Attach, write and
  resize each make that viewer's size win (`:276-282, 524-533, 568-573`); on detach the
  most recent remaining viewer's size applies (`:589-598`). Pause is a union (`:541-565`).
  There is **no size message to viewers and no letterboxing** anywhere.
- **Writes:** any viewer may write; no lock, no attribution (`pty-daemon.ts:535-540`).
- Snapshots: headless xterm + SerializeAddon for attach replay; 256 KB ring for
  `attachDelta` (`:88, 501-513`); viewers more than 1 MB behind get `resync`
  (`pty-daemon.ts:432-470`); disk snapshots survive reboot as "frozen" sessions.
- Events: `agent.screen` (ScreenWatcher every 1.2 s) and `agent.title` to viewers that said
  hello with "events"; `agent.event` / `agent.reply` only from a **standalone** daemon
  (`hive daemon`, which owns `hcp.sock`) (`:614-653`); standalone also sends ntfy-style push
  (`push.json`, `:408-430`).
- Main: `daemon-client.ts` spawns the daemon detached (ELECTRON_RUN_AS_NODE) and uses the
  shared `DaemonEndpoint` (reconnect with `since`). **One WebContents per tile**
  (`ptySenders`, `index.ts:1176-1204`); pty id `hm:<tileId>`. `ptyInterest` hides/shows a
  tile and redraws it from the daemon's `screen` (`index.ts:1323-1344`).
- The app and the `hive` CLI **share one daemon per machine**
  (`apps/cli/src/pty-client.ts`: `<config>/hivemind/pty-daemon.sock`).

### 1.3 Remote machines today (ssh)

- `remote/pty.ts`: `endpointFor` probes the host and opens a `DaemonEndpoint` over
  `ssh … hive daemon bridge`; without `hive` there, a local `ssh -tt` PTY (detach = kill).
  Local HCP credentials are stripped from the remote env.
- `hive daemon bridge` (`apps/cli/src/commands/daemon.ts:124-146`) ensures a standalone
  daemon and pipes stdio to its socket.
- **Transport-neutral seam:** `DaemonEndpoint` takes `connect: () => Promise<Duplex>`; ssh is
  just one implementation.
- Machine chip → **Sessions running there…** (`machines/MachineChip.tsx`) lists live
  sessions on that machine not already on the canvas and opens one with `attachOnly`.
  Validated: two real machines watched one session, typing both ways.
- Remote fs/git: one ssh command per call (`remote/fs.ts`, `remote/git.ts`); files > 4 MB
  refused; **no remote file watching**; `openPathInApp` refuses remote paths; issues are
  local only.

### 1.4 Control plane (HCP)

- JSON-RPC 2.0 over a 0600 unix socket owned by main (`hcp/hcp-server.ts`); one per-install
  token (`<userData>/hcp.token`); hooks may send `agent.event` without it.
- Methods include `tile.spawn_agent`, `agent.send/read/approve/await_approval/stream`,
  `workflow.run`, `tile.list/focus/close/connect`, `status/subscribe`. Canvas verbs go
  through `hcpCallRenderer` → `mainWindow` only (`index.ts:1799-1811`).
- `hive ctl` has no `--machine`; run/ps/attach/kill do.
- Spawn: the frame decides the cwd (`worktreePath ?? workspacePath`); an `ssh://` path
  makes main's `ptySpawn` go remote (`index.ts:1276`).

### 1.5 Renderer ↔ main

- 132 preload members (`preload/index.ts`, `shared/ipc.ts`), about 111 used by the
  renderer across 32 files. Groups: PTY, status/HCP, workspace/issues, git/worktrees, fs,
  machines, views, agents/plugins, settings, and local-only (dialogs, open in app, browser
  webview, updates, menus).
- `dev-bridge/server.ts` already serves ~30 of them over HTTP (`/rpc/<method>`) + SSE on
  127.0.0.1 with a token, using the in-process pty host (not the daemon).

### 1.6 Status and hooks

- Hooks run `hcp-event-hook.cjs` from the daemon's userData and send `agent.event` to
  `HIVE_HCP_SOCK`. Main's `StatusStore` (`index.ts:1101`, `agent-host/status-store.ts`)
  merges hook events (priority) and daemon screen reads; changes pushed as `hcp:status`.
- Remote: the standalone daemon forwards events over the bridge; the desktop accepts events
  for its own tiles (`remote/events.ts`). **Each desktop derives status on its own.**
- Not built for remote: an agent's `hive ctl` into the desktop, approvals, trust levels,
  auto-report, remote plan review.

### 1.7 View host

- `host-link.ts` is pure logic over a `PortLike`, validating messages, per-command
  permissions and flood limits (eight refusals disable a view; `LIMITS.malformed = 8`).
- `CommunityView.tsx` is Electron-bound: `hm-view://` iframe, MessageChannel handshake,
  long-task observer, `<TileSlot>` overlays. Clicking a docked terminal selects its tile
  (`tile-host.tsx` pointerdown → `setSelectedTileId`), so views learn which terminal you use.

### 1.8 Identity

None. `apps/cli/src/who.ts` guesses a name from env; `main/presence.ts` is this user's
idle/away state. Tokens: HCP (per install), dev-bridge (per process), view share (one-shot).

### 1.9 Design docs that touch this

- `remote-machines-2026-09-11.md`: built — daemon over ssh, many viewers, delta resume,
  machine chip, read-only event forwarding, `hive push`. Not built — interest levels,
  remote→laptop HCP over `ssh -R` with trust levels, `hive ctl --machine`, predictive echo,
  phone pairing (§7b: QR one-time secret, X25519, E2E frames, revoke).
- `session-host-2026-09-25.md`: daemon owns screens and status; renderer gets bytes only
  for visible terminals (interest shipped; disposing hidden xterms after a grace period
  not found on main).
- `agent-host-oss-2026-09-25.md`: the host as a language-neutral library serving clients
  over JSON-RPC; desktop and CLI as two clients.
- `workspace-views.md`: runtime owns frames/tiles/membership/selection/names/persistence;
  TileHost owns bodies; views own layout. Phase 2 (frame geometry out of core) not started.
- `views-by-persona-2026-09-16.md`: Queue, Tiled and Board exist as example views.

---

## Part 2 — outside research

### 2.1 iroh

- **1.0 shipped 2026-06-15** [V]; 1.x keeps the wire protocol compatible across minor
  versions [V]. `iroh`/`iroh-relay`/`iroh-dns-server` at **1.3.0** on 2026-09-28 [V].
  `iroh-gossip`, `iroh-docs`, `iroh-blobs` are still 0.10x [V]. MIT/Apache-2.0 [V].
- `Endpoint` identity = Ed25519; a new random identity each launch unless the `SecretKey`
  is persisted [V]. 1.0 renamed `NodeId/NodeAddr` → `EndpointId/EndpointAddr`, discovery →
  "address lookup"; mDNS moved to `iroh-mdns-address-lookup` (0.4) [V].
- QUIC bi/uni streams, per-stream priority, datagrams (`send_datagram`,
  `max_datagram_size`) [V]; protocols multiplexed by ALPN with a `Router` [V].
- **Tickets are reusable and reveal IP addresses** — never authorisation [V].
- Access control: `EndpointHooks::after_handshake(&Connection)` sees `remote_id()` and ALPN
  and can reject [V]. Revocation by closing live connections (seen in third-party code) [S].
- Hole punching: "roughly 9 out of 10 network configurations allow a direct connection"
  [V]; relay fallback otherwise.
- Browser/WASM: relay-only, no official npm bundle [V]. Mobile: Swift xcframework and
  Kotlin via `iroh-ffi` [V]; `iroh-ffi` cannot point address lookup at a custom server, so a
  phone app needs its own Rust layer [V].
- Node binding `@number0/iroh`: 1.1.0 (2026-07-16), lags core 1.3.0, no Intel-mac build [V]
  → use iroh from Rust (`hive-net`).
- Production users: Delta Chat (device sync by QR), Nous Research (Psyche) [V].

### 2.2 Loro

- 1.0 (2024-10) with a stable encoding; `loro` 1.16.2 and `loro-crdt` 1.16.3 (2026-09-21)
  [V]. MIT.
- Containers: Map, List, MovableList, Tree (movable), Text (rich), Counter [V].
- Sync: `export({mode: "update", from: versionVector})` / `import`; snapshots; shallow
  snapshots (history trimmed) [V]. Peer ids must be unique per session [V].
- `UndoManager` undoes only this peer's edits [V]. `EphemeralStore` for presence
  (per-key LWW with timeouts) [V]; `Cursor` keeps a caret on the right character under
  concurrent edits [V].
- Size (Automerge paper dataset): Loro snapshot 273,561 B; Yjs 226,973 B; Automerge
  292,742 B; Loro shallow snapshot 63,352 B [V].
- Examples of Loro over iroh: `loro-dev/iroh-loro` [V].
- Chosen over Yjs (no movable tree, no native Swift) and Automerge.

### 2.3 How multiplayer products work

- **Figma** [V]: server-authoritative per document; last-writer-wins per property;
  unacknowledged local edits win to avoid flicker; the server rejects reparenting cycles;
  fractional indexing for order.
- **tldraw sync** [V]: exactly one authoritative room per document (Cloudflare Durable
  Object); version-matched clients.
- **Excalidraw** [V]: E2EE rooms, key in the URL fragment; per-element versions.
- **Zed** [V]: guests read-only by default, host grants write; following within a pane;
  terminal following limited.
- **Liveblocks** [V]: presence throttled to 100 ms by default.
- Lessons [I]: one authority per workspace for side effects; per-property LWW for geometry;
  presence throttled and never persisted; local undo only.

### 2.4 Shared terminals

- **tmux** [V]: one PTY size; `window-size` default `latest` since 3.1.
- **upterm** [V]: allowlisted keys, accept each joiner, `--pty-size` to pin a size.
- **VS Code Live Share** [V]: only the host shares terminals; read-only by default;
  read/write "can run any command on your machine".
- Design [I]: one input holder (lease) per terminal, the holder's size wins, others scale.

### 2.5 UI here, agent there

- **VS Code Remote / Zed remote** [V]: server on the remote runs terminals, language
  servers and tasks; UI local.
- **Zeron** (`zeronsh/zeron`) [V]: Rust engine per device; devices on one account trust each
  other; relay "device rooms" on Cloudflare forward frames; Loro docs hold transcripts and
  a durable command queue executed by the owning device, which enforces path containment.
- Letting someone's agent change my project [I]: run it on my machine (one truth, but it is
  remote code execution), file sync (conflict churn), or a git hand-off (safest, not live).

### 2.6 Phones

- **Zeron iOS** [V]: Rust core via UniFFI 0.32, UIKit shell; push from an edge worker to APNs.
- **iOS** [V]: suspended apps lose sockets (TN2277); push is required for background
  alerts.

### 2.7 Security patterns

- Invites: secret in the URL fragment (Excalidraw) [V]; bind the secret to the joiner's key
  on first contact [I].
- Guests driving tools = remote code execution: Live Share warns, Zed defaults to
  read-only [V].

### 2.8 Other options considered

- **Tailcat** (`tailscale/tailcat`, BSD-3, v0.x, Aug 2026) [V]: Tailscale's WireGuard data
  plane without its control plane; `tailcat serve exec -- <cmd>` pipes each connection to a
  command; saved keys and `--allow` client lists. Rejected: one pipe per connection, no
  datagrams, Go-only, young.
- **Tailscale / tsnet / Headscale** [V]: BSD-3; need a tailnet (or a self-hosted Headscale).
- **Zeron** as a whole: native gpui app driving agents through their programmatic
  interfaces (stream-json, app-server, ACP), multi-device sync, iOS in progress. Where it is
  ahead of us and what we took from it: see the conversation that led to this design
  (summarised in the design's decisions).

---

## Part 3 — running our own servers

### 3.1 iroh-relay

- Build with `--features server`; image `n0computer/iroh-relay:v1.3.0` (amd64/arm64) [V].
  Run `iroh-relay -c config.toml` [V].
- Config keys [V]: `enable_relay`, `http_bind_addr` (`[::]:80`), `[tls]`
  (`https_bind_addr` 443, `quic_bind_addr` 7842, `hostname`, `cert_mode` =
  LetsEncrypt | Manual | Reloading, `cert_dir`, `contact`, `prod_tls`),
  `enable_quic_addr_discovery`, `[limits.client.rx]` (`bytes_per_second`,
  `max_burst_bytes`), `enable_metrics` / `metrics_bind_addr` (9090), `key_cache_capacity`,
  `access`.
- Ports [V]: 443/tcp (relay over WebSocket, `/ping`, `/healthz`), 80/tcp (captive-portal
  probe), **7842/udp** (QUIC address discovery; the README's "7824" is a typo), 9090/tcp
  metrics (no auth — firewall it). ACME uses TLS-ALPN-01 on 443.
- Access [V]: `everyone` (default), `allowlist` / `denylist`, `shared_token` (revocable
  only by restart), `access.http` (POST per connection; admit only on 200 + body `true`;
  header actually named `X-Iroh-NodeId`). Embedding: implement `AccessControl`
  (`on_connect`, `on_disconnect`). The relay handshake proves the endpoint id.
- Behaviour [V]: clients live in one process's memory; a relay drops packets for clients
  on another process — **one hostname per process, no load balancers**. Clients ping every
  15 s. n0 quotes 60,000 concurrent connections per relay. Rate limits are backpressure,
  not drops.
- Cloud Run is unsuitable (no UDP, WebSockets cut at the request timeout, several
  instances) [V/I]; Fly.io needs dedicated IPv4 for UDP [V].
- Client config [V]: `Endpoint::builder(presets::Minimal)` +
  `relay_mode(RelayMode::Custom(RelayMap::try_from_iter([...])?))`, `PkarrPublisher` /
  `PkarrResolver` / `DnsAddressLookup` builders for a custom lookup server;
  `home_relay_status()` → `auth_denied_reason()`. `presets::Empty` lacks the crypto provider.
- Compatibility [V]: relay protocol negotiated by `Sec-WebSocket-Protocol`
  (`iroh-relay-v2`, v1 accepted); upgrade relays before clients.
- Embeddable [V]: `iroh_relay::server::Server::spawn(ServerConfig)` behind the `server`
  feature.

### 3.2 iroh-dns-server and pkarr

- Three things in one [V]: pkarr relay (`GET`/`PUT /pkarr/{z32}`), authoritative DNS
  (UDP/TCP), DNS-over-HTTPS (`/dns-query`). Image `n0computer/iroh-dns-server:v1.3.0`;
  library too (`Config::load`, `Server::bind`).
- Config [V]: `[https]` 443 with `cert_mode = "lets_encrypt"` **and
  `letsencrypt_prod = true`** (else staging CA); `[dns]` port 53, origins; metrics
  127.0.0.1:9117; packets in `signed-packets-1.db`, evicted after 7 days without
  republish; uploads rate-limited per IP (burst 2, then 1 per 4 s; `smart` uses
  `X-Forwarded-For`).
- Self-hosting relays does **not** require self-hosting lookup; `presets::N0` publishes to
  `dns.iroh.link` regardless [V].
- Our own records [V]: any Ed25519-signed pkarr packet is accepted (≤ 1000-byte DNS
  packet), newest timestamp wins; readers verify the signature themselves. Hosts can also
  carry ≤ 245 bytes of user data in their own endpoint record.

### 3.3 APNs

- Token auth [V]: `.p8` key, JWT ES256 `{iss: TeamID, iat}`, refresh every 20–60 minutes;
  hosts `api.push.apple.com` / `api.sandbox.push.apple.com` over HTTP/2.
- Payload ≤ 4096 bytes; `apns-push-type`, `apns-priority` (10/5/1), `apns-expiration`,
  `apns-collapse-id` (≤ 64 bytes), `apns-topic` = bundle id; APNs stores one notification per
  app for offline devices [V].
- E2EE [V]: `mutable-content: 1` + alert → Notification Service Extension decrypts (about
  30 s budget).
- Actions [V]: an action without `.foreground` wakes the app in the background;
  `.authenticationRequired` needs unlock; about 30 s of background time, not guaranteed;
  network requests allowed.
- Errors [V]: 410 Unregistered → drop the token; never retry BadDeviceToken etc.; 5xx
  retry with backoff.
- **Keys are team-scoped** [V]: a push server can only push to apps of its own Apple team —
  a self-hoster cannot push to our App Store app.

### 3.4 FCM and UnifiedPush

- FCM HTTP v1 [V]: service-account OAuth2; data vs notification messages; 4096 bytes;
  high priority wakes from Doze (deprioritised if no notification is shown); only data
  messages can be end-to-end encrypted; 410-style `UNREGISTERED`.
- **UnifiedPush** [V]: Android apps register with a distributor app (ntfy, NextPush,
  Sunup) and get an endpoint URL; servers POST Web Push-encrypted messages (RFC 8291) to it.
  No Google; works on a local network; no iOS equivalent.

### 3.5 Push server building blocks and patterns

- Rust [V]: `apns-h2` 0.11 (Threema's maintained `a2`), `yup-oauth2` / `gcp_auth` +
  `reqwest` for FCM; avoid `fcm` 0.9 (legacy API). Threema `push-relay` (MIT/Apache)
  and chatmail `notifiers` (MIT/Apache) as references.
- Node [V]: `@parse/node-apn` 8.1, `apns2` 12.2, `firebase-admin` 14.5.
- Patterns [V]: Signal sends placeholder alerts and the app fetches content; chatmail
  encrypts device tokens to the push proxy; Matrix's pushkey is a capability; ntfy's iOS
  relay forwards only a poll request; Zeron's worker sends the chat title in plaintext.
- Our design [I] (in the design doc §12.4): phone-issued handles, phone-authorised host
  keys, signed + timestamped + replay-checked pushes, HPKE ciphertext padded to fixed sizes,
  generic alerts, answers straight to the host over iroh.

---

## Sources

iroh: https://www.iroh.computer/blog/v1 · https://docs.iroh.computer/concepts/endpoints.md
· https://docs.iroh.computer/concepts/tickets.md · https://docs.iroh.computer/concepts/relays
· https://docs.iroh.computer/connecting/endpoint-hooks
· https://docs.iroh.computer/concepts/security-privacy.md
· https://docs.iroh.computer/configuring-networks · https://docs.iroh.computer/connecting/local-discovery
· https://docs.iroh.computer/iroh-services/relays/self-hosted · https://docs.iroh.computer/relays/rate-limiting
· https://docs.iroh.computer/deployment/dedicated-infrastructure · https://docs.iroh.computer/about/release-policy
· https://github.com/n0-computer/iroh/tree/v1.3.0/iroh-relay · https://github.com/n0-computer/iroh/tree/v1.3.0/iroh-dns-server
· https://docs.rs/iroh-relay/latest/iroh_relay/server/index.html · https://docs.rs/iroh-dns-server/latest/iroh_dns_server/
· https://docs.rs/iroh-mdns-address-lookup/latest/iroh_mdns_address_lookup/
· https://github.com/n0-computer/iroh-ffi · https://www.npmjs.com/package/@number0/iroh · https://github.com/pubky/pkarr

Loro: https://github.com/loro-dev/loro-docs · https://www.npmjs.com/package/loro-crdt · https://github.com/loro-dev/iroh-loro

Products: https://www.figma.com/blog/how-figmas-multiplayer-technology-works/ · https://tldraw.dev/docs/sync
· https://plus.excalidraw.com/blog/end-to-end-encryption · https://zed.dev/docs/collaboration/overview
· https://zed.dev/docs/remote-development · https://learn.microsoft.com/en-us/visualstudio/liveshare/reference/security
· https://github.com/owenthereal/upterm · https://github.com/tmux/tmux/blob/master/options-table.c
· https://github.com/zeronsh/zeron · https://github.com/tailscale/tailcat

Push: https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns
· https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns
· https://developer.apple.com/documentation/usernotifications/modifying-content-in-newly-delivered-notifications
· https://developer.apple.com/library/archive/technotes/tn2277/_index.html
· https://firebase.google.com/docs/cloud-messaging/send/v1-api · https://unifiedpush.org/developers/spec/definitions/
· https://github.com/threema-ch/apns-h2 · https://github.com/threema-ch/push-relay · https://github.com/chatmail/notifiers
