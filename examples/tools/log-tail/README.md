# Log tail

Follows a log file live: the newest lines, read again every 2 seconds, each coloured by its level:
errors red, warnings amber, info and debug quieter. The level comes from a level word (`ERROR`,
`WARN`, `level=info` …) or, for JSON logs, the `level` field (words or numbers), and a JSON line is
shown as its time, message and other fields. A stack trace's lines take the level of the error
above them.

Filter by text, or by a regular expression written `/like this/i`; switch levels off and on, each
with its count; pause to read, resume to follow. "Ask an agent about these errors" starts one in
the tile's frame with the last 20 error lines (you read the prompt before it is sent). The field
at the top changes the file for this tile; the setting is the default for new ones.

```bash
hive tools install examples/tools/log-tail
hive plugins enable tool:dip497/log-tail
hive plugins set tool:dip497/log-tail file logs/server.log
hive ctl open-tool dip497/log-tail/tail
```

An agent asks it, while its tile is open:

```bash
hive ctl plugin call dip497/log-tail errors
hive ctl plugin call dip497/log-tail tail '{"lines":200,"filter":"/timeout|refused/i"}'
```

It asks for two permissions: start agents (`workspace:spawn`) and tell an agent something
(`workspace:prompt`).

## How it was made

Built by a coding agent (Claude) from the tool-plugin contract (the brief
`hive tools new` writes, and the tool plugin guide). It uses `host.run` of `tail`, `useTileState`
for the file, filter and levels shown, and `hm.commands.spawnAgent` with the permissions above.
Reading levels and filtering are in `lib.js`, tested on real log lines.
