# Tool plugins: kinds of tile, loaded into the app, with the view's client

Status: accepted, built 2026-10-07.

## Context

Anyone should be able to add a kind of tile (a pull request panel, a commit browser) without
changing the app, and the tiles that ship should be built the same way. The tile-registry branch
first did this with a sandboxed frame per tile (`hm-tile://`) and a main-process broker that ran
only allow-listed programs, after a startup dialog, for files pinned by hash.

Three facts changed the design:

1. **Tools already are tile plugins.** `tool-plugins.ts` says a tool is "something the workspace
   can spawn as a tile", with an on/off record, per-tool switches, CLI commands and
   `hive ctl open-tool`, and an installed one is "off until the user turns it on". The frame
   design added a second system beside it, outside the Plugins page and `hive plugins`.
2. **A frame per tile is a second API the app's own tiles never use**, with its own lifecycle
   problems: frames kept alive off screen, an unbounded output cache, and approval dialogs racing
   across windows.
3. **Views already have the workspace API a tile needs**: the `hm` client, its commands, requests
   and events, held to declared permissions. Widgets had a third, smaller one.

## Decision

1. **A tool plugin runs inside the app.** Its ES module is served over `hm-plugin://` and imported
   into the window; it imports the app's React and parts from `hm-plugin://host/`. Its tiles
   register through the same tile API as the app's own.
2. **One record, one kind.** An added tool plugin is a `tool:<owner>/<name>` plugin: off until
   switched on, on the Plugins page and in `hive plugins`. Switching it on is the consent; the page
   says it runs with the app's access.
3. **One client.** A tool's tile gets the view SDK's `hm`, linked in the window by the same link
   a view's frame uses (`usePluginLink`), held to the same permissions, with the same settings
   fields. Only what a tile alone has is extra (`host`: its folder, `run`, opening files and pages).
4. **Safe mode** (`HIVEMIND_SAFE_MODE=1`) loads none, and serves none of their code.
5. **One spawn rule.** The link asks the tile registry what may be spawned; `hive ctl open-tool`
   opens any tool, added ones included. No kind is named outside its plugin.

## Dropped, and why

- **The sandboxed frame, the program allow-list, the startup approval dialog and the file-hash
  pin.** A plugin the person switched on is trusted like the app (as VS Code and Obsidian
  plugins are). The pin guarded files anything able to change could also change settings.json and
  the agent hooks beside them in `~/.config/hivemind`.
- **`tile.json` and `<userData>/tiles`.** A tool plugin is a tool; it lives beside views and
  widgets in `~/.config/hivemind/tools`, where the CLI reads it too.
- **A hand-kept list of the app's tile kinds in core.** The registry is the one owner of which
  kinds are taken.

## Consequences

- A plugin that blocks the main thread slows every terminal. Safe mode is the way out; a separate
  process per plugin is the upgrade path if that happens in practice.
- A tool's tile on a shared board runs on the machine of whoever looks at it; a guest without the
  plugin sees the missing-plugin card.
- Widgets still have their own workspace API (`hive.workspace`); moving them onto `hm` is the next
  step, as is moving Issues and the Browser out of the app into packages built on the SDK.
