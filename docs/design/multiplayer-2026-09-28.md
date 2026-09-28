# Multiplayer, other devices, phone — design

**Status:** proposed, rev 2. **Date:** 2026-09-28. **Supersedes:** the transport and phone
sections of `remote-machines-2026-09-11.md` (§7b, §12c). Its ssh path stays.

**Rev 2 decisions (2026-09-28):** we run our own relay, address lookup and push server
(§12); a workspace outlives its host (§5.7–5.9); sticky notes and other board objects ship in
the first multiplayer milestone (§4.2 G).

Three features, built in this order, on one networking choice:

1. **Multiplayer.** People join one workspace and work in it together, like a Miro board:
   they see each other's cursors, move and rename tiles together, and watch and type
   into the same live agents.
2. **Other devices.** Open the hivemind on another machine, and choose where each agent
   runs: on that machine, or on yours, against your project.
3. **Phone.** The same workspace from a phone: who needs you, approve, answer, watch.

**Phase 0 comes first.** It lists every refactor these three features need, and nothing in
Phase 1 starts until Phase 0 is done.

---

## 1. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | **iroh 1.x** for every network link. There is no second transport, apart from the existing ssh machines. | Dial by key, QUIC streams + datagrams, hole-punching with relay fallback, native Swift/Kotlin. Wire protocol stable across 1.x. |
| D2 | **`hive-net`, a Rust sidecar** per machine, using iroh directly. Main talks to it over a local socket. | The npm binding (`@number0/iroh` 1.1.0, 2026-07-16) lags core 1.3.0 and ships no Intel-mac build. Rust gets endpoint hooks, datagrams and stream priorities at full fidelity, and the phone reuses the same crate. |
| D3 | **Loro** for the shared workspace document. | Map, MovableList, Tree, Text and EphemeralStore in one library; stable encoding since 1.0; JS (`loro-crdt` 1.16) and Rust (`loro` 1.16) read the same bytes. Zeron uses it for the same job. |
| D4 | **One authority per workspace: the host.** The CRDT merges layout edits from anyone. Every side effect (spawn, type into a PTY, approve, write a file) is an intent that the host validates and executes. | Figma, tldraw and Zeron all centralise authority. The document may be edited by guests; it is never trusted to cause actions. |
| D5 | **Permissions live outside the document**, in the host's local ACL, and are enforced in hive-net and main, never in a renderer. | Guests can edit the document, so they could otherwise edit their own role. |
| D6 | **Terminals stay on the machine that runs them.** The daemon is unchanged as the owner; it gains viewers over the network. | Already true for ssh machines (`remote-machines`, validated two-way on real hosts). |
| D7 | **One input holder per terminal** (an input lease); everyone else watches. | Two people typing into one agent corrupts its input. VS Code Live Share and upterm reach the same rule. |
| D8 | **We run our own infrastructure:** iroh relays, address lookup (pkarr DNS) and a push server. No third-party relay or push service carries hivemind traffic. | Decided 2026-09-28. Public n0 relays are dev-only; a push relay must hold our APNs/FCM credentials anyway. |
| D9 | **A workspace outlives its host.** Each of the owner's devices keeps a full replica of the document and the access list; hosting can move to an always-on machine (`hive host`), or any of the owner's devices can take it over. | Decided 2026-09-28. The CRDT makes failover a merge, not a recovery. |
| D10 | **Board objects** — sticky notes, checklists, text labels, arrows — live in the shared document from the first multiplayer milestone. | Decided 2026-09-28. A shared board without shared notes is a screen share. |

Rejected: Tailcat (point-to-point pipes, no multiplexing or datagrams, Go-only, v0.x);
Yjs (no movable tree; no native Swift core); a central server of our own (cost, accounts,
and it would hold everyone's terminal output).

---

## 2. Where things are today (the gaps)

Facts from the code, 2026-09-28:

| Area | Today | Gap for these features |
|---|---|---|
| Workspace state | Renderer `localStorage`: `hivemind:canvas-layout:<repo>` (frames, tiles, `frameOf`, names, editor tabs — `canvas-persistence.ts:110,137`) and `hivemind:view-layout:<view>:<repo>` (positions, sizes, viewport — `view-layout-store.ts`, `canvas-layout.ts`). Owned as React state in `Workspace.tsx`. | Nothing outside one window knows the workspace. HCP `tile.list` has to ask the renderer (`Workspace.tsx:785-826`). |
| Selection | In memory, `Workspace.tsx:239,361`. | Fine as local state; needs to become presence for others to see. |
| Terminals | Daemon per machine; many viewers per session; the last interacting viewer's size wins (`pty-session-manager.ts:103-108, 524-598`). Any viewer may write, no attribution (`pty-daemon.ts:535-540`). | No size notice to viewers, no letterboxing, no input lease, no "who typed". |
| PTY relay in main | One `WebContents` per tile (`ptySenders`, `index.ts:1176-1204`). | One window only; no fan-out to network peers. |
| Agent status | `StatusStore` in main (`index.ts:1101`), fed by hooks and daemon screen reads. Each desktop derives its own. | Two desktops watching one agent can disagree. |
| Control plane (HCP) | Unix socket, one all-powerful per-install token (`hcp.token`). Canvas verbs go to `mainWindow` only (`hcpCallRenderer`, `index.ts:1799-1811`). | No per-client identity or scope; verbs need a renderer. |
| Machines | `ssh://user@host/path` frame binding (`shared/remote-uri.ts`); `hive daemon bridge` over ssh; "Sessions running there…" adopts live sessions. Remote fs/git over one ssh command per call; no remote file watching. | A frame is bound to a host by ssh uri only; no other transport. |
| Renderer ↔ main | 132 preload members (`preload/index.ts`), about 111 used. A loopback HTTP/SSE shim (`dev-bridge/server.ts`) covers ~30 of them without the daemon. | No workspace API a remote client could call. |
| Identity | None. `apps/cli/src/who.ts` guesses a name from env. | Nobody to show on a cursor, grant a role to, or blame in an audit log. |
| View host | `host-link.ts` is transport-neutral; `CommunityView.tsx` is Electron-bound (`hm-view://`, local TileSlots). | Views cannot run on a phone yet. |

---

## 3. Phase 0 — refactors, all before any feature work

Each refactor stands alone, ships behind no flag, and leaves the single-user app working
exactly as today. They are ordered by dependency.

### R1. Workspace store out of the renderer, into a headless package

- **What.** Move the core layout blob and the per-view layout blobs out of renderer
  `localStorage` into a `WorkspaceStore`: one writer, change events, a snapshot per repo on
  disk (`<userData>/workspaces/<repo-hash>.json`). The renderer mirrors it over IPC and sends
  edits as operations (`frame.move`, `tile.rename`, …), not whole blobs.
- **It lives in a package, not in Electron main.** `packages/workspace-host` holds the store
  (and, later, intents R7 and the access list R11). Electron main embeds it; the `hive`
  binary runs it headless for an always-on host (R14). Nothing in the package imports
  Electron.
- **Files.** `canvas-persistence.ts`, `view-layout-store.ts`, `canvas-layout.ts`,
  `windows-layout.ts`, `Workspace.tsx` (state becomes a mirror), `main/index.ts`, new
  `packages/workspace-host/src/store.ts`, `shared/ipc.ts`, `preload/index.ts`.
- **Migration.** On first run, main reads each repo's localStorage blobs once (sent by the
  renderer), writes them to the store and marks them migrated. The blobs stay as a
  fallback for one release.
- **Unblocks.** Everything: HCP `tile.list` without a renderer, several windows, remote
  peers.
- **Done when.** All e2e specs green; `tile.list` answers with the window closed; the
  canvas round-trips through a restart with localStorage cleared.

### R2. The store becomes a Loro document

- **What.** `WorkspaceStore` keeps its API and is backed by one `LoroDoc` per workspace.
  Schema in §8, including board objects (`objects`) from the start, so M1 needs no schema
  migration. Local undo moves to Loro's `UndoManager` (this peer's edits only).
- **Files.** `packages/workspace-host/src/store.ts`, new `packages/workspace-doc` (schema,
  typed accessors, validation, shared with the phone later).
- **Done when.** Snapshot + update export/import round-trip tests; two in-process docs
  editing concurrently converge (fuzz test); undo only reverts local edits.

### R3. Identity: devices, people, workspaces

- **What.**
  - **Device key.** Ed25519, generated once per machine, kept in the OS keychain (a 0600
    file on a headless server). Its public half is the iroh `EndpointId`.
  - **Person key.** Ed25519, generated on a person's first device and copied to their other
    devices during self-pairing (§5.2), over the end-to-end encrypted pairing channel. It
    signs a **device certificate** for each of that person's devices ("device X belongs to
    person P"), so roles are granted to people and follow them to any of their devices.
  - **Workspace key.** Derived per workspace from the owner's person key
    (`HKDF(person secret, "hive-workspace" ‖ workspaceId)`), so every one of the owner's
    devices can derive it and nobody else can. It signs the workspace's **host record**
    (which machine hosts it now; §5.8).
  - **Profile.** Display name and colour, set on first use (prefilled from git config).
    Every document edit carries the person's peer id; every PTY write carries it too (R4).
- **Files.** new `packages/workspace-host/src/identity.ts`, `main/keychain.ts`,
  `settings-store.ts` (profile), Settings → Profile panel.
- **Done when.** Keys survive restarts and upgrades; a device certificate verifies; the same
  workspace key is derived on two devices of one person and on no one else's.

### R4. Daemon: size authority, input lease, attribution

- **What.**
  - The daemon **announces** the PTY size to every viewer (`size` server message) when it
    changes. Viewers whose own size differs render the terminal scaled or letterboxed.
  - An **input lease** per session: `lease{id, holder}` messages; writes from a
    non-holder are dropped and answered with an error. The host's own viewers may always
    take the lease. The holder's size is the PTY size.
  - Every `write` carries an `actor` (peer id). The daemon keeps a small ring of recent
    writers per session.
  - Protocol stays append-only: old clients ignore new messages; with no lease ever set, a
    session behaves as today.
- **Files.** `packages/agent-host/src/pty-protocol.ts`, `pty-session-manager.ts`,
  `pty-daemon.ts`, `daemon-endpoint.ts`, `TerminalTile.tsx` (scaled render),
  `apps/cli` attach.
- **Done when.** Two viewers of different sizes: one fills, the other letterboxes; a
  non-holder's keys are refused; `hive attach` still works unchanged.

### R5. Main fans out to many clients

- **What.** Replace `ptySenders: Map<tileId, WebContents>` with a subscriber set per
  session (local windows now, network peers in Phase 1). Canvas verbs (`tile.list`,
  `tile.focus`, spawn, close, rename) execute in main against `WorkspaceStore`;
  `hcpCallRenderer` is kept only for things that are truly visual (camera focus).
- **Files.** `main/index.ts` (pty relay, `hcpCallRenderer`), `main/hcp/methods.ts`,
  `useSpawn.ts` (spawn logic moves to main), `Workspace.tsx`.
- **Done when.** HCP spawn/close/rename work with no window; two windows on one workspace
  show the same terminals live.

### R6. One status per session, from its host

- **What.** The machine that runs a session is the only one that derives its status.
  Viewers (another window, a network peer) mirror that host's `StatusStore` instead of
  deriving their own from screen reads.
- **Files.** `main/index.ts` (status wiring), `packages/agent-host/src/status-store.ts`,
  `remote/events.ts`.
- **Done when.** Two viewers of one agent always show the same status; a remote ssh session's
  status matches its host's.

### R7. Intents: one path for every side effect

- **What.** A typed intent layer in main — `spawn`, `close`, `input.request`,
  `input.release`, `approve`, `send`, `file.write` — each with a permission check
  (`can(actor, intent)`), an audit record, and an idempotency id (first answer wins, as
  in `remote-machines` §12c). The renderer, HCP and (later) network peers all go through
  it.
- **Files.** new `packages/workspace-host/src/intents.ts` (runs in Electron main and in
  `hive host`), `main/hcp/methods.ts`, IPC handlers in `main/index.ts`.
- **Done when.** Every side-effecting IPC and HCP method is routed through it; the audit
  log (`<userData>/audit.jsonl`) records actor, intent, outcome.

### R8. A workspace API that is not Electron IPC

- **What.** Split `window.hive` into **local-only** calls (folder picker, open in app,
  window, updates, clipboard, browser webview) and a **workspace API** (store, intents,
  pty streams, status, git, fs, issues, views). The workspace API is defined once as a
  typed message protocol with two transports: Electron IPC (today) and a stream
  (hive-net, Phase 1). The dev-bridge shim becomes a thin client of it.
- **Files.** `shared/ipc.ts`, `preload/index.ts`, `dev-bridge/server.ts`, new
  `packages/workspace-api` (types + client).
- **Done when.** The renderer runs against the stream transport in a test harness with the
  same e2e results for canvas, terminals, git and issues.

### R9. Machines by id, not by ssh uri

- **What.** Frames bind to `machine://<machineId>/<path>`. A machine record says how it is
  reached: `local`, `ssh` (today's path), or `iroh` (Phase 2). Existing `ssh://`
  bindings are rewritten on load.
- **Files.** `shared/remote-uri.ts`, `remote/machines.ts`, `remote/pty.ts`,
  `remote/fs.ts`, `remote/git.ts`, `canvas-persistence.ts` migration, `hive` CLI
  machine commands.
- **Done when.** All remote-machine e2e green with the new uri; old workspaces open.

### R10. `hive-net` skeleton and packaging

- **What.** A Rust binary: iroh `Endpoint` with the R3 key, a `Router` with the ALPNs in
  §7, `after_handshake` gating against the ACL (R11), a local socket to main. Built for
  every release target (Linux x64/arm64, macOS arm64, Windows x64) and bundled like the
  `hive` binary; `install.sh`/`install.ps1` and `release.yml` updated.
- **Files.** new `crates/hive-net`, `.github/workflows/release.yml`, `scripts/*install*`,
  installer tests.
- **Done when.** Two machines ping each other by `EndpointId` through a self-hosted relay
  and directly; release artifacts include it; installer tests green.

### R11. Access list and audit

- **What.** The access list per workspace: `person key → { role, grantedAt, expires?,
  devices: [device certificates seen] }`. Each entry is signed by the owner's person key,
  so any of the owner's devices can verify it when it becomes host. It is replicated
  **only among the owner's own devices** (a separate, owner-only Loro document), never in
  the shared workspace document and never sent to guests. Roles in §6. Revoking closes
  live connections on the current host within a second.
- **Files.** new `packages/workspace-host/src/access.ts`, `crates/hive-net` (reads it for
  `after_handshake`), Settings → People panel.
- **Done when.** A revoked peer is disconnected within a second and cannot reconnect; a
  grant made on one of the owner's devices is enforced by another after a host move.

### R12. View protocol 1.5

- **What.**
  - `hello.device: { touch, compact }`, so one view can lay out for phone and desktop.
  - `participants` messages: who is here, their colour, their cursor and selection.
  - The SDK drops surface rects for tiles the host has not announced (today eight
    refusals disable a view).
  - A fake host for view authors (`@hivemind/view-sdk/testing`).
- **Files.** `packages/hive-view-sdk`, `host-link.ts`, `CommunityView.tsx`, docs.
- **Done when.** Protocol tests; an existing view works unchanged; a sample view shows
  participants.

### R13. Relay and address lookup we run

- **What.** Self-host `iroh-relay` (and optionally `iroh-dns-server`) in two regions, or
  buy n0 Pro ($19/mo). Public n0 relays are dev-only. Configurable per install.
- **Done when.** Relay reachable from both regions; hive-net uses it by default; a custom
  relay can be set in Settings.

### R14. Headless host: `hive host`

- **What.** The `hive` binary gains a service mode that runs, without Electron: the PTY
  daemon (as today's standalone `hive daemon`), `hive-net`, and `packages/workspace-host`
  (store, intents, access list, status store, HCP for agents running on it). Installed as a
  systemd/launchd user service, like Zeron's `daemon install`. It pairs as one of your
  devices (§5.2) from its terminal: `hive host pair` prints a QR and words, or accepts the
  words shown by your laptop.
- **Files.** `apps/cli/src/commands/host.ts`, `apps/cli/src/commands/daemon.ts`,
  `packages/workspace-host`, `crates/hive-net`, `install.sh`, `release.yml` (Linux x64/arm64
  assets are the main target; servers are usually Linux).
- **Done when.** A Linux VPS runs `hive host` after a reboot with no desktop session; a
  laptop pairs with it and opens a workspace hosted there; agents started in its frames
  keep running with the laptop closed.

### R15. The canvas renders board objects

- **What.** The canvas node builder (`canvas-node-build.ts`) and node types
  (`canvas-nodes.tsx`, today `frame` and `tile`) gain a third kind, **board object**, drawn
  by plain React (no TileHost surface): sticky note, checklist, text label, arrow. Text
  inside an object is edited in place; while it has focus, the canvas single-key shortcuts
  (`1`–`7`) do not fire (`dom-focus.ts`). Objects nest in frames like tiles and move with
  them.
- **Files.** `canvas-node-build.ts`, `canvas-nodes.tsx`, new `board-objects/*.tsx`,
  `useCanvasShortcuts.ts`, `dom-focus.ts`, `packages/workspace-doc` (object schema).
- **Done when.** Single user, no network: create, edit, resize, nest, undo, persist and
  delete each object kind; e2e covers typing in a note without triggering shortcuts.

**Order:** R1 → R2 → R15; R3 in parallel; R4 in parallel; R5 after R1; R6 after R5; R7
after R5; R8 after R7; R9 any time before Phase 2; R10–R11 after R3; R12 any time; R13
before Phase 1 ships; R14 after R1, R7, R10 and R11.

---

## 4. Feature 1 — Multiplayer

### 4.1 What it is

Anyone you invite joins **your workspace** (you are the host). The board, frames, tiles and
names are one shared document. Terminals and agents keep running on your machine; guests
watch them live, and type into one when you hand them the keyboard.

### 4.2 UX journey

**A. Invite (host)**
1. Toolbar → **Share** (or `⌘⇧S`). A panel opens: "Invite people to *api-work*".
2. Pick a role for the link: **Can view** (default) · **Can edit board** · **Can use
   terminals**. "Can drive agents" is never on a link; it is granted per person later.
3. **Copy link** or **Show QR**. The link is `hivemind://join/<host-id>#<secret>`; the
   secret is in the fragment, single-use by default, expires in 24 h (options: 1 h, 7 d,
   reusable).
4. Empty state before anyone joins: "Nobody here yet. Share the link — it works across
   networks."

**B. Join (guest)**
1. Guest clicks the link. If hivemind is not installed: a web page explains and offers the
   download, then reopens the link.
2. hivemind opens a **join sheet**: host name and avatar, workspace name, the role offered,
   "Your name: [ ] Colour: [●]" (prefilled from their profile).
3. **Join**. Host sees a toast: "Priya wants to join as *Can view* — Allow / Deny" (hosts
   can turn on "admit automatically" per link).
4. On allow, the guest's window opens the workspace. A slim banner: "You're in
   *api-work* on Adarsh's machine · Can view · Leave".
5. Errors: link expired or used → "This invite has expired. Ask for a new one." Host
   offline → "Adarsh's hivemind isn't online. We'll connect when it is." (retries in the
   background, with a Cancel).

**C. Being together**
1. **Avatars** top-right: everyone present, with a coloured ring. Click an avatar →
   **Follow** (your camera follows theirs until you move) or **Go to**.
2. **Cursors**: named, coloured pointers on the canvas, smoothed. Hidden when a person is
   typing in a terminal; their tile shows "Priya is typing" instead.
3. **Selection**: a tile someone has selected gets their colour on its border.
4. **Edits**: moving, resizing, renaming, creating frames — immediate for everyone. Undo
   (`⌘Z`) undoes only your own edits.
5. **Conflicts**: two people drag the same tile → the last drop wins, the other sees it
   jump to the new place with a short glide. No dialogs.
6. Views: every view (Canvas, Windows, Queue, Tiled, community views) shows the same
   workspace; each person picks their own view and camera.

**D. Terminals together**
1. Every terminal tile shows who holds its keyboard: a small avatar in its title bar
   ("⌨ Adarsh").
2. Viewers see the output live. If their tile is a different size, the terminal is scaled
   to fit (letterboxed if needed).
3. A guest with **Can use terminals** clicks into a terminal → a pill "Ask for keyboard".
   The holder sees "Priya asks for the keyboard — Give / Not now". **Give** hands it
   over; the terminal resizes to Priya's tile.
4. The host can always take the keyboard back (`⌘⇧K` or the avatar menu), from anyone,
   instantly.
5. Keyboard idle for 5 minutes → it returns to the host automatically.
6. Agent prompts (permission, question, plan) show to everyone. Only people with **Can
   drive agents** see Allow/Deny buttons; the first answer wins and everyone sees who
   answered.

**E. Roles and removal (host)**
1. **People** panel (avatars → Manage): each person, their role, when they joined,
   last activity. Change role inline.
2. **Remove** → they are disconnected immediately; their cursor disappears with "Priya was
   removed". Their invite link stops working.
3. **Can drive agents** can only be granted to a present person, needs a confirm:
   "Priya will be able to run commands on your machine through your agents."

**F. Leaving and disconnects**
1. Guest → **Leave**: the workspace closes on their side. A local read-only copy of the
   board (not terminals) stays in "Recent shared" for reopening.
2. Network drop: the guest's banner turns amber "Reconnecting…"; board edits made while
   offline are kept and merge on reconnect; terminals show "Paused — reconnecting" and
   replay the missed output on return.
3. Host quits or sleeps: guests see "Adarsh's hivemind went offline" with the last board
   state; terminals frozen with a grey overlay. Agents on the host keep running if the
   daemon is alive (it outlives the window), and guests see them again when the host is
   back.

**G. Board objects together (sticky notes, checklists, text, arrows)**
1. **Add.** Toolbar → **Board** menu, or keys on the canvas: `8` sticky note, `9`
   checklist (next to today's `1`–`7` tools); Text and Arrow from the menu. The object
   appears at the cursor, already in edit mode, tinted with the author's colour for a
   moment so others see who added it.
2. **Write together.** Everyone can type in the same note at once. Each person's caret and
   selection show inside the note in their colour with their name; edits merge
   character by character (Loro text), never "someone else is editing".
3. **Checklists.** `Enter` adds an item, `Space` on an item ticks it, drag reorders.
   Ticks are live for everyone, and the item shows who ticked it on hover.
4. **Arrows.** Hover the edge of any tile, frame or object → a handle; drag to another →
   the arrow snaps and follows when either end moves. Double-click an arrow to label it.
   Arrows between a note and an agent tile are how people say "this note is about that
   agent".
5. **Arrange.** Drop an object into a frame and it moves with the frame. Resize, recolour
   (six note colours), delete (`Backspace`), duplicate (`⌘D`). Undo (`⌘Z`) undoes only your
   own changes, including text you typed.
6. **Roles.** *Can view* sees objects and cursors but cannot edit; *Can edit board* and
   above can.
7. **Where they show.** The Canvas view draws objects. Other views (Windows, Queue, Tiled,
   community views) ignore them in M1; the phone shows notes read-only in its *Board* tab.
8. **Empty state.** A new shared workspace offers "Add a note to say what this board is
   for" once, dismissible.
9. Not in M1: images and files (need blob transfer), shapes, freehand drawing, comments
   on objects, agents writing notes (`hive ctl note`).

**Keys:** `⌘⇧S` share · `⌘⇧K` take keyboard back · `F` on an avatar to follow · `Esc`
stops following · `8` note · `9` checklist.

### 4.3 How it works

- Host's hive-net accepts `hive/ws/1` connections from peers on its ACL.
- **Document sync:** on join the host sends a Loro snapshot, then both sides exchange
  updates (`export({mode:"update", from: vv})`) over one reliable stream. The host
  validates each guest update against the guest's role (a "Can view" guest's updates are
  dropped) before applying and rebroadcasting.
- **Presence:** Loro `EphemeralStore` (cursor, camera, selection, typing-in, and the caret
  inside a board object as a Loro `Cursor`, which stays on the right character while others
  type), throttled to 50 ms, sent as datagrams; receivers interpolate. Never stored.
- **Terminals:** a guest subscribes to a session; the host opens one uni stream per
  subscribed session carrying daemon `data`/`resync`, and an input stream when the guest
  holds the lease (R4). Only visible tiles are subscribed (the existing interest rule).
- **Intents** (R7) travel on a `hive/ctl/1` stream: request/response with ids.

### 4.4 Done when

- Two people on different networks (one behind a mobile hotspot) edit one board with
  cursors under 150 ms p95 on a direct link, 300 ms through the relay.
- Three people type in one sticky note at once for a minute; all three end with the same
  text and nobody's keystrokes are lost (fuzz test plus a live check).
- 100 tiles, 5 people, 10 visible terminals streaming: host CPU under 20% above
  single-user.
- Handover, revoke and reconnect journeys pass as e2e tests with two app instances.

---

## 5. Feature 2 — Other devices, and where agents run

### 5.1 What it is

Two cases, one mechanism:

- **Your own devices** (desktop and laptop). Pair them once; each sees the other's
  workspaces and machines at full trust, without inviting anyone.
- **Someone else's hivemind.** You join it (Feature 1). You can run agents there on *your*
  machine, against *your* project, and they appear on the shared board.

**The mechanism:** every frame has an **executor machine** (R9). An agent or shell in that
frame runs on that machine's daemon. A workspace can mix frames from several machines;
each one's terminals stream from where they run.

### 5.2 UX journey — pair your own device

1. On device A: Settings → **Devices** → **Pair a device**. Shows a QR code and a 6-word
   code, valid for 5 minutes.
2. On device B: Settings → Devices → **Pair with a device** → scan or type the words.
3. Both show: "Pair *Adarsh's MacBook* with *Adarsh's desktop*? Both will be able to
   see and control everything on each other." **Pair**. Behind the scenes the new device
   receives your person key and a device certificate (R3), so it is "you" everywhere, and
   starts replicating the workspaces and access lists you own.
4. Device B appears under **Machines** on A (and vice versa) with a "Your device" badge.
5. Unpair: Devices → the device → **Unpair**. Both sides forget each other immediately.

### 5.3 UX journey — open another device's workspace

1. On A: **Recent projects** now lists workspaces from paired devices, marked with the
   device name ("*infra* — on desktop").
2. Open one: it opens as a multiplayer session where A is a full-trust participant, and the
   frames' executor is the desktop. Everything runs there; A is a window onto it.
3. If the desktop is asleep: "Desktop is offline. Showing the last saved board." Board is
   read-only until it is back.

### 5.4 UX journey — run an agent on my machine, inside their workspace

1. Guest (or your other device) is in a shared workspace. **New frame** → a sheet asks
   **Where does it run?**
   - *Adarsh's machine (host)* — default.
   - *My machine* → pick a folder or repo on your own disk.
2. The frame is created on the shared board with a machine badge ("on Priya's laptop").
   Agents spawned in it run on Priya's machine, with Priya's agent logins and keys.
3. Everyone sees the frame's terminals live (they stream from Priya's machine to the host
   and on to the others, or directly peer to peer; see §5.5).
4. Priya is the **owner** of that frame's machine: she alone can grant keyboard or agent
   driving in it, even to the workspace host. Her machine's ACL decides.
5. Getting the work into the host's project: the frame's toolbar has **Hand off** →
   *Push a branch* (git push to a remote both can reach, or a git bundle sent over
   hive-net into the host's repo as a new branch) or *Open a review* (a Diff tile on the
   host showing the branch). No live file sync.
6. Priya leaves → her frame shows "Runs on Priya's laptop — offline", grey. Her agents
   keep running on her machine; she can open them locally.

The reverse — "their agent works on **my** project" — is the same journey with roles
swapped: the host creates a frame on a guest's machine only if that guest's ACL grants
the host **Can drive agents** on it. Nobody's code runs on your machine unless you
granted it.

### 5.5 How it works

- Peers can connect directly (A ↔ Priya) when both ACLs allow; otherwise terminal streams
  are relayed by the workspace host. Direct is tried first.
- Frame record carries `machine: EndpointId` and `path`. Fs and git for that frame go to
  that machine's hive-net (a `hive/fs/1` ALPN replacing one-ssh-command-per-call), with
  the same path containment rules as `remote/fs.ts` and Zeron's owning-engine checks.
- Remote file watching: the executor machine watches and sends `fs:changed` for frames it
  owns (fixes today's "no remote watch" gap).
- Your own devices share one person identity; pairing stores each other's keys with role
  `self` (full trust).

### 5.6 Done when

- A laptop opens a desktop workspace and drives its agents over the internet with no ssh
  setup.
- A guest creates a frame on their own machine inside a host's workspace; everyone sees its
  agents; the host cannot type there without the guest's grant.
- Hand off by bundle lands a branch in the host's repo and opens a Diff tile.

### 5.7 UX journey — keep a workspace alive when your laptop sleeps

Terms: the **host** holds the document and the access list and serves everyone; an
**executor** runs a frame's terminals. They can be different machines.

**A. Set up an always-on machine (once)**
1. On a server, VPS or home box: `curl -fsSL https://hivemind.griiken.com/install.sh | sh`,
   then `hive host pair`. It prints a QR code and six words.
2. On the laptop: Settings → Devices → **Pair with a device** → the words. The server
   appears under Devices with an **Always on** badge and under Machines.
3. Errors: server unreachable → "Can't reach *home-server*. Is `hive host` running?" with
   the command to check (`hive host status`).

**B. Move hosting**
1. Workspace menu (or Share panel) → **Hosting**: "Hosted on *Adarsh's MacBook*. It goes
   offline when this laptop sleeps."
2. **Move to an always-on machine** → pick *home-server* → confirm: "The board, notes,
   people and invite links move to home-server. Agents keep running where they are."
3. A short progress sheet: *Copying board* → *Copying people* → *Telling everyone*. Guests
   see a one-line toast: "This workspace moved to home-server" and reconnect by themselves.
4. The Hosting row now reads "Hosted on *home-server* · always on".

**C. Where agents run after the move**
1. Existing frames keep their executor. A frame on the laptop shows "Runs on Adarsh's
   MacBook"; when the laptop sleeps it turns grey ("asleep"), and everyone else can still
   see the board and every other frame.
2. The move sheet offers **Run new frames on home-server by default** (on by default).
3. A running agent cannot move between machines. Its frame menu offers **Continue on
   home-server**: if the agent can resume sessions and the repo exists there, a new tile
   starts on the server resuming that session; otherwise the menu explains why not.

**D. Laptop asleep, work goes on**
1. From the phone or another laptop: the workspace opens (it is hosted on the server),
   agents on the server keep working, "needs you" still arrives.
2. The laptop wakes: its frames come back online; its local edits made offline merge in.

**E. The host dies (or you never moved it)**
1. If the host is unreachable for 2 minutes, your other devices show: "*home-server* isn't
   responding. **Host from this device**?" (only on the owner's devices).
2. Taking over publishes a new host record; guests reconnect to it; the board is the last
   synced copy plus any offline edits, merged.
3. When the old host returns, it sees a newer host record, becomes an ordinary replica and
   merges what it had. Nothing is lost that either side saved.

**F. Move back**
Hosting → **Move to** *this laptop* (or any of your devices). Same sheet.

### 5.8 How hosting moves

- **Workspace id and host record.** Every workspace has a random `workspaceId` and an owner
  (a person key). The current host is named by a **host record**
  `{workspaceId, hostEndpointId, seq}` signed by the workspace key (R3) and published
  through our own address-lookup service (pkarr records on our DNS server, §12) under the
  workspace public key. Invites carry the workspace public key, so guests can always find
  the current host.
- **Replicas.** Each of the owner's devices keeps the workspace document and the owner-only
  access document in sync while online. Guests keep a document replica for offline viewing
  but never the access list, and can never host.
- **Move.** The old host freezes writes for a moment, syncs the new host to its latest
  version, publishes the new record (`seq + 1`), sends connected peers `moved{record}`,
  and becomes a replica. Peers verify the record's signature before following it.
- **Take-over.** Any owner device publishes `seq + 1` from its replica. Two devices taking
  over at once: the higher `seq` wins, ties broken by endpoint id; the loser becomes a
  replica. The CRDT merges their edits.
- **Terminals are not part of hosting.** They stay with their executor's daemon; a new host
  learns executors from frame records and connects to them.

### 5.9 Done when (hosting)

- A workspace moves from a laptop to a VPS while two guests are connected; both reconnect
  in under 10 s without re-inviting.
- With the laptop off, a phone and a guest keep working on the board and on the VPS's
  agents.
- Pull the VPS's network for 5 minutes: the laptop takes over; when the VPS returns it
  becomes a replica and both sides' edits are present.

---

## 6. Roles

| Role | See board | Edit board | Watch terminals | Type (with keyboard) | Answer agent prompts, spawn/close agents | Manage people |
|---|---|---|---|---|---|---|
| Can view | ✓ | | ✓ | | | |
| Can edit board | ✓ | ✓ | ✓ | | | |
| Can use terminals | ✓ | ✓ | ✓ | ✓ (after handover) | | |
| Can drive agents | ✓ | ✓ | ✓ | ✓ | ✓ | |
| Owner / self | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

Rules:
- Roles are per workspace on the host, and per machine for frames that run elsewhere.
- Invite links carry at most *Can use terminals*.
- Every intent is checked on the machine that executes it.
- Guest input and approvals are marked in the audit log and in the terminal's writer ring.

---

## 7. Protocols (ALPNs on hive-net)

| ALPN | Purpose | Shape |
|---|---|---|
| `hive/pair/1` | First contact: present an invite or pairing secret, get a role | request/response, then close |
| `hive/ws/1` | Workspace document sync + presence | one bi stream for Loro updates; datagrams for EphemeralStore |
| `hive/ctl/1` | Intents (R7) | request/response per bi stream, idempotency ids |
| `hive/pty/1` | Terminal streams (R4 protocol over QUIC) | one uni stream per subscribed session out; one bi stream per lease in |
| `hive/fs/1` | File + git operations for frames on this machine | request/response; large files as chunked streams |
| `hive/view/1` | View protocol for remote view hosts (phone) | the existing view messages over a bi stream |

All ALPNs except `hive/pair/1` are rejected in `after_handshake` unless the peer's
`EndpointId` is on the ACL (R11). Versioned by ALPN suffix; a peer offers every version it
speaks.

---

## 8. Workspace document schema (Loro)

```
root: Map
  meta: Map        { workspaceId, workspacePublicKey, owner (person key), name, schema: 1 }
  machines: Map    machineId → Map { endpointId, label, owner }
  frames: Tree     node data: Map { title, color, machine, path, branch, worktreePath, rect{x,y,w,h}, z }
  tiles: Map       tileId → Map { kind, frame, name, cmd, args, session, pinned, pinAnchor, created{by, at} }
  objects: Map     objectId → Map {
                     kind: "note" | "checklist" | "text" | "arrow",
                     frame?, rect{x,y,w,h}, z, color, created{by, at},
                     text: LoroText                                   (note, text, checklist title)
                     items: MovableList<Map { done, doneBy?, text: LoroText }>   (checklist)
                     from, to: { id, side } , label: LoroText         (arrow; ends are tiles, frames or objects)
                   }
  order: MovableList   tile ids for Windows-view tab order
  views: Map       viewId → Map (shared view layout, e.g. canvas positions/sizes)
```

The **host record** is not in this document; it is published separately and signed by the
workspace key (§5.8). The **access list** is a separate owner-only document (R11).

- Per-person view state (camera, selection, collapsed panels) is **presence or local**,
  never in the document.
- Positions: per-property last-writer-wins by default (Loro Map values).
- The host rejects updates that break invariants (tile in a missing frame, frame cycles)
  and replies with a corrective update.
- History: shallow snapshots after 30 days; full history kept locally by the host.

---

## 9. Feature 3 — Phone

### 9.1 What it is

A phone app (iOS first, Android after) that pairs like a device (§5.2) and does what a
phone is good at: see who needs you, answer, approve, watch, switch views. It runs no
agents.

### 9.2 UX journey

1. **Install and pair.** App Store → open → **Pair with hivemind** → scan the QR from
   Settings → Devices → *Pair a phone* on the desktop. Name and colour carry over.
2. **Home: Needs you.** A list, most urgent first: agent, workspace, machine, reason
   (permission · question · plan), how long it has waited. Empty state: "Nothing needs
   you. 4 agents working."
3. **Push notification.** "*api · Fix nav overflow* needs permission: Edit Nav.tsx" with
   **Allow** / **Deny** actions on the notification itself; tap opens the item.
4. **Answer.** Permission → Allow once / Always / Deny. Question → the options as buttons,
   plus a text box. Plan → the plan as text, Approve / Ask for changes.
5. **Watch.** Tap an agent → a live terminal, read-only by default, scaled to width;
   pinch to zoom. **Type** asks for the keyboard like a guest; the reply box sends one
   line through the task-delivery path, which is easier than typing into a TUI.
6. **Views.** A tab bar: *Needs you* · *Working* · *Board* (a compact list of frames and
   tiles) · community views that declare phone support (R12 `hello.device.compact`).
7. **Offline host.** "Desktop is asleep. You'll get a notification when it's back." The
   last known state is shown with its age.
8. **Unpair.** Settings on the phone or on the desktop → the phone → Unpair.

### 9.3 How it works

- A Rust core (`hive-net` + `workspace-doc` + view models) behind UniFFI, UIKit shell,
  like Zeron's mobile rewrite. iroh's Swift xcframework is published for iOS.
- **Foreground only.** iOS suspends sockets in the background (Apple TN2277); the app
  reconnects on open.
- **Push needs a server.** The host sends "needs you / finished / failed" to a small push
  relay that holds the APNs credentials; payloads carry ids and short text only, and a
  notification action posts the approval back through the relay to the host as an
  idempotent intent. This is the only hosted service besides relays.
- Views on the phone run in a WKWebView host that speaks view protocol 1.5 over
  `hive/view/1`.

### 9.4 Done when

- Pair, get a push, approve from the lock screen, and the agent continues — end to end on
  a real iPhone, host behind home NAT, phone on cellular.

---

## 10. Security

- **Transport:** iroh E2E encryption (QUIC/TLS, Ed25519 identities). Relays and the DNS
  lookup service see which keys talk, when and how much; never content.
- **Tickets are not authorisation.** iroh tickets are reusable and reveal IP addresses.
  Invites carry the host id and a secret in the URL fragment; the secret is exchanged once
  on `hive/pair/1` and bound to the guest's `EndpointId`.
- **The document is untrusted input.** The host validates every update and every intent;
  the ACL is never in the document.
- **Driving an agent is remote code execution.** It is never the default, never on a link,
  needs a confirm, is logged, and can be revoked live. The host can always take the
  keyboard back.
- **Files:** `hive/fs/1` enforces path containment on the owning machine; `.git`
  internals are never served; ignored files (like `.env`) are refused unless the owner
  turns on "share ignored files" per frame.
- **Audit:** `<userData>/audit.jsonl` on each machine: actor, intent, target, outcome.
- **Keys:** device key in the OS keychain (a 0600 file under `hive host`); losing a device
  → unpair it from any other device of yours, which adds its certificate to a revocation
  list in the owner-only document; hosts refuse it from then on.
- **Person key compromise** (a device holding it is stolen and not merely lost): rotate the
  person key from a remaining device. This re-signs your device certificates and access
  entries and derives new workspace keys, so existing invite links stop working and guests
  need new ones. Documented as a deliberate, rare procedure, not automated.
- **Host records** are only followed when signed by the workspace key and newer (`seq`)
  than the last one seen; a stale or forged record cannot redirect guests.
- **Only the owner's devices can host.** A guest's machine can be an executor for its own
  frames (§5.4) but never holds the document authority or the access list.

---

## 11. Milestones

| # | Milestone | Contents | Gate |
|---|---|---|---|
| M0 | Phase 0 | R1–R13 | Single-user app unchanged in behaviour; full e2e suite and installer tests green; perf re-profile no worse |
| M1 | Multiplayer, board only | Share, join, presence, board edits, roles, remove | Two instances on different networks edit together; revoke works |
| M2 | Multiplayer, terminals | Terminal streams, keyboard handover, prompts answered by guests | Handover and reconnect e2e; 5-person load gate (§4.4) |
| M3 | Your devices | Pairing, device workspaces in Recent, executor machine over iroh | Laptop drives desktop over the internet with no ssh |
| M4 | Agents on my machine in their workspace | Frames on guest machines, per-machine ACL, hand off by branch/bundle | §5.6 |
| M5 | Phone | iOS app, push relay, approvals, views on phone | §9.4 |

---

## 12. Open questions

1. Hosted pieces: self-host `iroh-relay` + push relay, or n0 Pro relays + our push relay?
   (Cost vs. operations.)
2. Should a workspace outlive its host — e.g. an always-on machine that becomes the host?
   (Design allows it: the host is just the machine whose hive-net holds authority.)
3. Guest agent logins: an agent on the host runs with the host's API keys even when a guest
   drives it. Show a "billed to Adarsh" note? Allow per-guest limits?
4. Sticky notes and other board objects: in scope for M1, or later?
5. Intel Macs: the release publishes arm64 only; hive-net inherits that.
6. Windows as a host for others: `remote-machines` §12 kept Windows out of scope as a
   *remote* host; iroh removes the ssh reason, but the daemon on Windows needs the same
   e2e coverage.

---

## Sources

- iroh: [1.0 announcement](https://www.iroh.computer/blog/v1),
  [endpoints](https://docs.iroh.computer/concepts/endpoints.md),
  [tickets](https://docs.iroh.computer/concepts/tickets.md),
  [relays](https://docs.iroh.computer/concepts/relays),
  [endpoint hooks](https://docs.iroh.computer/connecting/endpoint-hooks),
  [security & privacy](https://docs.iroh.computer/concepts/security-privacy.md),
  [Swift](https://docs.iroh.computer/languages/swift.md),
  [pricing](https://www.iroh.computer/pricing),
  [@number0/iroh](https://www.npmjs.com/package/@number0/iroh)
- Loro: [docs](https://github.com/loro-dev/loro-docs), [loro-crdt](https://www.npmjs.com/package/loro-crdt),
  [iroh-loro](https://github.com/loro-dev/iroh-loro)
- [Figma multiplayer](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/),
  [tldraw sync](https://tldraw.dev/docs/sync),
  [Excalidraw E2EE](https://plus.excalidraw.com/blog/end-to-end-encryption),
  [Zed collaboration](https://zed.dev/docs/collaboration/overview),
  [Zed remote development](https://zed.dev/docs/remote-development)
- [Live Share security](https://learn.microsoft.com/en-us/visualstudio/liveshare/reference/security),
  [upterm](https://github.com/owenthereal/upterm), [tmux window-size](https://github.com/tmux/tmux/blob/master/options-table.c)
- [Zeron architecture](https://github.com/zeronsh/zeron/blob/main/ARCHITECTURE.md),
  [Zeron iOS rewrite](https://github.com/zeronsh/zeron/pull/570),
  [Zeron push](https://github.com/zeronsh/zeron/pull/589)
- [Apple TN2277 (background sockets)](https://developer.apple.com/library/archive/technotes/tn2277/_index.html)
