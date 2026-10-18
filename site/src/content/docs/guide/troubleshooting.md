---
title: Troubleshooting
description: Common problems and their fixes.
---

Start with the exit code of the `hive` command that failed: the table is in the
[CLI reference](../cli/#exit-codes).

## Agents and the app

| Problem | Fix |
|---|---|
| Exit 3 from `hive ctl` | Neither the app nor `hive host` is running. Start it: `hivemind .`. Issue commands work without it. |
| No agent to start | Install the agent's CLI and restart Hivemind, or `hive agents install <name>`. `hive agents list --found` shows what it sees. |
| An agent is missing from the menus | It is switched off, or failed to load: its page in Settings ▸ Plugins says why. |
| Agent tile is black with **Resume** | It is asleep. Press **Resume** or `hive ctl wake <tile>`. |
| Terminal empty after a reboot | That agent cannot resume; it starts fresh. Others continue their conversation. |
| `hive ctl read` exits 4 | The turn had not ended. Call `read` again. |
| `hive ctl read` exits 5 | The tile was closed while you waited. |
| Workflow refused with exit 7 | That agent does not report turn ends: pick one from [Run agents](../agents/#agents-that-can-work-for-other-agents). |
| Agent cannot browse | Switch on the Browser tool and **Agent browser control** on its page, restart, open a Browser tile. |
| A view is missing | Its page in Settings ▸ Plugins says why; `hive views list` shows load errors. |
| Browser page reloaded after switching views | Expected: tabs and history stay, scroll position does not. |

## Machines

| Problem | Fix |
|---|---|
| Terminals there end when the link drops | The machine has no `hive`: **Manage machines → Install hive**. |
| Machine shows **Sign in**, or will not connect | Press **Sign in**, or run `ssh user@host` once to accept its host key. `hive machine check <name>` shows what it finds. |

## Issues

| Problem | Fix |
|---|---|
| `no .hivemind/ found` | `hive init --prefix XX` in the project. |
| `.hivemind/ already exists` | Use it; bare `hive init` refreshes the agent skills. |
| Prefix rejected | 2 to 10 capital letters or digits, starting with a letter (`MYP`). |
| `move` refused | The issue has sub-issues: move them first (`hive link <child> --parent none`) or use `--copy`. |
| Another project's id not found | `hive workspace register` in both, then check `hive workspace list`. |

## API

| Problem | Fix |
|---|---|
| `FORBIDDEN` on hello | The token is wrong, revoked or expired, or does not reach that workspace. |
| `BAD_REQUEST` on hello | Name the workspace's folder, and open it in the app first. |
| `FORBIDDEN` on a call | The token's role does not allow it: see [Methods by role](../api-methods/). |

## Upgrades

```bash
hive upgrade          # run the installer again (nothing to do when current)
hive add skill        # then refresh the agent skills in each project
```
