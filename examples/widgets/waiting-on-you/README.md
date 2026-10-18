# Waiting on you

Every agent in the workspace that is waiting on you (for permission, an answer, a plan to
review), longest first, with how long it has waited. Press one and the app takes you to it. It can
also notify you the moment an agent starts waiting.

```bash
hive widgets install examples/widgets/waiting-on-you    # then add it from the toolbar's Add menu
hive ctl plugin open widget:@dip497/waiting-on-you        # or let an agent place it
hive ctl plugin call @dip497/waiting-on-you list
```

It asks for no permissions: it reads the agents' status and moves focus, which every widget may.

Options (the gear on the widget): `shown`: how many agents to list (1 to 8, default 4). `notify`: a desktop notification when one starts waiting (default off).

## How it was made

Built by a coding agent (Claude) from the widget contract: `hive widgets new`'s brief, `hive.d.ts`
and the [Widgets guide](../../../docs/src/content/docs/guide/widgets.md), then checked
in the app over the demo workspace. Its behaviour test is `packages/hive-core/src/showcase-widgets.test.ts`,
which runs `widget.js` with the same worker prelude the app uses.
