# Multiplayer, other devices, phone — design

**Status:** proposed, rev 1. **Date:** 2026-09-28. **Supersedes:** the transport and phone
sections of `remote-machines-2026-09-11.md` (§7b, §12c). Its ssh path stays.

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

### R1. Workspace store in main

- **What.** Move the core layout blob and the per-view layout blobs out of renderer
  `localStorage` into a `WorkspaceStore` in main: one writer, change events, a snapshot
  per repo on disk (`<userData>/workspaces/<repo-hash>.json`). The renderer mirrors it
  over IPC and sends edits as operations (`frame.move`, `tile.rename`, …), not whole blobs.
- **Files.** `canvas-persistence.ts`, `view-layout-store.ts`, `canvas-layout.ts`,
  `windows-layout.ts`, `Workspace.tsx` (state becomes a mirror), `main/index.ts`, new
  `main/workspace-store.ts`, `shared/ipc.ts`, `preload/index.ts`.
- **Migration.** On first run, main reads each repo's localStorage blobs once (sent by the
  renderer), writes them to the store and marks them migrated. The blobs stay as a
  fallback for one release.
- **Unblocks.** Everything: HCP `tile.list` without a renderer, several windows, remote
  peers.
- **Done when.** All e2e specs green; `tile.list` answers with the window closed; the
  canvas round-trips through a restart with localStorage cleared.

### R2. The store becomes a Loro document

- **What.** `WorkspaceStore` keeps its API and is backed by one `LoroDoc` per workspace.
  Schema in §8. Local undo moves to Loro's `UndoManager` (this peer's edits only).
- **Files.** `main/workspace-store.ts`, new `packages/workspace-doc` (schema, typed
  accessors, validation, shared with the phone later).
- **Done when.** Snapshot + update export/import round-trip tests; two in-process docs
  editing concurrently converge (fuzz test); undo only reverts local edits.

### R3. Identity

- **What.** A **device** identity: an Ed25519 key generated once, kept in the OS keychain,
  whose public half is the iroh `EndpointId`. A **person** profile: display name and
  colour, set on first use (prefilled from git config). Every document edit carries the
  person's peer id; every PTY write carries it too (R4).
- **Files.** new `main/identity.ts`, `settings-store.ts` (profile), Settings UI panel.
- **Done when.** The key survives restarts and upgrades; the profile shows in Settings.

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
- **Files.** new `main/intents.ts`, `main/hcp/methods.ts`, IPC handlers in `main/index.ts`.
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

- **What.** The host's ACL: `endpointId → { person, role, grantedAt, expires? }`, stored
  locally (`<userData>/access.json`, 0600), never in the shared document. Roles in §6.
  Revoking closes live connections.
- **Files.** new `main/access.ts`, `crates/hive-net` (reads it), Settings → People panel.
- **Done when.** A revoked peer is disconnected within a second and cannot reconnect.

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

**Order:** R1 → R2; R3 in parallel; R4 in parallel; R5 after R1; R6 after R5; R7 after R5;
R8 after R7; R9 any time before Phase 2; R10–R11 after R3; R12 any time; R13 before
Phase 1 ships.

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

**Keys:** `⌘⇧S` share · `⌘⇧K` take keyboard back · `F` on an avatar to follow · `Esc`
stops following.

### 4.3 How it works

- Host's hive-net accepts `hive/ws/1` connections from peers on its ACL.
- **Document sync:** on join the host sends a Loro snapshot, then both sides exchange
  updates (`export({mode:"update", from: vv})`) over one reliable stream. The host
  validates each guest update against the guest's role (a "Can view" guest's updates are
  dropped) before applying and rebroadcasting.
- **Presence:** Loro `EphemeralStore` (cursor, camera, selection, typing-in), throttled to
  50 ms, sent as datagrams; receivers interpolate. Never stored.
- **Terminals:** a guest subscribes to a session; the host opens one uni stream per
  subscribed session carrying daemon `data`/`resync`, and an input stream when the guest
  holds the lease (R4). Only visible tiles are subscribed (the existing interest rule).
- **Intents** (R7) travel on a `hive/ctl/1` stream: request/response with ids.

### 4.4 Done when

- Two people on different networks (one behind a mobile hotspot) edit one board with
  cursors under 150 ms p95 on a direct link, 300 ms through the relay.
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
   see and control everything on each other." **Pair**.
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
  meta: Map        { id, name, hostMachine, schema: 1 }
  machines: Map    machineId → Map { endpointId, label, owner }
  frames: Tree     node data: Map { title, color, machine, path, branch, worktreePath, rect{x,y,w,h}, z }
  tiles: Map       tileId → Map { kind, frame, name, cmd, args, session, pinned, pinAnchor, created{by, at} }
  order: MovableList   tile ids for Windows-view tab order
  views: Map       viewId → Map (shared view layout, e.g. canvas positions/sizes)
  notes: Map       noteId → LoroText   (future sticky notes)
```

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
- **Keys:** device key in the OS keychain; losing a device → unpair it from any other
  device of yours.

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
