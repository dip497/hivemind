# AGENTS.md — apps/desktop

The Electron canvas app. Three processes: **main** (Node — IPC, PTY, git, fs),
**preload** (context bridge), **renderer** (React + xyflow). Read the root
`AGENTS.md` first for build/test/conventions.

## Process map

```
src/main/      Node main process — owns IPC, PTY daemon, git, fs, windows
  index.ts        every ipcMain.handle/on channel; the IPC choke point
  pty-daemon.ts   detached node-pty + headless-xterm snapshots (persistence)
  daemon-client.ts / pty-host.ts   daemon vs in-process PTY transports
  git-adapter.ts  git ops (simple-git + raw spawn); rawGit() is the low-level seam
  remote/         ssh2 transport — conn (pool) · pty · fs (SFTP) · exec · git · known-hosts
  claude-resume.ts  session-id binding + shq() POSIX escaper (reused by remote)
  shell-env.ts    PATH/token patching so claude/gh/git resolve
src/preload/index.ts   window.hive bridge (1:1 with shared/ipc.ts HiveIpc)
src/shared/     types shared main↔renderer
  ipc.ts          HiveIpc interface — the contract
  remote-uri.ts   ssh:// URI parse/format (pure, shared)
src/renderer/src/   React app (see "Renderer" below)
tests/unit/     node:test (pure logic)   tests/e2e/  Playwright
```

## Renderer: the Canvas

`Canvas.tsx` is the composition root (~970 LOC — kept under 1000 deliberately).
It was decomposed out of a 3147-LOC god component; **don't recombine.** The work
lives in extracted modules/hooks that destructure a `ctx` object:

- `useSpawn` (tile/frame spawn + in-frame placement), `useWorktrees`
  (worktree/workspace/remote bind), `useFrameOps` (add/title/color/arrange),
  `useAgentAwareness`, `useCanvasShortcuts`, `useNodeDragStop`.
- Pure, unit-tested modules: `frame-layout.ts` (layout/collision/frameAtPoint),
  `canvas-persistence.ts` (load/save/migrate localStorage layout),
  `canvas-node-build.ts` (`buildBaseNodes` + `mkTile`), `frame-color.ts`,
  `canvas-sizing.ts`, `dom-focus.ts`.
- Leaf view modules: `canvas-islands/camera/overlays/nodes.tsx`, `FrameNode`,
  `LayersPanel`, the tiles (`TerminalTile`, `WorkbenchTile`/`EditorTile`,
  `DiffTile`, `IssuesTile`, `FileTreeTile`).

**Key invariant — `mkTile` (canvas-node-build):** a tile's effective repo/cwd is
its owner frame's zone repo (`worktreePath ?? workspacePath`) else the global
`repoPath`. This single override is how a tile "becomes" local / worktree /
remote — the tile components don't know the difference. When gating editor/diff
on "has a repo", gate on this *effective* repo, not the global one.

## Remote (SSH) frames

A remote frame = a frame whose `workspacePath` is an `ssh://user@host:port/path`
URI. It flows through `mkTile` into every tile's `cwd`/`repoPath` unchanged; each
backend helper branches once on `isRemote()`:

- PTY → `main/remote/pty.ts` (in-main, ssh exec+pty), routed from the `ptySpawn`
  handler; write/resize/kill check `hasRemotePty(tileId)`.
- git → `git-adapter.rawGit` delegates to `runRemoteGit` (ssh exec, args
  `shq()`-escaped). simple-git can't go remote, so stage/unstage/discard branch.
- fs → `fileRead`/`fileWrite` route to SFTP; remote paths use a POSIX traversal
  guard, never `path.resolve` (that mangles the URI).

One pooled `ssh2.Client` per host (`remote/conn.ts`) shared by PTY + SFTP + git.
Full design + edge cases: `docs/design/remote-frames.md`.

## Persistence & PTYs

PTYs survive window close via a detached daemon (`pty-daemon.ts`); claude is
`--session-id`-bound at spawn and `--resume`d after reboot. State persists
per-repo in `localStorage` (`canvas-persistence.ts`, versioned + migrated on
load). Remote PTYs are the exception — in-main, detach == kill.

## Gotchas

- `useStateWithRef` updates the ref in the setter (render-phase); explicit
  `xxxRef.current = …` patches stay where a handler needs a synchronous read.
- e2e drag tests probe `.tile-drag-handle` via element-from-point — don't move
  the handle class off the header.
- After editing a file the linter may touch it; re-Read before Edit if an edit
  fails with "modified since read".
