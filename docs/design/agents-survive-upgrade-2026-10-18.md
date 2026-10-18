# Agents survive an app upgrade

Status: accepted 2026-10-18. Steps 1–3 built (`daemon-replace.ts`, `daemon-client.ts`); steps 4–7 built (`install.sh`, `install.ps1`, `daemon-runtime.ts`, `remote/pty.ts`). Facts below were checked on this Linux laptop on
2026-10-18; facts marked *from code* were read, not run (no Mac or Windows machine here).

## Verdict

Build **B: adopt the running daemon when its protocol version matches**. When it does not, or when
the running daemon's code is older than the app's, replace it **only once every session is idle**
(sleep each agent, replace, wake), never in the middle of a turn. Before any of that, fix two install
facts that break survival today regardless of the daemon check: on **macOS** any surviving daemon
blocks every upgrade, and on **Windows** a surviving daemon makes the upgrade delete half the
install.

## Problem

**Goal.** Installing a new release and restarting the app leaves every running agent running: an
agent mid-turn finishes its turn, and its tile reattaches in the new app with its screen intact.

**Constraints.** No shims for old app versions (a one-time restart when moving *to* this version is
fine). Plain names. No tests that read code. Linux, macOS (arm64) and Windows all ship. Remote
machines (`hive host` / `hive daemon` over ssh) follow the same rule.

**How it works today.** `ensureFreshDaemon()` in `apps/desktop/src/main/daemon-client.ts` hashes
`pty-daemon.js` on disk and compares it with the hash the daemon computed of itself at boot
(`BUILD_STAMP`, `packages/agent-host/src/pty-daemon.ts`). Any difference sends `shutdown`. The daemon
flushes snapshots and exits; its children get SIGHUP and die. The new daemon respawns each session from
its snapshot: the screen comes back, the agent is resumed with `--resume`-style flags, and **the turn
in flight is lost**.

**Real numbers.**

| What | Number | Source |
|---|---|---|
| Live sessions under the installed release's daemon (heavy user, this laptop) | 25 | `pgrep -P 386808 \| wc -l` |
| Saved session snapshots | 81 | `ls ~/.config/hivemind/sessions \| wc -l` |
| Daemon memory, 25 sessions | 135 MB RSS | `ps` on pid 386808 |
| Dev daemons, 1–10 sessions | 25–214 MB RSS | `ps` on the dev daemons on this box |
| Daemon uptime | 16.7 h (60 052 s) | `ps etimes` — it lives across app restarts, by design |
| Releases 2026-09-20 → 2026-10-18 | 13 (≈3 a week) | `git tag` |
| Releases that changed daemon-side source | 7 of 13 | `git diff --name-only` per tag pair over `agent-host`, `hive-agents`, `core`, `agent-sdk` |
| Releases that changed `pty-protocol.ts` | 3 of 13 (9.6, 9.8, 10.2) | same |
| Daemon start, extracted install | < 2 s to listening | experiment below |
| Daemon start, AppImage run directly (squashfs, load ≈ 5–10) | 48 s to listening | experiment below |

The content hash covers `pty-daemon.js` only, but that file imports content-hashed chunk names
(`./chunks/events-ig2ww56Q.js`), so a change in a chunk the daemon shares with main also changes the
hash. In practice nearly every release kills every agent.

**The known problem.** This is *upgrading a long-lived server without dropping its clients' work*:
tmux/screen server vs a newer client, nginx binary upgrade, systemd restart with an fd store, Erlang
hot code loading, VS Code's remote server per commit.

### What the daemon carries that an upgrade cares about

`BUILD_STAMP`'s comment says it protects "hooks, env injection". Reading the daemon, what is fixed at
its boot is:

1. **Its protocol** with the app (`pty-protocol.ts`), including the control-plane hand-off (`control`).
   Unknown message types have no `default:` branch — an old daemon ignores a new request and the app
   waits for a timeout.
2. **The manifest interpreter** (`@hivemind/agents` runtime code: spawn transforms, resume, hook
   injection). The *manifests* are data in `~/.config/hivemind/agents/` and the daemon already rescans
   that directory on mtime change (`ensureAgentsCurrent`), so a new agent manifest reaches a running
   daemon without a restart. Manifests carry `manifestVersion`, refused when it is not the reader's.
3. **Hook scripts it writes once at boot** into userData: `tile-session-tracker.cjs`,
   `hcp-event-hook.cjs`, the agent SDK. Nothing else writes them.
4. **`hookExecPath` = `process.execPath`**, the runtime that runs those scripts, and
   `HIVEMIND_HIVE_NET`, the `hive-net` that runs `emit` hooks through the hook door.
5. **The base environment.** Already sent per attach (`attach.base`); not a reason to restart.

Items 1–4 are the daemon's contract. The app's `hive` path is not baked in: agents find `hive` on
PATH, which the installer replaces with an atomic `mv`.

### Facts about executables (question 3 of the brief)

**(a) Linux.** `install.sh` does **not** run the AppImage mounted; it extracts it to
`~/.hivemind-app/hivemind-extracted/` (to avoid libfuse2). The daemon runs as
`hivemind-extracted/hivemind hivemind-extracted/resources/app.asar/out/main/pty-daemon.js <sock>`.
While any daemon lives, `hivemind_running` matches it (the pattern is the extracted dir), so the
installer *stages* the new build as `hivemind-extracted.staged`, and the launcher does
`rm -rf hivemind-extracted && mv …staged hivemind-extracted` on the next start.

*Experiment (scratchpad `exp/`):* copied the installed v2026.10.3 tree, started its daemon, attached a
`tick` loop, then did the launcher's `rm -rf` + `mv` swap under it.
- `/proc/<pid>/exe` → `…/hivemind (deleted)`; the daemon kept running; the loop kept ticking.
- `list`, `screen` (served by the screen worker thread) and a **new** session spawned after the swap
  all worked.
- A separate process running from the tree read a file inside `app.asar` and started a `Worker` from
  it after the swap: both worked. The live daemon holds `app.asar` open (fd 21), and Electron keeps
  that archive open, so later reads come from the old inode.
- On Linux, `@lydell/node-pty` ships only `pty.node` (loaded at boot); there is no `spawn-helper`
  exec'd per spawn.

**(a) AppImage run directly** (someone who downloaded it and double-clicked, not `install.sh`): the
daemon's exec path is `/tmp/.mount_hivemiXXXX/hivemind`. *Experiment:* `hivemind.AppImage
--appimage-mount`, daemon started from the mount (48 s to listen under load), session attached, then the
mount's runtime process ended → **the daemon died with SIGBUS (exit 135, "Bus error (core dumped)")**
and its session with it. The runtime unmounts when its own child (the app) exits, so for these users
**every app quit kills every agent today**, upgrade or not.

**(a) macOS** *from code.* The app lives at `~/.hivemind-app/hivemind.app`; the daemon runs as
`hivemind.app/Contents/MacOS/hivemind …/app.asar/out/main/pty-daemon.js`. `install.sh` refuses to
upgrade while `pgrep -f "$APP_DIR/hivemind.app/"` matches — **and the daemon matches**. Frozen
snapshots keep the daemon from its idle exit, so for anyone with a canvas the daemon never goes away:
the in-app updater ends at "Close hivemind, then run `hivemind upgrade`", and closing does not help.
When it does replace, it is `rm -rf` + `mv` (new inode), which Apple's guidance says is the safe way;
overwriting a signed Mach-O in place gets the process SIGKILLed. On macOS node-pty *does* exec
`spawn-helper` by path for every new session, so a daemon outliving its bundle spawns new sessions
with the next build's helper.

**(a) Windows** *from code.* The app is `%LOCALAPPDATA%\hivemind\app\hivemind.exe`; the daemon is the
same `hivemind.exe`, windowless. `Test-AppRunning` deliberately ignores windowless processes, then
`Install-App` runs `Remove-Item -Recurse -Force $dest` under `$ErrorActionPreference = "Stop"`.
Windows refuses to delete a running image and its loaded DLLs, so with a live daemon this deletes
what it can, throws, and leaves a **half-deleted install**. A daemon on Windows cannot outlive its
install directory being replaced: it must run from a directory the installer does not touch.

**(b) Hooks of running agents.** A running agent's hooks name `hookExecPath` (the daemon's
`process.execPath`) and the `.cjs` files in userData. On Linux and macOS that path is fixed and, after
the swap, names the *new* runtime, which runs the old CommonJS hook scripts fine. `hive` and `hive-net`
are replaced by `mv` of a temp file, so a running agent's next `hive ctl` uses the new CLI against the
new app — consistent. The hook door between `hive-net hook` and the daemon is a contract and belongs
in the protocol version.

**(c) Installers and the update flow.** Neither installer kills the daemon on install (only the
uninstallers do: `pkill -f "$appdir"`, `Stop-Process`). The in-app update runs the installer and
relaunches through the launcher. **The only thing that kills agents on upgrade is the app's
`shutdown` in `ensureFreshDaemon`.**

**(d) Remote machines.** `remote/pty.ts` adopts any `hive` there that can run sessions; there is no
version or stamp check at all. A protocol change shows up there as requests that time out.

Side finding: the installed daemon holds the app's Chromium fds (Local Storage leveldb, `/dev/shm`
files) inherited at spawn — harmless here, worth closing later.

## What others do

- **tmux** — server and client exchange a protocol version; on mismatch the client refuses ("protocol
  version mismatch (client 8, server 6)") and distros tell you to end sessions before upgrading; the
  workaround is running the old binary via `/proc/<pid>/exe`. Teaches: an integer protocol check works,
  and a refusal with no way forward is what users hate. ([Debian tmux NEWS](https://sources.debian.org/src/tmux/3.6a-2/debian/NEWS), [mbedded.ninja](https://mbedded.ninja/programming/operating-systems/linux/programs/tmux/))
- **GNU screen 4.4** — could not reattach sessions from older versions; Arch said close all sessions
  first. Same lesson. ([Arch news](https://archlinux.org/news/screen-440-1-unable-to-attach-old-sessions))
- **WezTerm mux** — client refuses a server with another codec version: "install the same version …
  on both". Teaches: version the *codec*, not the build. ([wezterm#5200](https://github.com/wez/wezterm/issues/5200), [openSUSE wezterm](https://build.opensuse.org/package/show/X11:terminals/wezterm))
- **iTerm2** — jobs run in long-lived per-session server processes, not as children of the app; an
  upgrade through its updater leaves them running and the new app reattaches. Closest to our goal and
  it is the adopt design. ([iTerm2 restoration](https://iterm2.com/restoration.html))
- **cmux** — no daemon; restores layout, scrollback and resumes supported agents by their session ids
  after relaunch; "does not checkpoint arbitrary live process state". That is today's hivemind
  behaviour, i.e. what we want to beat. ([cmux session restore](https://cmux.com/docs/session-restore))
- **nginx** — binary upgrade: new binary in place, `USR2` makes the old master exec the new one,
  which inherits the listening fds; old and new run side by side; old workers drain and quit.
  Teaches: hand fds to the successor, drain the old. ([nginx control](https://nginx.org/en/docs/control.html))
- **systemd fd store** — a service hands fds (sockets, memfds with state) to PID 1 with
  `FDSTORE=1` and gets them back after a restart. Teaches: an fd handoff is a known, supported
  pattern on Linux — and Linux only. ([systemd.io FILE_DESCRIPTOR_STORE](https://systemd.io/FILE_DESCRIPTOR_STORE))
- **Erlang/OTP** — two versions of a module live at once; running processes stay on old code until
  their next qualified call; `code_change` migrates state. Teaches: old and new code can coexist, and
  the switch happens at a quiet point of each process. ([erlang-questions](https://erlang.org/pipermail/erlang-questions/2008-December/040558.html))
- **VS Code remote server** — one server directory per commit under `~/.vscode-server/bin/<commit>`;
  old ones pile up (~145 MB each) and are cleaned later. Teaches: versioned install dirs let an old
  server keep running while the new one installs. ([vscode-remote-release#6326](https://github.com/microsoft/vscode-remote-release/issues/6326))
- **Squirrel.Windows** — `app-<version>` folders beside `Update.exe`; shortcuts repointed; old
  folders removed on a later start. The standard answer to "Windows locks a running exe". ([Squirrel docs](https://docsearch.algolia.com/mcp/docs/repo/squirrel/squirrel.windows), [Solita write-up](https://dev.solita.fi/2016/03/14/automatic-updater-for-windows-desktop-app.html))
- **macOS code signing** — overwrite a signed Mach-O in place and the kernel SIGKILLs it; replace by
  `mv` to a new inode. ([golang#54132](https://golang.org/issue/54132), [Apple forums](https://developer.apple.com/forums/thread/130313))
- **AppImage runtime** — the FUSE daemon lives as long as the app's own process; it is not built to
  serve a detached grandchild. ([type2-runtime#138](https://github.com/AppImage/type2-runtime/pull/138))
- Kitty, Warp, Orca: no surviving server found; sessions end with the app.

## Every side

| View | Worry |
|---|---|
| User | "I clicked Update and my agent's 20-minute refactor vanished" is today's experience on nearly every release. With adopt: nothing visible. On the rare replace: a banner "3 agents are working — the update finishes when they are done", with a *Restart them now* button. |
| Data | Sessions' screens and conversations already survive in snapshots and the agents' own stores. What must stay consistent is the contract between app and daemon — one integer. A daemon on old code is "stale but correct". |
| Operator at 3am | How do I know which daemon code runs? `hive daemon status --json` shows its protocol and build. A wedged old daemon: `hive daemon stop` (exists). A drain that never ends (an agent never idle): the button, and a cap (below). |
| Security | Nothing new crosses a trust line: same user, same socket, same token. Keeping an old daemon means old *bugs* live longer, including security fixes — a fix that matters there bumps the protocol or forces the drain. |
| Cost | Adopt is one ping. Running old + new runtimes side by side (versioned dirs) costs disk: ≈ 250–640 MB per kept version until its daemon exits. |
| Next year | (1) Daemon bug fixes reach users without anyone restarting — needs the idle replacement. (2) The phone/other devices attach to the same daemon — adopt keeps them attached across a desktop upgrade too. (3) A Windows daemon survives — needs a directory the installer does not replace. |

## Options

### A. Boring: always replace, but drain first

```
new app ──ping──▶ old daemon (stamp differs)
   │  wait until every agent is idle (status store) ─┐
   │  sleep each agent  ──────────────────────────────┤ conversation kept
   │  shutdown ───────────────────────────────────────┘
   └─▶ new daemon (new code) ──▶ wake each agent (resume) ──▶ tiles reattach
```
Keeps the content stamp. Every release still restarts every agent process, but never mid-turn.
Shells lose their running programs (a dev server, an ssh) every release.
**First break:** a long-running agent or a shell running a server is never idle, so the update never
applies, or the person is asked to cut it off ≈ 3 times a week.

### B. Adopt by protocol version; replace only at an idle moment

```
new app ──ping──▶ old daemon ──pong {protocol: 7, build: "2026.10.4"}
   ├─ protocol same ─▶ ADOPT: attach tiles; agents never notice
   │                    build older ─▶ "terminal host update waiting": applied by A's drain
   │                                    when every session is idle, or on the person's click
   └─ protocol differs ─▶ A's drain (sleep at idle, replace, wake), with a banner
```
`DAEMON_PROTOCOL_VERSION` lives in `pty-protocol.ts`; both sides import it. The daemon answers an
unknown request with `error` instead of silence, so additive messages need no bump; a bump means
"the app needs something the old daemon cannot do".
**First break:** a release that bumps the protocol while agents are busy waits for the drain —
3 of the last 13 releases touched the protocol; with the additive rule most of those (new optional
fields) would not have bumped.

### C. Bold: hand the PTYs to the new daemon

```
old daemon ──spawn(new daemon, stdio: [..., pty fds])──▶ new daemon
     │ serialize sessions (snapshot format + seq/epoch + pids)        │ wrap each master fd
     └─ exit without SIGHUP to children ──────────────────────────────┘ watch child exits by pidfd
```
nginx/systemd-fdstore style: every upgrade runs new daemon code with zero loss.
**First break:** node-pty cannot adopt an existing master fd (it creates its own pty), and Node has
no `TIOCSWINSZ` or `pidfd_open` — a native addon on Linux and macOS. Children are no longer the new
daemon's children, so exit codes come from pidfd (Linux ≥ 5.3) or polling. **Windows ConPTY cannot do
it** (the pseudoconsole belongs to the process that created it). The screen worker's parsed state
must be carried over too.

### Scale

The load that grows is sessions per machine (25 today, heavy user) and releases (≈ 3 a week).

| Design | Today (25 sessions) | 10x (250) | 100x (2 500) |
|---|---|---|---|
| A | every release: 25 agents restarted ≈ 25 × 3 s CPU = 75 CPU-s, ≈ 5 s wall on 16 cores; turns kept if drained | 750 CPU-s ≈ 47 s wall of resume storm; holds only staggered | 7 500 CPU-s ≈ 8 min; breaks |
| B | adopt: 1 ping (< 1 ms) + 25 reattaches ≈ 25 × 200 KB = 5 MB replay; drain on ≈ 1 in 13 releases | 50 MB replay, only for shown tiles; holds | 500 MB if all shown; holds because only shown tiles get bytes |
| C | 25 × ≈ 3 fds = 75 fds passed + 25 snapshots serialized (≈ 135 MB RSS worth of state) | 750 fds; holds | 7 500 fds > default soft limit 1 024; needs `ulimit -n` raised |

Arithmetic: agent resume ≈ 3 CPU-s each is an assumption (a Node CLI booting and reading its
conversation; not measured here). Replay ≈ 200 KB per tile = 1 000 lines × ≈ 200 bytes with escapes
(the wake reads "newest 1000 lines"). Release share for B: 1 protocol bump in 13 releases assumes
the additive rule; 3 in 13 without it. fds: master + socket per session ≈ 2–3.

## Choice

**B**, with A's drain as its replace path, plus an install fix per platform.

- **A lost** because shells cannot be slept without losing what runs in them, and an agent that is
  always busy holds every update; it restarts 25 processes three times a week for code that did not
  change the protocol.
- **C lost** for now: native code on two platforms, nothing on Windows, and the screen worker's state
  to migrate — weeks of work for the ≈ 1-in-13 case B already handles with a drain. It stays the
  upgrade path if protocol bumps turn out frequent (see pre-mortem).
- **B wins** because the common case costs one ping, the agent process is untouched, and it is
  iTerm2's proven model.

**What surprised us.**
1. The daemon check is not the only killer. On **macOS the surviving daemon blocks every upgrade**
   (the installer's "running?" pattern matches the daemon); on **Windows it breaks the install**
   (the check ignores it, then the delete fails on its locked exe). Making the daemon survive *more*
   makes both worse unless the install changes too.
2. **Sleep does not save a turn in flight** — it ends the process. The brief's mismatch path
   ("sleep, replace, wake") still loses the turn unless it waits for idle first.
3. **An AppImage run directly kills agents on every quit** (SIGBUS when the mount goes), not just on
   upgrade.
4. Agent manifests are *already* hot-reloaded by the running daemon (`ensureAgentsCurrent`); what is
   fixed at boot is the interpreter and three hook scripts — a much smaller surface than "hooks, env
   injection" suggests.

## Pre-mortem

It is 2027 and B failed. Most likely why:

1. **Old daemons run for months and users hit bugs fixed long ago.** Daemons outlive app restarts
   (16.7 h uptime here) and a daemon with snapshots never idle-exits. *Change:* the pong carries
   `build`; an older build marks "terminal host update waiting", applied by the drain the first time
   every session is idle (agents idle per the status store, shells with no foreground job), or on a
   click. A fix that must land now bumps the protocol.
2. **Someone added a message without bumping and new features silently do nothing on adopted
   daemons.** *Change:* the daemon answers an unknown `t` with `error` (today it is ignored and the
   app waits for a timeout), so a missing capability fails loudly; the e2e upgrade spec runs the new
   app against the previous build's daemon code.
3. **The drain never finishes** (an agent always busy, a dev server in a shell). *Change:* the banner
   says which sessions hold it, with *Restart them now*; a shell with a foreground job counts as busy
   and is named. Known ceiling: an unattended machine with a never-idle agent stays on the old daemon
   until someone clicks; acceptable, because adopt keeps it working.

## Build order

1. **Protocol version.** `DAEMON_PROTOCOL_VERSION` in `pty-protocol.ts`; `pong` carries
   `{protocol, build}`; the daemon answers unknown requests with `error`. Remove `BUILD_STAMP` and
   `currentBuildStamp`. The app adopts on equal protocol. *Check:* the e2e spec — agent producing
   output, quit, daemon bundle changed with the same protocol, restart: same pid alive, tile shows
   output written during the restart. Fails today (the pid changes), passes after.
2. **Hook scripts current on adopt.** The three hook files and `hookExecPath` are part of the
   protocol contract; a change in their wire format bumps it. *Check:* provider golden test unchanged.
3. **Replace path = drain.** On protocol mismatch or "update waiting": wait for every agent idle,
   `sleep` each, `shutdown`, wake each (attach with `wake`). Banner + *Restart them now*. *Check:* an
   integration test against a real daemon: two stand-in agents, one busy — nothing is slept until it
   is idle; then both are slept, a new daemon starts, both wake into the same conversations.
4. **macOS installer:** count only the windowed app as running (match the main binary without a
   `pty-daemon.js` argument), like `install.ps1` does. *Check:* `scripts/install-macos-test.sh` with a
   fake daemon process alive.
5. **Windows:** the daemon runs from a copy of the runtime it needs in
   `%LOCALAPPDATA%\hivemind\runtime\<version>\` (or versioned `app-<version>` dirs, Squirrel-style);
   old copies removed by the installer when no process uses them. *Check:* the `build-windows` smoke
   job: start a daemon, run `Install-App` over it, the daemon and its session live.
6. **AppImage run directly:** when `APPIMAGE` is set, run the daemon from the extracted copy
   (`--appimage-extract` once into userData, or tell the person to use `install.sh`). *Check:* the
   mount experiment above, automated.
7. **Remote machines:** the bridge pings `protocol`; a mismatch shows the machine as *attention:
   update hive there*, and the same drain applies. *Check:* `apps/cli/tests` daemon test with two
   protocol numbers.
8. CHANGELOG line; docs.

Built in steps 1–3, and left for later: a daemon of the same protocol from an older build is kept
as it is, with no "update waiting" yet; the daemon still ignores a request it does not know rather
than answering it with an error.

Built in steps 4–7: `install.sh` counts only the app, not its daemon, as running, so on macOS an
upgrade is no longer refused and on Linux it goes in place instead of staged. `install.ps1` puts
each version in `app-<version>` and removes a folder once nothing runs from it. An AppImage started
directly runs its daemon from a copy extracted once per version under `<userData>/runtime/`. A
machine's daemon of another protocol is replaced the same way when its `hive` speaks this app's
protocol (`hive daemon status --json` → `speaks`); when that `hive` is older, the machine shows
*attention: update it there*. There is no *Restart them now* for a machine yet.

## Unknown

- **macOS and Windows behaviour** is read from code, not run. Check on a Mac: start a session, run
  `install.sh`, confirm it refuses; then with step 4, confirm the daemon survives the `rm -rf` + `mv`
  and that a new session spawns with the new `spawn-helper`. On Windows: the CI `build-windows` job.
- **Electron's asar cache on a worker restart after a swap**: the experiment used the same build on
  both sides, so whether a restarted screen worker loads old or new `screen-worker.js` is not shown.
  Check by swapping in a build with a different `screen-worker.js` and killing the worker (it restarts
  on exit). If it loads the new file, the worker messages join the protocol contract.
- **Agent resume time** (assumed ≈ 3 CPU-s): measure `claude --resume` cold start on this box.
- **How often protocol bumps would really happen** under the additive rule: re-read the three
  protocol diffs (9.6, 9.8, 10.2) and count which ones the app could not have done without.
