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
  `localStorage` into a `WorkspaceStore`: one writer that checks every input, a snapshot
  per repo on disk (`<userData>/workspaces/<repo-hash>.json`; R2 replaced it with the
  workspace's document before either shipped) written through on every change. The
  renderer reads it synchronously over IPC (as `settingsSync` already does) and writes
  debounced snapshots of the same shapes it saves today. Change events come with R5, where
  their first subscriber is. R2 turns each snapshot into the edits it makes; edits sent as
  operations (`frame.move`, `tile.rename`, …) wait for several writers (R5).
- **It lives in a package, not in Electron main.** `packages/workspace-host` holds the store
  (and, later, intents R7 and the access list R11). Electron main embeds it; the `hive`
  binary runs it headless for an always-on host (R14). Nothing in the package imports
  Electron.
- **Files.** new `packages/workspace-host/src/` (`layout.ts` shapes shared with the window,
  `record-file.ts` the file format (R2: `doc-file.ts`), `store.ts`), `main/workspace-store-ipc.ts`,
  `main/index.ts`, `shared/ipc.ts`, `preload/index.ts`, new
  `renderer/src/workspace/workspace-store-client.ts` (where layouts live),
  `canvas-persistence.ts`, `view-layout-store.ts`.
- **Migration.** The first read of a repo in a window offers main that window's
  localStorage blobs; main keeps only what it lacks, so an offer made twice changes
  nothing and a newer layout is never overwritten. The blobs stay in localStorage, so an
  older version still finds them.
- **Unblocks.** Everything: HCP `tile.list` without a renderer (R5), several windows, remote
  peers.
- **Done when.** All e2e specs green; the canvas round-trips through a restart with
  localStorage cleared. (`tile.list` without a window moved to R5: today closing the last
  window quits the app, and R5 is where the live tile state moves into main.)

### R2. The store becomes a Loro document

- **What.** `WorkspaceStore` keeps its API and is backed by one `LoroDoc` per workspace,
  kept as `<userData>/workspaces/<repo-hash>.loro`: a header line naming the format, its
  version and the repo, then a shallow snapshot (the state, without history). The repo path
  is in the header, not in the document, which will be shared. The window still saves whole
  layouts; the document takes each as the edits that make it hold that layout (a frame
  dragged sets its `x` and `y`, a tile renamed its `name`, a frame nested in another is one
  tree move), so edits made at once to different things merge. Schema in §8. A root
  container needs no migration when it is added, so `objects` (R15) and `machines` (R9)
  arrive with their first writer.
- **Waiting for a first caller.** Undo: the app has no canvas undo (only the editor's own),
  so Loro's `UndoManager` (this peer's edits only) comes with ⌘Z on board objects (R15).
  Update export and import come with sync (M1); the file is a snapshot. Whole layouts stay
  the way a window writes until there are several writers (R5): then each window writes from
  the document's current state (change events refresh it) or sends operations, or a window
  holding a stale layout would undo another's edit.
- **Per-person state.** The canvas camera and the Windows view's active tab and minimized
  tiles were in the view layouts the document holds. They are per-person (§8) and left the
  document with R5, where two windows on one workspace would otherwise share a camera, and
  so before M1 shares it with people; pins went with them (R5's decisions).
- **Migration.** The window's old localStorage layouts are imported as in R1, each entry
  checked by the document's writers. R1's `.json` file shipped in no release (R1 and R2 go
  out together), so it is not read.
- **Files.** new `packages/workspace-doc` (`shapes.ts` Node-free types and guards,
  `schema.ts` root containers, `fields.ts` a record's fields in a map, `core.ts`, `views.ts`;
  shared with the phone later), `packages/workspace-host/src/doc-file.ts` (the file),
  `store.ts`.
- **Done when.** A layout round-trips through the document and through a restart; two
  in-process documents editing concurrently converge (fuzz test) with both sides' edits to
  different tiles and fields kept; a golden file pins the format; all e2e specs green.
  (Undo reverting only local edits moves to R15, and update round-trips to M1, with their
  callers.)

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
- **Decided while building it, step 1 (2026-09-30).** The formats are `spec/identity.md`, held to
  `conformance/identity.json`, whose vectors were made with the Rust Ed25519 and HKDF iroh uses,
  so hive-net (R10) is held to the same ones. A workspace key's HKDF has no salt and the info
  `hive-workspace` followed by the workspace's id; a device certificate signs a tag, the person's
  key, the device's key and when, as a big-endian u64 of milliseconds.
- **Decided while building it, step 2 (2026-09-30).** Keys are kept in files, not the OS keychain:
  `<userData>/identity`, 0700, with `device.key`, `person.key` and `device.cert`, 0600 each
  (`packages/workspace-host/src/keyring.ts`, used by `main/identity.ts`). An unsigned macOS build
  is a new app to the keychain on every upgrade, and Linux without a secret service has none, so
  a keychain would not keep the keys through upgrades; it comes with signed builds. A key is made
  anew only when there is none, or the file there cannot be read as a key, which is set aside
  and said, since a new key makes the machine someone new. The profile is `profile.name` and
  `profile.color` (`#rrggbb`) in settings.json, each empty until chosen: a name left empty is
  git's global `user.name`, else the account's name, and a colour not chosen is picked from the
  eight Settings offers by the person's id, so it is the same on each of their devices. A name
  has no control characters, line breaks or bidirectional overrides, which would let it show as
  someone else's.
- **Decided while building it, step 3 (2026-09-30).** A workspace's document says whose it is in
  `meta`: `workspaceId`, `owner` (the person key) and `workspacePublicKey`. The store stamps a
  document that does not say yet when it opens it, with a new id and the person key its machine
  holds, and it is on disk with the next write, so a workspace made before this is its owner's
  from the next change to it. One that says whose it is keeps what it says: a copy on another
  person's machine stays the owner's. The stamp is nobody's edit, so undo never takes it back.
  Each store has a person key: main's is this machine's, and the dev-bridge's is its own. A
  record's `created{by, at}` waits for the first thing that shows it.

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
  `WorkspaceStore` gains change events carrying the writer's origin, so every window
  mirrors the others' edits without echoing its own.
- **Files.** `main/index.ts` (pty relay, `hcpCallRenderer`), `main/hcp/methods.ts`,
  `useSpawn.ts` (spawn logic moves to main), `Workspace.tsx`.
- **Done when.** HCP `tile.list`, spawn, close and rename work with no window (the tile
  list built by one shared function from main's store and status store, which the window
  also uses); two windows on one workspace show the same terminals live.
- **Decided while mapping it (2026-09-29).** "With no window" means these verbs never call a
  renderer, shown by tests at the control plane's dispatch with a real store and no window.
  An app that keeps running with no window open is R14's `hive host`: closing the last window
  quits the app today. The in-process PTY path (`HIVEMIND_PTY_DAEMON=0`) stays one window: it
  gives each mount a session of its own, and detaching from one kills it. The steps are in the
  tracker (`docs/plans/multiplayer.md`).
- **Decided while building it (2026-09-29).** A window takes another writer's change by merging
  it into what it has: the rebase the store runs on a window's write, run the other way, so an
  edit the window has not yet saved survives. Main ends a closed tile's session itself, so a
  close needs no window; a window that sees a tile closed closes it as its own × does, which
  also ends a session still starting there. With several windows, main holds one attach per
  session and relays it to each window that shows it (`SessionRelay`), and a session is
  started once however many windows mount it at once; the window that started it gives it its
  first task, and a window that joins drops its copy, until R14 moves the first task into main.
  What a window must draw from the start (pipes, spawn wires, statuses) it asks main for when it
  mounts, then follows the pushes: a push sent before its listeners mount is lost. A view's
  layout and the board are written from what the window last read, as the core is, and merged
  into another window's state; undo is per writer. One person's state (the camera, the Windows
  view's tab and minimized tiles, pins) is kept by the window on this device, never in the
  document, which is §8's "presence or local" for a single device until M1's presence.

### R6. One status per session, from its host

- **What.** The machine that runs a session is the only one that derives its status.
  Viewers (another window, a network peer) mirror that host's `StatusStore` instead of
  deriving their own from screen reads.
- **Files.** `main/index.ts` (status wiring), `packages/agent-host/src/status-store.ts`,
  `remote/events.ts`.
- **Done when.** Two viewers of one agent always show the same status; a remote ssh session's
  status matches its host's.
- **Decided while building it (2026-09-29).** The host of a session is where its hooks report:
  a desktop for its own sessions, a machine's daemon for the sessions it runs with no desktop
  there. That daemon keeps the status (the same `StatusStore`) and sends `agent.status`; a
  desktop mirrors it and folds nothing of its own into it but the session's end. Mirroring is
  taken only from a machine's own report, never from the control-plane socket.

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
- **Decided while building it (2026-09-30).** An intent's verb is the control-plane method's
  name, so the log reads in the words of `hive ctl`. A line holds `at` (when it was asked; it is
  written when it ends), `actor` (a tile, or a person at this machine), `verb`, `target` (a tile, a
  pipe, the tile a spawn opened), `detail` (an approval's decision, the tool it asks about; never
  what someone wrote), and `outcome` (`ok` or `error`, with the error's code). A failure is
  recorded; a question the worker's standing answer settles is not, since nobody is asked. The log
  never holds an effect back: a line that cannot be written is reported, and the effect happens.
  Until each tile has a token of its own the actor is what the call says; `hive ctl` names its
  tile on every call.
- **Decided while building it, step 2 (2026-09-30).** A tile's token is the tile's id and a MAC of
  it under the install's token (`<tile>.<HMAC-SHA256>`): the host checks it without storing
  anything, a session restored after a restart is given the same one, and it names its tile, so
  no client had to change. A tile acts only as itself; the person (the install's token) may act
  for any tile. The policy starts with one rule, `onlyBy`: an intent only one tile may ask for is
  refused to any other and recorded as `refused` (an approval's answer is its supervisor's;
  speaking as a tile is that tile's). A question is tied to the connection that asked it, so an
  answer after the asker gave up is refused rather than reported as done. What this does not do:
  every process of the user can read the install's token, so a tile token makes the actor right
  and does not wall an agent off; on one machine the boundary is the OS user. Hook notifications
  stay unauthenticated until peers (M1) need them not to be.
- **Decided while building it, step 3a (2026-09-30).** The window's channels are registered in one
  module that answers only the main frame of one of the app's windows, so a page a tile shows (a
  browser tile's webview, a view's iframe) or any other window reaches none of them, whatever it
  is given. A browser tile's registration names a page of its own window, so the debugger main
  drives for it is always a browser page's.
- **Decided while building it, step 3b (2026-09-30).** The window's effects are intents of the
  person at the window, named by their channel (`fileWrite`, `gitCommit`, `machines:add`), so the
  log reads in the words of each surface. An effect is one on the workspace or the machine: tiles,
  files, git, issues, settings, installs and machines. The app's own presentation and bookkeeping
  (windows, wallpaper, diagnostics, notifications, a browser page's registration) are not. A
  session is an intent when a window starts it; one it joins, or reattaches to after a restart,
  starts nothing and is not.

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
- **Decided while building it, step 1 (2026-09-30).** The protocol is `spec/workspace-api.md`: a
  call `{method, params}`, an answer `{result}` or `{error: {code, message}}`, the codes
  `BAD_REQUEST`, `UNKNOWN_METHOD` and `FAILED`. A host answers every call and never throws, so a
  client on any transport gets the same answer; the method's name is its audit verb. A method's
  handler takes its params as they were sent and checks them itself, so the checks sit where every
  transport's calls come in, not in the adapter behind it (the worktree checks moved there from
  `git-adapter.ts`); what an effect acts on is named from the params before they are checked, so
  only from text. Each domain is one Electron-free module (`src/main/workspace-git.ts`) that main
  and the dev-bridge both serve, so the dev-bridge can no longer drift from main's checks, and
  there is one channel (`workspace`) instead of one per method. The window's `window.hive` keeps
  its names (`gitStage`) as the client's: the renderer does not change.
- **Decided while building it, step 2 (2026-09-30).** A call that only the machine at hand can
  answer is not in the API, even where it reads a workspace: opening a folder, making a workspace
  in one, and the machine's own list of workspaces, which a peer who joined one workspace has no
  business reading. A method that takes a shape (a new issue, a patch) checks it against the
  schema its store reads back with (core's zod schemas beside `IssueFrontmatterZ`), so the check
  and the file cannot drift apart; a field it does not know is dropped, so a caller cannot sign
  an issue's activity with a name of its choosing. Until M1 names people, every change through the
  API is signed `ui` there, and who asked is the audit log's to say.
- **Decided while building it, step 3a (2026-09-30).** A client holds a connection to the host,
  and a transport makes one per client: over Electron a window, from when it opens (not from its
  first call, so it misses no event) until it closes; over the dev-bridge's HTTP, the page's
  event stream, which names it, since a request alone names no one. Every handler is given the
  connection its call came over, so a domain can keep what a client holds (a terminal it shows)
  and let go of it when the connection goes (`gone`). The hot path is a notice, which is never
  answered, so a keystroke costs one message; an event carries positional params like a call.
  The window keeps its names (`onHcpStatus`, `hcpLinks`) as the client's.
- **Decided while building it, step 3b (2026-09-30).** What a terminal session is to the API
  (who shows it, who sizes it, how long a pause lasts, which start or end is someone's intent) is
  one Electron-free module; how a session runs is the host's (`SessionBackend`): main's is the
  daemon, this process or ssh, with the control plane's taps on output, keystrokes and ends, and
  the dev-bridge's is this process. So a phone or a peer later is one more viewer, not another
  copy of the rules. Opening a terminal is a method, since the client waits for its pid;
  everything a client does to one after that is a notice. A terminal's audit verbs are
  `terminal.open` and `terminal.close`, recorded under the same rules R7 set for `ptySpawn` and
  `ptyKill`. File changes are events over the connection that watches the repo; the window's
  watch still starts where it did, so no new watchers appear, and a peer will ask for one with a
  `file.watch` when it needs it.
- **Decided while building it, step 4 (2026-09-30).** A window over Electron keeps reading the
  store synchronously: the channels answer from the store's API domain, as the window's
  connection, so there is one owner of what a write means and who hears of it. A client over a
  stream holds what it opened instead (`StoreReplica`), since it cannot read in the same tick; its
  rules are the spec's, written for the next implementation (a Rust client, the phone), and M1
  replaces the whole of it with a Loro replica syncing on `hive/ws/1`. A writer is a connection,
  not a window: the store's history per writer then works for any client. The dev-bridge's page
  became a bundled TypeScript client so it can use the package's client and replica rather than
  a copy of them in a string.
- **Decided while building it, step 5 (2026-09-30).** The local socket main was to serve for
  the API goes with R10: hive-net is its first caller, and until then it would be an API no one
  calls. The transport the harness runs over is the dev-bridge's (one connection per page, its
  event stream; calls and notices naming it), which is the shape a stream carries anyway. The
  harness is the same specs, not copies: a spec launches its window through one helper, which is
  the app or, in the harness, Chromium on the dev-bridge; a spec that needs Electron's main
  cannot be in it. So R8's "done when" holds for the canvas (tile-move, resize, frame), a
  terminal (keyboard-gate, and terminal-io, written for it: keys to the shell, output to the
  window), git and files (editor, shipped-features) and issues (issue-create, issues-tile).

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
- **Decided while building it, step 1 (2026-09-30).** `crates/hive-net` is a crate of its own
  (its own `Cargo.lock`, like `crates/agent-host`) on iroh 1.3 and `iroh-mdns-address-lookup`
  0.6. It reads the device key the app keeps (`<userData>/identity/device.key`) and never makes
  one, so making keys has one owner (`keyring.ts`), which `hive host` will use too. A device is
  reached in one of two ways until profiles (R16) choose: on the local network (no relays;
  devices found by mDNS under the service name `hivemind`, so only hivemind's), or through the
  relays named, where a device elsewhere is dialled by its id and the relay it uses, as there is
  no lookup server before R13. `hive/ping/1` says whether a device answers, in how long, and
  whether directly; whether it stays open to anyone, like pairing, is R11's to decide. `serve
  --relay` embeds iroh's relay over plain HTTP: the devices' traffic through it is end-to-end
  encrypted QUIC either way, and TLS for a relay on the internet comes with R13. The local socket
  to main waits for its first caller, M1's `hive/ws/1`.

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
- **Decided while building it, step 1 (2026-10-01).** `hive-net serve` runs every role on **one
  port**, so a self-hosted network needs one name and one certificate: the lookup server at
  `/pkarr` and `/dns-query`, the access role at `/access`, the relay on the rest (iroh's
  `RelayService`, which is made to be embedded; `--access-bind` is gone). HTTPS is Let's Encrypt
  over TLS-ALPN-01 for `--domain` (so the port is 443), or a certificate in files (`--cert`,
  `--key`, read again every hour); with HTTPS the relay also answers QUIC address discovery
  (7842/udp) and the captive-portal check (80), as iroh's own server does. Flags, not a TOML
  file: there were few enough. The lookup role embeds `iroh-dns-server` 1.3 on this machine
  only, without the DHT, and its DNS side only where asked (`--dns-bind`). How often an address
  may publish is held back in the front, by the address it saw (five at once, then one every two
  seconds; `--lookup-limit off` for an office behind one NAT): `iroh-dns-server`'s own "smart"
  limit discards its client-address extractor, so behind any proxy every device shares one
  limit. Devices use the profile's `lookup` (`PkarrPublisher`, relay URL only, and
  `PkarrResolver`) and trust the web's authorities plus this machine's (`SSL_CERT_FILE`, a
  company's CA), for relays, lookup and access alike. A relay apart from the access service
  (`--access-url`) keeps a yes five minutes but a no only ten seconds, else a device that
  connected while it registered would wait five minutes. `serve --all` makes the network's
  admin key in `--data` the first time (hive-net never makes device or person keys; this one is
  the network's) and keeps the signed profile as `network.json`, printing its link;
  `access enrol-link` makes the admin's links for devices. Host records are built here
  (`host_record.rs`, `spec/host-record.md`), the workspace key derived in Rust too (held to
  `conformance/identity.json`); publishing them as hosting moves is M3's. `hive-net doctor`
  says whether the lookup and access services answer, and why a relay turned a device away.
- **Decided while building it, step 2 (2026-10-01).** `infra/compose.yml` is the stack on plain
  HTTP (port 3340, `HIVE_URL` naming how devices reach it): a network inside a building, and
  what CI checks; `infra/compose.public.yml` over it is a server with a public name (HTTPS on
  443 from Let's Encrypt, 80, 7842/udp). The image is hive-net built from the repository on a
  distroless base: no shell, no package manager. `infra/check.sh` runs R13's checks against
  the running stack with hive-net devices on the host, and CI's `compose` job builds the image
  from the commit and runs them. Binding "every address" falls back to IPv4 where the machine
  has no IPv6, as a container often has none. The deployment of hivemind's own network (VMs,
  DNS, `infra.yml`) waits on its cloud accounts.

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
- **Decided while building it (2026-10-01).** What a machine answers about its workspaces is one
  package, `packages/host` (`@hivemind/host`): the domains the app's main process served, moved
  unchanged, and the headless host that composes them (`headless.ts`), with peers served by
  `PeerLinks` for both. `hive host` uses the app's data folder on that machine, so it is the
  device the app would be there, and it refuses to run while the app does; holding a socket in
  that folder makes it the one host. Its terminals run in the machine's PTY daemon, started as
  `hive daemon` does, whose status of each session the host mirrors (R6), so the daemon's own
  control-plane socket answers the agents' hooks; the control plane's verbs (`hive ctl` from an
  agent on the host) wait for a window there, which a headless host never has. Pairing is
  `spec/pairing.md`: six words (48 bits, five minutes, three tries) or a link, an HMAC proof from
  each side bound to both devices' keys, the app giving its person key and the host taking it;
  the words find the host on the local network through a tag in its mDNS user data. The owner's
  paired devices are the owner in every workspace on the host, ask it which workspaces it holds
  on a `device` stream of `hive/ws/1`, and type into its terminals as the host's own windows do.
  The service is a systemd user unit with `KillMode=process`, so a restart leaves the daemon's
  sessions running; lingering starts it at boot. macOS and Windows hosts wait on the compiled
  `hive` hosting a daemon there.

### R15. The canvas renders board objects

- **What.** The canvas node builder (`canvas-node-build.ts`) and node types
  (`canvas-nodes.tsx`, today `frame` and `tile`) gain board objects, drawn by plain React (no
  TileHost surface): sticky note, checklist and text label are nodes, one type per kind;
  arrows are drawn in a layer of their own in the viewport, not as react-flow edges (an edge
  needs a handle at each end, and tiles and frames have none). Text inside an object is
  edited in place; while an object is being written in, the canvas single-key shortcuts do
  not fire, even for a key typed before its field has focus. Objects nest in frames like
  tiles and move with them.
- **As built.**
  - *Add:* `8` note, `9` checklist on the canvas, or the toolbar's **Board** menu (note,
    checklist, text, arrow), shown in the Canvas view only. A note, checklist or text appears
    centred at the pointer (the middle of the view when the pointer is elsewhere), ready to
    type in, and in the frame it lands in.
  - *Write:* the text is a draft in its field and reaches the board after 400 ms without
    typing, when the field is left, or on `⌘Z`. In a checklist, `Enter` adds an item,
    `Backspace` in an empty one removes it, the grip reorders and the box ticks.
  - *Arrange:* a selected object shows resize handles and a bar (six note colours,
    duplicate, delete); `⌘D` duplicates and `⌫` deletes, and deleting an object takes the
    arrows that end on it. Dropped with its middle in a frame, an object joins it; the
    frame's drag, arrange and auto-fit move it as they move tiles. A frame is never narrower
    than an empty one, so its header fits beside a single note.
  - *Arrows:* **Board → Arrow**, then a click on the start and one on the end (a tile, a
    frame or an object); `Esc` stops. An arrow joins the sides its ends face each other on,
    follows either end and takes a label on a double-click. Dragging one from a handle shown
    on hover (§4.2 G, step 4) is not built: there is no handle to drag from yet.
  - *Undo:* `⌘Z` and `⌘⇧Z` (or `⌘Y`) on the canvas take back and redo board edits only,
    never tiles, frames or views (the store commits those as `sys:` and its `UndoManager`
    excludes them). A step is one save of the board: the window saves 250 ms after the last
    edit, and the store merges no steps (`mergeInterval: 0`). In a field the same keys save
    what was typed first, so it is taken back as a step of its own.
  - *Persist:* the board is saved with the workspace's layout, through the store (debounced,
    flushed on unload and on a project switch), and placed by the workspace's frames when
    it loads.
- **Files.** `board-objects/`: `board-model.ts` (pure: where a box is kept and where it is
  drawn, a new box, a copy, what a delete takes, an arrow's sides), `useBoard.ts` (a window's
  board: selection, the object being written in, an arrow being drawn, saving, undo and redo
  through the store), `board-context.ts`, `TextDraft.tsx`, `BoardNodes.tsx`, `Arrows.tsx`;
  `canvas-node-build.ts`, `canvas-nodes.tsx`, `CanvasView.tsx`, `Workspace.tsx`,
  `useCanvasShortcuts.ts`, `useFrameOps.ts`, `useNodeDragStop.ts`, `useSpawn.ts`,
  `frame-layout.ts`, the toolbar (`standard-toolbar.tsx`, `host-chrome.tsx`, `board` in
  `@hivemind/core`'s catalog); `packages/workspace-doc` (`objects.ts`, `shapes.ts`) and
  `packages/workspace-host` (`store.ts`: objects, undo, redo).
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
   starts replicating the workspaces and access lists you own. The workspaces it had are
   yours from then on. A computer that shares a workspace with someone, its own or theirs,
   is known to them as the person it is, so it is never the one added: pair the other way
   round (`spec/pairing.md`).
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
   *As built (M4 step 2c):* the frame's machine chip, its header and what views are told name a
   participant's computer by its person ("Priya's computer"): from who is here (presence names a
   peer's connection `peer:<device>`) and, in the owner's windows, from the workspace's list, which
   knows their devices while they are away; it reads offline while they are not connected (item 6).
3. Everyone sees the frame's terminals live (they stream from Priya's machine to the host
   and on to the others, or directly peer to peer; see §5.5).
4. Priya is the **owner** of that frame's machine: she alone can grant keyboard or agent
   driving in it, even to the workspace host. Her machine's ACL decides.
   *As built (M4 step 2):* her grant, per workspace, kept on her machine (`MachinePlaces`), set
   on her frame's machine chip and said to the host on the `machine` stream: *Only watch*
   (everyone watches), *Type into it* (the host's keyboards then go as for its own terminals;
   her machine lets typing through only then, and the size stays hers), *Run terminals and
   agents here too* (the reverse journey, below).
5. Getting the work into the host's project: the frame's toolbar has **Hand off** →
   *Push a branch* (git push to a remote both can reach, or a git bundle sent over
   hive-net into the host's repo as a new branch) or *Open a review* (a Diff tile on the
   host showing the branch). No live file sync.
   *As built (M4 step 3):* *Hand off its branch to the host* on her frame's machine chip sends the
   branch checked out in that frame's folder as a git bundle of what it adds to the branches her
   clone tracks (its whole history when the host lacks what that builds on), over the workspace
   API (`git.handOff`, *Can edit board*). The host checks it against its repository and fetches it
   as `handoff/<who>/<branch>`, touching none of its files or branches (a person updates only a
   hand-off of their own), then opens a Diff tile comparing it with the branch it has checked out.
   Pushing to a remote both can reach needs nothing of hivemind's.
6. Priya leaves → her frame shows "Runs on Priya's laptop — offline", grey. Her agents
   keep running on her machine; she can open them locally.

The reverse — "their agent works on **my** project" — is the same journey with roles
swapped: the host creates a frame on a guest's machine only if that guest's ACL grants
the host **Can drive agents** on it. Nobody's code runs on your machine unless you
granted it.
*As built (M4 step 2b):* the frame stays hers to make (only she puts a frame on her machine);
with *Run terminals and agents here too*, a terminal or agent that someone who may drive agents
in the workspace puts in one of her frames runs on her machine. The host's `terminal.open`
starts it through her filter, in that frame's folder, running what her copy of the workspace's
document says, with the opener's environment and task (never the host's control-plane
credentials), and the host may end it. Whoever places a tile starts it: her window shows one
the host placed once it runs and never starts it (a task given to an agent is the host's to
give), and what she placed is hers alone to start and end. Her filter decides, whatever the
host asks: taken back, nothing more is started or ended there.

### 5.5 How it works

- Peers can connect directly (A ↔ Priya) when both ACLs allow; otherwise terminal streams
  are relayed by the workspace host. Direct is tried first.
  *As built (M4 step 1b):* relayed by the host. Priya's app shows the host the sessions she
  placed on her machine over her own connection to it (a `machine` stream she opens, so the host
  never dials her), through a filter of her PTY daemon's protocol on her machine
  (`machine-share.ts`): the host may watch those sessions (attach without starting, restoring,
  sizing or pausing them, read their screens, let go) and nothing else, and hears what her daemon
  says of those alone. The host relays them to every client as its own, at her size (her daemon
  says it), with the keyboard hers: nobody types into them from the host until she grants it
  (step 2).
- Frame record carries `machine: EndpointId` and `path`. Fs and git for that frame go to
  that machine's hive-net (a `hive/fs/1` ALPN replacing one-ssh-command-per-call), with
  the same path containment rules as `remote/fs.ts` and Zeron's owning-engine checks.
  *As built (M4 step 4, the person's own devices):* no ALPN of its own, a `files` stream on the
  link the app already keeps to its device: the device answers the workspace API's calls about
  its own folders (`git.*`, `worktree.*`, `file.*`, `issue.*`, `review.*`) for the person's other
  devices alone, and nothing else on that stream (`device-files.ts`); a window's call naming
  `machine://<device>/path` goes there, the folder read as its path on the device. A
  participant's machine is not reached for its files this way yet.
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
- A peer's changes to the workspace document are checked by the host against their role before
  it takes any (`packages/workspace-host/src/edit-rules.ts`): placing, closing or changing what a
  tile that runs something runs is driving agents, and where a frame's tiles run is the owner's,
  because the host's own window starts the tiles its document has.
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
| `hive/ping/1` | Whether a device answers, and how (directly or through a relay) | one bi stream: 16 random bytes, echoed |

All ALPNs except `hive/pair/1` are rejected in `after_handshake` unless the peer's
`EndpointId` is on the ACL (R11). Versioned by ALPN suffix; a peer offers every version it
speaks.

*As built (M1–M4):* one `hive/ws/1` connection carries named streams, each opened by the side
that dialled sending on it first: `sync` (the workspace document), `api` (the workspace API,
presence included), `list` (the access list, kept in step on the owner's devices), `device` (the
workspaces a device holds), `pty` (the PTY daemon's protocol, for the owner's devices), `files`
(the workspace API's calls about a device's own folders, for the owner's devices), `hosting`
(moving a workspace), and `machine` (a participant's sessions on their own machine, shown to the
host through a filter of the same daemon protocol; the participant opens it, so the host never
dials a participant).

---

## 8. Workspace document schema (Loro)

```
root: Map
  meta: Map        { schema: 1, core (true once a core layout is written), workspaceId, workspacePublicKey, owner (person key), name }
  machines: Map    machineId → Map { endpointId, label, owner }
  frames: Tree     node data: Map { the frame's fields as the window keeps them: x, y, w, h, title, color, z, workspacePath, branch, worktreePath, …; machine }
  tiles: Map       tileId → Map { the tile's fields as the window keeps them: kind, label, cmd, args, session, pinned, pinAnchor, …; frame, name, tabs; created{by, at} }
  objects: Map     objectId → Map {
                     kind: "note" | "checklist" | "text" | "arrow",
                     frame?, x, y, w, h, z, color, created{by, at}    (x, y relative to the frame when in one)
                     text: LoroText                                   (note, text, checklist title)
                     items: Map<itemId, Map { done, doneBy?, text: LoroText }>, itemOrder: MovableList<itemId>   (checklist)
                     from, to: { id, side } , label: LoroText         (arrow; ends are tiles, frames or objects)
                   }
  order: MovableList   tile ids for Windows-view tab order
  views: Map       viewId → Map { v, data } (each view's own layout; data merges two levels deep)
```

R2 built `meta` (`schema`, `core`), `frames`, `tiles`, `order` and `views`; R3 added the
workspace's id, owner and public key to `meta`. The rest comes with its first writer or reader:
a record's `created` with the first thing that shows who made it (M1), `meta.name` with the
share sheet (M1), `machines` and a frame's `machine` with R9. R15 adds `objects`. A framed
object's position is relative to its frame, so moving the frame does not rewrite it: undo
(which puts a field back as it was) cannot then drop a note outside its frame, and a person
moving a frame never overwrites another moving a note inside it. A checklist's items are
records by id plus their order, as tiles are, so the document never holds a container made
outside it.

The **host record** is not in this document; it is published separately and signed by the
workspace key (§5.8). The **access list** is a separate owner-only document (R11).

- Per-person view state (camera, selection, collapsed panels) is **presence or local**,
  never in the document.
- Positions: per-property last-writer-wins by default (Loro Map values).
- The host rejects updates that break invariants (tile in a missing frame, frame cycles)
  and replies with a corrective update.
- History: none on disk while nothing reads it (R2 writes shallow snapshots); from M1,
  shallow snapshots after 30 days, full history kept locally by the host.

---

## 9. Feature 3 — Phone

### 9.1 What it is

A phone app (iOS first, Android after) that pairs like a device (§5.2) and does what a
phone is good at: see who needs you, answer, approve, watch, switch views. It runs no
agents.

### 9.2 UX journey

1. **Install and pair.** App Store → open → **Pair with hivemind** → scan the QR from
   Settings → Devices → *Pair a phone* on the desktop. Name and colour carry over.

   *As built (M5 step 2, pairing 0.3):* the phone is a device of kind `phone`, which only enters
   a code, and only an app's. It is given a certificate naming it, signed by the person key, and
   never the key: it is the person's device without being able to make another one the person's,
   and a lost phone gives no key away (unpair it on the computer). The computer lists it as a
   phone and never offers it as a place to run a frame, open a workspace on or move one to. The
   Rust side is `crates/hive-phone` (`hive-phone pair <link>` in a terminal), held with the app to
   `conformance/pairing.json`. Name and colour do not carry over yet, and it pairs on the local
   network: the reach chooser (step 2 below) comes with the phone's shell.

   *As built (M5 step 12, `spec/pairing.md` 0.7):* the person's other computers and hosts learn of
   the phone from the app it paired with, which tells each of them its phones, all of them each
   time (as one pairs or is forgotten, and as the app starts and wakes), so they let it in, serve it
   as a phone and tell it what happens there; and the phone asks the app which of the person's
   devices it may reach through it, so it asks them too.
2. **Away from this network?** On the local network (the default) the phone works only on
   the same Wi-Fi and only while the app is open. The pairing sheet asks once:
   - *Use hivemind's servers* — reach your devices from anywhere; notifications through our
     push server, which only ever sees encrypted content.
   - *Use my network's servers* — the network you already chose (self-hosted or a device
     that serves).
   - *Only on this Wi-Fi* — no servers, notifications only while the app is open (Android:
     UnifiedPush if a push server runs on this network).
   This is the reach chooser (§13.3 E), phrased for a phone.

   *As built (M5 step 7, `spec/pairing.md` 0.5):* the phone takes the network of the app it pairs
   with, its answer carrying it, and reaches the person's devices through it from then on; the app
   vouches for it on a closed network, and it registers itself on an open one. The chooser itself
   (a phone choosing otherwise) comes with the phone's shell. From elsewhere (M5 step 8, 0.6): the
   pairing link carries the network's access service and a voucher for one use, as an invite does,
   so the phone (or a computer) entering it gets onto the network before it dials.
3. **Home: Needs you.** A list, most urgent first: agent, workspace, machine, reason
   (permission · question · plan), how long it has waited. Empty state: "Nothing needs
   you. 4 agents working."

   *As built (M5 step 3, `spec/needs.md`):* the device that runs the agents works the list out
   (`needs.ts`: each agent whose status waits with a kind, called what the person named it, else
   its title, else its task, else its label, with the plan when it waits on one), and answers its
   owner's devices on the `device` stream; the phone asks each device it paired with, shows the
   lists as one, the one waiting longest first, and names a device that does not answer as away.
   Each device also says how many agents are at work there (M5 step 6), and the phone adds them
   up for the empty state. The machine column (M5 step 10, `spec/needs.md` 0.3): each item says
   the machine its agent runs on, the one its frame's folder is on, named as the device knows it
   (itself, another of the person's devices, a participant's computer, a saved machine, an ssh
   host); an item from an older device runs on the device that answered.
4. **Push notification.** "*api · Fix nav overflow* needs permission: Edit Nav.tsx" with
   **Allow** / **Deny** actions on the notification itself; tap opens the item.

   *As built (M5 step 5, `spec/push.md`):* the phone gives each device it paired with a Web Push
   subscription (an endpoint, and a P-256 push key and secret of its own) on the `device` stream;
   the device that runs the agent tells it when one begins waiting on the person (a new `since`),
   finishes or fails, the notice encrypted to that phone (RFC 8291) and posted to the endpoint.
   An agent first seen as the device starts is told of from its next change on. A permission its
   device can allow or deny says so (`decide`, M5 step 14), so the notification can carry Allow
   and Deny. Not built here: the notification itself and its actions, which are the phone app's.
5. **Answer.** Permission → Allow once / Always / Deny. Question → the options as buttons,
   plus a text box. Plan → the plan as text, Approve / Ask for changes.

   *As built (M5 step 4, `spec/needs.md` "Answering"):* `agent.answer(tile, since, answer)` on the
   device that runs the agent: a plan is decided as at the desktop; anything else is one line typed
   into the agent's terminal (the choice as its prompt takes it: the phone shows the screen, from
   *Watch*). It lands only while the agent still waits on that wait (`since`), and once, so a late
   or repeated answer, a notification's included, does nothing.

   *As built (M5 step 14, `spec/needs.md` 0.5, `spec/push.md` 0.4):* which key is *Allow once*
   is the agent's to say, not the phone's to guess from the screen: an agent's manifest gives the
   keys that allow and deny its own permission prompt (`answer.permission`; Claude Code's are `1`
   and Esc, read from its 2.1.287 binary), the device that runs it says so of each permission it
   can decide (`decide`, in the list and in the notice), and the phone answers Allow or Deny as
   `{decision}`, the device typing those keys a moment apart. An agent that gives none is answered
   with a line, as before. *Always* is not offered: what "always" allows differs per agent and
   per prompt, so it stays on the screen.
6. **Watch.** Tap an agent → a live terminal, read-only by default, scaled to width;
   pinch to zoom. **Type** asks for the keyboard like a guest; the reply box sends one
   line through the task-delivery path, which is easier than typing into a TUI.

   *As built (M5 step 3b):* read-only only, for now: the phone opens the workspace's API on its own
   connection to the device holding it and may call nothing there but `terminal.open` with
   `attachOnly` (it gets the screen, then the output as it comes). **Type** and the reply box come
   with step 4's answers.

   *As built (M5 step 11, `spec/needs.md` 0.4 "Sending", workspace API 0.10):* the reply box is
   `agent.send(tile, text)`: one line handed to the agent as `hive ctl send` hands one, through the
   control plane's mailbox (typed at its prompt, held while it is in a turn, Enter after it), role
   *Can drive agents*. **Type** is `terminal.write` from the phone, as the person: their devices
   are the host's for the keyboard, so it types while none of the people let in holds it, and asks
   for it (`terminal.keyboard.ask`) like a guest while one does. The phone never starts, sizes or
   closes a terminal, nor gives or takes a keyboard. `hive-phone send` and `hive-phone watch
   --type` do it from a terminal.

7. **Views.** A tab bar: *Needs you* · *Working* · *Board* (a compact list of frames and
   tiles) · community views that declare phone support (R12 `hello.device.compact`).
8. **Offline host.** "Desktop is asleep. You'll get a notification when it's back." The
   last known state is shown with its age.

   *As built (M5 step 6):* the phone keeps what each device last answered, and when
   (`heard.json`), and shows it for a device that is away. *As built (M5 step 9, `spec/push.md`
   0.2):* the notification when it is back. A computer that starts, or wakes, tells each phone
   subscribed there `{t:"back", device, name, since}` once it is on its network (the app starts
   its network at launch when the person has other devices, and again as it wakes, once it is
   online); the phone keeps which devices it found away (`away.json`) and shows a back only for
   one it found away before it, so one the push service gives late is not shown.
9. **Unpair.** Settings on the phone or on the desktop → the phone → Unpair.

   *As built (M5 step 6, `spec/pairing.md` "Unpairing"):* from the desktop, as for any device,
   which also stops telling the phone (step 5); from the phone, `{t:"unpair"}` on the `device`
   stream, answered, the phone forgotten once it hangs up, and recorded in the desktop's audit log
   as the phone. A desktop the phone cannot reach is
   forgotten by the phone alone and still lists the phone until it is unpaired there.

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

  *Decided while building it (M5 step 5):* the encryption is Web Push's (RFC 8291, over RFC 8188's
  `aes128gcm`) on every route, not HPKE (§12.4): UnifiedPush takes it as it is, a phone on the local
  network can be its own endpoint, and the push server, when it is built, carries the same
  ciphertext. Only the person's devices hold the phone's secret, so only they can send it a message
  it decrypts. No VAPID: a push service that requires it (Apple's and Google's web push) is not one
  a phone here gives.
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

  *As built (M5 step 12), for a phone:* no revocation list. Each device keeps the phones the app
  that paired them tells it of, and the app tells them all of its phones each time, so a phone
  unpaired there is forgotten everywhere as they hear it; unpaired on another device, that device
  asks the app to forget it (`forget`). A device away then hears it the next time the app starts
  or wakes.
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

*Built (M5 step 13, 2026-10-02; `crates/hive-net/src/push/`, `spec/push.md` 0.3), with these
changes from the above, checked against Apple's, Google's and UnifiedPush's documentation and
against Threema's push-relay, chatmail's notifiers, Sygnal, autopush and ntfy:*

- **One binary, no new stack.** The role is `hive-net serve --push` (in `--all`) on hyper and
  reqwest (HTTP/2 by ALPN, which Apple requires; the connection kept and pinged hourly), with
  `ring` for the ES256 provider token, the RS256 service-account assertion and the VAPID token: no
  axum, apns-h2 or yup-oauth2. Its parts are modules of their own (`wire`, `store`, `apns`, `fcm`,
  `unifiedpush`, `client`), on crate modules the access and lookup roles share (`signed`,
  `state_file`, `limit`, `egress`, `jwt`). It keeps its registrations in `push.json` in `--data`
  (readable by its user alone, synced to the disk before it replaces the last), not Firestore: the
  hosted deployment runs it as one instance with a lasting disk (not Cloud Run, whose disk goes
  with each instance and would take every phone's registration with it), and waits on the cloud
  accounts, as R13's does.
- **The phone names its senders.** In place of "host K may push to this handle until T" and a
  signed revocation, the phone's registration (signed by its device key) lists the devices that
  may tell it, and the phone registers again, under the same handle, whenever that list changes
  and before it gives a new device its subscription: unpairing a device is one more registration,
  and a registration no later than the one kept is refused, so an old one sent again cannot bring
  an unpaired device back.
- **Web Push on every route, signed by the device.** The ciphertext is Web Push's (RFC 8291, see
  §9.3), not HPKE, so a phone's own UnifiedPush distributor takes it as it is, and the server passes
  on nothing that is not one such message. A device signs each post (`Hive-Sender`: Ed25519 over
  the phone's handle, the time and the body's hash) where the phone's subscription asks it to (and
  nowhere else, so third parties never see its key), within ten minutes of the server's clock (not
  60 s: a phone's clock and a laptop's drift), and the server remembers each (device, time, body)
  it passed on for that long instead of a message id inside. A notice is one message of at most
  4096 bytes; there are no padding buckets, and its names are cut to 200 characters so that it
  fits what Apple carries.
- **Quotas, errors.** 60 notices at once per phone then one a second, 600 requests at once per
  address (an IPv6 address by its /64) then ten a second; an unknown handle and a sender the
  phone did not name get the same 404. A busy or failing service (429, 5xx) is tried once more
  within ten seconds, and a provider token Apple says expired, or an access token Google refuses,
  is made again. Only 410, `BadDeviceToken` and Google's `UNREGISTERED` drop a registration (and
  the device then gets 410 and forgets the address): `DeviceTokenNotForTopic` or a bare 404 would
  drop every phone of a server misconfigured. The device is told nothing of where a failure was;
  the server logs it, never with a token or a handle.
- **APNs and FCM as designed**, except the expiry follows the notice's TTL (a day), the priority
  its urgency (10 and `HIGH` for an agent waiting, else 5 and `NORMAL`), and no collapse id. A
  notice too large for either is answered 413, not sent.
- **Added: VAPID.** The server keeps a P-256 key of its own (`push-vapid.key`), names it in the
  profile (`push.vapid`), and signs each post to a UnifiedPush distributor with it (RFC 8292), so
  a distributor that asks for VAPID takes the server's posts; the phone gives its distributor that
  key.
- **Added: where it posts.** A distributor's address is the phone's to give, so the server posts to
  one on its own networks (private, shared, link-local or loopback addresses, literal or looked up)
  only on the networks it is told it serves (`--push-allow`), through no proxy and following no
  redirect, and to one on the internet over https alone; it reads at most 8 KiB of any answer.
  Beside the access role, a phone registers only once it is on the network.
- **Not at rest encrypted.** The tokens are kept in a file only the server's user can read; a
  token alone lets nobody send the phone anything without the server's Apple or Google
  credentials, which never leave it.
- **Still to come, outside this repository:** iOS cannot drop a notification its Notification
  Service Extension cannot decrypt (one a stranger could not have made, since the server takes only
  what the phone's devices sign) without Apple's `com.apple.developer.usernotifications.filtering`
  entitlement, to be asked for with the App Store build; and FCM's move from `token` to `fid`
  targeting, which `token` still accepts.

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
