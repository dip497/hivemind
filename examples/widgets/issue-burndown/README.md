# Issue burndown

The workspace's open issues day by day for the last week, one bar per day, with how many are in
progress, in review and closed. It reads the issues live, so an agent closing one with
`hive ctl set-state` moves the bar at once. An issue counts as closed from the day it was last
changed while done or cancelled.

```bash
hive widgets install examples/widgets/issue-burndown    # then add it from the toolbar's Add menu
hive ctl plugin open widget:@dip497/issue-burndown        # or let an agent place it
hive ctl plugin call @dip497/issue-burndown burndown
```

It asks to read the workspace's issues (`workspace:issues`).

Options (the gear on the widget): `days`: how many days to show (3 to 14, default 7).

## How it was made

Built by a coding agent (Claude) from the widget contract: `hive widgets new`'s brief, `hive.d.ts`
and the [Widgets guide](../../../docs/src/content/docs/guide/widgets.md), then checked
in the app over the demo workspace. Its behaviour test is `packages/hive-core/src/showcase-widgets.test.ts`,
which runs `widget.js` with the same worker prelude the app uses.
