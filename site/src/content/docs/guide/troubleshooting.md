---
title: Troubleshooting
description: Diagnose common errors.
---

## Start with the exit code

`hive ctl` failures carry structured codes (full table in [CLI](../cli/)): 2 usage,
3 neither the app nor `hive host` running, 4 timeout, 5 not found, 6 unauthorized, 7 refused or
unsupported (also: the agent is asleep, or `sleep`/`wake` did nothing), 8 the agent stopped to wait
on an answer.

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

- **Exit 3 on canvas verbs** — neither the app nor `hive host` is running: `hivemind .`. Issue
  verbs work without it; `spawn`, `read` and `agents` do not.
- **No agent to start** — no agent ships in the app. Install the agent's CLI, then restart
  Hivemind (it adds agents from HiveHub whose CLI it finds), or add one in Settings ▸ Plugins or
  with `hive agents install <name>`. `hive agents list --found` shows what is installed and
  whose CLI is on your `PATH`. See [Agents](../agents/).
- **Terminal empty after reboot** — an agent whose manifest has no resume starts fresh; the
  others continue their conversation. Screen content replays from disk after a daemon restart
  either way.
- **Agent tile is black with Resume** — it is asleep (`hive ctl sleep`, or **Put to sleep**).
  Press **Resume** or run `hive ctl wake <tile>`. `hive ctl read` on it exits 7 at once.
- **Remote terminals ended** — the machine has no `hive`, so its terminals are plain ssh and
  end with the connection. **Manage machines → Install hive** puts them in that machine's own
  daemon, where they survive drops and app restarts. See [Machines](../machines/).
- **Machine shows Sign in, or will not connect** — press **Sign in** to give it a password, or
  run `ssh user@host` once in a terminal to accept its host key or fix the login; Hivemind does
  not ask about host keys. `hive machine check
  <machine>` shows what it finds.
- **Browser page reloaded after a view switch** — known `<webview>` limit; tabs and
  history survive, scroll/form state does not.
- **Agent cannot browse** — switch on the Browser tool and its **Agent browser control** in
  Settings ▸ Plugins ▸ Browser, open a Browser tile, retry; the `hive-browser` skill reports what
  is missing.
- **View missing or disabled** — its page in Settings ▸ Plugins says why it cannot load (the
  Views list there shows it under **Off**); `hive views list` shows package errors.

## Timeouts

- `hive ctl read` waits 100 s by default (`--timeout 5m` to change it), in short polls; keep the
  total under your tool's timeout. Exit 4 means the turn had not finished — call
  again to collect it. Exit 5 with `finalStatus: "closed"` means the tile was closed
  while you waited; there is nothing left to read.
- `hive ctl workflow --timeout` is per worker (default `10m`; durations take units — `90s`, `10m`); give the calling
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

- Playwright/e2e: `unset ELECTRON_RUN_AS_NODE`, run under xvfb; the config isolates the
  profile.
- `HIVEMIND_SHELL_ENV=0` makes tiles inherit the app environment verbatim.
