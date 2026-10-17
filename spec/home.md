# Home (0.4)

What the person's phone shows first (`docs/design/phone-browser-2026-10-03.md` §11.2): every
workspace the computer holds, its frames and its tiles, as the desktop's Layers panel lists them,
with what waits on the person on top. The computer owns the rows, their order, the pins and each
tile's last line; the phone groups and draws. Agents and what they wait on are `agents.md`'s and
`needs.md`'s; this says how Home carries them. The cases in `../conformance/home.json` decide
whether an implementation follows this.

## Rows

Each row has a key and is one of three:

```json
{ "of": "workspace", "workspace": "<id>", "name": "api" }
{ "of": "frame", "workspace": "<id>", "id": "f1", "title": "api", "color": "#336699", "order": 0,
  "machine": { "name": "box", "state": "idle" }, "parentId": "f0", "branch": "fix",
  "folder": { "name": "api-fix", "kind": "worktree" }, "project": "web" }
{ "of": "tile", "workspace": "<id>", "id": "t1", "frameId": "f1", "kind": "claude", "name": "Fix login",
  "agent": "claude", "terminal": true, "order": 3, "pinned": true, "parent": "t0",
  "state": "waiting", "since": 1790000000000, "waiting": { … },
  "program": { "id": "claude", "label": "Claude Code" }, "machine": "desk",
  "interrupt": true, "conversation": true }
```

- A workspace is keyed `w:<workspace>`, a frame `f:<workspace>/<frame>`, a tile
  `t:<workspace>/<tile>`.
- A frame is what the view protocol's `structure` says of it (`machine`, `parentId`, `branch`,
  `folder`), with `order`, where the board lists it from 0, and `project`: for a top frame that
  runs in a folder on the computer other than the workspace's own, that folder's name, as the
  Layers panel names the project. Left out for the workspace's own project.
- A tile is its `structure` tile (`frameId`, null in no frame; `kind`; `name`; `agent`, the
  manifest it runs), with `order`, where the Layers panel lists it from 0 (one it does not list
  after those, in the board's order), `pinned` when the person pinned it there, `parent`, the
  tile that started it when that is on the same board, and `terminal` (0.3) when it runs a terminal
  (an agent's or a shell), which the phone may show and type into.
- An agent's tile also carries what `agents.md` says of it: `state`, `since`, `waiting` (with
  `tool`, `asks`, `choose`), `program`, `machine`, `interrupt`, `conversation`.

## Following

One of the person's devices opens the stream `home` on a connection on `hive/ws/1` to the
computer, and sends `{ "t": "follow" }`, or `{ "t": "follow", "layout": 40, "lines": 7 }` with
how far it followed each sequence before. Anything else sent on it is ignored; a second follow on
the same stream too. Who may follow is the person's own devices; anyone else is cut off.

There are two sequences, each numbered from 1 as it changes: `layout`, the rows, and `lines`,
each tile's last line, so a busy terminal never moves the rows'. The computer answers at once:

```json
{ "t": "home", "layout": { "seq": 40, "rows": [["w:<id>", { … }], …] },
  "lines": { "seq": 7, "rows": [["t:<id>/t1", "Run npm test?"], …] } }
```

when the device gave no positions, a position it never gave, or one older than it keeps; else the
changes after them:

```json
{ "t": "changes", "layout": { "seq": 42, "changes": [
    { "seq": 41, "key": "t:<id>/t1", "row": { … } },
    { "seq": 42, "key": "t:<id>/t4", "gone": true } ] },
  "lines": { "seq": 8, "changes": [ … ] } }
```

Then it sends each change as it comes, a `changes` with the sequences that moved, until the
stream or the connection closes: the first at once, those in the next 250 ms together at its end.
A row is sent only when it changed, so one agent's change is one row. The computer keeps the last
2000 changes and 256 KB of their JSON per sequence; a device further behind is sent both whole.

A device applies, in order, each change numbered after its position, and takes its position from
the message's `seq`. A change to a row it cannot read takes the row away, as one that went.
Changes before it holds a whole are no use: ignored. It reads a tile's agent as `agents.md` reads
an agent: a `state` it does not know, or one with no `since`, is no state and no wait; a wait of a
kind it does not know, or on a tile not `waiting`, is none; `decide` only of a permission,
`choose` only of a question, and what is said only as `true` only as `true`.

## The last line

A tile's line is what it last said, as the person would read it on its tile, at most 160
characters: for an agent with a conversation (`agents.md` 0.4), the first line of the last text
it wrote, or the tool it last used and what about; for anything else, the last line with text
on its screen. A tile that waits on the person shows its wait instead (the command or file, or
the question), which its row already says.

## Shown

The phone shows, from top to bottom:

1. **Needs you**: the agents waiting on the person (`needs.md`), the one waiting longest first,
   each with its answers.
2. **Working**: the agents at work, the one at work longest first.
3. **Pinned**: the pinned tiles, each workspace's in its order; listed there and nowhere below.
4. **The tree**: each machine, the computer first, then the others by name, with a heading each
   only when more than one has something to show. On a machine, each workspace by name; its own
   project first, named by the workspace, then each other in the order its first frame comes. In
   a project its top frames in order, a worktree's frame under its own; its heading carries the
   first of them, `frame` (0.2), where an agent started from the heading runs. A project's only
   top frame, with no frame under it and called as the project is (trimmed, in any case), is no row
   of its own (0.4): its tiles are the project's, one level up. In a frame its agents
   first, then its other tiles, each in order, one an agent there started under it (unless the
   starters loop). Tiles in no frame, or in one that is gone, after the workspace's own frames
   on the computer.

A search keeps only the tiles whose name, agent or `program` label holds it, in any case, and the
frames, projects and machines with one of them; a machine chosen keeps only what is on it, a
tile being on its frame's machine. While either is in force a frame with no tile kept is left
out; else every frame shows. The machines to choose from show when there is more than one.
