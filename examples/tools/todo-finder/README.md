# TODO finder

Every TODO, FIXME, HACK and XXX note in the repository, grouped by file and counted by marker. Click
one to open its file in the editor beside the tile; "Hand to an agent" starts one in the tile's
frame to deal with it (you read the prompt before it is sent).

It uses `git grep`, so files git ignores stay out.

```bash
hive tools install examples/tools/todo-finder
hive plugins enable tool:dip497/todo-finder
hive plugins set tool:dip497/todo-finder pattern "TODO|FIXME|BUG"
```
