# Git history

The repository's commits in a tile. Search them by message, author or hash, read each one's diff in
the app's own diff view, and ask an agent to explain a commit: it starts one in the tile's frame,
and you read the prompt before it is sent.

```bash
hive tools install examples/tools/git-history
hive plugins enable tool:dip497/git-history
hive plugins set tool:dip497/git-history count 1000   # how many commits to list (default 300)
```

It asks for two permissions: start agents (`workspace:spawn`) and tell an agent something
(`workspace:prompt`).
