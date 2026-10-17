# CI runs

The repository's GitHub Actions runs in a tile, newest first, refreshed while any is running. Choose
a run to see its jobs; choose a failed job to read the lines that failed. Rerun the failed jobs,
cancel a run, open it on GitHub, or ask an agent to find and fix the cause: it starts one in the
tile's frame, and you read the prompt before it is sent.

It drives `gh`, so `gh auth login` first.

```bash
hive tools install examples/tools/ci-runs
hive plugins enable tool:dip497/ci-runs
hive plugins set tool:dip497/ci-runs branch current   # only the checked-out branch's runs
```

It asks for two permissions: start agents (`workspace:spawn`) and tell an agent something
(`workspace:prompt`).
