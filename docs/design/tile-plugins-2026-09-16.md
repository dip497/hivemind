# Tile plugins: tools that ship their own UI

Status: proposal. 2026-09-16. Branch `feat/tile-plugins`.

## What already exists

- **A tool-plugin registry** (`packages/hive-core/src/tool-plugins.ts`): a plugin id is
  `ns/name`, contributes tile kinds, and is OFF until the user enables it. Today one entry:
  `browser` ← `hivemind/web`. Editor and diff are still unmanaged legacy kinds.
- **A sandboxed iframe surface**: view packages over `hm-view://`, manifest, install
  review, permissions refused at install and load, theme vars.
- **A control plane**: HCP methods (`tile.*`, `agent.*`, `workflow.run`, `tool.open`)
  fronted by `hive ctl`, whose `--json` is "the same shape as the MCP tool".
  `packages/hive-mcp` is scaffolded and empty.

## The correction: don't invent a protocol

MCP-UI and OpenAI's Apps SDK merged into an official MCP spec extension — **MCP Apps
(SEP-1865), status Stable, 2026-01-26** (`modelcontextprotocol/ext-apps`). It defines
exactly what we were about to design: a tool that returns a `ui://` HTML resource
(`text/html;profile=mcp-app`), rendered in a sandboxed iframe, speaking JSON-RPC over
postMessage (`ui/initialize`, `ui/notifications/tool-result`, `tools/call`, `ui/message`,
`ui/open-link`, size-change), with CSP declared in `_meta.ui.csp`.

Our `hm-view://` machinery is most of an MCP Apps host already. Adopting it means **any
third-party MCP server that ships a UI resource becomes a spawnable tile with no
hivemind-specific code** — and our own tiles prove the API is honest.

Canvas views keep their own protocol (`hivemind-view.json`, protocol 1). A whole-canvas
view is a genuinely different thing. Tool tiles speak MCP Apps.

## Two kinds of "tool", kept apart

The word is overloaded. Split it and the design stops fighting itself.

| | Host capabilities | Plugin tools |
| --- | --- | --- |
| Examples | `git.diff`, `files.read`, `review.list` | `browser_navigate`, a plugin's own actions |
| Author | us | the plugin |
| Declared in | one capability registry in `hive-core` | the plugin's own MCP server |
| Reached by | plugin RPC, `hive ctl` | agents, as `mcp__hivemind_<plugin>__<tool>` |

A plugin manifest gains one field, not a schema language:

```json
{ "id": "acme/diff",
  "tools": [{ "key": "diff", "tileKind": "diff", "entry": "diff.html" }],
  "mcp": { "command": "${PLUGIN_ROOT}/server" },
  "permissions": ["git:read", "files:read"] }
```

That is Claude Code's plugin model, and the resulting tool namespace is one every agent we
orchestrate already understands.

**The rule for what agents get:** expose a capability to an agent only when it is
**app-owned state a shell cannot reach** — comments, tile state, browser pages, plan
reviews. Never duplicate `git diff` or `cat`; an agent already has a terminal in the repo.

## Review comments: the store has to move first

`ReviewComment` lives in renderer **localStorage** (`hivemind:comments:<repoPath>`,
`code/review-store.ts`), and the only path to an agent is `deliverToClaude(text)` — a
one-way dump. An agent cannot read localStorage, so no tool design fixes this. Move the
store into main behind the capability registry, then expose:

`review_list({file?, status?})` · `review_get(id)` · `review_reply(id, body)` ·
`review_resolve(id, summary?)` · `review_dismiss(id, reason)` · **`review_watch({timeoutSeconds})`**

The last one blocks until a human leaves a comment. That is what turns the diff tile into
a real review loop instead of a one-shot dispatch, and it is the shape the closest prior
art (agentation.com's annotation MCP: acknowledge → reply → resolve/dismiss + watch) has
already converged on.

## Browser: use the names everyone else uses

Playwright MCP, Chrome DevTools MCP, browser-use and the agent browsers converged
independently on an **accessibility-tree snapshot with opaque element refs, not pixels**:
`browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_find`,
`browser_take_screenshot`, `browser_evaluate`, `browser_console_messages`,
`browser_network_requests`, `browser_tabs`. Screenshots are a fallback capability for
canvas/WebGL, not the default.

Use these names verbatim. A nonstandard name costs a failed tool call per session. Note
that `tool-plugins.ts` already describes the browser as one "agents can drive when you
allow it" — nothing in the control plane implements that yet.

## Permissions

- Host-owned, never self-granted. A manifest declares what it wants; the user decides.
- Annotate every tool `readOnlyHint` / `destructiveHint`. Read-only skips confirmation;
  writes confirm once with "always allow for this plugin". That is the convergent rule.
- Keep the existing second gate: installed ≠ enabled.
- **`files:write` scoped to the repo is not a middling permission.** Writing `.git/hooks/*`
  or `.git/config` (`core.fsmonitor`, `sshCommand`) executes arbitrary code on the user's
  next git operation, and an in-repo symlink defeats a naive path check. Deny `.git/**`
  and resolve symlinks before the scope check, or treat `files:write` as full trust.
- Missing from the capability list on purpose: **exec**. Plugins never run commands. That
  is what agent tiles are.

## Events, not just requests

Request/response alone leaves every plugin UI stale the moment an agent edits a file. The
capability layer needs push: file-watch, git index/HEAD change, and comment change. Ship
this with the first read capability, not after.

## Order of work

1. Split diff/editor tiles into pieces (`FileTree`, `ChangesList`, `CommitBar`,
   `DiffView`, `ConflictView`). No protocol work; overdue anyway.
2. Capability registry in `hive-core`, with change events. Our own pieces call it instead
   of reaching into IPC directly.
3. Move the review-comment store out of localStorage into main.
4. `packages/hive-mcp`: the host MCP server, exposing app-owned state only — review
   comments first, since that is the loop with no substitute.
5. Convert built-in kinds into built-in tool plugins (`hivemind/code`, `hivemind/git`).
   No user-visible change.
6. Browser tools, converged names, snapshot-first.
7. MCP Apps host: tool tiles rendered from `ui://` resources, CSP from `_meta.ui.csp`.
   Third-party plugins land here.

Steps 1-4 stand on their own: they fix a real gap (comments an agent cannot see) and clean
up code we own. Steps 5-7 open the ecosystem, and are worth doing only when someone wants
to ship a plugin.

**Skipped on purpose:** `replaces` / `kindOverrides` until a competing tile exists, and the
`lsp` capability — largest new surface, benefits nobody yet.
