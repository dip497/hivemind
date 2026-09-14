# Remote Machines — design

**Status:** proposed, rev 3 — herdr claims validated against the `v0.9.0` tag (commit
`b99002a`); our own load-bearing assumptions **run end to end over real OpenSSH**
(Appendix C). **Date:** 2026-09-11. **Supersedes the transport of**
`docs/design/remote-frames.md` (its `ssh://` URI seam stays).

Target: what herdr v0.9.0 shipped ("Manage Local and saved SSH machines from one
window, combined agent list, machine-scoped navigation, notifications, automatic
reconnects"), plus what a canvas can do and a one-workspace TUI cannot: several
machines' agents **live on screen at once**, on links from LAN to transatlantic.

### Implementation status (branch `feat/remote-machines`)

| Piece | State |
|---|---|
| Machine catalog (`@hivemind/core` `machines.ts`) | **built**, tested |
| Multi-viewer sessions, last-interactor-owns-size, `list` detail, `attach noSpawn` | **built**, tested (daemon under node *and* bun) |
| bun PTY adapter (`bun-pty.ts`), embedded addon, hook-runtime wrapper | **built**, tested; bun ≥ 1.2.10; CI/release bumped to 1.3 |
| Socket claim (never steal a live daemon's socket), socket `0600` | **built**, tested |
| CLI: `hive daemon`, `run`, `ps`, `attach`, `kill`, `machine`, `--machine` routing | **built**, tested; E2E over real OpenSSH with the compiled binary |
| M1: remote terminals run in the remote daemon over system ssh (`DaemonEndpoint` + `hive daemon bridge`), re-attach after drops, detach keeps them alive; in-app ssh2 fallback for hosts without `hive` | **built**, tested; E2E over real OpenSSH in the real app. Password/passphrase via askpass is unit-tested only |
| M2: remote fs, git, folder picker and the no-`hive` fallback terminal over the system ssh; `ssh2`, SFTP and the TOFU JSON store deleted | **built**, tested (unit + real app over OpenSSH). fish/zsh login shells untested |
| M4 (daemon side): output positions + per-session epoch, exact delta resume, flood resync for viewers that announce it, ssh compression instead of binary framing | **built**, tested (unit, real daemon, real ssh) |
| M3 machine UI: one catalog with the CLI (live-watched), Machines dialog (list with live state, add with probe + install, rename/off/remove, folder picker), machine chip on remote frames (state, RTT, sessions running there, retry, change folder), reconnect banner on remote terminals, Layers status dots + Machines strip; old saved hosts migrate in; the probe only counts a `hive` that can run the daemon | **built**, tested (unit + real app over OpenSSH, 8-step UI drive) |
| Validation on a second, real machine (another person's laptop over a phone hotspot, password auth, its own hivemind already installed) | add + install over ssh, frame bound, round trip on the chip, adopting a `hive run` job, a 17 s outage with recovery, and an app restart: 14/14 |
| Machine to machine, both directions (same two real machines) | his laptop and my app watching one session at once (typing both ways, size follows the last typist, his kill seen by my app); his CLI adding my laptop, installing hive on it, running/listing/attaching/killing a session there; his daemon pushing a real hook notification to my laptop over the network: 5/5 + 5/5 |
| `summary`/`cold` interest levels (need tile visibility from the renderer), trust levels UI | not started |
| M5 (read-only half): standalone daemon owns `hcp.sock`, forwards hook events to viewers that ask (`events` cap), refuses requests at once; desktop accepts them only for its own tiles; `hive push` (ntfy-style POST, per session+topic throttle) | **built**, tested (unit, real daemon, real ssh). Gap: a remote worker's auto-report to its parent needs the reply text in the event (its transcript path is dropped at the boundary), so it isn't delivered yet |
| Remote `hive ctl` into the desktop (approvals, trust levels), predictive echo | not started (M5 write half, M6) |
| `hive-linux-arm64` release asset (CLI only, arm runner, compiled-daemon smoke test in both Linux jobs), `install.sh` arm64 path, `machine add --install` downloading the same version's asset for other platforms | **built**; installer + download tested over real ssh; the arm job itself runs only on the next release |
| macOS as a *compiled* daemon host (spawn-helper extraction) | not started — the CLI refuses with a clear message |

---

## 1. What herdr actually built

Validated in source at `v0.9.0` (see Appendix A for file/line evidence).

| Herdr | Mechanism (verified) | What it means for us |
|---|---|---|
| Per-machine **server** (static Rust binary, musl Linux x86_64/aarch64, macOS both archs) | `portable-pty` + `libghostty-vt` (Zig) VT emulation of every pane, server-side | Our `pty-daemon` is the same shape (§2) — including the server-side VT |
| Server → client sends **cell diffs, not PTY bytes** | `PaneSurfaceFrame` = `FrameData` + `PaneSurfacePatchRow` changed-cell spans, revisioned; framing `[u32LE len][bincode]`, 2 MB frame cap | Bandwidth is bounded by *screen change*, not output volume. A `cat 50MB` costs them a few frames. We must match this under floods (§4) |
| **One render slot** per client | `ClientWriterQueue { control: VecDeque, ordered: VecDeque, render: Option<Vec<u8>> }` — a new render while one is pending is `TrySendError::Full` and dropped | Latest-state-wins: a slow link never back-pressures the PTY; input/control never queue behind screen data. **Our draft got this wrong** (§3b) |
| Only the **active** machine gets screens | `set_client_shell_surface_active`: inactive → `discard_pending_render`, no repaint; `message_policy.rs` still passes metadata, notifications, shutdown | Binary, per-connection. Their TUI shows one workspace at a time so it never needed more. A canvas does (§4) |
| Disconnected machine → last state **dimmed**, input disabled until a fresh screen | client cache | Same UX is right for us when *disconnected*; not an issue while connected |
| Reconnect 500 ms → 30 s, heartbeat 5 s / timeout 10 s | `retry_delay = 500ms · 2^min(n−1, 6)`, capped 30 s — **no jitter** | Copy, add jitter |
| System `ssh` + generated config + private ControlMaster | one `ssh … exec herdr --session S remote-client-bridge` child **per accepted local connection**; client talks to a 0600 local unix socket | Copy (§3a) |
| Version skew | wire variants are **append-only**; golden bincode digests freeze generation-1 payloads (`wire.rs` ~L1729); restart needed only across an endpoint *generation* or missing `surface_interest`/`health_check` caps | Same policy we want. Copy the golden-bytes test technique (§7) |
| Remote install | `uname` → Linux/Darwin × x86_64/aarch64 only; probes PATH, `~/.local/bin`, Homebrew (mac + linuxbrew), mise, Nix; downloads per `herdr.dev/latest.json` with **sha256 verify**; non-interactive refuses to install | Copy |
| Scrollback | lives server-side; the client receives screen surfaces, not history (inferred from the protocol) | Scrolling back is a round trip for them. Ours stays local in xterm.js — an honest advantage (§5) |
| Live handoff | experimental, opt-in `--handoff` | Skip (§7) |

## 2. The lazy core: remote is the same daemon, not a new server

hivemind already has the server herdr built. `apps/desktop/src/main/pty-daemon.ts`
is a headless node process (spawned via `ELECTRON_RUN_AS_NODE`) that:

- owns every `node-pty` session and speaks a socket protocol (`pty-protocol.ts`),
- feeds **every byte into an always-on `@xterm/headless` per session** and replays
  reattach via `SerializeAddon.serialize()` (`pty-session-manager.ts`) — that *is*
  herdr's server-side VT, already paid for,
- keeps disk session snapshots that survive its own death, emits the agent hook
  scripts, hosts the HCP token/socket.

> **Run the same daemon on the remote host and talk to it through the stdio of
> one `ssh … hive daemon bridge` child.**

herdr surfaces its ssh bridge as a private local socket because its client wants a
socket. Ours does not need one: `DaemonEndpoint` (built in M1) takes any stream, so the
local daemon gets a unix socket and a remote one gets the ssh child's stdio — one
protocol, one session manager, one set of agent hooks, local and remote.

Consequence: remote terminals gain **persistence**. `main/remote/pty.ts` runs remote
PTYs in-main today precisely because "an SSH drop loses remote shell state"
(`remote-frames.md`). With the daemon on the far side the PTY is a child of a
process on the remote box; an SSH drop loses nothing. The in-main `RemotePty` stays
only as the fallback for hosts without `hive`.

### The PTY in a single-file `hive` (M0 — resolved on Linux, see Appendix C)

`hive` is compiled with `bun build --compile`. Measured, not assumed:

- **Embedding works.** A static `require("…/pty.node")` makes bun embed the N-API
  addon; the binary runs from an empty directory with no `.node` beside it. node-pty's
  own loader probes paths relative to `__dirname` and fails inside `$bunfs`, so the
  shipped build never uses it: `apps/cli/scripts/build.ts` defines `HIVE_PTY_NATIVE`
  (the addon's absolute path), which turns `require(HIVE_PTY_NATIVE)` into a static
  require, and `bun-pty.ts` drives that addon directly. No tarball needed.
- **node-pty's JS layer is broken under bun.** The first `write()` kills the shell
  with `SIGHUP` (master fd closed). node-pty reads via `tty.ReadStream(fd)`; under
  bun a stream on that non-blocking master errors with `EAGAIN` (measured). node-pty
  ignores EAGAIN, so the fd is most likely closed by bun's stream teardown (inferred,
  consistent with the SIGHUP). Reproduced in 10 lines (bun 1.3.11); identical code
  works under node.
- **Fix: a bun-native shim over the same addon** (~80 lines, replaces node-pty's
  `UnixTerminal` for the daemon's `ManagedPty` factory): `native.fork(...)` → fd;
  reads via `Bun.file(fd).stream()` (event-driven; 20 idle PTYs ≈ 14 ms CPU/s);
  writes via node-pty's own queued `fs.write` + EAGAIN retry; `native.resize(fd,
  cols, rows, 0, 0)`; pause stops pulling (a read already in flight is held until
  resume), so the kernel buffer fills and the child blocks. Shipped as
  `apps/desktop/src/main/bun-pty.ts`; input, size, resize, UTF-8, pause holding
  1.3 MB, exit ordering all verified on bun 1.3.11 and 1.2.10. **bun ≤ 1.2.0 cannot
  read a pty this way** (1.1.45 and 1.2.0 measured) — the adapter refuses with a clear
  error, and CI/release moved from bun 1.1 to 1.3.
- **macOS (untested — no mac here):** node-pty forks through a `spawn-helper`
  executable that must exist on disk; the binary must extract it to
  `~/.cache/hivemind/<version>/spawn-helper` (chmod +x) on first run. Linux ignores
  `helperPath`.
- **Size:** 99 MB raw / 38 MB gzip (it carries the bun runtime). Prefer the remote
  downloading the release asset over uploading it from the client.

Fallback if the shim disappoints on macOS: run the unmodified daemon under `node`
on the remote (node-pty works there today — the whole Appendix C E2E passed on node).

Also needed regardless: **a `linux-arm64` asset.** We publish `hive-linux-x86_64`
and `hive-darwin-arm64` only; herdr ships aarch64 Linux because remote boxes are
often Graviton / Ampere / Pi. The native PTY must be built on an arm64 runner, not
cross-compiled (same reason the mac job is host-arch only).

## 3. Transport

### 3a. Drop `ssh2`; shell out to OpenSSH (herdr's flags, verified)

```
ssh -T <target> 'exec hive --session <s> bridge'
-F <generated config>        # Include ~/.ssh/config, Include system config, then
                             #   Host *  ServerAliveInterval 15 / ServerAliveCountMax 4
-S <private ctl socket> -o ControlMaster=auto -o ControlPersist=yes   # not on Windows
background connects add:
  BatchMode=yes NumberOfPasswordPrompts=0 StrictHostKeyChecking=yes
  ConnectTimeout=10 ConnectionAttempts=1
teardown: ssh -O exit -o BatchMode=yes <target>
```

Wins, all by deletion of `main/remote/conn.ts` + `known-hosts.ts`:

- `~/.ssh/config` aliases, `ProxyJump`, bastions, `IdentityFile`: free — the list
  `remote-frames.md` deferred.
- ssh-agent, FIDO `sk-` keys, 2FA, agent forwarding: free. `known_hosts` is
  OpenSSH's; our TOFU JSON goes away.
- **CPU:** ssh2 runs the cipher in JS on the Electron main event loop — the same
  loop that relays canvas IPC. OpenSSH does it in another process with AES-NI.
- ControlMaster: `hive ctl --machine`, bootstrap probes, and reconnects reuse one
  authenticated TCP connection.

Costs, handled:

- **Password auth** exists today (`saved-hosts.ts`, Electron `safeStorage`). Keep it
  with an `SSH_ASKPASS` helper + `SSH_ASKPASS_REQUIRE=force` (~20 lines), shipped in
  the *same* milestone as the transport switch. Background reconnects stay
  `BatchMode=yes` → **Attention** state.
- **Windows client**: OpenSSH ships with Windows 10+; no ControlMaster there
  (herdr has the same gap and generates a config without `ControlPath`).

### 3b. One connection per machine, prioritized writer — never pause the PTY

*Rev 1 of this doc proposed per-stream credit windows whose starvation would
back-pressure the remote PTY via the daemon's existing `pause`/`resume`. That is
wrong for remote: a slow Wi-Fi link would throttle the remote agent itself. herdr
proves the better shape — slow viewers drop frames, never producers.*

- **One bridge connection per machine** carries everything, like herdr's one
  client connection per server. No separate mux layer: the daemon protocol already
  keys every message by session `id`. fs / git / listdir become new request types
  on the same protocol (the daemon runs `git` and reads files locally on the
  remote), which retires SFTP along with ssh2.
- **Framing** goes binary: `u32LE len | u8 kind | payload`, `kind 0` = the existing
  JSON control message, `kind 1` = PTY data `id | u64 seq | raw bytes`. Stops paying
  JSON-escape overhead on the hot path — **measured ×1.45** for `seq 1 400000` today
  (3.89 MB on the wire for 2.69 MB of output); 2 MB frame cap (herdr's). Local sockets
  use it too — one codec.
- **Daemon-side writer per connection, strict priority:**
  1. control lane — input acks, resize, exit, HCP events, request replies;
  2. per-session output, round-robin across sessions;
  3. never blocks the PTY read loop. The PTY is always drained into the headless
     VT; what the viewer gets is governed by §4.
- Local renderer back-pressure (`pause`/`resume`, which exists for `cat hugefile`
  into a slow renderer) stays **local-only**. For remote viewers the same signal
  flips a session to sync mode (§4) instead.

## 4. Output modes — raw when cheap, state-sync when not

Per session, per viewer, the daemon picks a mode. Everything comes from pieces the
daemon already has (headless xterm + serializer).

| Mode | When | Wire |
|---|---|---|
| `raw` | tile `live` (focused / readable zoom) **and** unsent backlog under budget | raw PTY bytes, coalesced daemon-side with window `max(4 ms, rtt/4)` — full fidelity, local scrollback grows exactly as locally |
| `sync` | backlog over budget (flood, slow link, renderer said "behind") | drop the backlog; **one pending snapshot slot** per session (latest wins — herdr's render slot); send `serialize()` of the screen when the writer frees, then return to `raw` from that snapshot's `seq` |
| `summary` | visible but small, or on an unfocused machine | snapshot at 2–4 Hz, byte-capped |
| `cold` | offscreen / collapsed | state + exit events only; on refocus one snapshot + scrollback tail |

- Budget default ≈ max(256 KB, 1 s × measured throughput). A `cat 50MB` over 1 Mbps
  becomes a handful of snapshots, the remote process runs at full speed, and
  siblings' keystrokes ride the control lane untouched.
- Honest cost of `sync`: the client's local scrollback has a gap for the flooded
  span. Render a one-line marker ("… output skipped while catching up — history is
  on the remote") and fetch the range on demand. herdr has the same property
  (history is server-side for them always).
- `summary`/`cold` are what let a canvas keep 12 tiles on 3 machines **live** at a
  few kB/s. herdr's per-connection binary interest cannot express "visible but
  small"; it doesn't need to, a TUI shows one workspace.

## 5. Resume by sequence

Every `kind 1` frame carries a per-session monotonic `seq`; the client acks the
highest contiguous seq it has written into xterm.js. The daemon keeps a byte ring
per session keyed by seq.

- Reconnect: `attach {id, sinceSeq}` → gap inside the ring = **delta only**; gap
  beyond it = one `serialize()` snapshot + tail (today's full-replay path becomes the
  fallback, not the default).
- Scrollback stays **local** in xterm.js: scrolling back through an agent's output
  on a 150 ms link costs zero round trips.
- Multi-viewer (two laptops on one remote daemon): herdr's rule, verified in its
  changelog — **the last viewer to interact owns the PTY size**; others letterbox.
  A viewer whose terminal disappears detaches rather than resizing panes to a
  fallback size (herdr #3519 — that bug caused expensive history reflow).

`seq`, `sinceSeq`, and the binary frame are additive to `pty-protocol.ts`.

## 6. Machines as a canvas dimension

Catalog `~/.config/hivemind/machines.json`, herdr's saved-profile shape and guard
rails (`src/client/endpoint/catalog.rs`, verified):

- `{ version: 1, machines: [{ id, label, target, session, enabled }] }`, strict parse
  (unknown fields rejected),
- caps 64 KB file / 64 profiles / 128-byte label / 1024-byte target, no control
  chars; target validated and **rejected if it embeds a password**,
- write: private (0600) temp file → `fsync` → atomic replace → `fsync` parent dir;
  **refuse if the target path is a symlink or non-file**,
- unreadable catalog leaves live connections untouched and is retried,
- opaque generated ids; users read them from `hive machine list`.

No passwords, keys, or control sockets in the catalog; auth is OpenSSH's (§3a);
`saved-hosts.ts` shrinks to the optional askpass secret.

- A frame's `workspacePath` stays the `ssh://user@host:port/path` URI — the
  path-keyed IPC seam from `remote-frames.md` is untouched. `machineId` is a label
  over `hostId` resolved from the catalog, not a new field threaded through IPC.
- Connection state per machine: `idle → connecting → online → attention → backoff`.
  Heartbeat 5 s (ping only when quiet), timeout 10 s (also expires a connect whose
  initial snapshot never lands), reconnect `500 ms · 2^(n−1)` capped 30 s **plus
  full jitter** (herdr has none: after a Wi-Fi flap every machine retries in
  lockstep). PING RTT is the number on the machine chip.
- `attention` = needs a human (host key, auth, incompatible binary). Background
  connects never prompt, install, or restart anything.
- One machine's failure never blocks another's input or moves canvas focus.
  Disabling/removing the machine in view falls back to Local.

CLI: `hive machine add|list|rename|enable|disable|remove` (`--json` on list), and
`hive ctl --machine <id> …` routed through the profile's ssh target with no UI
running (herdr's `SavedSshApiBridge` does exactly this). Remote ids print
namespaced `machineId:tileId` — herdr's ids are per-server and collide (its docs
warn two machines can both have `w1:p1`).

## 7. Bootstrap and version policy

`hive machine add <target>`: `uname -sm` → map only Linux/Darwin × x86_64/aarch64
(`amd64`/`arm64` aliases), else fail clearly. Look for a compatible `hive` on PATH,
`~/.local/bin`, Homebrew (`/opt/homebrew`, `/home/linuxbrew/.linuxbrew`); if missing,
copy this client's asset when the platform matches, otherwise download on the remote
with `curl -sfL --max-time 120` and **verify sha256** from a release manifest; install
to `~/.local/bin/hive`; warn if that is off the remote PATH. Non-interactive runs
refuse to modify the host. Never copy local config, plugins, or secrets.

- **Protocol is append-only.** Unknown request kinds and fields are ignored; a newer
  client on an older daemon loses that feature, not the attach. Enforce it the way
  herdr does: **golden byte fixtures** for representative frames, checked in, so a
  breaking encode change fails CI. (herdr's "servers older than endpoint generation
  1 need a one-time upgrade" was a single migration into this regime, not an ongoing
  failure mode — rev 1 of this doc overstated it.)
- **No live handoff.** Replacing a remote daemon asks first, default No. Disk session
  snapshots on the remote restore the session *shape*; the PTYs honestly do not
  survive.

### 7a. Launch, hooks, and control plane — lessons from running it

Each of these failed or surprised in the Appendix C runs; each is now a requirement.

- **Call `hive` by absolute path.** A non-interactive `ssh host cmd` gets a bare
  PATH (`~/.bun/bin`, `~/.local/bin` absent). Bootstrap records the resolved path in
  the machine profile; herdr probes absolute install paths for the same reason.
- **`hive daemon --detach` daemonizes itself** (spawn a `detached` child + `unref`,
  exactly as `daemon-client.ts` does locally) and the bridge never relies on shell
  backgrounding. Observed: `cd X && setsid nohup <daemon> &` launched over ssh dies
  when the ssh session tears down (root cause not pinned — the subshell parent is
  the variable); the detached-spawn form survived 12/12 with and without `cd`.
- **Readiness = a successful `ping`**, never "socket file exists": the daemon unlinks
  and re-binds, and a stale file from a dead daemon looks identical.
- **Socket paths ≤ 108 bytes** (`sun_path`). A long path failed as a misleading
  `EADDRINUSE`. Use `$XDG_RUNTIME_DIR/hivemind/<short-id>.sock` (fallback
  `/tmp/hivemind-<uid>/`), never a path derived from a deep workspace dir.
- **Fix the unconditional unlink** (`pty-daemon.ts` ~L368 unlinks the socket before
  `listen` even when a live daemon owns it). Two clients racing to start one remote
  daemon would orphan the first daemon *and its PTYs*. Probe-connect first; unlink
  only on `ECONNREFUSED`/`ENOENT` (herdr refuses with "already listening"). Also a
  latent local bug.
- **Hook runner, not `execPath`.** Hooks are `.cjs` scripts invoked as
  `<execPath> hook.cjs …`; on the remote `execPath` is `hive`. Verified: `BUN_BE_BUN=1
  <hive> hook.cjs` runs them with full `net`/`fs`. The env var goes **in the hook
  command string** (`/usr/bin/env BUN_BE_BUN=1 <hive> …`), never in the agent's env —
  that would turn every `hive ctl` inside the agent into bun.
- **Remote agent status over `ssh -R`.** The hooks report to an HCP socket; on the
  remote nothing listens there. Verified: `ssh -R <remote.sock>:<local.sock>` with
  `StreamLocalBindUnlink=yes` delivers a real stop-hook event from the remote into a
  local socket (sshd creates the remote end `0600`). Requirements that came with it:
  - hook events carry **no token** (`{"t":"event","topic":"turn",…}`) — socket
    permissions are the only guard, and on a remote box root can open that socket;
  - so main exposes a **per-machine HCP endpoint** (own socket, own token, method
    allowlist: turn/status/notification/approval-reply *for that machine's tiles*;
    never spawn-local-terminal or anything that executes on the laptop), and `-R`
    forwards that, not the main HCP socket;
  - servers with `AllowStreamLocalForwarding no` need a relay through the bridge
    connection instead — detect at `machine add`, fall back automatically.

### 7b. Connection, auth and pairing — the security model

**Two directions, two mechanisms.**

| Direction | Carries | Auth | Built |
|---|---|---|---|
| laptop → machine | spawn, attach, input, resize, `ps`, fs/git | **OpenSSH** — your keys / agent / FIDO, `known_hosts` | yes (CLI) |
| machine → laptop | agent status, notifications, approval requests, `hive ctl` from remote agents | a **per-machine capability token** on a per-machine socket forwarded with `ssh -R`, method allowlist = trust level (§12b) | no (M5) |

**Why there is no pair code for ssh machines.** Possession of an ssh key that logs
in as you *is* the pairing; anyone who has it can already read every file the daemon
could show them, so a second code adds a ritual, not a boundary. The pairing
ceremony is the one herdr uses: the first contact is an interactive `ssh <host>`
that accepts the host key; every background connection afterwards runs
`BatchMode=yes` + strict host-key checking and stops at **attention** instead of
prompting or trusting silently. What is enforced today:

- no secrets in `machines.json` (strict schema; `user:password@` rejected);
- targets that could be read as ssh options (`-oProxyCommand=…`) are rejected, and
  every remote argument is single-quoted — the remote shell sees one word;
- the remote `hive` runs by an absolute path recorded at `add`, never via PATH;
- the daemon socket is `0600` in a `0700` directory, never TCP — a shell as you is
  reachable only by you;
- `machine add --install` copies only *this* binary, same platform only, via a temp
  file + rename.

**Where a pair code *is* needed — any path that is not ssh:**
- *Phone / mobile relay* (later; orca's model, Appendix D): phone shows a QR with a
  one-time secret → X25519 key exchange → end-to-end encrypted frames the relay
  cannot read; a device list with revoke. Outbound-only on both ends.
- *Remote → laptop*: not a code but a token minted per connection, scoped by trust
  level, never the desktop's main HCP token (hook events carry no token today —
  §7a — so the socket and its allowlist are the boundary).
- *Push*: payloads carry no transcript ("build-box: approval needed"); an approval is
  never granted by opening a plain URL — the notification opens `hive attach` / the
  app, where the answer is given.

**Threat model, briefly.** Compromised remote box → it controls its own sessions
(it already could) and can send status for its own tiles; with `status`/`collaborate`
trust it cannot run anything on the laptop. Stolen laptop → the ssh keys are the
crown jewels; use an agent with a passphrase or a FIDO key. Network attacker → ssh.
Another user on the server → the `0600` socket.

## 8. Latency: predictive echo (opt-in, last)

Above ~40 ms RTT, echo typed characters locally in `raw`-mode tiles and reconcile
against real output by `seq` (mosh's model, scoped to a detected line-editing state,
abandoned on any cursor surprise). Off by default. herdr has nothing equivalent;
sequenced last because it is the one feature that can *look wrong* rather than slow.

## 9. Milestones

| # | Deliverable | Done when |
|---|---|---|
| **M0** | bun PTY shim wired into the daemon's `ManagedPty` factory; embed plugin; `hive daemon --detach`; hook runner; linux-arm64 + macOS `spawn-helper` extraction | the Appendix C E2E passes with the daemon running **inside the compiled `hive`** on Linux x86_64 + arm64 + macOS arm64 (today it passes on node; the shim is proven standalone) |
| **M1** | OpenSSH bridge → local socket; askpass; probe-before-unlink fix; remote terminals through the remote daemon; delete `remote/pty.ts`, `conn.ts`, `known-hosts.ts` | kill the link mid-`claude`, reconnect, session intact with correct scrollback (already demonstrated for `bash` on node) |
| **M2** | binary framing + prioritized writer; fs/git/listdir as daemon requests; delete SFTP path | editor + diff tiles on one connection; keystrokes unaffected by a sibling `cat` |
| **M3** | catalog, `hive machine`, machine chips, health/backoff/jitter | one machine unplugged, others keep taking input; focus never jumps |
| **M4** | `sync`/`summary`/`cold` modes + seq/ack delta resume | perf budget below |
| **M5** | remote HCP forwarding: unified agent list, notifications, `hive ctl --machine` | an approval on machine B notifies and is answerable locally |
| **M6** | predictive echo | keystroke feel on a shaped 120 ms link |

## 10. Perf budget (acceptance for M4)

Real display (`DISPLAY=:1`; xvfb is llvmpipe — `docs/design/performance-native-2026-09-09.md`),
`tc netem`-shaped ssh link, interleaved runs, `perf-views.mjs` + new `perf-remote.mjs`:

| Metric | Budget |
|---|---|
| keystroke → glyph, 80 ms RTT, `raw` tile | < RTT + 16 ms |
| idle bandwidth per machine, all tiles `summary`/`cold` | < 2 kB/s |
| reattach after 5 min sleep, first correct frame | < 300 ms |
| `head -c 50M /dev/urandom \| base64` in a tile over a 1 Mbps link | remote wall time within noise of no viewer attached; sibling keystroke latency unchanged |
| 12 remote tiles across 3 machines, Electron main CPU | within noise of 12 local tiles |

## 11. Semver / release

New `hive machine` verb, `hive daemon`/`hive bridge`, new remote + linux-arm64
assets → **minor**. The bridge protocol becomes a versioned public surface; a
breaking change later would be **major** — hence §7's golden fixtures.

## 12a. CLI surface

Four new top-level verbs, citty subcommands in the existing style (`--json` on every
leaf → the `{ ok, data }` / `{ ok:false, code, error }` envelope from `format.ts`).
`hive agents` is taken (agent-provider plugins), so live sessions are `hive ps`.

```
hive daemon start [--socket P] [--foreground]   start this machine's PTY daemon (detached by default).
                                                 Idempotent: a live daemon on P → ok, not an error.
hive daemon status [--socket P] [--json]         { running, socket, pid?, buildStamp?, sessions }
hive daemon stop   [--socket P]                  graceful shutdown; sessions persist as snapshots

hive ps     [--machine M] [--socket P] [--json]  sessions on a daemon: id, state, cmd, cwd, pid, viewers, size, title
hive attach <session> [--machine M] [--socket P] [--read-only]
                                                 this terminal becomes a viewer of <session> (id or unique prefix).
                                                 detach: ctrl-b d · literal ctrl-b: ctrl-b ctrl-b · never spawns
hive run [--cwd D] [--id ID] [--attach] [--machine M] -- <command…>
                                                 start a persistent session (tmux `new -d`); starts the daemon if
                                                 needed. Without the desktop this is the only thing that creates one.

hive machine add <target> [--label L] [--install] [--json]
                                                 probe over ssh (uname, find hive by ABSOLUTE path), optionally
                                                 copy this binary to ~/.local/bin/hive (same platform only), then
                                                 save the profile. Nothing is saved if the probe fails.
hive machine list  [--json]
hive machine check <machine> [--json]            re-probe: reachable, platform, hive path + version, daemon running
hive machine rename <machine> <label>
hive machine enable|disable <machine>
hive machine remove <machine>                    forgets the profile only; the remote daemon and its agents keep running
```

- `<machine>` / `--machine M` = profile id **or** label (exact; an ambiguous label is
  an error that lists the ids).
- `--machine` routes through the profile's ssh target with the system `ssh`
  (BatchMode for `ps`, `-t` for `attach`) and runs the remote `hive` by the absolute
  path recorded at `machine add` — the non-interactive PATH is bare (§7a).
- Default socket: `$HIVEMIND_PTY_SOCK`, else `<config>/hivemind/pty-daemon.sock` —
  the path the desktop daemon uses on Linux, so on any one machine the desktop,
  `hive daemon`, `hive ps` and `hive attach` meet at **one** daemon.
- Exit codes follow `hcp.ts`: 0 ok · 1 error · 2 usage · 3 unavailable (no daemon /
  host unreachable) · 4 timeout · 5 not found (session / machine).

Daemon protocol additions (all additive; old desktop clients unaffected):
`list {detail:true}` → `sessions.detail[]`; `attach {noSpawn:true}` → `attached`
with `error` instead of spawning; a session fans out to **every** attached
connection and detaching one leaves the others; **the last viewer to interact
(attach / resize / write) owns the PTY size**.

## 12b. Agents across machines

The desktop app is the hub; agents never hold ssh keys or open their own connections.

- **Local agent → remote**: `hive ctl --machine M read|send|spawn …` — main routes the
  call over its connection. Spawning on a remote machine is the sanctioned version of
  "the agent ssh'es into the box": the new tile is visible, persistent, killable.
- **Cross-machine workflows** fan out over the same `read`/mailbox path; tile ids are
  namespaced `machineId:tileId`.
- **Remote agent → anything** is gated by a per-machine **trust level** chosen at
  `machine add`, enforced as the method allowlist of that machine's HCP endpoint (§7a):

| trust | a remote agent may |
|---|---|
| `status` (default) | report turn/status/notification/approval for its own tiles |
| `collaborate` | + read and message other agents (any machine, incl. local) |
| `full` | + spawn tiles, **including on the laptop** — only for boxes you own outright |

## 12c. Mobile

herdr ships **no mobile app and no web dashboard** (their docs, "Work from your
phone"): you ssh from a phone terminal and the TUI switches to a single-column layout
at `ui.mobile_width_threshold` (default 64 cols; `src/client/shell/mobile.rs`, ~1.1k
lines). Their notifications are toast / OSC-terminal / OS only — nothing reaches a
phone that is not connected.

Ours, in order:
1. **Phone over ssh** — `hive ps` + `hive attach` (§12a) on the machine where the
   agents run. Works with the laptop closed, because the daemon lives on the server.
   `hive ps` renders a compact layout below 64 columns.
2. **Push** (beats herdr) — the remote daemon itself sends approval / turn-done events
   to a per-machine ntfy/webhook URL. Needs the remote daemon to consume hook events
   locally *and* forward them to the desktop — `ssh -R` alone only works while the
   desktop is connected.
3. A tailnet-only web page, maybe later; a native app, probably never.

Rules: a phone viewer follows the same last-interactor-owns-size rule as everyone;
approvals are idempotent actions with ids (first answer wins); nothing ever listens on
a TCP port.

## 12d. Desktop UI screens (M3 — built; trust levels and phone pairing are not)

The CLI is the complete surface today; the app needs these, all backed by the same
catalog and daemon protocol:

1. **Add machine** (replaces `RemoteConnectModal`'s ssh2 form): target, label, trust
   level, "install hive if missing" → live probe result (platform, hive version) →
   save. Host-key / auth failure shows an **attention** card with a copyable
   `ssh <target>` to run once, never a password prompt inside the app.
2. **Machines** panel in Settings: status + RTT, check, rename, enable/disable,
   remove, trust level, push URL.
3. **Machine chip** on every remote frame and in the agent list (grouped by machine),
   dimmed with a banner while reconnecting; one machine down never blocks another.
4. **Session picker**: attach a tile to an existing remote session (`hive ps` data),
   so work started on a phone or with `hive run` shows up on the canvas.
5. Later: phone pairing (QR) and per-device revoke, if the relay is built.

## 12. Not in scope

- Windows **as a remote host** for saved machines (herdr's `from_uname` rejects it
  too; its standalone attach only reaches a Windows host with herdr preinstalled).
- Remote `.hivemind` issue stores, remote worktrees, live remote file-watching.
- Live handoff.

---

## Appendix A — herdr evidence (tag `v0.9.0`, `b99002a`)

| Claim | Where |
|---|---|
| Catalog shape, `CATALOG_VERSION 1`, caps 64 KB / 64 / 128 / 1024 | `src/client/endpoint/catalog.rs:10-15, 19-26` |
| Private temp file + `sync_all` + `replace_file` + `sync_parent_directory`, symlink refusal; path `state_dir/client/endpoints.json` | `catalog.rs:~340-372` |
| Heartbeat 5 s / timeout 10 s, initial-snapshot expiry | `src/client/endpoint/health.rs:3-4, action()` |
| Backoff `500ms · 2^min(n−1,6)`, cap 30 s, no jitter | `src/client/endpoint/supervisor.rs:11-12, retry_delay()` |
| `ConnectTarget::{Local, Ssh}` — Local is just another endpoint | `supervisor.rs` |
| ssh options, managed config, ControlMaster/Persist, `-O exit` | `src/remote/attach.rs:~760-810, ~2255-2290` |
| `SshStdioBridge`: 0600 local socket, 50 ms accept poll, per-connection ssh child + two copy threads; remote side `exec herdr --session S remote-client-bridge` | `attach.rs:21-23, ~1738, ~1779-1860, ~1995-2035`; used by `src/remote/saved.rs` |
| Remote platform map Linux/Darwin × x86_64/aarch64 only | `attach.rs:~136-152` |
| Install probe list, `latest.json` manifest with sha256, `checksum::verify_sha256` | `attach.rs:28, ~191-330, ~789-810, ~1541` |
| Restart policy: generation / `surface_interest` / `health_check` / detached daemon | `src/remote/restart_policy.rs` |
| Wire: `PROTOCOL_VERSION 22`, `[u32LE len][bincode]`, 2 MB cap (32 MB graphics), append-only variants, golden digests | `src/protocol/wire.rs:20-35, ~620, ~1592-1650, ~1729` |
| `RenderEncoding::{SemanticFrame, TerminalAnsi}`; `PaneSurfaceFrame` + `PaneSurfacePatchRow` cell spans | `wire.rs:43-48, ~1213-1240` |
| Single render slot, prioritized control lane, full slot drops the new frame | `src/server/client_transport.rs:~245-300`, test `client_writer_queue_keeps_render_slot_bounded` |
| Inactive connection: discard pending render, stop repaint, keep metadata | `src/server/headless/surface_interest.rs`, `src/client/endpoint/message_policy.rs` |
| Static musl Linux x86_64 + aarch64, macOS both, Windows | `.github/workflows/release.yml:46-56` |
| `portable-pty` (vendored), `libghostty-vt` via Zig in `build.rs`, tokio | `Cargo.toml:25-51`, `build.rs:6-39` |

**Rev 1 → rev 2 corrections.** Rev 1 read `main` HEAD, not the tag, and got these
wrong: (1) credit-window back-pressure onto the PTY — replaced by herdr's
drop-frames-not-producers model (§3b/§4); (2) "unselected machines are dimmed" —
dimming is for *disconnected* machines; (3) version-skew critique — herdr is
append-only with golden tests; (4) #3444 cited as a reattach bug — it isn't, and
#3519 is a vanished-terminal resize, not reattach; (5) proposed a new headless VT —
the daemon already has one; (6) claimed SFTP retained — it goes with ssh2.

## Appendix B — work inventory

### Touch

| File | Change |
|---|---|
| `apps/desktop/src/main/daemon-client.ts` | connect to a bridge socket per machine; `sinceSeq` on attach; binary codec |
| `apps/desktop/src/main/pty-daemon.ts` | run outside Electron; prioritized per-connection writer; `raw`/`sync`/`summary`/`cold` per viewer; fs/git/listdir requests; last-interacting-viewer sizing |
| `apps/desktop/src/main/pty-protocol.ts` | binary frame kinds, `seq`, `interest`, `snapshot`; append-only |
| `apps/desktop/src/main/pty-output-buffer.ts` | move coalescing daemon-side, rtt-aware window |
| `apps/desktop/src/main/pty-session-manager.ts` | seq-keyed byte ring next to the existing headless xterm |
| `apps/desktop/src/main/index.ts` | remote `ptySpawn`/fs/git branches → daemon requests; machine IPC |
| `apps/desktop/src/main/remote/{pty,conn,known-hosts,fs,exec,git}.ts` | **delete** (fs/git move into the daemon) |
| `apps/desktop/src/main/remote/saved-hosts.ts` | shrink to askpass secret |
| `apps/desktop/src/renderer/src/components/RemoteConnectModal.tsx` | "add machine": target + label + session |
| `apps/desktop/src/renderer/src/workspace/*`, `FrameRailMenu.tsx`, `TerminalTile.tsx` | machine chips/RTT/state, tile-visibility → interest, skipped-output marker |
| `apps/desktop/src/main/hcp/*` | forward remote HCP events, `machineId:` namespace |
| `apps/cli/src/{index,parse}.ts`, `commands/` | `hive machine`, `hive daemon`, `hive bridge`, `hive ctl --machine` |
| `.github/workflows/release.yml`, `install.sh`, `scripts/install-plan-test.sh` | linux-arm64 job; remote tarball; sha256 manifest |
| `docs/design/remote-frames.md` | mark transport superseded |

### New

`src/main/remote/bridge.ts` (ssh argv + generated config + ControlMaster + socket
pump), `src/main/remote/askpass.ts`, `src/main/machines.ts` (catalog + supervisor +
health), `src/main/remote/bootstrap.ts`, `apps/cli/src/commands/machine.ts`,
`src/main/bun-pty.ts` (the §2 shim: `native.fork` + `Bun.file(fd).stream()` +
`fs.writeSync` + `native.resize`, behind the existing `ManagedPty` interface),
`apps/cli/build.ts` (`Bun.build` with the embed plugin replacing the one-line
`bun build --compile` script), `src/main/hcp/machine-endpoint.ts` (per-machine
socket + token + allowlist). `ssh2` leaves `package.json`.

Also touched by §7a: `pty-daemon.ts` (probe-before-unlink; `--detach`),
`packages/hive-agents/src/providers/*/node.ts` (hook commands built from a
`hookRunner: string[]` instead of `execPath`).

### Tests

catalog caps / strict parse / password-in-target / symlink refusal / atomic write ·
health table (quiet → ping → expire; initial-snapshot expiry) · backoff sequence
with jitter bounds · ssh argv golden (managed and unmanaged, Windows variant) ·
golden binary frames (append-only guard) · writer priority: control never waits
behind output · flood test: producer never blocks while the viewer is throttled ·
`raw → sync → raw` seq continuity · delta resume and ring-overflow → snapshot ·
bootstrap decision table · e2e: remote tile survives a killed bridge; one machine
down leaves others typable.

### Risks, ranked

1. **The bun PTY shim on macOS** — Linux is proven; macOS needs the extracted
   `spawn-helper` and has not been run. Node-on-remote is the known-good fallback.
2. **Per-machine HCP endpoint scope** — a compromised remote must not reach
   anything on the laptop beyond its own tiles' status/approvals (§7a).
3. **`raw ↔ sync` transitions** — seq continuity and the xterm reset on snapshot
   must not flash or duplicate lines; this is where "feels fast" is won or lost.
4. **Headless-VT parse cost on the remote** — every byte is parsed by
   `@xterm/headless` in JS (herdr uses Zig `libghostty-vt`). Already true locally;
   measure throughput on a small arm64 box before calling M4 done.
5. **Password auth regression on the OpenSSH switch** — askpass lands with M1.
6. **Version skew** — only real with golden fixtures plus an old-daemon/new-client
   CI job.

## Appendix C — validation log (2026-09-11, this machine, bun 1.3.11, node 22.18)

Transport tests ran against a throwaway user-mode `sshd` on `127.0.0.1:22422` with
scratch host/client keys (the user's `~/.ssh` untouched), so every hop is real
OpenSSH. Daemon under test: the **unmodified** built `out/main/pty-daemon.js`.

| # | Claim | Result |
|---|---|---|
| 1 | node-pty addon embeds in `bun --compile` and spawns a PTY from an empty dir | **pass** (embed plugin required; `/dev/pts/N`, size, exit code correct) |
| 2 | compiled `hive` can run hook `.cjs` scripts | **pass** with `BUN_BE_BUN=1`; real `hcp-stop-hook.cjs` delivered its event |
| 3 | existing daemon runs under bun | **fail** on input — node-pty JS layer; shell SIGHUPs on first write |
| 4 | bun-native shim over the same addon | **pass** — input, size, live resize, exit code; event-driven reads; single-file binary |
| 5 | daemon launched over ssh outlives the session | **pass** with detached spawn (12/12); **fail** with `cd … && setsid nohup … &` |
| 6 | herdr-style bridge: local 0600 socket → `ssh` → remote socket, existing protocol | **pass** (node runtime) |
| 7 | SSH `SIGKILL` mid-session: remote daemon + PTY survive | **pass** |
| 8 | reattach over a new ssh: same pid, replay has pre-drop output **and output printed while disconnected** | **pass** (129 B serialized replay) |
| 9 | NDJSON wire overhead on a flood | **×1.45** (2.69 MB → 3.89 MB), 6.1 MB/s over loopback ssh |
| 10 | `ssh -R` unix-socket forward carries remote hook events to a local socket | **pass**; remote end created `0600`; events carry no token |
| 11 | 20 idle PTYs on the bun read path | ~14 ms CPU/s total |

Harness pitfalls hit and fixed along the way (all now requirements in §7a): bare
non-interactive PATH, 108-byte `sun_path`, readiness-by-file-existence, overlapping
daemons on one socket path (the unconditional unlink). Another session was rebuilding
`apps/desktop/out` during the runs, so the daemon bundle was frozen to a private copy.

Not yet run: macOS anything; the daemon composed *inside* the compiled binary with
the shim; `claude` (vs `bash`) through a remote reattach; `tc netem` latency numbers.

## Appendix D — orca (`stablyai/orca`, v1.4.200, 2026-09-11)

The closest competitor in shape (TypeScript + Electron, 66k stars). Read from its
README, `docs/reference/headless-linux-server.md`, `cloud/README.md`, `package.json`:

| Orca | How | Our position |
|---|---|---|
| **Remote runtime** `orca serve` | runs the **whole Electron app under Xvfb** on the server: apt-install GTK/NSS/ALSA/X libs, glibc ≥ 2.31, per-release package names | one self-contained `hive` (bun + embedded pty addon), no system packages — the thing §2 chose |
| **SSH worktrees** | `ssh2` in-process, auto-reconnect, port forwarding | system OpenSSH (§3a): config aliases, ProxyJump, agent, FIDO for free |
| **Mobile companion** (iOS/Android app) | phone and desktop each open an outbound WebSocket to a hosted **relay** (director + cells on Cloud Run, Terraform) that splices frames; X25519 host key (`tweetnacl`) | phone over ssh + `hive attach` now (zero infra); a relay only if we choose to run a service |
| **Push** | separate push gateway; the desktop authenticates with its X25519 key via an encrypted challenge; aggregate-only logging | user-owned ntfy/webhook from the remote daemon (§12c); borrow their rules: host-key-authenticated sender, no content in logs |
| Persistence | `@xterm/headless` + node-pty, "scrollback that survives restarts" | same building blocks; ours already replay across daemon death and ssh drops |

Take-aways: orca proves the market wants mobile, and shows what a relay costs to run
properly. Their headless server is the heavy path we avoided.
