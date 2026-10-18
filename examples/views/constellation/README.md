# Constellation

Your workspace in 3D. Each frame is a star in its own colour; its agents are lights on orbits
around it, coloured by what they are doing: working, waiting on you, idle or stopped. A worktree
sits beside the frame it came from, and a line joins an agent to the ones it started. Drag to turn
it, scroll to come closer, and click an agent to dock its live terminal beside the stars.

It draws with [three.js](https://threejs.org) 0.186.0 (MIT), which ships in this folder as
`three-0.186.0.min.js`: a view's page may load any script from its own folder, and nothing from the
network. That file is three.js's own build, tree-shaken to the parts used, with its licence header.

```bash
hive views install examples/views/constellation     # then switch to it with ⌘E (Ctrl+E)
hive ctl plugin open view:@dip497/constellation       # or let an agent switch to it
hive ctl plugin call @dip497/constellation census
hive ctl plugin call @dip497/constellation show '{"name":"docs"}'    # dock that agent's terminal
hive ctl plugin call @dip497/constellation release
```

Its commands are there while it is the view shown. `icon.svg` is its mark for a listing; a view manifest has no icon field, so the app does not show it yet. It asks for no permissions.

Settings (its page in Settings ▸ Plugins, or `hive plugins set view:@dip497/constellation <id> <value>`): `frameRate` (5 to 60, default 30): fewer frames use less of the computer; it draws nothing while hidden. `turn`: turn slowly on its own.

## How it was made

Built by a coding agent (Claude) from the view contract: `hive views new`'s brief and the
[Extension authoring guide](../../../docs/src/content/docs/guide/extension-authoring.md),
then checked in the app over the demo workspace. What it works out from the workspace is in `lib.js`,
tested in `packages/hive-core/src/showcase-views.test.ts`.
