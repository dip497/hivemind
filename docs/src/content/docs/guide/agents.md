---
title: Agents
description: Supported agents and their capabilities.
---

## The catalog

Every runtime is one entry in `packages/hive-agents` — identity, icon, screen status
detector, and a typed capability set — read by the desktop UI, the `hive` CLI, and the
control plane (`docs/design/agent-providers.md`). A runtime's limits are declared, so
unsupported requests are refused up front with an exit code instead of timing out.

## Spawnable runtimes

| | Prompt delivery | Turn signal | Resume | Supervision | Model / modes |
|---|---|---|---|---|---|
| **claude** | argv | yes | own session id | brokered to supervisor | yes / yes |
| **codex** | typed | no | newest for cwd | stays with human | no / no |
| **opencode** | typed | no | none | stays with human | no / no |
| **droid** | typed | yes | newest for cwd | stays with human | no / no |
| **pi** | argv | yes | newest for cwd | none (no permission system) | no / no |
| **kiro** | typed | yes | own session id | brokered to supervisor | no / no |

- **argv** runtimes get the task as a trailing argument; **typed** runtimes get it keyed
  into their TUI once the screen reads idle, so delivery depends on idle detection.
- **Turn signal** is required to be an HCP worker: `hive ctl read` and
  `hive ctl workflow` gather replies only from these runtimes. Others are driven by hand.
- **Resume** applies after a daemon restart or reboot.
- **Supervision**: only claude and kiro support permission brokering; pi is refused at
  spawn; codex/droid/opencode accept a supervise request but prompts stay with the human.

codex spawns with `--sandbox workspace-write --ask-for-approval on-request`.

## Recognised for status only

gemini, cursor, antigravity, cline, copilot, kimi, amp, grok, hermes, openclaw — hivemind
scrapes their screen for status when you run them yourself; they are not offered for
spawning.

cursor is recognised by its agent binary, `cursor-agent` — a bare `cursor` is the Cursor
editor, not the agent. A cursor tile you start yourself resumes its last chat for that
folder after a restart.

## Add your own, or turn one off

Any agent can be switched off in **Settings ▸ Agents**, including these built-in ones.
To add an agent that is not listed here, describe it in one file — see
[Add your own agent](../agent-providers/).

## Live status

Tiles show **working**, **idle**, or **blocked** (needs you), detected from the rendered
screen; claude alone distinguishes permission prompts from questions. Status feeds the
frame header, Layers rail, and view tiles. Probe your machine with:

```bash
hive agent detect   # probes PATH for catalogued CLIs, records in config.yaml
```

## Assignees

Issues can be assigned to an agent:

```bash
hive update MYP-1 --assignee claude --assignee-type agent
hive new "…" --assignee pi
```

`.hivemind/.agent.md` is regenerated on writes so a new agent session can read one file
for board state. `HIVE_AGENT_ID` signs `hive ctl` activity rows inside spawned tiles.

## Refusal behaviour

`hive ctl spawn --agent <id>` validates against the spawnable list (unknown → exit 2
with the valid ids). Worker operations without a turn signal exit 7 `UNSUPPORTED`
before spawning, listing capable runtimes. `--model` and `--mode` apply only where the
provider declares them.
