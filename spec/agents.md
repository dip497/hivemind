# Agents (0.9)

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
follow is the person's own devices, a phone among them; anyone else is cut off.

Each agent is one with a status (`status.md`) whose tile is on the board of a workspace the device
holds:

```json
{ "workspace": "<the workspace's id>", "name": "<the workspace's name>", "tile": "<its tile>",
  "agent": "<what it is called>", "program": { "id": "claude", "label": "Claude Code" },
  "state": "waiting", "since": 1790000000000, "machine": "<the machine it runs on>",
  "waiting": { "kind": "permission", "says": "trust", "since": 1790000000000, "plan": "<markdown>", "decide": true },
  "interrupt": true, "conversation": true, "session": "<its session's id>" }
```

A supervised agent's wait on its starter (0.5, `"kind": "approval"`) also says what it asks, and the
item who started it:

```json
{ "parent": "client:<grant id>",
  "waiting": { "kind": "approval", "since": 1790000000000,
               "approval": { "request": "<its id>", "tool": "Bash", "summary": "rm -rf dist",
                             "expiresAt": 1790000540000 } } }
```

- `agent` and `machine` are as `needs.md` gives them (0.3).
- `program` is the agent its tile runs, by its manifest's id and label; left out for a tile whose
  command no manifest here names.
- `state` is its status's state, `since` when it last changed.
- `waiting` is there while it waits with a kind: `kind` (`permission`, `question`, `plan`, `other`,
  or `approval`, on the agent supervising it), `since` the same as the state's, and `says` (0.5),
  `plan`, `decide`, and `tool`, `asks` and `choose` (0.7) as `needs.md` gives them for a wait on the
  person.
- `approval` (0.5) is there on an `approval` wait: the `tool` it would use, a `summary` of what it
  would do with it (a command, a file, a URL), and `expiresAt`, when it stops waiting and the agent
  asks at its own prompt instead.
- `parent` (0.5) is who started it and hears what it reports: an agent's tile, or
  `client:<grant id>` for a program on the drive socket (`workspace-api.md`, "Drive socket").
- `interrupt` is `true` when its manifest says which keys interrupt its turn (`interrupt`), so
  `agent.interrupt` stops it; left out otherwise.
- `conversation` is `true` when its manifest maps its session file's records (`session.transcript`)
  and says where that file is (`session.resume.exists`), so `agent.conversation` can say what it and
  the person said to each other ("Conversation"); left out otherwise (0.4). The phone opens an agent
  without one in its terminal.
- `session` (0.6) is the session it is in, as its agent last said: `agent.start`'s `resume` goes on
  with it. A new one (the person cleared it, or resumed another) changes the item, so a reader
  following `agent.changed` hears it. Left out until the agent says, and kept once it exits.

Agents are in order of their workspace's id, then their tile (by its characters' codes).

A phone keeps each device's list as it last answered, and shows them one device after another;
what waits on the person among them (a `waiting` whose kind is not `approval`) it shows as one list,
as `needs.md` orders it, and the agents at work it adds up. An answer with no list of agents says
nothing; a `working` that is not a whole number of none or more counts none. An item it cannot read
is left out: one that is not an object, has a field it must have (`program`, `waiting`,
`interrupt` and `conversation` may be missing) missing or of another type, a `state` not listed
above, or a `waiting` that is no object, has a kind not listed or no `since`. A `program` that is
not an `id` and a `label`, a `decide`, `interrupt`, `conversation` or `choose` that is not `true`,
a `decide` on anything but a permission, a `choose` on anything but a question, and a `waiting`'s
`tool` or `asks` not shaped as `needs.md` gives them, are taken as not there.

## Starting

`agent.startable(workspace)`, a method of the workspace API (`workspace-api.md`), answers what
may be started in the workspace, which a peer names as `hive://<its id>`:

```json
{ "programs": [ { "id": "claude", "label": "Claude Code",
                  "options": [ { "id": "model", "label": "Model", "values": ["opus", "sonnet"] } ] } ],
  "frames": [ { "id": "<frame>", "name": "<its title>", "machine": "<the machine its folder is on>" } ] }
```

`programs` are the agents this device starts (switched on, their command found here); `options`
are their `model` and `mode` choices, as the desktop's settings offer them: those the agent's
command lists (its `--help`, or its listing command), then those its manifest names; `values` empty
for one taken as typed. A command that has not answered within 1.5 s adds its own next time.
`agent.places` lists each machine's agents the same way; a saved machine's command is not asked.
`frames` are the
workspace's frames, as the board orders them.

`agent.start(workspace, start)` starts one there, as `hive ctl spawn` does: `start` is `{ program,
frame?, folder?, images?, prompt?, model?, mode?, name?, resume?, supervise?, report? }`, `program` one `agent.startable` lists, `frame` one of its frames (none: the
workspace's first frame, or none when it has none), `folder` (0.8) one of "Places" below, not with
`frame`, and `program` then one found on its machine, `images` (0.8) at most 4 photos `{ "type":
"image/png" | "image/jpeg" | "image/webp" | "image/gif", "data": "<base64>" }` of at most 5 MB
each, kept on the machine it runs on and their paths put after the prompt, a blank line between,
`prompt` at most 10,000 characters with no
control characters but newlines and tabs, and `model`, `mode`, `name` (its tile's) and `resume` (a session of its to go on with) lines of at
most 200 characters. `supervise` (0.5) is `true` (the tools its manifest says are supervised),
`"all"`, or a list of tool names: before using one it waits on its starter (an `approval` wait),
which answers with `agent.answer`. A program that starts it on the drive socket is its starter, and
is told what it reports (`hive ctl report`): the workspace's readers get an `agent.event` of kind
`reported`, unless `report` is `false`.
It starts as the person launches it at their desktop, with the options they saved for that agent
and these on top: never in its unattended mode unless `mode` says so, or an agent on the drive
socket starts it (`hive ctl spawn`) unsupervised, where no one is at its tile. It answers `{ "tile":
"<the new tile>" }`. Anything else is `BAD_REQUEST`.

## Places

(0.8) `agent.places(workspace)` answers where an agent may be started in the workspace: each
machine its folders are on, this computer first (`id` `""`), then the saved machines by name, with
the agents found there (as `programs` above) and its folders:

```json
{ "machines": [ { "id": "", "name": "<this computer>", "programs": [ … ],
                  "folders": [ { "path": "/home/p/api", "name": "api", "kind": "project", "frame": "<frame>" },
                               { "path": "/home/p/notes", "name": "notes", "kind": "recent" } ] },
                { "id": "<saved machine>", "name": "build-box", "programs": [], "folders": [ … ],
                  "unreached": "<why it could not be asked>" } ] }
```

`project` folders are the workspace's own folder then each frame's, as the board orders them, with
the frame there; `recent` ones the folders the person opened lately, newest first, those that are a
project's left out. A folder is a path here, or `machine://<saved machine>/<path>`; one on a
machine not saved, or on a paired device, is not listed. A machine that could not be asked has
no `programs` and says why in `unreached`.

`agent.folders(workspace, folder)` answers the folders in `folder`, one of the workspace's projects
or inside one, links followed: `{ "path": "<folder>", "folders": [ { "name", "path" } ], "more"?:
true }`, by name, at most 200, those whose name starts with a dot left out, `more` when there are
more. A folder in none of its projects is `FORBIDDEN`; one not there is `NOT_FOUND`.

An agent started in a `folder` runs in the frame there; when there is none, in one opened for it
inside the innermost project it is in, or at the top for a recent folder. A folder that is neither
is `FORBIDDEN`, and nothing is started.

## Stopping

`agent.interrupt(tile)` types the keys the agent's manifest says interrupt its turn (`interrupt`,
tokens as `hive ctl keys` takes them), a moment apart, while it is working or waiting, and answers
`{ "interrupted": true }`; `{ "interrupted": false }` when it is doing neither, or has no terminal.
An agent whose manifest says no keys is `BAD_REQUEST`.

`agent.close(tile)` ends the agent's session and takes its tile off the board, as `hive ctl close`
does, and answers `{ "closed": true }`; `{ "closed": false }` when no workspace here has the tile.

## Sleep

`agent.sleep(repo, target?, force?)` puts agents to sleep, as `hive ctl sleep` does: a tile by its
id or name, else a frame's agents (those of the frames in it too), else every agent of the
workspace. Each one's process ends; its tile keeps its name and its last screen, and the folder it
slept in (`sleeping` in the layout). Left awake, each listed with why: an agent working or waiting on
someone (unless `force`), one whose manifest says no `session.resume` (it would wake blank), a
shell, and a session started elsewhere. Nothing is typed into a sleeping agent: `agent.send` to it
is refused, and what other agents send it waits. `agent.wake(repo, target?)` starts each again in
its conversation, in the folder it slept in; what waited is typed once it says its session started.
Another tile may not start a sleeping agent's conversation, and a sleeper is not woken while
another tile runs it. Both answer `{ "slept" | "woke": [tile], "skipped": [{ "tile", "why" }] }`.

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
yet tracked as a new file (one over 64 KiB, or that is not text, is listed and not shown), cut at
512 KiB at the end of a line, when `truncated` is `true`. A folder that is no git
repository answers no files and an empty patch; one on another machine is `FAILED`, saying so.

## Conversation

`agent.conversation(tile, cursor?, session?)` (0.2; `session` 0.3) answers what the agent of `tile`
and the person said to each other, as the agent keeps it in its session file (its manifest's
`session.transcript` maps the file's records), and then sends the caller what is said next, as it
is written, until the call's connection goes:

```json
{ "entries": [ … ], "cursor": 52311, "session": "<the session's id>" }
```

with the event `agent.said` (`[tile, entries, cursor, session]`) for each later piece, never
before the answer. Each entry is one of

```json
{ "id": "<its id>", "at": 1790000000000, "who": "person", "text": "<what they asked>" }
{ "id": "<its id>", "at": 1790000000000, "who": "agent", "text": "<what it said, in markdown>" }
{ "id": "<its id>", "at": 1790000000000, "who": "agent", "tool": { "id": "<the use>", "name": "Edit", "about": "src/nav.ts" } }
{ "id": "<its id>", "at": 1790000000000, "who": "agent", "tool": { "id": "<the use>", "name": "AskUserQuestion", "asks": [{ "question": "Which color?", "options": ["Red", "Blue"] }] } }
{ "id": "<its id>", "at": 1790000000000, "who": "tool", "result": { "of": "<the use>", "text": "<what it gave back>", "error": true } }
```

- The device reads them from the file as the agent's manifest maps its records
  (`session.transcript`: which records say what, and in which fields; the agent providers guide
  has the rules). It knows no agent's format of its own. `id` is the record's, with `/` and the
  item's index after it for one read from a list of several items; `at` its time, in ms since the
  epoch; a tool's `about` at most 120 characters, its first line; a tool's `asks` (0.7) the
  questions it asks the person, as `needs.md` gives them; what a tool gave back cut to
  2,000 characters, `error` only when true (left out otherwise). A line that is not a record, and
  a record or item no rule reads, say nothing.
- `cursor` is how far into the file the entries go (in bytes, at the end of a line), and `session`
  the session whose file it is: given back, they answer only what comes after the cursor, as after
  a reconnect. Without them, or for a session the agent keeps no more, it answers the last 200
  entries of the last 1 MiB of its file now.
- The session is the one last recorded for the agent's tile (by its tracker, or as it was started),
  else the one its manifest would resume. When the agent begins another while it is followed (as
  Claude Code's `/clear` does), and that session's file is there, the device follows that one
  instead: the next `agent.said` names it, with the last of it, as answered without a cursor, and
  cursors into its file. Whoever follows shows a conversation begun anew.
- An agent with no session file found, or whose manifest maps no transcript, answers no entries
  and cursor 0, no session, and nothing more.

(0.9) `agent.tool(tile, use)` answers one tool use of the agent's session now, unfolded, as the
person opens its row:

```json
{ "name": "Bash", "about": "<what it is about, whole>", "input": "<its input>",
  "result": { "text": "<what it gave back, whole>", "error": true }, "truncated": true }
```

read from the records of its session file that name `use`, wherever they are in it, as its
manifest maps them, `input` as the field the manifest's `tool.input` names (text as it is, else
JSON, two spaces a level); `about`, `input` and `result` each left out when there is none (no
`result`: nothing given back yet), each cut to 262,144 characters, `truncated` then (left out
otherwise). A use the session does not name, or an agent that keeps no conversation, is
`NOT_FOUND`. The cases in `../conformance/conversation.json` (`unfolded`) decide it.

## Who may

`agent.startable`, `agent.diff`, `agent.conversation` and `agent.tool` may be called by who may view the
workspace; `agent.places` and `agent.folders` (0.8), which name the person's folders, and `agent.start`,
`agent.interrupt` and `agent.close` by who may drive its agents (role `agents`); all of them by the
person's own devices, a phone among them. Each of the last three is recorded in the device's audit
log against its tile, as the device that called it.
