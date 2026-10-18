---
title: Tokens and roles
description: Make a token for a program, choose its role, and revoke it.
---

A token lets one program drive the workspaces you name, at one role.

## Make a token

**In the app**: open the workspace, then **Settings → API access**. Under **New token**, name what
uses it (*my dashboard*), pick what it may do, press **Create token**, and **Copy** it. It is shown
this once.

**In a terminal**:

```bash
hive grant create dashboard -w ~/work/api --role view --expires 30d
```

```text
hgr_…                                   ← the token, shown once
dashboard may view in api, until 2026-11-17T09:00:00Z (`hive grant revoke 1a2b3c4d5e6f`).
It connects to ~/.config/hivemind/drive.sock and says {"hello": {"token": "<this token>", "workspace": "<the folder>"}}.
```

| Option | Means |
|---|---|
| `<name>` | what the program is called; shown in the token list and the audit log |
| `-w`, `--workspace` | a workspace it may drive: its folder, name or id. Repeat for more. The workspace must be open in the app or served by `hive host`. |
| `--role` | `view`, `edit`, `terminals` or `agents` (the default) |
| `--expires` | how long it lasts: `12h`, `30d`. Without it, until you revoke it. |
| `--json` | prints `{grant, token, socket}` |

Tokens made in Settings reach the workspace in that window and never expire.

## Roles

Each role can do everything the roles above it can.

| Role | Settings calls it | The program can |
|---|---|---|
| `view` | **View** | list agents and their status, read replies and output, read files, diffs, issues and review comments, watch terminals, hear events |
| `edit` | **Edit** | also press widgets, open a tool's tile, and hand over a git branch of its own |
| `terminals` | **Use terminals** | also type into terminals and resize them |
| `agents` | **Drive agents** | also start, answer, message, interrupt, rename, put to sleep, wake and close agents; open and close frames and terminals; pipe one agent's replies into another |

Pick the smallest role that does the job: a dashboard needs `view`, an orchestrator `agents`. A
call the role does not allow is answered `FORBIDDEN` and never runs. The full list per role is on
[Methods](../api-methods/).

## See your tokens

**Settings → API access** lists each token with its role, its workspaces, its expiry and when it
was last used. Or:

```bash
hive grant list
```

```text
1a2b3c4d5e6f  dashboard  view  /home/you/work/api  expires 2026-11-17T09:00:00Z  last used never
```

## Revoke and expiry

**Revoke** in Settings → API access, or:

```bash
hive grant revoke 1a2b3c4d5e6f      # the id hive grant list shows
```

Revoking closes the program's connections at once. A token that expires closes them at that
moment. Hivemind keeps only a hash of each token, so a lost token cannot be shown again: make a new
one.
