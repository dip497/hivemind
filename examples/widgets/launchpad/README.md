# Launchpad

Three jobs you hand to an agent often, one press each: review my changes, run and fix the tests,
write the changelog. Each press starts your default agent with that job as its first message; the
app shows you the message and you send or cancel it. Change the buttons and their jobs in its options.

```bash
hive widgets install examples/widgets/launchpad    # then add it from the toolbar's Add menu
hive ctl plugin open widget:@dip497/launchpad        # or let an agent place it
hive ctl plugin call @dip497/launchpad jobs
```

It asks to start agents (`workspace:spawn`) and to give one its first message (`workspace:prompt`).

Options (the gear on the widget): `oneLabel`/`one`, `twoLabel`/`two`, `threeLabel`/`three`: each button's label and job.

## How it was made

Built by a coding agent (Claude) from the widget contract: `hive widgets new`'s brief, `hive.d.ts`
and the [Widgets guide](../../../docs/src/content/docs/guide/widgets.md), then checked
in the app over the demo workspace. Its behaviour test is `packages/hive-core/src/showcase-widgets.test.ts`,
which runs `widget.js` with the same worker prelude the app uses.
