# SQLite browser

The repository's SQLite files in a tile, read-only. Choose a file: its tables and views are listed
with their row counts; choose one to see its first 200 rows in a grid (numbers right-aligned, nulls
marked). Write any query in the box and run it with the button or Ctrl+Enter.

It finds `.db`, `.sqlite` and `.sqlite3` files that git tracks, and any within three folders of the
top (a database is often ignored by git). It opens them with `sqlite3 -readonly -safe -json`:
`-readonly` refuses every write, and `-safe` refuses sqlite3's commands that run programs or attach
other files; a query starting with `.` is not sent at all.

```bash
hive tools install examples/tools/sqlite-browser
hive plugins enable tool:dip497/sqlite-browser
hive ctl open-tool dip497/sqlite-browser/browser
```

An agent asks it, while its tile is open:

```bash
hive ctl plugin call dip497/sqlite-browser tables
hive ctl plugin call dip497/sqlite-browser query '{"sql":"SELECT status, COUNT(*) FROM orders GROUP BY status"}'
hive ctl plugin call dip497/sqlite-browser query '{"sql":"SELECT * FROM users LIMIT 5","file":"data/app.db"}'
```

It needs `sqlite3` (3.33 or newer, for `-json`). It asks for no permissions.

## How it was made

Built by a coding agent (Claude) from the tool-plugin contract (the brief
`hive tools new` writes, and the tool plugin guide). It uses `host.run` of `git ls-files`, `find`
and `sqlite3`, and `useTileState` to keep the chosen file, table and query. Building the queries
and reading sqlite3's answers are in `lib.js`, tested against a real database.
