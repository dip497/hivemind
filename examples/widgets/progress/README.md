# Progress

A task's steps on the board, kept by the agents doing it. An agent names the task, adds steps and
ticks them off as it goes; you watch the meter fill, and can tick a step yourself by pressing it.
Everyone in the workspace sees the same steps.

```bash
hive widgets install examples/widgets/progress     # then add it from the toolbar's Add menu
hive ctl plugin commands                            # what it lets an agent run
hive ctl plugin call @dip497/progress set-title '{"title":"Ship the release"}'
hive ctl plugin call @dip497/progress add '{"text":"Run the tests"}'
hive ctl plugin call @dip497/progress check '{"index":0}'
hive ctl plugin call @dip497/progress list
```

It asks for no permissions: it only draws what agents tell it.
