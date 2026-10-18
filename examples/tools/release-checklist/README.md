# Release checklist

Is the repository ready to release? Six checks, each with what it found:

- the working tree is clean (`git status --porcelain`), naming what is not committed;
- you are on the release branch (a setting, `main` by default);
- the branch is up to date with its remote (it fetches, then counts commits not pushed and not pulled);
- the tests pass (the test command you set; skipped when none is set);
- the changelog's top section has entries;
- no TODO or FIXME was added since the last tag, each one listed and opened in the editor with a click.

"Run all" runs the quick git checks together and the tests last; "Run again" runs one. A meter
shows how many passed. "Ask an agent to fix" on a failed check starts one in the tile's frame (you
read the prompt before it is sent). The last results are kept with the tile.

```bash
hive tools install examples/tools/release-checklist
hive plugins enable tool:dip497/release-checklist
hive plugins set tool:dip497/release-checklist testCommand "bun test"
hive plugins set tool:dip497/release-checklist branch release
hive ctl open-tool dip497/release-checklist/checklist
```

An agent asks it, while its tile is open:

```bash
hive ctl plugin call dip497/release-checklist check    # run everything
hive ctl plugin call dip497/release-checklist status   # the last results
```

The test command runs without a shell, with the app's limit of 60 seconds. It asks for two
permissions: start agents (`workspace:spawn`) and tell an agent something (`workspace:prompt`).

## How it was made

Built by a coding agent (Claude) from the tool-plugin contract (the brief
`hive tools new` writes, and the tool plugin guide). It uses `host.run` of `git` (`status`,
`branch`, `fetch`, `rev-list`, `ls-files`, `describe`, `diff`), `cat` and your test command,
`host.openFile` for a TODO, `useTileState` for the last results, and `hm.commands.spawnAgent` with
the permissions above. Reading git's answers is in `lib.js`, tested on real git output.
