# Agent pulse

How the workspace's agents are doing right now: how many are working, waiting on you or idle,
how busy they are as a share, and how many turns they finished today (from the app's history, so
it counts turns from before the widget was placed).

```bash
hive widgets install examples/widgets/agent-pulse    # then add it from the toolbar's Add menu
hive ctl plugin open widget:@dip497/agent-pulse        # or let an agent place it
hive ctl plugin call @dip497/agent-pulse status
```

It asks for no permissions.

## How it was made

Built by a coding agent (Claude) from the widget contract: `hive widgets new`'s brief, `hive.d.ts`
and the [Widgets guide](../../../docs/src/content/docs/guide/widgets.md), then checked
in the app over the demo workspace. Its behaviour test is `packages/hive-core/src/showcase-widgets.test.ts`,
which runs `widget.js` with the same worker prelude the app uses.
