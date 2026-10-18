---
title: API overview
description: Let a program of your own drive a workspace (start agents, read replies, follow status) with a scoped token.
---

The API lets a program on your computer drive a workspace the way you do: an orchestrator that
hands work to agents, a dashboard that shows who is waiting, a script your CI calls. You give the
program a **token**; the token reaches only the workspaces you pick, and only at the **role** you
pick.

<figure class="diagram" style="--min:600px">
  <div><img src="../../diagrams/api-drive.svg" width="800" height="260" alt="Your program connects to the drive socket on this computer and says hello with its token. Each call is checked against the role the token was made with: an allowed call reaches the workspace, its agents, terminals and board; any other call is refused with FORBIDDEN." /></div>
  <figcaption>Every call is checked against the token's role</figcaption>
</figure>

## How it works

| Piece | What it is |
|---|---|
| **Drive socket** | `drive.sock` in the app's data folder (a named pipe on Windows). The app or `hive host` serves it, whichever runs. Only your user can open it. |
| **Token** | Made in **Settings → API access** or with `hive grant create`. Shown once. |
| **Role** | `view`, `edit`, `terminals` or `agents`: the same roles people get in a [shared workspace](../multiplayer/#roles). |
| **Messages** | One line of JSON per message, both ways: your calls, the answers, and events about the workspace. |

## In four steps

1. [Make a token](../api-tokens/) for one workspace, at the smallest role that does the job.
2. [Connect and say hello](../api-connect/) with it.
3. Call [methods](../api-methods/) such as `agent.list`, `agent.start` and `agent.read`.
4. [Revoke](../api-tokens/#revoke-and-expiry) the token when the program is done; its connections close at once.

## What a token can never do

Whatever its role, a program cannot share the workspace, let people in or change their roles, or
make or revoke tokens. Those stay yours, at your own window or terminal.

The `terminals` and `agents` roles can still change files and run any command, `git push`
included: through a shell they type into, or an agent they start.

## Without writing a client

`hive ctl` speaks the same API. Give it the token and it acts as the program:

```bash
export HIVE_DRIVE_TOKEN=hgr_…
# only when the token reaches several workspaces:
export HIVE_WORKSPACE=~/work/api
hive ctl agents --json
# needs the agents role:
hive ctl spawn --agent claude --prompt "Run the tests"
```

A [tool plugin's service](../tool-plugins/#a-service-that-keeps-running) gets its own token this
way, made when it starts and revoked when it stops.

The full protocol is `spec/workspace-api.md` in the repository.
