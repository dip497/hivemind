# Multiplayer hardening (2026-10-03)

Status: proposed. Plan rows: `docs/plans/multiplayer.md` → **Hardening** (H1–H10).

We checked each suspected multiplayer bug against the code (file:line below) or the tests.
Each real issue gets a **primitive**: one change that removes the whole class of bug, not a
patch for the one case found. The issues are ordered by severity, privacy and security first.

The four root causes this addresses: entry paths drift apart (UI IPC, `host.sock`, `hcp.sock`,
bridge, agents, phone); there is no declared scope per piece of state; e2e tests assert data
instead of what a person sees; and new actor-facing methods are allowed by default.

## 1. Verdicts

| # | Suspicion | Verdict | Evidence |
|---|---|---|---|
| a1 | Host paths in **method answers** to guests | **REAL → fixed** (708a0e4) | `peers.ts` mapped `hive://<id>` → host folder on the way in (`inbound`) but sent answers back untouched; `worktree.list` returns absolute `path` (`host/src/git.ts`). |
| a2 | Host paths in **error messages** | **REAL → fixed** (708a0e4) | `server.ts` `failed("FAILED", err.message)`: Node and git errors carry `'/home/…'`. |
| a3 | Host paths in **events** (status titles, `tile.opened` cwd) | **PARTIAL → fixed** (708a0e4) | `peers.ts` rewrote only `file.changed`/`presence`/`people.*`/`tile.opened.repo`; `...opened` kept `cwd`; `status.changed` titles passed as-is. |
| a4 | Host paths/commands in the **replicated document** | **REAL, open (H1)** | `doc-sync.ts:92,109` sends the whole Loro doc; `workspace-doc/src/shapes.ts`: frame `worktreePath`/`workspacePath`, tile `cmd`/`args` (may hold inline `FOO=token`), `task` (the prompt), `editorTabs` (absolute paths), browser tile `url`. |
| a5 | Secrets in files a view guest can read | **REAL, open (H2)** | `file.read` / `git.fileContents` need `view` (`roles.ts:23`) and read any file in the repo, including git-ignored `.env`. |
| a6 | Secrets in transcripts / terminal output | **NOT a bug (by design), documented** | `agent.conversation` and `terminal.show` are `view` (`roles.ts`). Sharing a terminal shares what it prints. The share dialog has to say so (H2). |
| b1 | Guest sees/streams the host's logged-in browser | **NOT** | `BrowserTile.tsx:106`: each machine renders its own `<webview partition="persist:browser">`. A guest loads the URL with **its own** cookies. There is no screencast or `sendInputEvent` path. |
| b2 | Guest clicks/types into the host's browser | **PARTIAL (H3)** | There is no `browser.*` peer method (deny-by-default). But a guest with the `agents` role runs processes on the host. The CDP port is on localhost (`index.ts:241`, `HIVEMIND_BROWSER_TARGETS` in every pty), so a guest's agent can drive the host's logged-in tabs. |
| b3 | Browser tile URL shared without asking | **REAL, open (H1)** | The tile's `url` is in the document. A capability URL (a magic link, `?token=`) reaches every guest. |
| c1 | Two people saving one file: last write wins | **REAL, open (H5)** | `host/src/files.ts:19-23` writes with no version or mtime check. |
| c2 | Two people typing into one terminal | **PARTIAL** | `keyboard.ts` hands the keyboard over (R4), so only its holder types. Among holders, `terminals.ts:285` marks who is typing (`terminal.typing`) but does not lock. |
| c3 | A guest's undo reverts the host's change | **NOT** | `workspace-host/src/store.ts:337-345`: one UndoManager per writer, which excludes every other writer's origins. File contents are not in the CRDT, so they are not undone. |
| c4 | Both people spawn into the same slot | **REAL, open (H6)** | `reserveTileSlot` (`frame-layout.ts:221`) records the reservation in `pendingSlots`, a `useRef` in each renderer (`useSpawn.ts:149`), so two people can pick the same box. |
| d1 | Host away: frozen board with nothing shown | **NOT** | `shared-workspaces.ts:44` has the states connecting/connected/reconnecting/offline/left/removed. `shared-banner.tsx:21-24` shows them. |
| d2 | Host restart / rejoin | **NOT** | `shared-workspaces.ts:205-220` redials on its own and stops only on "removed"/"not admitted". |
| d3 | Revoked guest keeps the cached doc/media | **REAL, by decision (H7)** | `shared-workspaces.ts:207` sets `removed` and wipes nothing, and the banner says "the last copy you had, to read". This is a product decision: see H7. |
| e1 | Version skew errors instead of degrading | **PARTIAL (H8)** | A missing method answers `UNKNOWN_METHOD` (`server.ts:99`). `appearance.get` swallows it (`shared-workspaces.ts:173`); other call sites do not. |
| e2 | Capability negotiation in hello | **REAL gap (H8)** | The sync hello is `{t, workspace, seen}` (`doc-sync.ts:44`), with no version and no method list. Only hive-net (`PROTOCOL=2`), the view protocol and hcp carry versions. |
| f1 | New methods allowed by default for actors | **NOT (peers)** | `roles.ts:76-80`: an unnamed method is the owner's alone. The test is `peers.test.ts`. |
| f2 | View-role guest acting through a community view | **NOT** | `views.ts:363` grants a view only what its caller's `may` allows (`peers.ts:202`). One loose end: `from.may?.(m) ?? true` treats a connection with no `may` as owner. Today every remote connection sets `may`. H4 makes this explicit. |
| f3 | Guest acting through `hive ctl` | **NOT** | `hcp.sock` / `host.sock` are local 0600 sockets, so a guest reaches them only by already running code on the host (b2). |
| f4 | A guest's agent acting on the host | **PARTIAL (H3)** | `agent.start` / `terminal.open` need `agents` (`roles.ts`). That role is code execution on the host, and the UI does not say so. |
| g1 | Headless host vs app drift | **REAL (H4)** | `headless.ts:283` passes `appearance(..., onChange: () => {})`, so a `hive host` never sends `appearance.changed`. |
| g2 | Separate command tables | **REAL (H4)** | There are five: workspace-api `methods.ts` + `roles.ts`; hcp `control/methods.ts` (a switch, `UNKNOWN_METHOD` at :944); `host.sock` (`host-control.ts`); desktop IPC (`app-ipc.ts`, `workspace-ipc.ts`, `workspace-store-ipc.ts`, `plugin-catalog-ipc.ts`); the view protocol. |
| h1 | `git.handOff` unpacks a guest-supplied bundle | **review (H9)** | `edit` role (`roles.ts:29`). It needs a size cap and a check that no hooks or config are taken from it. |
| h2 | E2e asserts data, not what a person sees | **REAL (H10)** | The two-app specs assert `tiles()` and `notes()` ids (`helpers/multiplayer.ts:68-70`). Nothing checks what the guest's window shows: viewport, names, theme, privacy. |

## 2. Primitives

### H1 — Guest egress projection for the document (privacy, high)

**Class:** host-private data that rides along in shared state.

Every field of the workspace document declares a **scope**:
- `shared`: everyone sees it.
- `follow`: shared, but each person may override it locally.
- `local`: never leaves the device.
- `host-private`: the host keeps it, and guests see a projection of it.

The declaration sits beside the shape in `@hivemind/workspace-doc/shapes`. `doc-sync.ts`'s
sending side for a non-owner peer sends a projection:
- host-private paths are rewritten to `hive://<id>/…`, the same rule as the `peers.ts` egress
  fixed today;
- `cmd`/`args`/`task` are dropped or replaced with the agent's name;
- browser tiles' `url` is withheld until the host marks the tab shared (b3).

The hard part is that guests write the document back. A projected field must not read as
"deleted" when the guest's edit returns. So host-private fields live in a sibling container
that is never replicated to guests, with the tile record keyed the same. The document is then
safe because it never contains those fields, not because something filters them on the way
out.

**Enforced by:** a test that walks every leaf key of the shapes and fails on any key without a
declared scope. A second test serializes a guest's welcome and searches it for the host's tmp
path. This test is the generic form of today's egress test.

### H2 — Secret-bearing reads are the owner's unless shared (privacy, high)

- `file.read` / `git.fileContents` for a non-owner refuse paths that git ignores (one
  `git check-ignore` per read, cached per tree) and a fixed set (`.env*`, `*.pem`, `id_*`).
  The check sits in the host's `files` domain, the module that owns the data.
- The share dialog says plainly that terminals and agent transcripts are shown as printed.

### H3 — Roles say what they grant; browser tabs are private until shared (security, high)

- `agents` and `terminals` mean running code as the host's user. The share dialog names that,
  and the role picker shows it as the dangerous one.
- Terminals started for a peer get a scrubbed environment: no `HIVEMIND_BROWSER_*`, no
  control-socket paths, nothing on a denylist of the host's secret env names. One
  `peerEnv()` in `@hivemind/host`, used by every spawn path.
- The CDP endpoint asks for a per-tile token, which only the host's own processes are given.
  A browser tile is drivable by a peer's agent only when the host shares that tab, and that
  tab is the only thing it shares.

### H4 — One command registry, deny-by-default, every surface generated from it (security/drift, high)

One table per method: `{ name, minRole | "owner", actors: [window, cli, peer, phone, view, agent], params schema, since: "0.17" }`.
- `roles.ts`'s `LEAST`, the phone's `allows`, hcp's dispatch and the IPC preload are
  generated from it or checked against it.
- `may` becomes required on `Connection`, which removes the `?? true` in `views.ts:363`.
- **Parity test:** every method a domain answers appears in the registry. Every registry
  method marked `headless` is registered by `startHeadlessHost`, which would have caught g1.
  Every peer-callable method has a role.

### H5 — Optimistic file writes (correctness, medium)

`file.read` returns `{text, version}`, where `version` is the mtime and size or a hash.
`file.write(repo, file, body, version)` refuses with `CONFLICT` when the file on disk has moved
on, and the Editor offers to reload or overwrite. A soft per-file presence lock ("Ana is
editing") rides on presence. One owner (the files domain) holds the rule for every surface.

### H6 — Host-assigned tile slots (correctness, medium)

The guest proposes a frame. The host's store places the tile when it applies the insert, the
same as `reserveTileSlot` but run in `store.ts` on the one copy everyone converges on.
Alternatively, a CRDT-safe collision pass runs on merge. Then `pendingSlots` goes away.

### H7 — Connection state machine owns the cache (privacy, decision)

`shared-workspaces.ts`'s states become the single machine that owns the guest's local copy.
`removed` runs one `forget(workspace)`, which deletes the doc, media and view caches.
Whether a removed guest keeps a read-only copy becomes a **host** choice made at revoke time
("remove and wipe"), not a fixed decision. Wiping is best effort, since a guest can always
copy what they saw. The UI says so.

### H8 — Capability negotiation in hello (robustness, medium)

The sync and peer hello carry `{api: "0.17", methods: [...]}` from H4's registry. The client
asks before it calls (`host.supports("appearance.get")`). A feature the host lacks is hidden or
shown greyed with "host is on an older hivemind", never an error. A peer whose major API
differs is refused at hello, with both versions named.

### H9 — Untrusted input from peers (security, low)

`git.handOff`: a bundle size cap, fetched into a fresh ref namespace with
`core.hooksPath=/dev/null`, and nothing taken from the bundle's config.

### H10 — Golden tests from the guest's eyes (process)

Two-app specs assert what the guest's window shows: a screenshot region or DOM text for the
viewport, people's names, theme and the banner states. They also assert a **privacy probe**:
the guest page's whole serialized state (`document.body.innerText`, its stores, IPC replies)
must not contain the host's tmp root. The probe is cheap and catches every future leak of a
path, whichever surface it comes through.

## 3. Order

1. H1, H2, H3, H4. H4 first among them: it is the table the others hang off.
2. H10's privacy probe, alongside H1.
3. H8, H5, H6.
4. H7 (after the product decision), H9.

## 4. Done today

- **708a0e4**: `servePeer` now holds a single egress step. Every answer, error message and
  event (except raw terminal bytes and agent speech) going to a non-owner peer has the host
  folder rewritten to `hive://<id>`. Test: `peers.test.ts` "the host's folder never reaches a
  peer…". With egress disabled, it and two existing assertions fail (shown).
