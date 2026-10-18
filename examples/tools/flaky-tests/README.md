# Flaky tests

Runs the repository's tests several times, one after another, and shows every test's pass rate: a
row of green and red squares, one per run, and how often it passed. A test that passed in some runs
and failed in others is flaky, and comes first; "Ask an agent to fix" starts one in the tile's
frame with the test and its history (you read the prompt before it is sent). A meter fills as the
runs finish; stop after the current one at any time.

It reads the per-test lines of `bun test`, `node --test` (TAP and the spec reporter), any TAP
runner, `pytest -v`, `jest --verbose` and `vitest --reporter=verbose`.

```bash
hive tools install examples/tools/flaky-tests
hive plugins enable tool:dip497/flaky-tests
hive plugins set tool:dip497/flaky-tests command "pytest -v tests/"
hive plugins set tool:dip497/flaky-tests runs 10
hive ctl open-tool dip497/flaky-tests/flaky
```

An agent drives it, while its tile is open:

```bash
hive ctl plugin call dip497/flaky-tests run     # run them; answers within 25 s or keeps going
hive ctl plugin call dip497/flaky-tests flaky   # the last runs' flaky tests
```

The command runs without a shell (no pipes, no `&&`, no environment assignments), and each run has
the app's limit of 60 seconds and 10 MB of output. It asks for two permissions: start agents
(`workspace:spawn`) and tell an agent something (`workspace:prompt`).

## How it was made

Built by a coding agent (Claude) from the tool-plugin contract (the brief
`hive tools new` writes, and the tool plugin guide). It uses `host.run` of the test command you
set, `useTileState` to keep the last results with the tile, and `hm.commands.spawnAgent` with the
permissions above. Reading the reporters is in `lib.js`, tested on their real output.
