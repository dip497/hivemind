# Code tools — design (2026-11-02)

Status: step 1 ☑ (2026-11-02: Files and Changes as tools of their own; e2e `code-tools.spec.ts`, `control-open-tool.test.ts`), step 2 ☑ (2026-11-03: fff on the host, `code.findFiles`/`code.picked`/`code.grep` at API 0.40, the Search tile and the Code tile's Search panel, Ctrl+P, release checks; host tests `code-search*.test.ts`, e2e `code-search.spec.ts`), step 4 in part ☑ (closing brackets, word completion; outline and breadcrumbs ☐), step 3 ☑ (`git-history-2026-11-02.md`, built 2026-11-02), steps 4–6 ☐. Inputs: the bundled Code plugin (`packages/hive-core/src/tool-plugins.ts`,
`CODE_PLUGIN_ID`), its tile (`apps/desktop/src/renderer/src/tiles/code.tsx`,
`WorkbenchTile.tsx`) and the three components it composes; the Code view
(`dip497/hivemind-plugins/views/code`), which docks the Code tile and showed what a view cannot
do with it today; and fff (`github.com/dmtrKovalenko/fff.nvim`, MIT), tried here.

## 1. Who it is for, and the job

Developers who keep the code in sight while agents write it. The job: find any file or any line
in a moment, and see what changed, without leaving Hivemind for an editor.

## 2. What exists, and what is missing

The Code plugin ships **one** tool, Code (`editor`), whose tile composes three components. Each
already has a standalone mode (`embedded={false}` draws its own header); `WorkbenchTile` embeds
all three.

| Piece | Component | Has |
|---|---|---|
| Files | `FileTreeTile` (`@pierre/trees`) | the tree from `git ls-files`, git status marks, a filter by name |
| Editor | `EditorTile` (CodeMirror 6) | tabs, highlighting for `@codemirror/language-data`'s languages, line numbers, folding, bracket matching, find in the file, undo, an inline-diff mode, Reload / Keep mine when a file changes on disk |
| Changes | `DiffTile` (`@pierre/diffs`) | working tree or branch-vs-branch diff, stage / unstage / discard, commit, push / pull, conflicts, review comments to agents, search in the diff |

`diff` and `workbench` are saved-board aliases of `editor` (`sameAs`), and a view may spawn
only `editor` (`canSpawnKind` refuses aliases). Missing, against VS Code:

1. **Find in files**: search (and replace) across the repository.
2. **Go to file**: a fuzzy Ctrl+P over the repository's files.
3. **Git history**: blame, a file's log, stash.
4. **Editor details**: auto-closing brackets, word completion, an outline, breadcrumbs.
5. **Code intelligence**: completion, go to definition, hover, diagnostics (language servers).
6. **A view's reach**: the Code view cannot show Files or Changes on their own, open Changes
   directly, or drop the tile's own header.

## 3. Decisions

### 3.1 Split, not rewrite

The Code plugin offers each piece as a tool of its own, built from the component that exists:

| Tool key | Tile kind | Component | Singleton per frame |
|---|---|---|---|
| `editor` | `editor` | `WorkbenchTile` (unchanged: the all-in-one) | yes |
| `files` | `files` | `FileTreeTile` standalone | yes |
| `changes` | `changes` | `DiffTile` standalone, on the working tree | yes |
| `search` | `search` | new: find in files and go to file (§3.2) | yes |

Code is the plugin's `main` tool: `hive ctl open-tool @hivemind/code` opens it, as it did when it
was the plugin's only tool; the others are named (`@hivemind/code/files`). Each is switched on or
off on its own in Settings ▸ Plugins (`tileKindAvailability` already
gates per tool), opened from the menus that open tools, and spawnable by a view
(`canSpawnKind`: new kinds, not aliases).

**No data migration.** The new kinds are new. `diff` and `workbench` stay aliases of `editor`,
drawn as they are today, so every saved board opens as before.

**Opening a file from Files or Search** reuses the path that exists: the frame's tile that opens
`file` (`kindsThatOpenNow("file")`, `openFileInTile`, or a spawn with `opts.file`). The all-in-one
keeps its own tabs; a lone Files tile opens files in the frame's Editor, starting one if there is
none.

### 3.2 fff for finding

`@ff-labs/fff-node` (MIT) loads fff's Rust core (`libfff_c`) through `ffi-rs` (Node-API), with
prebuilt binaries for every platform the app releases: linux x64 and arm64, darwin arm64, win32
x64. Tried here on this repository: index 61 ms, a typo'd file search (`wrkbnchtile` →
`WorkbenchTile.tsx`) 3 ms, a plain grep 60 ms; the same under Electron's runtime
(`ELECTRON_RUN_AS_NODE`). Ranking adds frecency (opened often and lately) and git status, and grep
has plain, regex and fuzzy modes with paging. OpenCode uses it for its agent search.

- **Where it runs**: the main process (Electron-free module beside `fs-watcher.ts`), one
  `FileFinder` per repo, made when a Search or Code tile of that repo first asks and destroyed
  when the last one closes (CLAUDE.md: a feed stops when its last follower leaves).
- **How the renderer asks**: two workspace API methods, `code.findFiles {repo, query, limit}` and
  `code.grep {repo, query, mode, cursor}`, answered from the finder, so the phone page and a
  guest's window reach them the same way, subject to the repo access rules that `git:*` follow.
- **Frecency**: the editor reports a file opened (`code.opened`), which fff keeps in its own
  store under the app's data folder.
- **Per event**: fff watches the tree itself; it is not fed from `fs-watcher.ts`, so a file write
  costs no extra work on main. Measure the idle cost of one finder at 50 frames' repos before
  merging.
- **Packaging**: `asarUnpack` adds `**/node_modules/@ff-labs/**` and `**/node_modules/ffi-rs*/**`;
  `release.yml` asserts the right `fff-bin-*` and `ffi-rs` binary made it into each bundle, as it
  does for `conpty.node`, because nothing else fails when a native module is missing.
- **If it cannot load** (an unsupported platform, a missing binary): `code.findFiles` falls back
  to the `git ls-files` list with the same fuzzy scoring, and `code.grep` to `git grep`
  (`simple-git`, already a dependency). Search stays usable, slower.
- **Agents** search with the tools in their shell (`rg`, `git grep`), faster than a round trip to
  the app; `hive ctl open-tool @hivemind/code/search` shows the person. No `hive code` command
  (decided 2026-11-03, as for history).

### 3.3 Later features, and what each needs

| Feature | Built on | New dependency |
|---|---|---|
| Find in files, go to file | fff (§3.2) | `@ff-labs/fff-node` |
| Blame, file history, stash | `git blame` / `git log` / `git stash` through `simple-git` | none |
| Outline, breadcrumbs | CodeMirror's syntax tree (`@codemirror/language`) | none |
| Auto-closing brackets, word completion | `@codemirror/autocomplete` | one, official CodeMirror |
| Code intelligence | a language-server client and a server per language | yes; its own design |

### 3.4 The view protocol

A view docks `files`, `changes` and `search` like any tile once they are spawnable kinds; nothing
new is needed for that. Two additions, protocol 1.19, for the Code view:

- `spawnTile(kind, frameId, { open: "changes" | "files" })`: which side a Code tile opens on.
- A surface rect's `chrome: "none"` also hides a tile's own header where the tile has one
  (`embedded`), so a view that frames the tile draws the only header.

### 3.5 Native (Rust) where it pays

The rule: a hot path measured as slow gets a native (Rust) implementation, with the numbers
before and after in its commit (CLAUDE.md). Not everything: each native piece is a binary per
release target (linux x64 and arm64, darwin arm64, win32 x64) to build, unpack and check.

| Path | Today | Native? |
|---|---|---|
| Finding files and lines | — | **Rust**: fff (§3.2) |
| Watching the tree | chokidar (`fs-watcher.ts`, JS) | **Rust, step 2b**: fff watches the tree itself and reports `WatchEvent`s; the Code tools take their invalidations from it, and chokidar stays only for what fff does not cover. Measured at 50 repos before it replaces anything. |
| git status, diff, blame, log | the `git` binary through `simple-git` | already native; gitoxide only if `git status` measures slow on a large repo |
| Diffing and highlighting | `@pierre/diffs` and CodeMirror in workers | only if a large file measures slow; then a WASM build (imara-diff, tree-sitter) in the same worker |
| Language servers | — | native already (rust-analyzer, gopls, …), started by the app |

## 4. Steps

1. **Split**: `files` and `changes` tools and kinds from the existing components; menus,
   availability, `canSpawnKind`; e2e: each opens alone, opens a file in the frame's Editor, and a
   board with `diff`/`workbench` tiles opens unchanged.
2. **Search with fff**: the main-process finder and its lifetime, the two API methods, the
   `search` tile (go to file and find in files in one, as VS Code's quick open and search view),
   Ctrl+P / Ctrl+Shift+F inside Code tiles, `hive code find|grep`, packaging and its release
   check, the fallback.
3. **Git history**: the log in Changes, a file's history, blame in the editor's gutter; designed
   in `git-history-2026-11-02.md` (measured, and what IntelliJ, Zed and git do). Stash later.
4. **Editor details**: `@codemirror/autocomplete` (brackets, words), outline and breadcrumbs.
5. **Protocol 1.19** and the Code view using the split tools.
6. **Code intelligence**: design first.

Each step lands on its own with its guide page, CLI reference, CHANGELOG line and tests
(`.claude/skills/feature-done`).

## 5. Open questions

- Should `search` be its own tile, or only an overlay inside Code and Editor tiles? Proposed:
  both; the overlay is the tile's body shown floating.
- fff's frecency store: kept per machine (its default) or synced with the workspace? Proposed:
  per machine; it is a habit, not shared state.
