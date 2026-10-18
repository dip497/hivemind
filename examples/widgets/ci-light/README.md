# CI light

The build's status as a light: green when it passed, red when it failed, amber while it runs.
Whatever knows the result sets it: your CI wrapper, a git hook, or an agent that just ran the build.
When it turns red it notifies you, and **Ask an agent to fix it** starts one with the failure as its
first message, which you read before it is sent.

```bash
hive widgets install examples/widgets/ci-light    # then add it from the toolbar's Add menu
hive ctl plugin open widget:@dip497/ci-light        # or let an agent place it
hive ctl plugin call @dip497/ci-light set '{"state":"running","name":"CI","branch":"main"}'
hive ctl plugin call @dip497/ci-light set '{"state":"failed","name":"CI","branch":"main","detail":"typecheck: 2 errors"}'
hive ctl view emit ci.build '{"state":"passed","name":"CI"}'   # the same, as an event
hive ctl plugin call @dip497/ci-light status
```

It asks to start agents (`workspace:spawn`) and to give one its first message (`workspace:prompt`), for the fix button.

## How it was made

Built by a coding agent (Claude) from the widget contract: `hive widgets new`'s brief, `hive.d.ts`
and the [Widgets guide](../../../docs/src/content/docs/guide/widgets.md), then checked
in the app over the demo workspace. Its behaviour test is `packages/hive-core/src/showcase-widgets.test.ts`,
which runs `widget.js` with the same worker prelude the app uses.
