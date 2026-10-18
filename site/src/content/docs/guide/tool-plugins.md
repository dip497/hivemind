---
title: Tool plugins
description: Add a kind of tile to the app — a pull request panel, a commit browser — drawn by your own code.
---

A tool plugin adds a kind of tile. Open it from the toolbar's **Add**, a frame's ⋯ → **Add a tool
or widget…**, or with `hive ctl open-tool <owner>/<name>/<tool>`, and it sits on the board beside
terminals and the Code tile, in every view. The Browser, Issues and the Code tile are tools that come with the app.
Issues and Code are always on. The Browser is off until you switch it on: its page in
**Settings ▸ Plugins**, or `hive plugins enable tool:hivemind/web`. The ones you add are written
against the same contract.

A tool plugin runs **inside the app**, with the access the app has: your files, your programs and
your logins. So one you add is off until you switch it on, on its page in **Settings ▸ Plugins** or
with `hive plugins enable tool:<owner>/<name>`. Switch on only what you trust. If one makes the
app misbehave, start it in safe mode, where none loads: `HIVEMIND_SAFE_MODE=1 hivemind`.

The project's own are on [HiveHub](https://hivehub.griiken.workers.dev/), published from
[dip497/hivemind-plugins](https://github.com/dip497/hivemind-plugins/tree/main/tools):

| Example | What it shows |
|---|---|
| `github-prs` | the repository's pull requests: conversation, diff, checks; comment, approve, merge (through `gh`) |
| `git-history` | commits, searchable, with their diffs; ask an agent to explain one |
| `todo-finder` | every TODO and FIXME by file; open one, or hand it to an agent; its markers are a setting |
| `ci-runs` | GitHub Actions runs: a failed job's lines, rerun or cancel, hand the failure to an agent (through `gh`) |
| `worktrees` | every git worktree: uncommitted changes, ahead and behind the base, its diffs; review one with an agent, remove the merged ones |
| `dependency-audit` | known vulnerabilities in the repository's lockfiles, from the OSV database; ask an agent to upgrade |
| `flaky-tests` | runs the tests several times and shows which pass only sometimes |
| `changelog-writer` | the commits since the last tag, grouped into a changelog draft |
| `release-checklist` | clean tree, right branch, up to date, tests, changelog, no new TODOs: each checked, each fixable by an agent |
| `bundle-size` | the files of a build folder by size and gzip size, against a baseline you keep |
| `sqlite-browser` | a SQLite file's tables and rows, and read-only queries |
| `log-tail` | follows a log file with level colours, filters, and errors handed to an agent |
| `api-explorer` | the HTTP endpoints the code declares, and a panel to send one a request |

Install one by its id, `dip497/<name>` (from 2026.10.3), or from the **HiveHub** tab of Settings ▸ Plugins (pick **Tools** to see only tools). It arrives
switched off, an update too, so turn it on:

```bash
hive tools install dip497/worktrees
hive plugins enable tool:dip497/worktrees
hive ctl plugin open tool:dip497/worktrees
```

A folder works too: `hive tools install tools/git-history` in a checkout of the plugins repository.

## Make one

```bash
hive tools new my-tool        # a starter in ./my-tool, id <your GitHub login>/my-tool
cd my-tool && hive tools install . && hive plugins enable tool:<you>/my-tool
```

The starter's `PROMPT.md` is a brief a coding agent can build the tool from: write what you want
at the top and hand it the file.

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
  wherever the app shows the tool: the Add menu, tabs and Layers. Without one, its
  `glyph` is shown.
- Each tool is one kind of tile. `needsRepo` hides it in a frame with no repository;
  `singleton` focuses the open one instead of opening a second.
- `permissions` and `settings` are a view's, word for word ([Extension authoring](../extension-authoring/#permissions)): the same
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
| `host` | what only a tile has: `repoPath`, `cwd`, `run(bin, args, { maxAgeMs, stdin })` (a program on PATH, in the tile's folder, without a shell), `openFile(path)` in the frame's Code tile, `openUrl(url)` in the frame's browser |
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
  Settings → API access: `view`, `edit`, `terminals` or `agents`. It can never share a workspace or
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
for. From the app's environment the service gets where programs are and who and where you are
(`PATH`, `HOME`, `USER`, `SHELL`, the locale, `TZ`, the temp and XDG folders), and nothing else:
no token an agent's terminal carries.

If it exits with an error, it is started again after 1 s, then 2, 4 and so on up to a minute.
If it exits cleanly, or its grant is taken back in Settings → API access, it stays stopped. It
should exit when its stdin closes: that is the app going away, however it went. What it prints
is on its page, and in `services/<owner>--<name>.log` in the app's data folder.

## On a board you share

A guest sees a tool's tile if they have the same plugin switched on; otherwise the tile shows what
it needs, and the board keeps it. A tile's programs run on the machine of the person looking at it.
