# AGENTS.md — apps/desktop

The Electron canvas app. Three processes: **main** (Node — IPC, PTY, git, fs),
**preload** (context bridge), **renderer** (React + xyflow). Read the root
`AGENTS.md` first for build/test/conventions.

## Process map

```
src/main/      Node main process — owns IPC, PTY daemon, git, fs, windows
  index.ts        every ipcMain.handle/on channel; the IPC choke point
  daemon-client.ts / pty-host.ts   daemon vs in-process PTY transports
  git-adapter.ts  git ops (simple-git + raw spawn); rawGit() is the low-level seam
  remote/         ssh2 transport — conn (pool) · pty · fs (SFTP) · exec · git · known-hosts
  claude-resume.ts  session-id binding + shq() POSIX escaper (reused by remote)
src/preload/index.ts   window.hive bridge (1:1 with shared/ipc.ts HiveIpc)
src/shared/     types shared main↔renderer
  ipc.ts          HiveIpc interface — the contract
  remote-uri.ts   machine:// and ssh:// URI parse/format (pure, shared)
src/renderer/src/   React app (see "Renderer" below)
tests/unit/     node:test (pure logic)   tests/e2e/  Playwright

packages/agent-host/src/   the host, shared with the `hive` CLI
  pty-daemon.ts   detached node-pty + headless-xterm snapshots (persistence)
  shell-env.ts    PATH/token patching so claude/gh/git resolve
  hooks/          the hook scripts it writes for agents
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

A remote frame = a frame whose `workspacePath` is a `machine://<machineId>/path`
URI (R9: the saved machine, by id; main reaches it through `remoteTarget`), or an
`ssh://user@host:port/path` one for a host no machine is saved for. It flows through
`buildTileSurfaces` into every tile's `cwd`/`repoPath` unchanged; each
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

PTYs survive window close via a detached daemon (`packages/agent-host/src/pty-daemon.ts`); claude is
`--session-id`-bound at spawn and `--resume`d after reboot. State persists
per-repo in main's workspace store (`packages/workspace-host`, files in
`<userData>/workspaces/`): the core blob (`canvas-persistence.ts`, v2) plus one
versioned blob per view (`workspace/view-layout-store.ts`), all migrated on
load. Both reach it through `workspace/workspace-store-client.ts`, which imports a
window's pre-store localStorage layout once and uses localStorage only when there
is no bridge. Remote PTYs are the exception — in-main, detach == kill — which is why
tile bodies live in the TileHost and are never remounted by a view.

## Gotchas

- `useStateWithRef` updates the ref in the setter (render-phase); explicit
  `xxxRef.current = …` patches stay where a handler needs a synchronous read.
- e2e drag tests probe `.tile-drag-handle` via element-from-point — don't move
  the handle class off the header.
- Run e2e headless: `xvfb-run -a --server-args="-screen 0 1600x1000x24" npx playwright test …`
  (else Electron windows open on your desktop). `playwright.config.ts` isolates the
  profile via a fresh `XDG_CONFIG_HOME` per run: settings.json and the agents live there
  whatever `--user-data-dir` says, and a spec launched without `--user-data-dir` uses its
  `hivemind-dev` dir as userData — so without it every spec reads YOUR settings and agents,
  and restores YOUR dev canvas. (`--user-data-dir` itself is honoured: the app's own files —
  `workspaces/`, `hcp.token`, window state — land in it.) The suite is a gate: every spec
  must pass headless, `--retries=0`. Specs
  assume the FRESH profile (Layers rail visible, no stored layout) and the real
  UI (the created issue opens in the peek; in-diff search is collapsed to its
  icon; the sonner toast stack covers the bottom-right corner; tree rows expose
  the file name only as their accessible name) — wait on state, never on time.
- The harness (`pnpm test:e2e:harness`, `playwright.harness.config.ts`) runs the canvas, terminal,
  git and issue specs against the renderer in Chromium over the dev-bridge instead of Electron.
  A spec in it launches through `tests/e2e/helpers/window.ts` and asks only the window
  (`window.hive`), never Electron's main. Set `HIVE_HARNESS_CHROMIUM` to a Chromium binary when
  Playwright's own is not installed (in the cloud containers: `/opt/pw-browsers/chromium`).
- Perf: `scripts/perf-canvas-effects.mjs` is the reproducible workload for canvas
  changes. The view harness (`perf-views.mjs`) went with the World view it measured;
  a scene-view gate would have to be rewritten against a community view.
- After editing a file the linter may touch it; re-Read before Edit if an edit
  fails with "modified since read".
- UI primitives are shadcn components in `src/renderer/src/components/ui`
  (`components.json`; add more with `npx shadcn@latest add <name>`, then point the
  `cn` import at `../../lib/cn`). Use them instead of hand-rolled buttons/inputs,
  and change a look in the component, not at the call site. They read the palette
  through the shadcn tokens bound in `styles.css`; the brand rules are `/brand` on the site.
- After making changes, run `pnpm lint` (oxlint + `@shadcn/lint`) and fix all errors.
  Enabled: `no-restyle` (a primitive owns its look — add a variant instead of classes
  at the call site; only layout classes are allowed on one), `no-unknown-classes`
  and `no-raw-colors`. `nodrag`/`nopan`/`nowheel` are allowed: react-flow behaviour, not style.
- A menu/list row is `MenuItem`, a static chip is `Badge`, and tile/canvas chrome uses the small
  Button sizes (`2xs` 20px, `micro` 16px, and their `icon-` twins) so a converted control keeps
  its box. Popovers stay as they are — do not restructure one into a Radix menu.
- Surface tokens derive in CSS: `--color-bg2/3/4` come from `--surface-2/3/4`, which is what
  `html.glass-on` recolours. Never write `--color-bg2/3/4` inline from JS — an inline custom
  property outranks every stylesheet rule and freezes glass mode opaque.
