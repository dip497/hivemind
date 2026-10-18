---
title: Methods by role
description: Every method a program's token can call, grouped by the smallest role that allows it.
---

A token's role allows its own methods and those of every role above it in this page. `repo` is
the workspace's folder; `tile` is a tile's id from `agent.list` or `agent.start`. Full parameters
and results are in `spec/workspace-api.md`.

## view

**Agents**

| Method | Params | Returns |
|---|---|---|
| `agent.list` | `repo` | `{seq, agents}`: every agent now, with its state and what it waits on |
| `agent.since` | `repo`, `seq` | the changes and events after `seq` (null: list again) |
| `agent.read` | `tile`, `timeoutMs`? | its reply when the turn ends: `{text, finalStatus, truncated}` |
| `agent.output` | `tile`, `lines`? | the last lines it printed (40 by default), as plain text |
| `agent.diff` | `tile` | `{files, patch, truncated}`: what it changed since its last commit |
| `agent.sessions` | `place`, `program`, `limit`? | past sessions of that agent in a folder, to resume |
| `agent.startable` | `repo` | the agents that can be started, their models and modes, and the frames |
| `agent.conversation` | `tile`, `cursor`? | what the agent and you said, read from its session file |
| `agent.tool` | `tile`, `use` | one tool use from that conversation, in full |
| `status.all` | | every agent's status |
| `link.list` | | which agent pipes into which, and which started which |

**Files, git, issues**

| Method | Params | Returns |
|---|---|---|
| `git.status` | `repo` | branch, ahead/behind, changed files |
| `git.diff` | `repo`, `scope`, `file`? | `{patch}` |
| `git.listFiles`, `git.listBranches`, `git.fileContents` | `repo`, … | files, branches, a file at `HEAD`, `INDEX` or `WORKING` |
| `worktree.list` | `repo` | the repository's worktrees |
| `file.read` | `repo`, `file` | a file's text (path inside the workspace) |
| `issue.list`, `issue.read` | `root`, `id`? | issues (`root` is the workspace's `.hivemind` folder) |
| `review.list` | `repo` | comments left on diffs |

**Board, widgets, terminals, views**

| Method | Returns or does |
|---|---|
| `store.open`, `store.core`, `store.view`, `store.objects`, `store.objectsWithIds` | the board's layout and objects |
| `widget.all`, `widget.packages`, `widget.asset` | what widgets draw, which are installed, their images |
| `terminal.open` with `attachOnly` | watch a running terminal; output arrives as `terminal.data` |
| `terminal.show`, `terminal.history`, `terminal.flow`, `terminal.ack`, `terminal.detach`, `terminal.watchActivity`, `terminal.saved` | follow terminals; `terminal.saved` is what a sleeping agent last showed |
| `presence.set` | where your pointer is, for others in the workspace |
| `appearance.get` | the host's theme |
| `view.list`, `view.file`, `view.open`, `view.post`, `view.screen`, `view.close` | open an installed phone-ready view |

## edit

| Method | Params | Does |
|---|---|---|
| `widget.press` | `repo`, `id`, `{action}` or `{click: true}` | press a widget's button or card |
| `tool.open` | `repo`, `{tool, frame?, url?}` | place a tool's tile, `{tile}` |
| `git.handOff` | `repo`, `branch`, `bundle` | hand over a branch of your own; it lands as `handoff/<name>/<branch>` |

## terminals

| Method | Params | Does |
|---|---|---|
| `terminal.write` | `tile`, `data` | type into a terminal, while you hold its keyboard |
| `terminal.resize`, `terminal.fit` | `tile`, `cols`, `rows` | size it |
| `terminal.keyboard.ask`, `terminal.keyboard.give` | `tile`, … | ask for its keyboard, hand it on |

## agents

| Method | Params | Does |
|---|---|---|
| `agent.start` | `repo`, `{program, frame?, prompt?, model?, mode?, name?, resume?, supervise?, report?}` | start an agent, `{tile}`; with `supervise`, its permission prompts come to you |
| `agent.send` | `tile`, `text` | a message, typed in as its next prompt |
| `agent.answer` | `tile`, `since`, `{text}` or `{decision, feedback?, always?}` | answer what it waits on: a question, a permission, a plan |
| `agent.interrupt` | `tile` | stop its turn |
| `agent.keys` | `tile`, `keys` | type keys (`Enter`, `Escape`, `Up`, `C-c`, …) |
| `agent.rename` | `tile`, `name` | rename it (empty: back to its own name) |
| `agent.sleep`, `agent.wake` | `repo`, `target`?, `force`? | put to sleep or wake a tile, a frame, or every agent |
| `agent.close` | `tile` | end it and take its tile off the board |
| `agent.places`, `agent.folders` | `repo`, `folder`? | where in the workspace an agent may be started |
| `frame.open` | `repo`, `{path}` or `{worktree: {branch, base?}}` | a frame on a folder or a new worktree of the workspace |
| `frame.close` | `repo`, `frame`, `{closeTiles?, removeWorktree?, force?}`? | close a frame |
| `terminal.open`, `terminal.close` | | start or end a terminal |
| `link.connect`, `link.disconnect` | `src`, `dst`? | pipe one agent's replies into another as prompts |

## No role

No token can call the methods that commit, push, pull, stage or discard; write files; create or
change issues and review comments; create or remove worktrees; let people in or change their
roles; or make or revoke tokens.

That does not keep a program away from your files: with `terminals` it types into a shell, and
with `agents` it starts agents, and either can run any command there.
