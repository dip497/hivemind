# Code, the Windows view, opening anything, and asking an agent about code

Status: proposed 2026-11-25. Five asks from the founder, designed together because they share three
primitives.

## Goal

Anything a person or an agent points at (a URL, a path with a line, an image) opens in the right
place with one click; code can be read, navigated and questioned like in a real IDE, faster; and the
Windows view is the fastest way to run many agents.

## What is there (read 2026-11-25)

- **Windows view** is a built-in community view (`apps/desktop/views/windows/`, 438 + 254 lines):
  split tree up to 12 panes, tabs drag between panes and to edges, zoom, minimise, terminals stay alive
  across tabs (e2e `windows-view.spec.ts:196`). Missing: grouping by frame or page, quick switcher,
  recent order, a key to cycle tabs, agent status on tabs. The guide caption (`views.mdx:47`) is stale.
- **Code tile** is CodeMirror 6 (`EditorTile.tsx`), with git status, inline diff, blame, history.
  `@dip497/code` is a view that hosts the same tile. Bugs found by reading (not yet reproduced):
  switching tabs loses undo/cursor/scroll (`EditorTile.tsx:531`); closing a tab with unsaved edits
  drops them without asking (`:798`); CRLF files never clear "unsaved" and saving rewrites every line
  ending; a binary or image opens as text and Ctrl+S writes it back corrupted (`host/src/files.ts:17`);
  an agent's write to an open clean file replaces the whole document (`:406`); every keystroke
  copies the whole document to compare (`:523`); search runs synchronously on Electron main
  (`main/index.ts:1743`, 1.5 s per folder).
- **No code intelligence** at all (no definition, references, hover, outline).
- **Comments to agents** exist only on diff lines (`DiffComment`, `deliverToAgent`), anchored by line
  number only.
- **Links:** http(s) always opens the Browser tile; a path click drops `:line:col`
  (`browser-open.ts`); a bare `README.md:12` is not a link (`PATH_RE` needs `/`); the shell's current
  folder is never tracked (no OSC 7/633/1337); images go to the OS app; no setting.
- **The founder's own engines:** `omg` (Rust, tree-sitter + SQLite) answers by symbol name, not by
  position (10 call edges on hive-core, all ambiguous, measured); OneLens exports IntelliJ PSI;
  `~/projects/openidea` is an LSP host in Rust, not a PSI port.

## Known problems

1. Opening anything anywhere: a dispatch table by type (kitty `open_actions`, VS Code
   `externalUriOpeners`, custom editors "Reopen with").
2. Asking about code: review comments anchored to text that moves (GitHub outdating, Gerrit
   re-anchoring, CodeMirror position mapping).
3. Code intelligence: a router over providers of different accuracy (Zed, Fleet, OpenIDEA all split
   syntax / workspace index / language server).
4. The Windows view: a pane manager with an attention model (Zellij inbox, Orca quick open, tmux).

## Options

### A. Fix each surface where it is (boring)

Links logic in TerminalTile, an image tile, comments in EditorTile, a language server started from
Electron main, Windows view features inside the view.
Breaks first: every surface grows its own rule for "where does this open"; language servers on main
freeze every window (the search on main already does).

### B. Three shared primitives (chosen)

```
            ┌──────────── opener (one table, first match wins) ─────────────┐
terminal ─┐ │ url localhost → Browser tile   url other → setting (system/tile)│
editor  ──┼▶│ path+line → Code tile at line  image → Image viewer tile        │
markdown ─┤ │ allowlisted file → OS app      unknown scheme → ask             │
agents  ──┤ └─────────────────────────────────────────────────────────────────┘
views   ──┘   `hive ctl open <thing>`, `hm.open(thing)`, tile-sdk `openFile(path, {line})`

code tile ──▶ code intelligence router ──▶ syntax provider (tree-sitter in a Worker)
                 (fastest answer first,       workspace index (sidecar, position-keyed)
                  replaced by more accurate)  language servers (sidecar, on demand)

attention model (needs you · failed · done · working · quiet · new output)
   ──▶ Windows view tabs and panes, quick switcher, canvas tiles, Layers, dock badge
```

### C. Embed a whole IDE

Run an extension host and VS Code extensions (open-vsx) or embed OpenIDEA, and get languages,
debuggers and more at once.
Breaks first: an extension host per window (~200 MB+ before any server), a second UI language inside
ours, and agents still cannot drive it through `hive`.

### Scale

Numbers: a person runs 5-20 tiles, up to 12 panes (`MAX_PANES`), 12 WebGL contexts (`BUDGET`);
worktrees per repo 1-10; language servers 1-3 GB each on real repos (jdtls default 1 GB heap,
rust-analyzer 12-16 GB on Zed's repo, reported).

| Design | Today (1 repo, 2 languages) | 10x (10 worktrees) | 100x (100 worktrees, remote machines) |
|---|---|---|---|
| A | servers on main: one slow answer freezes the app — fails today | fails | fails |
| B | 2 servers × ~1.5 GB = 3 GB, off main: holds | 20 × 1.5 = 30 GB: bites; cap + idle stop holds it at ~6 GB | servers run on the machine holding the files: holds per machine |
| C | extension host 0.2 GB + same servers: holds | 10 windows × 0.2 + servers: bites as B | as B, plus extension hosts per window |

Arithmetic: servers × per-server memory; the cap keeps at most 4 live servers (4 × 1.5 GB = 6 GB)
and stops one idle 10 minutes.

## Choice

B. A spreads one rule into five places and freezes the app; C buys breadth we cannot drive from
`hive` and doubles the UI. B's primitives are each small, each serves every surface, and agents get
them for free through `hive ctl open`, `hive review` and the provider's commands.

What was surprising:
- The type-accurate engine is no longer anyone's moat: JetBrains shut Fleet (Dec 2025) and ships
  IntelliJ's engine as a language server; TypeScript moved to Go and LSP (1.2 s vs 9.6 s to load the
  VS Code repo, Microsoft's number). A Rust rewrite of PSI would rebuild alone what language owners now
  ship. "Faster than IntelliJ" is won on opening, outline and the first answer; we own the router and
  a position-keyed index shared by the editor and the agents.
- Two of the Code tile's gaps lose work today (unsaved close, binary save). They come before any
  feature.
- "Open a file" and "click a URL" are the same feature.

## Pre-mortem

1. **Language servers ate the machine** (worktrees × languages). Change: at most 4 live, stop after
   10 idle minutes, run on the machine that holds the files, memory shown in the machine usage
   widget. Ceiling: one huge repo whose server alone needs more than the machine has; upgrade path is
   the index layer only (no server) for that language.
2. **Comments drifted or vanished as agents rewrote files.** Change: each comment stores its line
   range, the text it covered and two lines around it; while open it moves with CodeMirror's position
   mapping; on disk change it is re-found by the stored text, else marked outdated, never dropped.
3. **A link opened something dangerous.** Change: only http, https, mailto and file pass; file paths
   only inside a workspace and only allowlisted extensions go to the OS (the existing `OPENABLE_EXT`);
   anything else asks once per scheme; terminal OSC 8 links are checked like typed ones.

## Contract

- Settings `links.web: "system" | "tile"` (default `"system"`, localhost always the tile),
  `links.files: "code" | "system"` (default `"code"`), in `settings-schema.ts`, with a row in
  Settings ▸ Browser.
- `packages/hive-core/src/opener.ts` (pure): `openerFor(target, settings) =>
  { to: "browser-tile" | "system-browser" | "code" | "image" | "os" | "ask", path?, line?, col?, url? }`.
- Desktop: one `openThing(target, from)` in the window used by terminals, editor, markdown, notes and
  the view protocol; `hive ctl open <url|path[:line[:col]]>`; tile-sdk `openFile(path, { line, col })`;
  view protocol 1.21 `open` request.
- Terminal: OSC 7 / 633;P;Cwd / 1337;CurrentDir set the tile's current folder per line; the path
  matcher takes bare names with `:line:col`; a per-tile "Open detected link" picker.
- Image viewer tile `image`: fit, fixed zoom steps, sharp pixels above 3x, checkerboard, size line.
- Code comments: `CodeComment { file, startLine, endLine, text, before, after }` in review-shape.ts
  beside `DiffComment`; selection toolbar and gutter mark in EditorTile; "Ask an agent" sends
  `@file#L5-10` plus the question; agents answer with `hive review reply`.
- Code intelligence provider: a tool-plugin contribution `{ languages, runs, accuracy }` answering
  documentSymbol, foldingRange, definition, references, hover, callHierarchy, rename, diagnostic,
  workspace/symbol; answers carry accuracy and document version; rename only from a compiler-accurate
  provider. Sidecar process host per machine; never on Electron main.
- Attention: one `attentionOf(agentState)` in hive-core used by the Windows view, canvas, Layers and
  the dock badge.

## Build order

0. Code tile safety: one EditorState per path; ask before closing unsaved; CRLF kept; binary and
   oversize files never opened as text; an agent's write applied as a minimal change; search off main.
   Checked by unit tests at the editor boundary and the `editor` e2e.
1. Opener: settings, `openerFor`, terminal cwd tracking and path matcher with line:col, image viewer
   tile, `hive ctl open`, `openFile` with a line. Checked by unit tests on `openerFor` and the matcher,
   one e2e clicking a URL, a `file:12` and an image.
2. Ask an agent about code: selection toolbar, gutter marks, anchored `CodeComment`, send as one
   batch, re-anchoring on change. Checked by a re-anchor unit test and an e2e.
3. Windows view: attention on tabs and panes, quick switcher (needs-you first, digit keys), recent
   order, cycle tabs, group by frame and page, broadcast input to a group, caption fixed. Checked by
   the existing windows-view e2e plus new cases.
4. Code intelligence: provider contract and router; tree-sitter outline in a Worker; the language
   server host with TypeScript first (go to definition, references, hover); Find Usages falls back to
   search for the word. Then the position-keyed index (omg's ideas, re-keyed) as its own step.

## Unknown

- How the Code tile bugs feel in the running app (read, not reproduced).
- Real memory of TypeScript's native server on this repo; measure when step 4 starts.
- web-tree-sitter cost in a Worker.
