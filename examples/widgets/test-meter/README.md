# Test meter

The share of tests passing in the last run, the ones that failed, and the runs before it, so a
trend shows. An agent reports a run after it runs the tests, as can a git hook or a CI step.

```bash
hive widgets install examples/widgets/test-meter    # then add it from the toolbar's Add menu
hive ctl plugin open widget:@dip497/test-meter        # or let an agent place it
hive ctl plugin call @dip497/test-meter report '{"passed":412,"failed":3,"skipped":2,"suite":"unit","failing":["auth refresh"]}'
hive ctl plugin call @dip497/test-meter history
hive ctl plugin call @dip497/test-meter clear
```

It asks for no permissions.

## How it was made

Built by a coding agent (Claude) from the widget contract: `hive widgets new`'s brief, `hive.d.ts`
and the [Widgets guide](../../../docs/src/content/docs/guide/widgets.md), then checked
in the app over the demo workspace. Its behaviour test is `packages/hive-core/src/showcase-widgets.test.ts`,
which runs `widget.js` with the same worker prelude the app uses.
