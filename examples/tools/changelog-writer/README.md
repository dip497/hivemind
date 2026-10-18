# Changelog writer

A changelog draft from the commits since the last tag (or the latest commits, when there is no tag
yet), grouped by their [conventional-commit](https://www.conventionalcommits.org) type: `feat` under
Added, `fix` under Fixed, `perf` under Performance, `refactor` under Changed, `docs` under
Documentation, the rest under Other, and anything marked `!` or `BREAKING CHANGE:` under Breaking.
A commit's scope is written in bold; merge and `chore(release)` commits are left out.

The grouped commits sit beside the draft, which you read rendered or as Markdown. "Copy" puts the
Markdown on the clipboard; "Ask an agent to write it into CHANGELOG.md" starts one in the tile's
frame to merge it into the file in its own style (you read the prompt before it is sent).

```bash
hive tools install examples/tools/changelog-writer
hive plugins enable tool:dip497/changelog-writer
hive plugins set tool:dip497/changelog-writer hashes false   # entries without commit hashes
hive ctl open-tool dip497/changelog-writer/changelog
```

An agent asks it, while its tile is open:

```bash
hive ctl plugin call dip497/changelog-writer draft
```

It asks for two permissions: start agents (`workspace:spawn`) and tell an agent something
(`workspace:prompt`).

## How it was made

Built by a coding agent (Claude) from the tool-plugin contract (the brief
`hive tools new` writes, and the tool plugin guide). It uses `host.run` of `git describe` and
`git log`, the sdk's `Markdown` to draw the draft, and `hm.commands.spawnAgent` with the
permissions above. Grouping and writing the draft are in `lib.js`, tested on real commit messages.
