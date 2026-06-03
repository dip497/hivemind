# Remote SSH Frames — Design

**Status:** implemented (MVP vertical slice). **Date:** 2026-06-04.

A *remote frame* is a canvas frame (workspace) whose working directory lives on
another machine reached over SSH. Every tile inside it — terminal, Claude,
editor, diff — operates against the remote host: the terminal is a real PTY on
the remote, the editor reads/writes remote files over SFTP, diff/status shell
out to `git` on the remote. Locally nothing changes; remote and local frames
coexist on the same canvas.

## Design driver: the IPC is path-keyed

Every backend channel is keyed by a path string — `ptySpawn({cwd})`,
`gitStatus(repoPath)`, `fileRead(repoPath, rel)`, etc. The renderer never sends
a "host"; locality is implicit in the path. That single fact dictates the whole
design:

> **Encode the remote target *in the path string itself* as an `ssh://` URI.**
> `ssh://user@host:port/abs/remote/path`. A remote frame's `workspacePath` is
> such a URI. It flows through `canvas-node-build.mkTile` into every tile's
> `data.cwd` / `data.repoPath` **unchanged** — no IPC signature changes, no
> "host" field threaded through 30 channels. Each backend helper gains one
> branch: `if (isRemote(p)) …route over SSH… else …local…`.

This is the minimal-invasion seam the codebase was already shaped for.

### URI scheme (`remote-uri.ts`, shared)

```
ssh://[user@]host[:port]/absolute/posix/path
```

- `isRemote(p)` → `p.startsWith("ssh://")`.
- `parseRemote(uri)` → `{ host, port, user, path, hostId }` where
  `hostId = "user@host:port"` is the connection-pool key.
- `formatRemote({...})` → the URI string.
- `remoteDisplay(uri)` → `user@host:/path` for chips/labels.

Pure, no deps, unit-tested. Lives in `src/shared/` so main + renderer share it.

## Connection model

One **`ssh2.Client` per host** (`hostId`), held in a main-process
`RemoteConnectionManager`. SSH multiplexes channels, so a single TCP/transport
connection carries: the interactive PTY channel(s), one cached SFTP session
(reused for all file ops), and every git `exec`. The pool evicts a connection on
`close`/`error`.

**Auth (MVP):** SSH agent first (`process.env.SSH_AUTH_SOCK`), then an explicit
private-key file (+ passphrase). Password is out of MVP scope.

**Host-key verification:** trust-on-first-use. The fingerprint (sha256) is
stored in `~/.hivemind-known-hosts.json`; a later mismatch is **rejected** with a
loud error (possible MITM). First-use is auto-accepted and recorded. (No
`hostVerifier` = ssh2 auto-accepts silently — we never ship that.)

**Keepalive** 15 s so long-lived PTY frames detect dead links;
`readyTimeout` 20 s.

## Backend seams (where local vs remote branches)

| Concern | Local | Remote |
|---|---|---|
| **PTY** | `pty-daemon` → `node-pty.spawn` | **in-main** `RemotePty` (ssh2 `exec`/`shell` channel). Remote PTYs bypass the persistence daemon — an SSH drop loses remote shell state, so reattach is meaningless; running in-main keeps the SSH pool in one place (shared with fs/git). |
| **git** | `git-adapter.spawnGit` (`spawn git, cwd`) | `execCapture(conn, "git -C <path> …")` over ssh `exec`, **reusing the same arg arrays**, each arg `shq()`-escaped. simple-git can't go remote, so remote routes *all* git ops through the raw-arg path. |
| **fs read/write** | `fs.promises` + `resolveInRepo` | SFTP `readFile`/`writeFile` on the cached session. |
| **fs-watch** | chokidar | **none in MVP** — remote tiles refresh on focus / manual refresh instead of live push. (Future: remote inotify or poll.) |
| **folder pick** | native `dialog` | SFTP browser from `realpath('.')` (remote `$HOME`), navigate + pick. |

PTY routing detail: the `ptySpawn` IPC handler branches on `isRemote(opts.cwd)`.
Remote → `RemotePtyManager` (in main, backed by the shared connection manager);
the `pty:data:`/`pty:exit:` event plumbing is transport-agnostic and unchanged.
The local `fsp.stat(cwd)` directory precheck is skipped for remote cwds.

## Tile behavior on a remote frame

- **Terminal / Claude** — `data.cwd` is the `ssh://` URI. `ptySpawn` opens a
  remote PTY; `bash -lc 'cd <path> && exec <cmd>'` starts the program in the
  remote cwd. `claude` runs *on the remote* (its files, its tools).
- **Editor** — `data.repoPath` is the URI. `fileRead`/`fileWrite` route to SFTP.
  The file tree comes from `gitListFiles` (remote `git ls-files`).
- **Diff** — `data.repoPath` is the URI. `gitDiff`/`gitStatus`/`gitFileContents`
  route to remote `git`.
- **Issues** — scoped by `.hivemind` `root`. MVP: issues stay **local-only**
  (the issue store is the launching project's). A remote frame doesn't show an
  issues tile bound to the remote unless that remote has its own `.hivemind`
  (out of MVP scope).

## Folder selection UX

No native dir picker reaches the remote. Flow:

1. **Attach remote** action on the canvas / a frame → connect form
   (host, user, port, optional key path).
2. On connect, open an **SFTP folder browser** starting at `realpath('.')`
   (remote home). `readdir` per level, navigate in/up, "Use this folder".
3. The picked absolute remote path → `formatRemote(...)` → the new/bound frame's
   `workspacePath`. From then on every tile in that frame is remote.

Data contract: `sshListDir(hostId, dir) → { name, isDir, isSymlink }[]`.

## Edge cases handled

- **Command injection** — every interpolated remote path/arg is `shq()`-escaped
  (the same POSIX single-quote escaper used by `claude-resume`).
- **Remote paths are always POSIX** even if the client is Windows — never
  `path.join` a remote path; use `path.posix` / explicit `/` joins.
- **Permission / vanished dirs** — SFTP `readdir`/`stat` errors are caught
  per-entry; the tree skips them instead of aborting.
- **Symlinked dirs** — not followed (cycle guard) in the bounded tree walk.
- **Large files** — `stat` size-gate before buffering a `readFile` into the
  editor (refuse > a few MB; stream later).
- **Connection drop mid-PTY** — `close` is terminal; surfaced as exit. No fake
  resume; reconnect respawns the PTY.
- **Channel exhaustion** — OpenSSH caps `MaxSessions`; git `exec` calls are
  concurrency-limited per connection so the PTY/SFTP channels aren't starved.
- **ptySpawn local precheck** — `fsp.stat(cwd)` is skipped for `ssh://` cwds.

## Packaging

`ssh2` is pure-JS (its only native bits — `cpu-features`, `nan` — are optional
and tolerated absent). It's in `dependencies`; `externalizeDepsPlugin` already
externalizes all deps from the main bundle, so no extra config. The PTY daemon
process (`ELECTRON_RUN_AS_NODE`) does **not** need ssh2 — remote PTYs run in
main, not the daemon.

## Out of MVP scope (documented, not built)

- Live remote file-watching (chokidar replacement).
- `~/.ssh/config` host-alias resolution (`ssh-config` parser) + `ProxyJump`.
- Password / keyboard-interactive auth.
- Remote `.hivemind` issue stores.
- Worktrees on a remote.

## Module map

```
src/shared/remote-uri.ts        parse/format ssh:// URIs (pure, shared)
src/main/remote/conn.ts         RemoteConnectionManager (pool, auth, host-key)
src/main/remote/pty.ts          RemotePty + RemotePtyManager (in-main remote PTYs)
src/main/remote/fs.ts           RemoteFs (SFTP: readdir/readFile/writeFile/stat)
src/main/remote/exec.ts         execCapture + remoteGit (ssh exec for git)
src/main/remote/known-hosts.ts  TOFU fingerprint store
```

Seams branch in: `main/index.ts` (ptySpawn, fileRead/Write, sshConnect/sshListDir),
`git-adapter.ts` (spawnGit/git ops), `pty` routing.
