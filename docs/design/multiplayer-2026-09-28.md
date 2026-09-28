# Multiplayer, other devices, phone — design

**Status:** accepted 2026-09-28, rev 4. **Date:** 2026-09-28. **Supersedes:** the transport
and phone sections of `remote-machines-2026-09-11.md` (§7b, §12c). Its ssh path stays.

**Progress:** [`docs/plans/multiplayer.md`](../plans/multiplayer.md) (start here) ·
**Research:** [`multiplayer-2026-09-28-research.md`](multiplayer-2026-09-28-research.md)

**Rev 2 decisions (2026-09-28):** we run our own relay, address lookup and push server
(§12); a workspace outlives its host (§5.7–5.9); sticky notes and other board objects ship in
the first multiplayer milestone (§4.2 G).

**Rev 3 (2026-09-28):** hivemind is open source, so our servers are never a requirement: a
local-network mode with no servers, self-hosting every server role from the same binary we
run, and one device serving a small group (§13).

**Rev 4 (2026-09-28):** our servers are **not the default**. A fresh install is on the local
network and uses no servers at all. The first time you reach beyond your network, hivemind
asks how: our servers, your own, one of your devices, or not at all (§13.3 E).

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
| D8 | **We run our own infrastructure:** iroh relays, address lookup (pkarr DNS) and a push server, for people who choose them (D11). No third-party relay or push service carries hivemind traffic. | Decided 2026-09-28. Public n0 relays are dev-only; a push relay must hold our APNs/FCM credentials anyway. |
| D9 | **A workspace outlives its host.** Each of the owner's devices keeps a full replica of the document and the access list; hosting can move to an always-on machine (`hive host`), or any of the owner's devices can take it over. | Decided 2026-09-28. The CRDT makes failover a merge, not a recovery. |
| D10 | **Board objects** — sticky notes, checklists, text labels, arrows — live in the shared document from the first multiplayer milestone. | Decided 2026-09-28. A shared board without shared notes is a screen share. |
| D11 | **Our servers are optional, and not the default.** A fresh install is on the **local network** and uses no servers at all — ours, n0's or anyone's. The first time you reach beyond your network, hivemind asks how (§13.3 E). Every server role (relay, lookup, access, push) is part of the MIT-licensed `hive-net` binary; every address comes from a **network profile**, never a constant. Our hosted network runs the same binary as anyone else. | hivemind is open source (MIT): people must be able to run it entirely on their own machines and networks, and nothing should leave their network unless they chose it (§13). |

Rejected: Tailcat (point-to-point pipes, no multiplexing or datagrams, Go-only, v0.x);
Yjs (no movable tree; no native Swift core); a central server that holds workspaces and
terminal output (cost, accounts, and everyone's sessions in one place). The servers we do
run (§12) only forward encrypted packets, look up addresses and wake phones.

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
  disk (`<userData>/workspaces/<repo-hash>.json`). The renderer reads it synchronously over
  IPC (as `settingsSync` already does) and writes debounced snapshots of the same shapes it
  saves today. Edits as operations (`frame.move`, `tile.rename`, …) come with R2, where each
  one becomes a Loro change; doing operations twice would be wasted work.
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
- **Unblocks.** Everything: HCP `tile.list` without a renderer (R5), several windows, remote
  peers.
- **Done when.** All e2e specs green; the canvas round-trips through a restart with
  localStorage cleared. (`tile.list` without a window moved to R5: today closing the last
  window quits the app, and R5 is where the live tile state moves into main.)

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
- **Done when.** HCP `tile.list`, spawn, close and rename work with no window (the tile
  list built by one shared function from main's store and status store, which the window
  also uses); two windows on one workspace show the same terminals live.

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
- **Takes its whole network setup from a network profile (R16):** relays, lookup, access,
  push — or **local mode**: no relays, mDNS lookup (`iroh-mdns-address-lookup`), direct
  connections (§13.4).
- **Also the server:** `hive-net serve --relay --lookup --access --push` runs any mix of the
  server roles (§13.4). `hive serve` wraps it.
- **Files.** new `crates/hive-net`, `.github/workflows/release.yml`, `scripts/*install*`,
  installer tests.
- **Done when.** Two machines ping each other by `EndpointId` through a relay run by
  `hive-net serve --relay` and directly; two machines on one Wi-Fi with no internet find
  and connect to each other in local mode; release artifacts include it; installer tests
  green.

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

### R13. Our relays, address lookup and relay access

- **What.** Stand up the infrastructure in §12.1–12.3 — three relays, one lookup server,
  the relay-access service — each running `hive-net serve` with the matching role, so our
  hosted network runs exactly the code self-hosters run (D11). Our network is the built-in
  *Hosted* profile (R16), **used only by devices whose owner chooses it** (§13.3 E). Then
  `hive-net` uses it (`presets::Minimal`, `RelayMode::Custom` with the same relay map on
  every device, `PkarrPublisher`/`PkarrResolver` pointed at our lookup server) and
  registers its device key with the access service. Until then it never contacts them.
- **For self-hosters:** `infra/compose.yml` runs every role on one machine, and a
  **self-hosting guide** goes on the docs site. The compose stack runs in CI, so it cannot
  rot.
- **Files.** new `infra/` (Terraform or `gcloud` scripts, role configs, `compose.yml`),
  `.github/workflows/infra.yml` (manual dispatch), `crates/hive-net` (relay map, lookup,
  registration, `home_relay_status()` watch), `docs/src/content/docs/guide/self-hosting.md`.
- **Done when.** Two hive-net instances on different networks connect through each relay
  and directly; a device that never registered is refused by the relays; lookup of a
  published endpoint and of a host record works from a third network; a relay restart is
  survived by reconnecting clients; the same checks pass against the compose stack.

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

### R16. Network profiles and admission

- **What.** Everything a device needs to know about a network, as one signed file (§13.2):
  relays, lookup, access and push URLs, the admission policy, the admin's public key,
  local-mode switches. Built in: *Local network* (no servers) — **the default** — and
  *Hosted* (ours), off until chosen. Distributed by pairing (a new device inherits it), by
  link or QR, or by `hive network use <file>`. Settings → **Network** shows the active
  profile and its health; `hive network show | use | doctor` does the same from a terminal.
- **The reach chooser** (§13.3 E): the sheet that appears the first time something needs to
  reach beyond the local network, and the same choice in Settings → Network.
- **Update check switch:** the app's existing update check (GitHub releases, `main/index.ts`)
  moves under Settings → Network with an off switch, so a fully offline install makes no
  outside connection at all. It stays on by default; it is not part of the multiplayer
  network.
- **Admission** (enforced by the access role, §12.3): `open-pow` (our hosted network),
  `closed` (self-hosted default: devices enrolled by the admin or by an enrolled device),
  and **vouchers**: a host signs a time-limited admission for a guest's device key when it
  invites them, so guests from other networks can use the host's relays (§13.3 D).
- **Files.** `crates/hive-net` (profile loading, verification), `packages/workspace-host`
  (profile store), Settings → Network panel, `apps/cli/src/commands/network.ts`.
- **Done when.** A fresh install makes no network connection outside the local network
  (update check off) — not to our servers, not to n0's; a device switched between Local
  network, Hosted and a self-hosted profile talks only to that profile's servers (both
  checked by capturing traffic in the e2e run); a guest from another network joins with a
  voucher and is refused once it expires.

**Order:** R1 → R2 → R15; R3 in parallel; R4 in parallel; R5 after R1; R6 after R5; R7
after R5; R8 after R7; R9 any time before Phase 2; R10–R11 after R3; R16 with R10; R12 any
time; R13 before Phase 1 ships; R14 after R1, R7, R10 and R11.

**Local network mode lands first.** It needs no servers, so Phase 1 is developed and
e2e-tested on it; the hosted network (R13) then adds reaching across the internet.

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
4. **Who can use it.** On the local network (the default) the sheet says "Works for people
   on this network" and lists **Nearby people** to invite directly. **Invite someone
   elsewhere…** opens the reach chooser (§13.3 E) the first time; once a way to reach out
   is chosen, links work across networks.
5. Empty state before anyone joins: "Nobody here yet. Share the link."

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
   back. A workspace hosted on an always-on machine (§5.7) never goes offline this way;
   only the frames that run on the sleeping laptop grey out.

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
   code, valid for 5 minutes, and lists **Nearby** devices on the same network.
2. On device B: Settings → Devices → **Pair with a device** → scan or type the words, or pick
   A from Nearby (both screens then show the same six words to confirm). A device that is
   not on this network — a server, a laptop at home — needs a way to reach it: the reach
   chooser (§13.3 E) opens first.
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
2. On the laptop: Settings → Devices → **Pair with a device** → the words. A box on the same
   network pairs directly. A server elsewhere needs a way to reach it, so the reach chooser
   (§13.3 E) opens; for a VPS with a public address the natural pick is **Serve from one
   of my devices** — `hive host pair --serve` makes the server itself your network (relay
   and lookup), with no third party involved.
3. The server appears under Devices with an **Always on** badge and under Machines.
4. Errors: server unreachable → "Can't reach *home-server*. Is `hive host` running?" with
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
  (a person key). The current host is named by a **host record**: a pkarr packet signed by
  the workspace key (R3), holding one TXT record `_hive host=<endpointId>;seq=<n>`,
  uploaded to our address-lookup server with `PUT /pkarr/<z32 workspace public key>`
  (§12.2). The server accepts any correctly signed packet up to 1000 bytes and keeps the
  newest; it evicts a packet not republished for 7 days, so the host republishes hourly and
  on every move. Readers fetch `GET /pkarr/<key>` and verify the signature themselves.
  Invites carry the workspace public key, so guests can always find the current host. The
  record reveals only which endpoint hosts the workspace, which iroh treats as public
  anyway; the access list still decides who gets in.
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
2. **Away from this network?** On the local network (the default) the phone works only on
   the same Wi-Fi and only while the app is open. The pairing sheet asks once:
   - *Use hivemind's servers* — reach your devices from anywhere; notifications through our
     push server, which only ever sees encrypted content.
   - *Use my network's servers* — the network you already chose (self-hosted or a device
     that serves).
   - *Only on this Wi-Fi* — no servers, notifications only while the app is open (Android:
     UnifiedPush if a push server runs on this network).
   This is the reach chooser (§13.3 E), phrased for a phone.
3. **Home: Needs you.** A list, most urgent first: agent, workspace, machine, reason
   (permission · question · plan), how long it has waited. Empty state: "Nothing needs
   you. 4 agents working."
4. **Push notification.** "*api · Fix nav overflow* needs permission: Edit Nav.tsx" with
   **Allow** / **Deny** actions on the notification itself; tap opens the item.
5. **Answer.** Permission → Allow once / Always / Deny. Question → the options as buttons,
   plus a text box. Plan → the plan as text, Approve / Ask for changes.
6. **Watch.** Tap an agent → a live terminal, read-only by default, scaled to width;
   pinch to zoom. **Type** asks for the keyboard like a guest; the reply box sends one
   line through the task-delivery path, which is easier than typing into a TUI.
7. **Views.** A tab bar: *Needs you* · *Working* · *Board* (a compact list of frames and
   tiles) · community views that declare phone support (R12 `hello.device.compact`).
8. **Offline host.** "Desktop is asleep. You'll get a notification when it's back." The
   last known state is shown with its age.
9. **Unpair.** Settings on the phone or on the desktop → the phone → Unpair.

### 9.3 How it works

- A Rust core (`hive-net` + `workspace-doc` + view models) behind UniFFI, UIKit shell,
  like Zeron's mobile rewrite. iroh's Swift xcframework is published for iOS.
- **Foreground only.** iOS suspends sockets in the background (Apple TN2277); the app
  reconnects on open.
- **Push goes through our push server (§12.4), which never sees content.** The host
  encrypts "needs you / finished / failed" to the phone's push key and sends only the
  ciphertext and an opaque handle. The server wakes the phone through APNs or FCM with a
  generic alert; on iOS a Notification Service Extension decrypts the real text on the
  device (it has about 30 seconds). Only hosts the phone has authorised can push to it.
- **Answers never go through the push server.** Tapping **Allow** / **Deny** (marked
  `.authenticationRequired`, so the phone must be unlocked) wakes the app in the
  background for about 30 seconds — Apple does not guarantee it — and the app dials the
  host over iroh and sends a signed, idempotent approve intent. If the host cannot be
  reached in about 20 seconds, the phone shows "Open hivemind to answer" instead.
- **The phone needs our own Rust layer.** iroh's Swift/Kotlin bindings (`iroh-ffi`,
  1.1.0) set relays and auth tokens but cannot point address lookup at our server, so the
  app links the `hive-net` crate through UniFFI, as Zeron does.
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
- **What our servers see** — only for people who chose *Hosted* (§13.3 E). Relays and the
  lookup server: which device keys connect, which pairs talk, when and how much; never
  content. The lookup server also holds host records,
  readable by anyone who has a workspace's public key. The access service: registered
  device keys and connection counts. The push server: handles, times and sizes of
  ciphertexts; never titles, names or content. Metrics ports are never public. A
  self-hosted network's servers (§13) see exactly the same and no more, and a
  local-network setup has no servers to see anything.
- **Nobody can push to a phone it has not paired with**, and a push that decrypts to
  something stale, duplicated or not signed by a paired host is dropped on the phone.

---

## 11. Milestones

| # | Milestone | Contents | Gate |
|---|---|---|---|
| M0 | Phase 0 | R1–R16; local network mode first (the default); then relays, lookup server and relay access live (§12.1–12.3), all from `hive-net serve`; `infra/compose.yml` and the self-hosting guide | Single-user app unchanged in behaviour; full e2e suite and installer tests green; perf re-profile no worse; a fresh install makes no connection outside the local network; two devices with no internet connect in local mode; R13's network checks pass from three networks and against the compose stack; no connection outside the active profile (§13.4) |
| M1 | Multiplayer, board | Share, join, presence, board edits, **sticky notes, checklists, text, arrows**, roles, remove — in every network mode (§13.1) | On one local network with no servers, then across two networks: people edit together; three people in one note (§4.4); revoke works; a guest from a self-hosted network joins a hosted workspace by voucher |
| M2 | Multiplayer, terminals | Terminal streams, keyboard handover, prompts answered by guests | Handover and reconnect e2e; 5-person load gate (§4.4) |
| M3 | Your devices and always-on hosting | Pairing (person key, device certificates), device workspaces in Recent, executor machine over iroh, `hive host`, moving and taking over hosting | Laptop drives desktop over the internet with no ssh; §5.9 |
| M4 | Agents on my machine in their workspace | Frames on guest machines, per-machine ACL, hand off by branch/bundle | §5.6 |
| M5 | Phone | iOS app (Rust core via UniFFI), push server (§12.4), approvals from notifications, views on phone; Android after, with FCM and UnifiedPush (§13.4) | §9.4; push content never readable on the server (checked by inspecting stored and logged data); an Android phone on a local network with no internet gets a notification through UnifiedPush |

**Before M5 starts:** Apple Developer Program membership and a Firebase project (§12.4).

---

## 12. Our infrastructure

Decided: we run all of it (D8), **for people who choose it** — it is the *Hosted* network
profile, never the default (D11, §13). Four pieces; the first three are needed before M1,
the push server before M5. Versions pinned; **relays and the lookup server are upgraded before
clients**, since iroh 1.x keeps the wire protocol compatible across minor versions but its
public relays run only the newest major.

```
                         ┌── euw1.relay.hivemind.griiken.com ──┐
 hive-net (laptop) ──────┼── use1.relay.hivemind.griiken.com ──┼────── hive-net (guest, phone)
                         └── aps1.relay.hivemind.griiken.com ──┘
        │  publish/resolve              │ "may this endpoint use the relay?"
        ▼                               ▼
 dns.hivemind.griiken.com       access.hivemind.griiken.com  (Cloud Run, 2 regions)
 (iroh-dns-server, pkarr)                │
                                 push.hivemind.griiken.com   (Cloud Run)  ──► APNs / FCM ──► phone
```

### 12.1 Relays

- **Three relays**, one per region: `euw1` (Belgium, next to the site's `europe-west1`),
  `use1` (US East), `aps1` (Asia-Pacific; Singapore unless most users are elsewhere).
  Each is **one process behind one hostname**. A relay keeps its clients in memory and
  drops packets for clients connected to another process, so relays are never put
  behind a load balancer; capacity grows by adding hostnames to the relay map.
- **Where:** small Compute Engine VMs with static IPv4 and IPv6, in the site's GCP project.
  Not Cloud Run: it cannot take UDP, cuts WebSockets at its request timeout, and runs
  several instances.
- **Software:** `hive-net serve --relay` under systemd — our binary embedding `iroh-relay`
  1.3 (`server` feature), the same one self-hosters run (§13.4). Its `AccessControl` asks
  the access service and caches each answer for five minutes, so a short access-service
  outage does not lock anyone out. The stock `n0computer/iroh-relay:v1.3.0` image with
  `access.http` is the fallback while the prototype is built.
- **Config** (TOML): `[tls] cert_mode = "LetsEncrypt"` (it obtains certificates itself over
  TLS-ALPN-01 on 443), `enable_quic_addr_discovery = true`, a per-connection limit in
  `[limits.client.rx]` (start at 4 MB/s, burst 8 MB), `metrics_bind_addr` on the private IP,
  and admission checked through the access service (§12.3).
- **Firewall:** 443/tcp (relay over WebSocket, `/ping`, `/healthz`), 80/tcp (captive-portal
  probe), 7842/udp (QUIC address discovery). Port 9090 (metrics) only from our monitoring.
  Clients need outbound 443 with WebSocket upgrades, and ideally outbound UDP.
- **Sizing:** n0 quotes up to 60,000 concurrent connections per relay; no official CPU or
  RAM figures exist, so we size from the metrics. Relays only carry traffic that could not
  go direct (about 1 in 10 networks); terminal output is small, so the cost to watch is
  internet egress per GB, not the VMs.

### 12.2 Address lookup

- **One `iroh-dns-server`** at `dns.hivemind.griiken.com`, on its own small VM (it keeps
  signed packets in a local database file, so it is not replicated). It runs
  `hive-net serve --lookup`, which embeds `iroh-dns-server` 1.3 (a library as well as a
  binary); the stock `n0computer/iroh-dns-server:v1.3.0` image serves the prototype.
- Config: `[https]` on 443 with `cert_mode = "lets_encrypt"` **and `letsencrypt_prod =
  true`** (without it the staging CA is used), `pkarr_put_rate_limit = "smart"`, metrics on
  127.0.0.1.
- Clients publish their endpoint record and resolve others over **HTTPS**
  (`/pkarr/<key>`), so no DNS delegation is needed at first; the DNS port can be opened
  later.
- It also stores **workspace host records** (§5.8): any Ed25519-signed pkarr packet is
  accepted, newest wins, 1000-byte limit, evicted after 7 days without republish.
- If it is down: new lookups fail, but peers that already know each other's relay (from
  pairing or an earlier connection) still connect. Nightly backup of its database.

### 12.3 Relay access

hivemind has no accounts, so "who may use our relays" cannot mean "who is signed in". For
each new connection the relay asks our access service about the connecting endpoint id
(which the relay handshake has already proven) — through `hive-net serve --relay`'s
`AccessControl`, or through `access.http` (admit only on HTTP 200 with the body `true`) on
a stock relay. The same service implements every admission policy of §13
(`open-pow` here, `closed` and vouchers for self-hosted networks).

- **Registration.** When a device's owner chooses *Hosted* (§13.3 E), hive-net registers its
  device key with the access service: it signs a challenge and solves a small
  proof-of-work (about a second), which makes mass registration expensive. Registered keys
  are allowed.
- **Abuse.** Per-connection rate limits on the relays; a denylist in the access service;
  per-key connection counts reported from relay metrics.
- **Where:** a small Rust service on Cloud Run in two regions (`europe-west1`,
  `us-east1`), each relay pointed at the nearer one, backed by Firestore (as the HiveHub
  plan proposes). If it is unreachable the relay refuses new connections, so it runs in
  two regions and is monitored like the relays.
- We do **not** use the relay's `shared_token` mode: a token shipped in the app can be
  extracted and can only be revoked by restarting the relays.
- Later, if the access check becomes a bottleneck even with caching: the access service
  issues short-lived signed tokens and the relay's `AccessControl` verifies them without
  a network call.

### 12.4 Push server

Built for M5. It holds our APNs and FCM credentials and nothing else of value.

- **Stack:** the `push` role of `hive-net serve` (§13.4). Rust, `axum` + `apns-h2`
  (Threema's maintained successor of `a2`, MIT) + `reqwest`/`yup-oauth2` for FCM HTTP v1,
  plus UnifiedPush (Web Push encryption, RFC 8291) for Android without Google; the
  structure of Threema's `push-relay` (MIT/Apache) is the reference. Ours runs on Cloud
  Run, `europe-west1`, Firestore; APNs `.p8` key and FCM service account in Secret
  Manager.
- **Phone registers** with the push server: platform, APNs environment, device token and its
  push public key, signed by the phone's device key. The server returns a random 128-bit
  **handle**. The phone re-registers on every launch (tokens change); the handle stays.
- **Phone authorises hosts.** When pairing, the phone gives the host `{push URL, handle,
  push public key}` over iroh and tells the push server, in a message it signs: "host key
  K may push to this handle until T". Unpairing sends a signed revocation.
- **Host pushes** `{handle, msgId (random 128-bit), ts, ttl, priority, ciphertext}` with an
  Ed25519 signature by its device key over the method, path, body hash and time. The server
  checks the signature, that K is authorised for the handle, the time is within ±60 s, the
  `msgId` is new (replay cache), the size fits a padding bucket, and per-host and
  per-handle quotas. Unknown handles and unauthorised senders get the same error.
- **End-to-end encryption.** The host encrypts to the phone's push key (HPKE, X25519); the
  plaintext carries the message id, host id, time, expiry and the host's signature, padded to
  fixed sizes (about 2.5 KB usable within the 4096-byte APNs/FCM limit). The server sends:
  - **APNs:** `alert` push, priority 10, `mutable-content: 1`, generic text ("hivemind — an
    agent needs you"), an opaque collapse id, expiry 1 hour; the phone's Notification
    Service Extension decrypts and replaces the text and picks the action category.
  - **FCM:** a high-priority **data** message (notification messages cannot be end-to-end
    encrypted); the app builds the notification and its buttons.
- **Stores only** handle → token (encrypted at rest), authorised host keys and counters. No
  titles, no content, no workspace names.
- **Token hygiene.** APNs 410 / FCM `UNREGISTERED` delete the token; the next push from a
  host gets 410 so the host drops the handle. APNs JWT refreshed every 20–60 minutes; 5xx
  retried with backoff.
- **Prerequisites:** an **Apple Developer Program** membership ($99/year; the project has
  none today — the same membership also lets us sign and notarise the macOS app) and a
  Firebase project for FCM (free).

### 12.5 Operations

- **Monitoring:** Prometheus scrapes relays (9090, private), the lookup server (9117,
  local) and the services; alerts on relay `send_packets_dropped`,
  `bytes_rx_ratelimited_total`, access-service errors, APNs 403/410/429 rates and FCM
  quota errors. `/healthz` on every relay from an uptime check.
- **Deploys:** `infra/` holds the VM definitions, configs and service Dockerfiles;
  `.github/workflows/infra.yml` deploys on manual dispatch. Relays roll one region at a
  time; the relay map lists all three, so clients fail over.
- **Staging:** one extra relay and lookup server that pre-release builds point at, so a
  relay upgrade is tried before production.
- **Cost:** four small VMs plus egress, Cloud Run and Firestore (inside the free tier at
  first), and the Apple membership. Estimate with the GCP calculator before M0 ends; the
  number to watch is relay egress.
- **Self-hosting by others:** everything above is the *Hosted* network profile; §13 covers
  running any or all of it yourself, or using no servers at all.

## 13. Open source: run it your way

hivemind is MIT-licensed, so none of this may depend on us (D11). Four rules:

- **The local network is the default.** A fresh install uses no servers at all — not ours,
  not n0's, not anyone's. Every device works on a local network with nothing else.
- **Reaching further is a choice you make, once.** The first time something needs to reach
  beyond your network, hivemind asks how (§13.3 E). Our servers are one of the answers,
  never the assumed one.
- **No private server code.** Every server role in §12 is part of the `hive-net` binary in
  this repo (`hive serve …`), under MIT. Our hosted network runs exactly that binary.
- **Every address is configuration.** Where a device finds relays, lookup, admission and
  push comes from a network profile, never from a constant in the code.

### 13.1 Network modes

| Mode | For | Servers | Works | Doesn't |
|---|---|---|---|---|
| **Local network** (default) | A home or office network — say 4–5 devices — including offline and air-gapped | None | Pairing, multiplayer, board objects, hosting, agents on any machine, the phone while its app is open | Devices outside that network; iPhone notifications (APNs needs the internet) |
| **Hosted** (hivemind's servers, by choice) | People who want to reach anyone, anywhere, with nothing to set up | Ours (§12) | Everything, across the internet | — |
| **Self-hosted** | Companies, privacy, regulated sites | Theirs — one machine can run every role | Everything, including people working from outside | Our App Store iPhone app cannot use *their* push server (§13.4) |
| **This device serves** | One laptop, desktop, VPS or small box acting as the server for a group | That device | What self-hosted does, while that device is awake and reachable | From outside the network, a laptop behind home NAT is reachable only with a forwarded port or a VPN |

A device has one **home network**, the local network until you choose otherwise. Local
discovery stays on whichever you choose, so devices on the same network always connect
directly. Workspaces on other networks are reachable through their invites (§13.3 D).

### 13.2 Network profiles

A small file, signed by the network's admin key, saying where the network's servers are:

```
name
relays[]            URL, optional pinned certificate
lookup              URL (pkarr)
access              URL, policy: open-pow | closed
push                URL, kinds: apns | fcm | unifiedpush
admin               public key (verifies enrolments and profile updates)
local               mDNS on/off, direct connections on/off, relays off (local mode)
```

- **Built in:** *Local network* (no servers, mDNS on) — **the default** — and *Hosted*
  (ours), used only once chosen.
- **Distributed** by pairing (a new device takes the profile of the device it pairs with),
  by a link or QR (`hivemind://network/<signed profile>`), or `hive network use <file>`.
- A profile change must be signed by the same admin key; devices show who signed it.
- Settings → **Network** shows the active profile and its health; `hive network doctor`
  checks the same from a terminal.

### 13.3 UX journeys

**A. Local network, no servers (4–5 devices in one office)**
1. Nothing to set up: a fresh install is already on the local network. Settings → Network
   reads "**Local network** — devices find each other on this network. Nothing leaves it.
   Devices outside it can't connect."
2. Settings → Devices → **Pair a device** lists **Nearby** devices ("office-nuc", "Priya's
   laptop"). Pick one; both screens show the same six words; confirm on both, so a
   stranger on the same Wi-Fi cannot slip in.
3. One machine hosts: an office box runs `hive host` (R14); workspaces move to it (§5.7);
   laptops come and go.
4. Share a workspace: the invite sheet lists **Nearby people** first; a link or QR carries
   local addresses and works on this network only.
5. Phones on the office Wi-Fi pair by QR and work while the app is open. Notifications:
   Android through UnifiedPush with a push server on the same network (the `push` role, or
   ntfy); iPhone only while the app is open.
6. Multicast blocked or "client isolation" on (common on guest Wi-Fi): "Can't see other
   devices on this network." Offer **Enter an address** (shown on the other device), or ask
   one machine to **Serve this network** (journey C), which gives everyone a relay inside
   the network.
7. Laptop taken home: its office workspaces show "Not on the office network"; nothing is
   sent anywhere; they reconnect when it is back.

**B. Self-host everything (a company, or one person with a server)**
1. On a server: `hive serve --all --domain hive.example.com`, or `docker compose up` with
   `infra/compose.yml`. It lists the ports to open, obtains certificates, creates an admin
   key (backed up by the admin), and prints a **network link and QR**.
2. The admin opens the link on their laptop: "Use the *Example Corp* network, signed by
   …?" → **Use**. The link enrols the admin's device.
3. Colleagues join the network by pairing with an enrolled device, or through an enrolment
   link the admin sends. Devices that were never enrolled are refused by the relays
   (`closed` policy).
4. Push: Android through their own push server (UnifiedPush, or FCM with their own Firebase
   project and their own build of the app). iPhone: through our push server, which only
   ever sees ciphertext (§12.4), or their own build of the iOS app signed by their own
   Apple team.
5. Health: Settings → Network → "*Example Corp* · 3 relays ✓ · lookup ✓ · push ✓";
   `hive network doctor`.
6. Leaving: Settings → Network → back to Local network (or to Hosted). The company's
   workspaces stay reachable only if its network admits outside devices.

**C. This device serves the network**
1. Settings → Network → **Serve from this device** (or `hive serve --relay --lookup` on a
   headless box).
2. It checks and says how it can be reached: on the local network always; from outside
   only with a public address, a forwarded port or a VPN.
3. It shows a network QR for the other devices.
4. While it sleeps: "Devices outside this network can't reach you while *Adarsh's MacBook*
   is asleep." Devices on the same network keep connecting to each other directly.

**D. Joining a workspace that lives on another network**
1. The invite carries the host network's relays and lookup, so the guest's device uses them
   for this workspace only; its own home network is unchanged.
2. The host's relays admit the guest because the host **vouched** for them when inviting: a
   signed, time-limited admission for the guest's device key, given to the host network's
   access service (R16). The guest never registers with the host's network.
3. The joining side always dials the host, so the host never has to look the guest up on a
   lookup server it doesn't use.
4. A local-network workspace cannot be joined from outside it; the invite sheet says so.

**E. The first time you reach beyond your network (the reach chooser)**
1. **When it appears** — only when something needs a device outside this network:
   **Invite someone elsewhere…** (§4.2 A), pairing a device that is not nearby (§5.2), a
   server for always-on hosting (§5.7 A), a phone you want to use away from this Wi-Fi
   (§9.2). Never at first launch, never for someone who only works locally.
2. **The sheet:** "To reach devices outside this network, hivemind needs a way through.
   Choose one:"
   - **Use hivemind's servers** — free, nothing to set up. They forward encrypted traffic,
     help devices find each other and wake your phone; they never see your work.
     *What they see* expands to the list in §10.
   - **Use my own servers** — scan or paste a network link (journey B).
   - **Serve from one of my devices** — a machine with a public address or a forwarded port,
     such as a VPS running `hive host`, becomes your network (journey C).
   - **Not now** — stay on this network; the action that opened the sheet is cancelled with
     a one-line reason.
3. **After choosing:** the choice becomes the device's home network, is passed on to the
   devices you pair from now on, and shows in Settings → Network with **Change**. Choosing
   *Hosted* registers the device with our access service at that moment (§12.3), not
   before.
4. **Local stays local.** Whatever is chosen, devices on the same network keep finding and
   connecting to each other directly; the servers are used only for devices elsewhere.
5. **Going back:** Settings → Network → **Local network**. The device stops using the
   chosen servers at once; workspaces with people elsewhere show them as unreachable until
   a way through is chosen again.

### 13.4 How it works

- **Local mode:** no relays (`RelayMode::Custom` with an empty `RelayMap`), mDNS lookup
  (`iroh-mdns-address-lookup`, 0.4 for iroh 1.x), direct QUIC connections. iroh documents
  this fully air-gapped setup; it needs multicast forwarded and client isolation off.
  Invites and pairing also carry direct addresses, so manual entry works where mDNS does
  not. Host records travel peer to peer: any of the owner's devices answers "who hosts this
  workspace now?" with the signed record (§5.8).
- **One binary, every role:** `hive-net serve` embeds `iroh-relay` (`server` feature:
  `Server::spawn` with our `AccessControl`), `iroh-dns-server` (`Server::bind`), the access
  service and the push server; `--all` runs every role, and a TOML file configures them.
  Our hosted network (§12) and `infra/compose.yml` run this same binary.
- **Admission policies** in the access role: `open-pow` (our hosted network: anyone may
  register a device key with a small proof-of-work), `closed` (self-hosted default:
  enrolled devices plus vouchers), and none in local mode (no relays to protect).
- **Push kinds:**
  - **APNs** only reaches an iOS app signed by the same Apple team as the push server's key
    (Apple keys are team-scoped). A self-hoster cannot push to our App Store app; they use
    our push server, which relays only ciphertext to phones that authorised their hosts, or
    they build the iOS app under their own team.
  - **FCM** needs the Firebase project the Android build was made with: ours for the Play
    Store build, theirs for their own build.
  - **UnifiedPush** (Android): the app registers with a distributor app such as ntfy and
    gets an endpoint URL; our push role sends Web Push-encrypted messages (RFC 8291) to it.
    No Google, works on a local network, fits self-hosting. iOS has no equivalent.
- **Nothing phones home.** The default local profile contacts no server at all. hive-net
  never uses iroh's default presets (`presets::N0` would publish to n0's lookup server and
  use n0's relays); it builds from `presets::Minimal` plus whatever the active profile
  names. A self-hosted profile contacts only its own servers. An e2e test runs the app with
  only the profile's addresses reachable and fails on any other connection. The app's
  update check (GitHub releases) is separate from the network features and has its own
  switch (R16).

### 13.5 What this changes elsewhere

- **Phase 0:** R10 (profiles, local mode, `serve` roles), R13 (our network on the same
  binary, used only by choice, `compose.yml`, self-hosting guide), new R16 (profiles with
  Local network as the default, the reach chooser, admission, vouchers, the update-check
  switch).
- **Journeys:** inviting (§4.2 A), pairing (§5.2), always-on hosting (§5.7 A) and phone
  pairing (§9.2) open the reach chooser the first time they need a device elsewhere.
- **Order:** local network mode lands first — it is the default and needs no servers, so
  Phase 1 is built and e2e-tested on it — then the ways of reaching further.
- **M5:** UnifiedPush for Android alongside FCM.
- **Docs:** `guide/self-hosting.md` on the docs site: modes, profiles, `compose.yml`, ports,
  certificates, push options, backups.

### 13.6 To prove in the M0 prototype

1. A relay inside a local network has no public name for a Let's Encrypt certificate: pin a
   self-signed certificate in the profile, or run the relay over plain HTTP (relayed traffic
   is end-to-end encrypted anyway). Check which of the two iroh 1.x clients accept.
2. On iPhone, local discovery needs the Local Network permission and declared Bonjour service
   types; check iroh's mDNS works under them.
3. Corporate networks often block multicast; measure how often people fall back to entering
   an address or serving a relay.

## 14. Open questions

1. Guest agent logins: an agent on the host runs with the host's API keys even when a guest
   drives it. Show a "runs on Adarsh's account" note? Allow per-guest limits?
2. Intel Macs: the release publishes arm64 only; hive-net inherits that.
3. Windows as a host for others: `remote-machines` §12 kept Windows out of scope as a
   *remote* host; iroh removes the ssh reason, but the daemon on Windows needs the same
   e2e coverage.
4. The Asia-Pacific relay region: Singapore by default; move it if most users are
   elsewhere (e.g. Mumbai).
5. Our hosted relays admit any device that registers with a small proof-of-work, with rate
   limits on top. Acceptable for launch, or do we want accounts before opening them to
   everyone? (Self-hosted networks default to `closed` either way.)
6. Official iOS builds for self-hosters: publish a "bring your own Apple team" build guide,
   or keep iPhone push always through our push server (it sees only ciphertext)?

Resolved 2026-09-28: we run our own relay and push server (§12); a workspace outlives its
host (§5.7–5.9); board objects are in M1 (§4.2 G); our servers are optional and every role
can be self-hosted, including no servers at all on a local network (§13); the local network
is the default and our servers are used only by choice (§13.3 E).

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
- Our infrastructure (§12):
  [iroh-relay config (`main.rs`, v1.3.0)](https://github.com/n0-computer/iroh/blob/v1.3.0/iroh-relay/src/main.rs),
  [iroh-relay defaults](https://github.com/n0-computer/iroh/blob/v1.3.0/iroh-relay/src/defaults.rs),
  [relay client map (one process per relay)](https://github.com/n0-computer/iroh/blob/v1.3.0/iroh-relay/src/server/clients.rs),
  [self-hosted relays](https://docs.iroh.computer/iroh-services/relays/self-hosted),
  [rate limiting](https://docs.iroh.computer/relays/rate-limiting),
  [dedicated infrastructure](https://docs.iroh.computer/deployment/dedicated-infrastructure),
  [configuring networks](https://docs.iroh.computer/configuring-networks),
  [release policy](https://docs.iroh.computer/about/release-policy),
  [iroh-dns-server](https://github.com/n0-computer/iroh/tree/v1.3.0/iroh-dns-server),
  [pkarr](https://github.com/pubky/pkarr),
  [iroh-ffi relay/endpoint](https://github.com/n0-computer/iroh-ffi/blob/main/src/endpoint.rs),
  [Cloud Run WebSockets](https://docs.cloud.google.com/run/docs/triggering/websockets)
- Push (§12.4):
  [APNs token auth](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns),
  [APNs requests](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns),
  [APNs responses](https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns),
  [Notification Service Extension](https://developer.apple.com/documentation/usernotifications/modifying-content-in-newly-delivered-notifications),
  [actionable notifications](https://developer.apple.com/documentation/usernotifications/declaring-your-actionable-notification-types),
  [background execution time](https://developer.apple.com/documentation/uikit/extending-your-app-s-background-execution-time),
  [FCM HTTP v1](https://firebase.google.com/docs/cloud-messaging/send/v1-api),
  [FCM message priority](https://firebase.google.com/docs/cloud-messaging/android/message-priority),
  [apns-h2](https://github.com/threema-ch/apns-h2),
  [Threema push-relay](https://github.com/threema-ch/push-relay),
  [chatmail notifiers](https://github.com/chatmail/notifiers),
  [Matrix push gateway API](https://spec.matrix.org/latest/push-gateway-api/),
  [RFC 8291](https://www.rfc-editor.org/rfc/rfc8291), [RFC 8292](https://www.rfc-editor.org/rfc/rfc8292)
- Open source, run it your way (§13):
  [iroh: configuring networks (air-gapped, local)](https://docs.iroh.computer/configuring-networks),
  [iroh mDNS local discovery](https://docs.iroh.computer/connecting/local-discovery),
  [iroh-mdns-address-lookup](https://docs.rs/iroh-mdns-address-lookup/latest/iroh_mdns_address_lookup/),
  [iroh-relay server (embeddable)](https://docs.rs/iroh-relay/latest/iroh_relay/server/index.html),
  [iroh-dns-server (library)](https://docs.rs/iroh-dns-server/latest/iroh_dns_server/),
  [UnifiedPush](https://unifiedpush.org/developers/spec/definitions/),
  [ntfy as a UnifiedPush distributor](https://unifiedpush.org/users/distributors/ntfy/),
  [APNs token-based connection (team-scoped keys)](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns)
