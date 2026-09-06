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

## Renderer: the Workspace + view plugins

`Workspace.tsx` is the composition root and workspace RUNTIME (was `Canvas.tsx`;
~1000 LOC — kept there deliberately). It was decomposed out of a 3147-LOC god
component; **don't recombine.** The work lives in extracted modules/hooks that
destructure a `ctx` object:

- `useSpawn` (tile/frame spawn + in-frame placement), `useWorktrees`
  (worktree/workspace/remote bind), `useFrameOps` (add/title/color/arrange),
  `useAgentAwareness`, `useCanvasShortcuts`, `useNodeDragStop`.
- Pure, unit-tested modules: `frame-layout.ts` (layout/collision/frameAtPoint),
  `canvas-persistence.ts` (load/save/migrate the core blob), `canvas-node-build.ts`
  (`buildBaseNodes` — canvas nodes, shell data only), `frame-color.ts`,
  `canvas-sizing.ts`, `dom-focus.ts`, `workspace/tile-surfaces.ts`
  (`buildTileSurfaces` — every tile's body + repo scope), `workspace/workspace-view.ts`
  (view contract + registry), `workspace/view-layout-store.ts` (versioned per-view blobs).
- **Views are plugins** (`workspace/views/`): `CanvasView` (xyflow) and `WindowsView`
  (tab strip) receive a read-only model + commands, never react-flow nodes, and
  render `<TileSlot>`s. `workspace/tile-host.tsx` owns every tile BODY once for the
  tile's life and lends it to whichever view is active (DOM reparenting) — so a
  view switch never remounts a terminal/editor/browser (a remote PTY's unmount
  would kill it). Contract + phases: `docs/design/workspace-views.md`.
- Leaf view modules: `canvas-islands/camera/overlays/nodes.tsx`, `FrameNode`,
  `LayersPanel`, the tiles (`TerminalTile`, `WorkbenchTile`/`EditorTile`,
  `DiffTile`, `IssuesTile`, `FileTreeTile`).

**Key invariant — `buildTileSurfaces` (workspace/tile-surfaces):** a tile's
effective repo/cwd is its owner frame's zone repo (`worktreePath ??
workspacePath`) else the global `repoPath` (`effectiveRepoOf`). This single
override is how a tile "becomes" local / worktree / remote — the tile components
don't know the difference. When gating editor/diff on "has a repo", gate on this
*effective* repo, not the global one.

## Remote (SSH) frames

A remote frame = a frame whose `workspacePath` is an `ssh://user@host:port/path`
URI. It flows through `buildTileSurfaces` into every tile's `cwd`/`repoPath`
unchanged; each
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
per-repo in `localStorage`: the core blob (`canvas-persistence.ts`, v2) plus one
versioned blob per view (`workspace/view-layout-store.ts`), all migrated on
load. Remote PTYs are the exception — in-main, detach == kill — which is why
tile bodies live in the TileHost and are never remounted by a view.

## Gotchas

- `useStateWithRef` updates the ref in the setter (render-phase); explicit
  `xxxRef.current = …` patches stay where a handler needs a synchronous read.
- e2e drag tests probe `.tile-drag-handle` via element-from-point — don't move
  the handle class off the header.
- Run e2e headless: `xvfb-run -a --server-args="-screen 0 1600x1000x24" npx playwright test …`
  (else Electron windows open on your desktop). `playwright.config.ts` isolates the
  profile via a fresh `XDG_CONFIG_HOME` — main's `app.setName("hivemind-dev")` makes
  userData ignore `--user-data-dir`, so without it every spec restores YOUR dev canvas
  and spawns its agents. The suite is a gate: 56/56 must pass headless. Specs
  assume the FRESH profile (Layers rail visible, no stored layout) and the real
  UI (the created issue opens in the peek; in-diff search is collapsed to its
  icon; the sonner toast stack covers the bottom-right corner; tree rows expose
  the file name only as their accessible name) — wait on state, never on time.
- Perf: `scripts/perf-views.mjs` (+ `perf-views-compare.mjs`) is the reproducible
  multi-agent workload for view/canvas changes — see docs/design/workspace-views.md.
- After editing a file the linter may touch it; re-Read before Edit if an edit
  fails with "modified since read".
