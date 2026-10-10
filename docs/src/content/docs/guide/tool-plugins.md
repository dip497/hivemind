---
title: Tool plugins
description: Add a kind of tile to the app — a pull request panel, a commit browser — drawn by your own code.
---

A tool plugin adds a kind of tile. Open it from a frame's **Open** menu, or with
`hive ctl open-tool <owner>/<name>/<tool>`, and it sits on the board beside terminals and the Code
tile, in every view. The Browser, Issues and the Code tile are tools that come with the app; the
ones you add are written against the same contract.

A tool plugin runs **inside the app**, with the access the app has: your files, your programs and
your logins. So one you add is off until you switch it on, in **Settings ▸ Plugins ▸ Tools** or
with `hive plugins enable tool:<owner>/<name>`. Switch on only what you trust. If one makes the
app misbehave, start it in safe mode, where none loads: `HIVEMIND_SAFE_MODE=1 hivemind`.

The examples are in the repository, in `examples/tools`:

| Example | What it shows |
|---|---|
| `github-prs` | the repository's pull requests: conversation, diff, checks; comment, approve, merge (through `gh`) |
| `git-history` | commits, searchable, with their diffs; ask an agent to explain one |
| `todo-finder` | every TODO and FIXME by file; open one, or hand it to an agent; its markers are a setting |
| `ci-runs` | GitHub Actions runs: a failed job's lines, rerun or cancel, hand the failure to an agent (through `gh`) |
| `worktrees` | every git worktree: uncommitted changes, ahead and behind the base, its diffs; review one with an agent, remove the merged ones |

```bash
hive tools install examples/tools/git-history
hive plugins enable tool:dip497/git-history
hive ctl open-tool dip497/git-history/history
```

## Make one

```bash
hive tools new my-tool        # a starter in ./my-tool, id <your GitHub login>/my-tool
cd my-tool && hive tools install . && hive plugins enable tool:<you>/my-tool
```

A tool plugin is a folder with `hivemind-tool.json` and an ES module:

```json
{
  "id": "acme/prs",
  "name": "Pull requests",
  "version": "1.0.0",
  "apiVersion": 1,
  "description": "One line, shown in Settings.",
  "category": "git",
  "entry": "index.js",
  "permissions": ["workspace:spawn"],
  "settings": [
    { "id": "state", "label": "Show", "type": "choice", "values": ["open", "all"], "default": "open" }
  ],
  "tools": [
    {
      "key": "prs", "label": "Pull requests", "description": "What its tile shows.",
      "tileKind": "acme-prs", "size": { "width": 1100, "height": 760 },
      "needsRepo": true, "singleton": true, "glyph": "⇅", "icon": "icon.svg"
    }
  ]
}
```

- `id` is `owner/name`; `hivemind/` is kept for the app's own.
- `category` is what it is for: `code`, `git`, `agents`, `productivity`, `monitoring`, `team`, `web`, `fun` or `other` (the default). The Add menu groups tools and widgets by it, and
  HiveHub lists plugins by it.
- A tool's `icon` is an `.svg` in the folder (32 KB at most), drawn in the menu's text colour
  wherever the app shows the tool: the Add menu, the Open menu, tabs and Layers. Without one, its
  `glyph` is shown.
- Each tool is one kind of tile. `needsRepo` hides it in a frame with no repository;
  `singleton` focuses the open one instead of opening a second.
- `permissions` and `settings` are a view's, word for word ([Views](./views/)): the same
  permissions, asked for the same way, and the same setting fields, drawn on its Settings page and
  set with `hive plugins set tool:acme/prs state all`.

The module's default export says which component draws each tile kind:

```js
import React, { useEffect, useState } from "hm-plugin://host/react.js";
import { Button, PatchView } from "hm-plugin://host/sdk.js";

const h = React.createElement;

function PullRequests({ tile, hm, host }) {
  const [list, setList] = useState([]);
  useEffect(() => {
    host.run("gh", ["pr", "list", "--json", "number,title"], { maxAgeMs: 30_000 })
      .then((r) => setList(JSON.parse(r.stdout)));
  }, [host]);
  return h("ul", null, list.map((p) => h("li", { key: p.number }, `#${p.number} ${p.title}`)));
}

export default { tiles: { "acme-prs": PullRequests } };
```

It imports the app's own React and parts from `hm-plugin://host/`, so it bundles none: `react.js`,
`react-jsx-runtime.js` and `sdk.js`. With a bundler, mark `react`, `react/jsx-runtime` and
`@hivemind/tile-sdk` external and map them to those URLs.

## What a tile is handed

| | |
|---|---|
| `tile` | `{ id, kind, name, frameId }` |
| `hm` | the client a view has (`@hivemind/view-sdk`): the workspace's frames, tiles and names, agents' status and events, commands (`hm.commands.spawnAgent`, `focusTile`…), requests (`hm.prompt`, `hm.agents()`), its settings (`hm.settings`, `hm.on("settings")`) and its saved state, kept per tile (`hm.hello.layout`, `hm.setLayout`). Each is held to the permissions the manifest declares. |
| `host` | what only a tile has: `repoPath`, `cwd`, `run(bin, args, { maxAgeMs, stdin })` (a program on PATH, in the tile's folder, without a shell), `openFile(path)` in the editor beside it, `openUrl(url)` in the frame's browser |
| `selected` | it has the person's focus |

`sdk.js` gives `Button`, `PatchView` (a unified diff drawn by the app's diff view), `Markdown` and
`Loading` (a spinner in the middle of the space it fills: `h(Loading, { label: "Loading the runs" })`)
and `useTileState(hm, key, initial)`: React's `useState`, kept with the tile, so what it showed
(what was chosen, a filter, a tab) is there again when the app starts.
`ui.js` is the app's whole UI kit, so a plugin looks like the app: `Button`, `Input`, `Textarea`,
`Label`, `Dialog…`, `Popover`, `DropdownMenu…`, `MenuItem`, `Switch`, `Tooltip…`, `Badge`,
`Skeleton`, `MarkdownPreview`, and `toast` for notifications. With a bundler, map
`@hivemind/app-ui` to it. The Issues tile that comes with the app (`apps/desktop/tools/issues`) is
built this way, and is the fullest example there is.

A tile reads the workspace's issues through `hm` like any plugin: `hm.onIssues(cb)` for the list,
live, and `hm.issues.read(id)`, `create`, `update`, `setState`, `comment`, `delete`, `link`,
`unlink`, `move`, `workspaces()`. All of it needs `"workspace:issues"`; only `read` reaches another
workspace (a link's other end), and every write is to the tile's own.

Reach the app only through these, never `window.hive`: that is the app's own and changes without
notice. This contract changes only with `apiVersion`; a plugin written for a newer one is listed
with why it does not load.

## Commands an agent can run

A tool can let an agent ask its open tile something, or tell it to do something: declare the
command in `hivemind-tool.json`, answer it with `hm.onCommand` in the tile.

```json
"commands": [
  { "name": "list", "description": "Every worktree, with its branch and what is not committed." }
]
```

```js
useEffect(() => hm.onCommand("list", () => trees), [hm, trees]);
```

An agent finds it with `hive ctl plugin commands` and runs it with
`hive ctl plugin call dip497/worktrees list`; what the handler returns (or a promise of it) is
what the agent reads, and what it throws is the agent's error. A command takes one JSON argument;
`args` in the manifest says, in a line, what it holds. It runs only while a tile of the tool is
open; with two open, the agent names one with `--tile`.

## A service that keeps running

A tool plugin can bring a program the app keeps running while the plugin is on: an orchestrator,
a dashboard, a watcher. Declare it in `hivemind-tool.json`:

```json
"service": { "command": ["node", "service.js"], "role": "agents" }
```

- `command` is a program on PATH, or a file in the plugin's folder written `./bin/serve`, and its
  arguments. It runs in the plugin's folder.
- `role` is what it may do in the workspaces it drives, as for a program you let in from
  Settings → Programs: `view`, `edit`, `terminals` or `agents`. It can never share a workspace or
  push.

Switched on, it waits until you pick the workspaces it may drive: on its page, or with
`hive plugins workspaces tool:acme/prs ~/code/api` on a machine where `hive host` runs it. Then
it is started with its own token, made for this run and taken back when it stops:

| Variable | What it holds |
|---|---|
| `HIVE_DRIVE_SOCK` | the drive socket, where it connects |
| `HIVE_DRIVE_TOKEN` | its token: the first line it sends is `{"hello": {"token": …, "workspace": …}}` |
| `HIVE_WORKSPACES` | the folders it may drive, separated as in `PATH` |

With one workspace picked, `workspace` can be left out of the hello. `hive ctl` run by the service
uses its token as it is; with several workspaces, set `HIVE_WORKSPACE` to the one each call is
for. From the app's environment the service gets `PATH`, `HOME`, the locale and the temp folder,
and nothing else.

If it exits with an error, it is started again after 1 s, then 2, 4 and so on up to a minute.
If it exits cleanly, or its grant is taken back in Settings → Programs, it stays stopped. It
should exit when its stdin closes: that is the app going away, however it went. What it prints
is on its page, and in `services/<owner>--<name>.log` in the app's data folder.

## On a board you share

A guest sees a tool's tile if they have the same plugin switched on; otherwise the tile shows what
it needs, and the board keeps it. A tile's programs run on the machine of the person looking at it.
