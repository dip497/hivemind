# Workspace map

The workspace as a map, left to right: the workspace, its frames, the worktrees made from them,
and every tile, each agent lit by what it is doing. Arcs show which agent started or feeds which.
Beside it, the workspace's issues by state; pick one to read its description and acceptance criteria.

```bash
hive views install examples/views/workspace-map     # then switch to it with ⌘E (Ctrl+E)
hive ctl plugin open view:@dip497/workspace-map       # or let an agent switch to it
hive ctl plugin call @dip497/workspace-map map
hive ctl plugin call @dip497/workspace-map read '{"id":"FAS-1"}'
```

Its commands are there while it is the view shown. `icon.svg` is its mark for a listing; a view manifest has no icon field, so the app does not show it yet. It asks to read the workspace's issues (`workspace:issues`).

## How it was made

Built by a coding agent (Claude) from the view contract: `hive views new`'s brief and the
[Extension authoring guide](../../../docs/src/content/docs/guide/extension-authoring.md),
then checked in the app over the demo workspace. What it works out from the workspace is in `lib.js`,
tested in `packages/hive-core/src/showcase-views.test.ts`.
