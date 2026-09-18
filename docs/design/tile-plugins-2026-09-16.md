# Tile plugins: letting someone bring their own editor, diff, or anything else

Status: proposal. 2026-09-16.

## The gap

We have exactly one plugin surface for UI: a **workspace view** — a sandboxed
`hm-view://` iframe that redraws the whole canvas from a projection of frames, tiles and
status. Its defining rule is an asymmetry: *a view decides how the workspace looks; it does
not decide what runs*. It gets no path, no file contents, no command line, and has no
network (`default-src 'none'`).

Everything else — terminal, diff, workbench (editor), browser, issues, planReview — is a
hardcoded `case` in `workspace/tile-host.tsx`, rendered by our own React and talking to
main over ~90 `ipcMain` handlers.

So a user who wants their own diff viewer has nowhere to put it. A workspace view can't:
it draws the whole canvas, and it can't read a file. This proposal adds the missing
surface, reusing the view machinery rather than inventing a second plugin system.

## Two additions, one existing seam

### 1. A tile can be a plugin

Same package format, same `hm-view://` scheme, same sandbox, same SDK, same
`hive views install`. One new manifest field says where it mounts:

```json
{
  "id": "acme-diff",
  "name": "Acme diff",
  "version": "0.1.0",
  "entry": "index.html",
  "protocol": 2,
  "surface": "tile",
  "tile": { "kinds": ["diff"], "title": "Acme diff" },
  "permissions": ["git:read", "files:read"]
}
```

- `surface: "workspace"` (default, today's behaviour) or `"tile"`.
- `tile.kinds` declares which built-in tile kinds this plugin can *replace*, so a user can
  set "use Acme diff for diff tiles" in settings. An empty list means it only opens as its
  own tile kind (`plugin:acme-diff`).
- `tile-host.tsx` gains one `case "plugin"` that mounts the iframe at the tile rect. The
  iframe is already an out-of-process frame, which is what we want per tile.

What carries over unchanged: theme vars, `createInvalidator` and the draw-on-demand rule,
the 64 KB `setLayout` blob, `reveal`, the install review, the CSP.

What does **not** apply to a tile plugin: surface rects (a tile plugin *is* inside a tile;
hole-punching a terminal into it is out of scope for v1) and the frame/tile projection
(it gets its own tile's context instead — see below).

### 2. Data capabilities: the "tools"

A view gets a projection. A tile plugin needs *content*, which means new request/response
messages, each behind a permission that appears in the install review:

| Permission | Commands | Backed by |
|---|---|---|
| `files:read` | `readFile(path)`, `listDir(path)`, `watch(path)` | existing file IPC |
| `files:write` | `writeFile(path, content)` | existing file IPC |
| `git:read` | `status()`, `diff(scope)`, `show(sha, path)`, `log()`, `blame(path)` | `main/git-adapter.ts` |
| `git:write` | `stageHunk(patch)`, `unstage`, `commit(msg)` | `main/git-adapter.ts` |
| `review:comments` | `listComments`, `addComment`, `sendToAgent(text)` | `code/review-store.ts` |
| `lsp` | `request(method, params)`, `onDiagnostics` | new: host-side LSP proxy |

Three rules make this safe and keep it small:

1. **The host does the work.** The plugin never touches a filesystem or spawns `git`. It
   asks; main answers. That is also why remote machines come for free: a tile carries a
   `workspacePath`, which may be an `ssh://` URI, and the host already routes by it. The
   plugin sends the same `diff()` whether the repo is local or on another machine.
2. **Scoped to the tile.** Every request is implicitly rooted at that tile's
   `workspacePath`. Paths that escape it are refused, the same way a view package refuses a
   symlink pointing out of itself.
3. **No new powers.** Every command above maps onto an IPC handler that already exists
   (except LSP). This is an exposure of what the app can already do, not new capability.

`diff` scopes are our existing shapes: `{kind:"working",staged?}`, `{kind:"branch",base,head}`,
`{kind:"unpushed",base}`, `{kind:"commit",sha}`.

### Tile context

Where a workspace view gets `structure`, a tile plugin gets a `context` message:

```ts
{ type: "context", tileId, frameId, workspacePath, repo: { branch, head, dirty }, file?: string }
```

Re-sent when the user changes file or scope, plus `visibility`, `resize`, `theme` as today.

## Built-ins become the reference implementation

The point of this is not third parties. It is that **our own diff and editor tiles get
rewritten against the public API**, in-process and unsandboxed but using the same commands.
That is the only way the API stays honest: if `stageHunk` is awkward, we feel it first.

This depends on the piece-split done first (`DiffTile`'s ~1,070-line component broken into
`FileTree`, `ChangesList`, `CommitBar`, `DiffView`, `ConflictView`). Those pieces become
the reference plugin, and a third-party plugin can import the same npm-published pieces if
it wants to look native.

## Perf and limits

- Data crosses as structured clone over `postMessage`. Strings of a few MB are fine; a
  10k-line diff is ~1 MB. Cap responses (say 8 MB) and paginate `diff()` by file.
- Editor writes debounce; never a message per keystroke. The plugin owns its buffer and
  flushes.
- Draw-on-demand still applies. The host already watches for views that paint while idle.
- A tile plugin is an out-of-process frame: ~20-40 MB each. Fine for a few, not for fifty
  tiles. Unmount when off-screen, as tiles already do.

## Versioning

`PROTOCOL_VERSION` is 1. Adding messages and permissions additively is a **minor** bump,
per the semver table in CLAUDE.md — but `surface: "tile"` changes what a manifest means, so
ship it as protocol 2 and keep loading protocol-1 workspace views unchanged. Unknown
permission names are already refused at install and at load, which is what lets old hosts
reject new plugins cleanly.

## Order of work

1. Split the diff/editor tiles into pieces (no protocol work, pays for itself anyway).
2. Publish those pieces as a package; rewrite our tiles on top.
3. Protocol 2: `surface: "tile"`, `context`, `case "plugin"` in tile-host.
4. `git:read` + `files:read` only. Ship a read-only third-party diff as the proof.
5. Writes (`files:write`, `git:write`, `review:comments`) once one read-only plugin exists.
6. LSP proxy last — it is the biggest piece and it benefits our own editor first.

## The cheaper answers, if nobody actually asks

Building a plugin API before anyone has asked for one is how a codebase gets a second
plugin system nobody uses. Two options cover most of the demand for zero protocol work:

- **"Open in your IDE"** on any file or diff. Most harnesses do exactly this and ship no
  editor at all.
- **A code-server tile**, which is the browser tile pointed at a local VS Code server: a
  real IDE, real extensions, the user's own settings, and no API to design.

Do steps 1-2 regardless. Do 3+ when a real user wants a real plugin.
