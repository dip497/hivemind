# Pull requests

The repository's GitHub pull requests in a tile: the list, each one's conversation, its diff (drawn
by the app's own diff view) and its checks. Comment, approve, request changes or squash-merge.

It runs `gh` in the tile's repository, as you, so `gh auth login` first.

```bash
hive tools install examples/tools/github-prs
hive plugins enable tool:dip497/github-prs
hive plugins set tool:dip497/github-prs state all   # which PRs to list: open, closed, merged, all
```

Then open **Pull requests** from a frame's **Open** menu. It remembers which pull request was open.
