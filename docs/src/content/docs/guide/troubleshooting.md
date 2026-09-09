---
title: Troubleshooting
description: Diagnose common errors.
---

## Start with the exit code

`hive ctl` failures carry structured codes (full table in [CLI](../cli/)): 2 usage,
3 app not running, 4 timeout, 5 not found, 6 unauthorized, 7 refused/unsupported.

## Tracker

- **`no .hivemind/ found`** — run `hive init --prefix XX` in the repo (or a parent of
  your cwd owns one; `find .. -name .hivemind` to check).
- **`.hivemind/ already exists`** — init refuses to clobber; use the tracker, or bare
  `hive init` to refresh the agentic stack.
- **Prefix rejected** — must match `^[A-Z][A-Z0-9]{1,9}$` (e.g. `MYP`).
- **`move` refused** — the issue still has sub-issues; re-parent them
  (`hive link <child> --parent none`) or use `--copy`.
- **Cross-repo id unresolved** — register the other workspace
  (`hive workspace register`) and confirm with `hive workspace list`.

## App and canvas

- **Exit 3 on canvas verbs** — the app is not running: `hivemind .`. Issue verbs work
  without it; spawn/read/list do not.
- **Agent not spawnable** — run `hive agent detect` in the workspace; install the CLI if
  missing. Distinguish spawnable runtimes from recognised-for-status ones
  ([Agents](../agents/)).
- **Terminal empty after reboot** — runtimes without resume (opencode) start fresh;
  others resume per their provider. Screen content replays from disk after a daemon
  restart either way.
- **Remote terminals ended** — remote PTYs run in the app process; an SSH drop ends
  them and there is no remote daemon to reattach. Reopen the tile; use a local worktree
  when you need sessions to outlive connections.
- **Browser page reloaded after a view switch** — known `<webview>` limit; tabs and
  history survive, scroll/form state does not.
- **Agent cannot browse** — enable agent browser control in Settings, open a Browser
  tile, retry; the `hive-browser` skill reports what is missing.
- **View missing or disabled** — check Settings → Extensions for runtime load errors and
  `hive views list` for package errors. A plugin that
  violated its budget stays disabled until the app restarts.

## Timeouts

- `hive ctl read` waits 100 s by default in ≤ 10 s slices; keep the total under your
  tool's timeout. Exit 4 means the turn had not finished — call
  again to collect it.
- `hive ctl workflow --timeout` is per worker (default 600 000 ms); give the calling
  tool a timeout longer than the slowest worker.
- `hive ctl open-review --timeout` defaults to a 24 h ceiling; set an explicit value
  when calling from an agent.

## Upgrades

```bash
hive upgrade          # re-run the installer (no-op when current)
hive upgrade --dev    # source install: git pull + rebuild
```

After upgrading, refresh workspace skills with `hive add skill`.

## Environment quirks

- Dev-bridge needs tsx (node), not bun — bun drops `@lydell/node-pty` output on Linux.
- Playwright/e2e: `unset ELECTRON_RUN_AS_NODE`, run under xvfb; the config isolates the
  profile.
- `HIVEMIND_SHELL_ENV=0` makes tiles inherit the app environment verbatim.

State is files: `cat` the issue, `hive config get`, `hive views list`. Fixes go through
[Contributing](../contributing/).
