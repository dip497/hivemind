# Timeline

Today as a timeline: one row per agent, grouped by frame, with a bar for each stretch it spent
working, waiting on you or idle, and a tick for each turn it finished. The past comes from the app's
history, so it shows the hours before you opened the view; the present is kept live. The header adds
it up: time working, time waiting on you, turns finished.

```bash
hive views install examples/views/timeline     # then switch to it with ⌘E (Ctrl+E)
hive ctl plugin open view:@dip497/timeline       # or let an agent switch to it
hive ctl plugin call @dip497/timeline summary
```

Its commands are there while it is the view shown. `icon.svg` is its mark for a listing; a view manifest has no icon field, so the app does not show it yet. It asks for no permissions.

Settings (its page in Settings ▸ Plugins, or `hive plugins set view:@dip497/timeline <id> <value>`): `everyTile`: show terminals and tools too, not only agents.

## How it was made

Built by a coding agent (Claude) from the view contract: `hive views new`'s brief and the
[Extension authoring guide](../../../docs/src/content/docs/guide/extension-authoring.md),
then checked in the app over the demo workspace. What it works out from the workspace is in `lib.js`,
tested in `packages/hive-core/src/showcase-views.test.ts`.
