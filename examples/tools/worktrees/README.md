# Worktrees

Every git worktree of the repository in a tile: its branch, how many files it has changed and not
committed, how far it is ahead of and behind the base branch, and whether it is merged. Choose one
to read its uncommitted changes or its whole branch against the base, in the app's own diff view.
Ask an agent to review a branch: it starts one in the tile's frame, and you read the prompt before
it is sent. A worktree with nothing uncommitted whose branch is merged can be removed, with its
branch; git refuses anything that would lose work.

```bash
hive tools install examples/tools/worktrees
hive plugins enable tool:dip497/worktrees
hive plugins set tool:dip497/worktrees base develop   # compare with another branch (default main)
```

It asks for two permissions: start agents (`workspace:spawn`) and tell an agent something
(`workspace:prompt`).
