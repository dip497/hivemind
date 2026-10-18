# Spend today

What your agents spent today, in dollars and tokens, against a daily budget, with the three that
spent most. Agents report what a turn cost (or a hook that runs when a turn ends does); the day
starts again at midnight, and you are notified when the budget is spent.

```bash
hive widgets install examples/widgets/spend-today    # then add it from the toolbar's Add menu
hive ctl plugin open widget:@dip497/spend-today        # or let an agent place it
hive ctl plugin call @dip497/spend-today add '{"usd":0.42,"tokens":120000,"agent":"claude"}'
hive ctl plugin call @dip497/spend-today today
```

It asks for no permissions. A widget cannot read an agent's usage itself, so it counts only what is reported to it.

Options (the gear on the widget): `budget`: the daily budget in dollars (default 20).

## How it was made

Built by a coding agent (Claude) from the widget contract: `hive widgets new`'s brief, `hive.d.ts`
and the [Widgets guide](../../../docs/src/content/docs/guide/widgets.md), then checked
in the app over the demo workspace. Its behaviour test is `packages/hive-core/src/showcase-widgets.test.ts`,
which runs `widget.js` with the same worker prelude the app uses.
