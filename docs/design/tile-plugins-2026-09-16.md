# Tile plugins: every tile kind becomes a tool plugin

Status: proposal. 2026-09-16. Branch `feat/tile-plugins`.

## What already exists (do not rebuild it)

Three seams are already in the tree, and this proposal is the join between them.

1. **A tool-plugin registry** — `packages/hive-core/src/tool-plugins.ts` +
   `tool-registry.ts`. Metadata only, no I/O. A plugin id is `ns/name`, contributes up to
   32 tools, and is **OFF until the user enables it** (`settings.tools.enabledPlugins`);
   installation activates nothing. `tileKindAvailability()` returns `null` for an
   *unmanaged legacy kind* (ships with the app, always allowed) and a real answer for a
   *managed* kind. Today `MANAGED_KINDS` has exactly one entry: `browser` ←
   `hivemind/web`. The shape for "a plugin contributes a tile kind" is already decided.
2. **A sandboxed UI surface** — view packages served over `hm-view://` into an
   out-of-process iframe under `default-src 'none'`, with a manifest, an install review,
   permissions refused at install *and* load, `hive views install`, theme vars, and the
   draw-on-demand rule. Protocol version 1.
3. **A control plane** — HCP methods (`tile.focus`, `tile.close`, `views.rescan`, …)
   fronted by `hive ctl` verbs whose `--json` output is documented as "the same shape as
   the MCP tool". `packages/hive-mcp` is scaffolded (`@modelcontextprotocol/sdk`, `zod`)
   with no source yet.

The renderer already knows about three plugin page kinds: `PLUGIN_PAGE_KINDS =
["agent", "view", "tool"]`. The installable catalog knows only two: `agent` and `view`.
**That missing third type is the whole gap.** A tool plugin today can only be bundled
metadata; nobody can ship one.

## The move

Every tile kind becomes a tool contributed by a plugin. The built-ins stop being
"legacy unmanaged kinds" and become plugins we happen to ship.

| Plugin | Tools (tile kinds) | Ships as |
| --- | --- | --- |
| `hivemind/code` | `workbench` (editor), `diff` | built-in, enabled by default |
| `hivemind/git` | `changes`, `commit`, `conflicts` | built-in |
| `hivemind/issues` | `issues`, `planReview` | built-in |
| `hivemind/web` | `browser` | built-in, off by default (today's behaviour) |
| `acme/diff` | `diff` (replaces) | third-party, sandboxed |

`terminal` stays host-owned. It is a real pty surface the host must position and own; a
plugin declares where one goes (surface rect), it never renders one.

Two plugin flavours, one registry:

- **Built-in (trusted):** contributes React components in-process, exactly as tiles render
  today. No iframe, no bundle cost, full speed.
- **Installed (untrusted):** ships a view-style package; its tool renders in an
  `hm-view://` iframe pinned to the tile rect.

Both go through the same registry, the same enable switch, the same settings page, and
the same capability permissions. That is what keeps the API honest: our own diff tile
calls the same commands a third-party diff tile calls.

## The new plugin type

`type: "tool"` joins `"agent"` and `"view"` in the catalog and installer. Manifest
(`hivemind-tool.json`), reusing the view package rules verbatim — relative paths only, no
symlink escape, unknown permission refused at install and load:

```json
{
  "id": "acme/diff",
  "name": "Acme diff",
  "version": "0.1.0",
  "protocol": 1,
  "tools": [
    { "key": "diff", "label": "Acme diff", "description": "Side-by-side diff",
      "tileKind": "diff", "replaces": "hivemind/code/diff", "entry": "diff.html" }
  ],
  "permissions": ["git:read", "files:read"]
}
```

`replaces` is what lets a user say "use Acme diff wherever a diff tile opens". It is a
user preference (`settings.tools.kindOverrides`), never something a plugin takes by
installing itself.

`MANAGED_KINDS` stops being a module constant and becomes a map built from
registry + installed catalog. `tileKindAvailability()` keeps its exact contract, and
`tile-host.tsx` gains one `case "plugin"` next to the existing kinds.

## Capabilities: define once, expose three ways

This is the part worth getting right. A capability is declared **once** — name,
permission, input/output schema (zod, already a dependency of `hive-mcp`), handler — and
three faces are generated from that one declaration:

```
                      ┌─ plugin RPC      postMessage command, gated by manifest permission
capability registry ──┼─ MCP tool        packages/hive-mcp, gated by the agent's grant
                      └─ hive ctl verb   CLI + HCP method, gated by the same grant
```

So `git.diff` is simultaneously: a command a tile plugin can call, a tool an agent can
call over MCP, and `hive ctl git diff --json`. One schema, one handler, one permission
name, three transports. Adding a capability is one file; forgetting to expose it to
agents becomes impossible, because the MCP tool list *is* the registry.

Starting set, all of which map onto IPC handlers or modules that already exist:

| Capability | Permission | Backed by |
| --- | --- | --- |
| `files.read`, `files.list`, `files.watch` | `files:read` | existing file IPC |
| `files.write` | `files:write` | existing file IPC |
| `git.status`, `git.diff`, `git.show`, `git.blame`, `git.log` | `git:read` | `main/git-adapter.ts` |
| `git.stageHunk`, `git.unstage`, `git.commit` | `git:write` | `main/git-adapter.ts` |
| `review.list`, `review.add`, `review.sendToAgent` | `review:comments` | `code/review-store.ts` |
| `lsp.request`, `lsp.diagnostics` | `lsp` | new host-side proxy |

Three invariants:

1. **The host does the work.** A plugin never touches a filesystem or spawns `git`; it
   asks, main answers. That is also why remote machines come free — a tile carries a
   `workspacePath` that may be an `ssh://` URI, and the host already routes by it. The
   same `git.diff` call works local or remote.
2. **Scoped to the tile.** Every request is rooted at that tile's `workspacePath`;
   paths that escape are refused, like a view package refusing a symlink out of itself.
3. **No new powers.** Everything above is already something the app can do. This exposes
   it under a permission, it does not add capability. `lsp` is the one genuinely new
   thing, and it benefits our own editor first.

A tile plugin gets no canvas projection. It gets its own context:

```ts
{ type: "context", tileId, frameId, workspacePath, repo: { branch, head, dirty }, file? }
```

## Built-ins move first, or the API is fiction

Order matters. The point is not third-party plugins; it is that **our diff and editor
tiles get rewritten against the public capability API**. If `git.stageHunk` is awkward, we
find out before anyone else does. That depends on the piece-split landing first:
`DiffTile`'s ~1,070-line component broken into `FileTree`, `ChangesList`, `CommitBar`,
`DiffView`, `ConflictView`.

## Versioning

- New catalog type + new capabilities, additive: **minor** — but a `hive ctl --json`
  shape change or a `.hivemind/` schema change is **major**, so land capability verbs
  additively and never reshape an existing verb.
- Tile plugins get their own `protocol: 1` namespace; the workspace-view protocol stays
  at 1 and is untouched. A view protocol break would be **major**.

## Order of work

1. Split diff/editor tiles into pieces. No protocol work; pays for itself anyway.
2. Capability registry in `hive-core` + generated MCP server in `packages/hive-mcp`
   (currently empty) + `hive ctl` verbs. Agents get file/git tools on day one, before any
   UI plugin exists.
3. Convert built-in kinds into built-in tool plugins (`hivemind/code`, `hivemind/git`,
   `hivemind/issues`); `MANAGED_KINDS` becomes dynamic. No user-visible change.
4. Catalog `type: "tool"`, `hivemind-tool.json`, `hive tools install`, settings page.
5. `case "plugin"` in tile-host: sandboxed tools with `git:read` + `files:read` only.
   Ship a read-only third-party diff as the proof.
6. Writes, then `kindOverrides` ("use Acme diff for diff tiles").
7. LSP proxy last.

Steps 1-2 are worth doing whatever happens to 3-7: the piece-split is overdue, and the
capability registry gives agents real file/git tools regardless of whether anyone ever
ships a UI plugin.

## Open question

Whether `lsp` belongs in the same registry or stays internal until our own editor uses it.
Exposing `lsp.request` to agents is powerful (real go-to-definition instead of grep) and
also the largest new surface. Defer the decision to step 7.
