---
title: Agents
description: Install agents from HiveHub, what each one can do, and putting them to sleep.
---

## No agent ships in the app

The app has no agent built in. Every agent is one manifest file published on
[HiveHub](https://hivehub.griiken.workers.dev): its name, its command, its icon, how to read
its screen, and what it can do. The desktop app, the `hive` CLI and the control plane read the
same manifests (`docs/design/agent-providers.md`). What an agent cannot do is declared, so a
request it cannot serve is refused at once with an exit code instead of timing out.

## Install an agent

**Automatically.** Soon after the app starts, it asks HiveHub for its list of agents and adds
each one whose command is on your `PATH`, without asking. A notice names what it added and what
each can do, with a **Remove** button. This needs the network, and it does not run while the
update check is off. To stop it, switch off **Add agents found on this machine** at the foot of
the Agents group in **Settings ▸ Plugins**. An agent you remove is not added again.

**From the app.** Open **Settings ▸ Plugins**, choose **HiveHub**, find the agent and press
**Install**. The app shows what the agent can do before it writes anything.

**From a terminal.** Name the agent as HiveHub lists it. The first run prints what the agent
runs and what it can do, and installs nothing. Run it again with `--yes` to install:

```bash
hive agents install codex          # shows what codex would run
hive agents install codex --yes    # installs it
hive agents list --found           # the agents whose command is on this machine
hive agents remove codex           # removes it; it is not added again at start
```

`hive agents install` also takes a folder holding `agent.yaml`, or `owner/repo[/dir]` on
GitHub. To write your own, see [Add your own agent](../agent-providers/).

HiveHub lists 21 agents today: aider, amp, antigravity, auggie, claude, cline, codex,
continue, copilot, crush, cursor, droid, grok, hermes, kimi, kiro, mistral-vibe, opencode,
openhands, pi and qwen-code. Listing a new one is a pull request to
[dip497/hivemind-plugins](https://github.com/dip497/hivemind-plugins).

## Agents that can work for other agents

An agent can be a worker, one whose reply `hive ctl read` and `hive ctl workflow` can collect,
only if its manifest reports when a turn ends. These do:

| | Prompt delivery | Turn signal | Resume | Supervision | Model / mode |
|---|---|---|---|---|---|
| **claude** | argv | yes | its own session | passed to the supervisor | yes / yes |
| **codex** | typed | yes | newest in the folder | stays with you | yes / yes |
| **droid** | typed | yes | newest in the folder | stays with you | no / yes |
| **hermes** | typed | yes | none | stays with you | no / no |
| **kiro** | typed | yes | its own session | passed to the supervisor | no / yes |
| **opencode** | typed | yes | none | stays with you | yes / yes |
| **pi** | argv | yes | newest in the folder | none (no permission system) | yes / no |

- **argv** agents get the task as a trailing argument. **typed** agents get it typed into
  their screen once it reads idle, so delivery depends on idle detection.
- **Resume** applies after the terminal daemon restarts or the computer reboots.
- **Supervision** is what `hive ctl spawn --supervise` does. claude and kiro pass their
  permission prompts to the supervising agent. pi has no permission system, so a supervise
  request for it is refused at spawn. For the others the request is accepted and the prompts
  stay with you.

codex starts with `--ask-for-approval on-request --sandbox workspace-write` unless you choose
other values.

Every other agent on HiveHub starts the same way once its command is found, but you drive it by
hand: its manifest declares no turn signal, so its replies cannot be collected and workflows
refuse it up front.

cursor is recognised by its agent command, `cursor-agent`; a bare `cursor` is the editor. kiro
is recognised by `kiro-cli`; a bare `kiro` is the IDE.

## Turn one off

Open the agent in **Settings ▸ Plugins** and use its switch, or:

```bash
hive plugins disable agent:codex
hive plugins enable agent:codex
```

An agent that is off leaves every picker and `hive ctl spawn`. One that is running keeps running
until you close it. The agent's page also has **Make default**: the default is what ⌘\ and the
toolbar's agent button start.

## Live status

A tile shows **working**, **idle** or **blocked** (needs you). The status comes from the agent's
hooks once they report, and from its screen until then, or when it has no hooks. claude's
manifest also tells a permission prompt from a question. The status feeds the frame header,
the Layers panel and views.

```bash
hive agent detect   # looks on PATH for the agents' commands and records them in config.yaml
```

## Sleep and resume

Putting an agent to sleep ends its process and frees its memory. Its tile keeps its name and
shows the terminal's background with a **Resume** button. Resuming starts the agent again in the
same conversation, on this computer, an ssh machine or another of your devices.

In the app:

- a tile's title bar has a moon button that puts that agent to sleep;
- a tile's menu in the Layers panel has **Put to sleep** and **Resume** (a sleeping agent's row
  shows a moon);
- a frame's menu has **Put agents to sleep** and **Resume sleeping agents**;
- the Layers panel's own menu has **Put agents to sleep**, for every agent.

An agent that is working or waiting on you is only put to sleep after you confirm.

From a terminal, name a tile or a frame, or nothing for every agent in the workspace:

```bash
hive ctl sleep                     # every agent not working or waiting on you
hive ctl sleep "claude #2"         # one tile
hive ctl sleep payments --force    # a frame, busy agents too
hive ctl wake payments
```

Without `--force`, a busy agent stays awake. `--json` lists what slept or woke and what was
skipped and why; the exit code is 7 when nothing was done. A message sent to a sleeping agent
waits until it is at its prompt again. `hive ctl read` of a sleeping agent answers at once with
`finalStatus: "asleep"` and exit code 7.

## Assignees

An issue can be assigned to an agent:

```bash
hive update MYP-1 --assignee claude --assignee-type agent
hive new "Fix the login test" --assignee pi
```

`.hivemind/.agent.md` is rewritten on every change, so a new agent session can read one file
for the state of the board (`hive agent context` rewrites it on demand). `HIVE_AGENT_ID` signs
`hive ctl` activity rows inside spawned tiles.

## Refusals

`hive ctl spawn --agent <id>` checks the id against the installed agents: an unknown or switched
off id exits 2 and lists the valid ones; with no agent installed, it says how to install one.
A worker operation on an agent without a turn signal exits 7 (`UNSUPPORTED`) before anything is
spawned, and lists the agents that can do it. `--model` and `--mode` apply only where the
agent's manifest declares them.
