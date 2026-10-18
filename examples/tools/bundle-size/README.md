# Bundle size

The files of a build folder, largest first, as bars coloured by kind (scripts, styles, images,
fonts, source maps), with the total and, for scripts, styles and other text, the size gzip level 9
makes of them: what a browser downloads.

"Keep as baseline" saves today's sizes with the tile; from then on each file shows how much it grew
(red) or shrank (green) since, new files are marked and removed ones listed, and the header shows
the total's change. Build again and press "Measure again".

```bash
hive tools install examples/tools/bundle-size
hive plugins enable tool:dip497/bundle-size
hive plugins set tool:dip497/bundle-size folder build   # the folder your build writes (default dist)
hive ctl open-tool dip497/bundle-size/sizes
```

An agent asks it, while its tile is open:

```bash
hive ctl plugin call dip497/bundle-size sizes     # sizes now
hive ctl plugin call dip497/bundle-size compare   # change since the baseline
```

Sizes come from `find` and `wc -c`. A tile runs programs without a shell, so it cannot pipe
`gzip -c` into `wc`, and output reaches it as text, which would miscount gzip's bytes; the gzip
sizes therefore come from `python3`, whose gzip module compresses each file at level 9 (as
`gzip -9 -n` does). Without `python3` the tile shows sizes only. The baseline keeps the 500 largest
files. It asks for no permissions.

## How it was made

Built by a coding agent (Claude) from the tool-plugin contract (the brief
`hive tools new` writes, and the tool plugin guide). It uses `host.run` of `find`, `wc` and
`python3`, and `useTileState` for the baseline. Reading sizes and comparing them are in `lib.js`,
tested on real `wc` output and checked against `gzip -9` itself.
