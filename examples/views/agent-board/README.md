# Agent board

A view the agents write to. Each note they pin shows here, newest first, marked done, blocked or a
note, for everyone looking at the workspace in this view. The notes are kept with the workspace.

```bash
hive views install examples/views/agent-board       # then switch to it (⌘E)
hive ctl plugin call agent-board post '{"text":"Tests pass on main","from":"claude #1","kind":"done"}'
hive ctl plugin call agent-board list
```

Its commands are there while it is the active view: `hive ctl plugin commands` lists them.
