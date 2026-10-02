# Agents (0.1)

The person's agents, as their phone sees and drives them (M5, `docs/design/phone-app-2026-10-02.md`
§4): every agent in the workspaces one of their devices holds, live; and starting one, stopping
its turn, closing it, and what it changed. What waits on the person, and answering it, is
`needs.md`'s. The cases in `../conformance/agents.json` decide whether an implementation follows
this.

## Following

One of the person's devices opens the stream `agents` on a connection on `hive/ws/1` to another of
their devices, and sends `{ "t": "follow" }` on it. The device answers at once with the agents in
the workspaces it holds,

```json
{ "t": "agents", "agents": [ … ], "working": 3 }
```

and answers again, with the whole list, each time it would answer otherwise, until the stream or
the connection closes: the first change at once, and the changes in the next 100 ms together at
its end, so at most ten answers a second, none the same as the one before it. `working` is how
many of them are at work (`needs.md` 0.2). Anything else sent on the stream is ignored. Who may
follow is the person's own devices, a phone among them; anyone else's stream is closed.

Each agent is one with a status (`status.md`) whose tile is on the board of a workspace the device
holds:

```json
{ "workspace": "<the workspace's id>", "name": "<the workspace's name>", "tile": "<its tile>",
  "agent": "<what it is called>", "program": { "id": "claude", "label": "Claude Code" },
  "state": "waiting", "since": 1790000000000, "machine": "<the machine it runs on>",
  "waiting": { "kind": "permission", "since": 1790000000000, "plan": "<markdown>", "decide": true },
  "interrupt": true }
```

- `agent` and `machine` are as `needs.md` gives them (0.3).
- `program` is the agent its tile runs, by its manifest's id and label; left out for a tile whose
  command no manifest here names.
- `state` is its status's state, `since` when it last changed.
- `waiting` is there while it waits with a kind: `kind` (`permission`, `question`, `plan`, `other`,
  or `approval`, on the agent supervising it), `since` the same as the state's, and `plan` and
  `decide` as `needs.md` gives them for a wait on the person.
- `interrupt` is `true` when its manifest says which keys interrupt its turn (`interrupt`), so
  `agent.interrupt` stops it; left out otherwise.

Agents are in order of their workspace's id, then their tile (by its characters' codes).

A phone keeps each device's list as it last answered, and shows them one device after another;
what waits on the person among them (a `waiting` whose kind is not `approval`) it shows as one list,
as `needs.md` orders it, and the agents at work it adds up. An answer with no list of agents says
nothing; a `working` that is not a whole number of none or more counts none. An item it cannot read
is left out: one that is not an object, has a field it must have (`program`, `waiting` and
`interrupt` may be missing) missing or of another type, a `state` not listed above, or a `waiting`
that is no object, has a kind not listed or no `since`. A `program` that is not an `id` and a
`label`, and a `decide` or `interrupt` that is not `true`, are taken as not there.

## Starting

`agent.startable()`, a method of the workspace API (`workspace-api.md`), answers what may be
started in the workspace:

```json
{ "programs": [ { "id": "claude", "label": "Claude Code",
                  "options": [ { "id": "model", "label": "Model", "values": ["opus", "sonnet"] } ] } ],
  "frames": [ { "id": "<frame>", "name": "<its title>", "machine": "<the machine its folder is on>" } ] }
```

`programs` are the agents this device starts (switched on, their command found here); `options`
are their `model` and `mode` choices, `values` empty for one taken as typed. `frames` are the
workspace's frames, as the board orders them.

`agent.start(start)` starts one, as `hive ctl spawn` does: `start` is `{ program, frame?, prompt?,
model?, mode? }`, `program` one `agent.startable` lists, `frame` one of its frames (none: the
workspace's first frame, or none when it has none), `prompt` at most 10,000 characters with no
control characters but newlines and tabs, and `model` and `mode` lines of at most 200 characters.
It starts as the person launches it at their desktop, with the options they saved for that agent
and these on top: never in its unattended mode unless `mode` says so. It answers `{ "tile":
"<the new tile>" }`. Anything else is `BAD_REQUEST`.

## Stopping

`agent.interrupt(tile)` types the keys the agent's manifest says interrupt its turn (`interrupt`,
tokens as `hive ctl keys` takes them), a moment apart, while it is working or waiting, and answers
`{ "interrupted": true }`; `{ "interrupted": false }` when it is doing neither, or has no terminal.
An agent whose manifest says no keys is `BAD_REQUEST`.

`agent.close(tile)` ends the agent's session and takes its tile off the board, as `hive ctl close`
does, and answers `{ "closed": true }`; `{ "closed": false }` when no workspace here has the tile.

## Changes

`agent.diff(tile)` answers what the agent changed, in the folder it runs in (its frame's worktree's,
else its frame's, else the workspace's), against its last commit:

```json
{ "files": [ { "path": "src/nav.ts", "status": "M", "added": 3, "removed": 1 } ],
  "patch": "<a unified diff>", "truncated": false }
```

`files` are the changed files, by path: `status` is `M` (modified), `A` (added), `D` (deleted),
`R` (renamed), `C` (copied), `U` (conflicted) or `?` (not yet tracked), and `added` and `removed`
the lines the patch adds and removes in it. `patch` is `git diff HEAD`, followed by each file not
yet tracked as a new file, cut at 512 KiB, when `truncated` is `true`. A folder that is no git
repository answers no files and an empty patch; one on another machine is `UNSUPPORTED`.

## Who may

`agent.startable` and `agent.diff` may be called by who may view the workspace; `agent.start`,
`agent.interrupt` and `agent.close` by who may drive its agents (role `agents`); all of them by the
person's own devices, a phone among them. Each of the last three is recorded in the device's audit
log against its tile, as the device that called it.
