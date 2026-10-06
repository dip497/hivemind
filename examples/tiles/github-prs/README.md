# GitHub pull requests

A tile plugin: the open pull requests of the tile's repo, each with its conversation, files and
checks, and comment, approve, request changes and merge. It runs `gh` and nothing else, so
`gh auth login` once on the machine is all it needs.

Install it by copying this folder to the app's tiles folder and restarting the app:

```bash
cp -r examples/tiles/github-prs ~/.config/hivemind/tiles/          # Linux
cp -r examples/tiles/github-prs ~/Library/Application\ Support/hivemind/tiles/   # macOS
```

The first load asks whether it may run `gh`. Open it from a frame's **Open → Pull requests**.

## Writing a tile plugin

A folder with two files:

- `tile.json`: its `name`, the `kinds` of tile it draws (each a `title`, an optional one-character
  `glyph`, a `size`, and whether it `needsRepo` or is a `singleton`), and the programs it asks to
  run under `permissions.exec`.
- `index.html`: the page each tile shows. It runs sandboxed, with no network. Other files in the
  folder load from the page by relative path.

The page talks to the app with `postMessage`:

| Direction | Message |
|---|---|
| app → page | `{ type: "hive:init", tile: { id, kind, repoPath, root }, theme }` |
| page → app | `{ type: "hive:call", id, method: "exec", bin, args, maxAgeMs? }` |
| app → page | `{ type: "hive:reply", id, ok, value: { code, stdout, stderr } \| error }` |
| page → app | `{ type: "hive:close" }` |

`exec` runs only a program the manifest declared and the person allowed, in the tile's own repo,
never through a shell. Tiles asking the same thing within `maxAgeMs` share one answer.
