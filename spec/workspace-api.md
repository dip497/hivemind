# Workspace API (0.3)

What a workspace's host is asked for, and what it answers. The host is the machine the
workspace's repo is on; today its callers are the app's windows and the dev-bridge, and later a
peer or another device. What only the machine at hand is asked for (a folder picker, the list of
the machine's workspaces, opening a file in another app) is not part of it. Every transport carries the same messages. Design: R8 in
`docs/design/multiplayer-2026-09-28.md`.

## Messages

A call is `{"method", "params"}`: `method` a dotted name (`git.stage`), `params` a list, in the
order the method below takes them. A param that is left out is `null` or absent from the end.

An answer is `{"result"}` or `{"error": {"code", "message"}}`, and nothing else: a host answers
every call, and a method that returns nothing answers `{"result": null}`. `code` is one of:

| Code | Why |
|---|---|
| `BAD_REQUEST` | The params are not what the method takes, or name something it may not reach (see below). It never ran. |
| `UNKNOWN_METHOD` | No such method on this host. |
| `FORBIDDEN` | The caller may not do this: a peer's role on the workspace does not allow it (below). It never ran. |
| `FAILED` | It ran and failed: git refused, a file could not be written. `message` says why, ending in the system's code when there is one (`… (ENOENT)`). |

A **notice** is a call that asks for no answer, `{method, params}` sent one way: the hot path (a
keystroke, a resize, flow control) and what a client tells the host about itself. A host never
answers a notice; one that is unknown or fails is logged on the host.

An **event** is what a host sends a client unasked: `{event, params}`, with a dotted name and
positional params like a call. A client holds a **connection** open to the host; each event goes
to every connection, or to those it concerns (a terminal's output to the clients that show it),
from when the connection opens until it closes. When it closes, the host lets go of what it held
for it.

## Transports

| Transport | Caller | Its connection | A call | A notice | Events |
|---|---|---|---|---|---|
| Electron IPC | the app's windows | the window, from when it opens until it closes | `invoke("workspace", method, params)` → the answer | `send("workspace:notice", method, params)` | `workspace:event`, one `{event, params}` each |
| HTTP | the dev-bridge's page | its event stream: `GET /workspace/events?token=…`, whose first event, `connection`, carries `{id}` | `POST /workspace`, body `{"method", "params"}` → 200 with the answer | `POST /workspace/notice`, same body → 204 | the stream's `data:` lines, one `{event, params}` each |

| hive-net | a peer on another device, reaching a workspace shared from here (M1) | its `hive/ws/1` connection | a frame on the `api` stream, `{"id", "method", "params"}` → a frame `{"id", "result"}` or `{"id", "error"}` | a frame without `id` | frames `{event, params}` on the same stream |

Over Electron only the main frame of an app window is heard; anything else is rejected. Over HTTP
every request carries the token (`x-hive-token`, or `token` on the stream) and a call or notice
names its connection (`x-hive-connection`): 401 without the token, 400 without a connection.

## Who asks, and the audit log

Each call is some actor's: over both transports above, the person at the host's machine. A
method with an effect is carried out through the host's intents and recorded in its audit log
(`audit.jsonl`, one JSON line each), its verb the method's name: who asked, what it acted on
(`target`), a `detail`, and how it ended (`ok`, `error` with the code it failed with). A read is
not recorded. What someone wrote (a commit message, a file's contents) is never recorded.

## Peers

A peer names the workspace by its id, `hive://<workspaceId>`, wherever a call takes a repo (or a
`cwd` inside it); the host reads that as its repo. Each call and notice is checked against the
peer's role on the workspace (design §6) before it runs, and one the role does not allow is
`FORBIDDEN` (a notice is dropped): reads and watching terminals are anyone's with access; the
board's edits need *Can edit board*; typing into and resizing a terminal, *Can use terminals*;
opening and closing tiles, *Can drive agents*; anything else is the owner's. A peer is sent only
the events about its workspace's tiles, and a tile outside the workspace is refused to it. A
peer's `presence.set` is its person's (the device's certificate names them), whatever name it
sends, and one participant per device.

## Params a host refuses

- A file is relative to the repo and stays inside it: an absolute path, or one whose `..` leaves
  the repo, is `BAD_REQUEST`. In an `ssh://` repo a file is a POSIX path with no `..` at all.
- A value git takes as an argument of its own — a revision (`scope.sha`, `scope.base`,
  `scope.head`), a branch, a worktree, a sparse root or an included file — may not begin with
  `-`, where git would read it as an option.
- A branch a worktree is made on is `[A-Za-z0-9._/-]+` with no `..`; its `path`, `sparse` roots
  and `includeFiles` are relative to the repo with no `..`.
- An issue as a call asks for it has each field as the issue's file holds it (a title that is not
  empty, a state from the list, a positive `github` number, …); a field the method does not name
  is dropped. An issue id is `PREFIX-N` or a sub-issue's `PREFIX-N.M`.
- Review comments are saved as a list; anything else would replace every comment with none.

## Methods

`repo` is the repo's path on the host, or an `ssh://` URI.

| Method | Params | Result | Recorded as |
|---|---|---|---|
| `git.status` | `repo` | `{branch, upstream, ahead, behind, files: [{path, status, staged, unstaged, origPath?}], conflictedFiles, isMerging, isRebasing, head}` | read |
| `git.listFiles` | `repo` | the tracked and untracked paths .gitignore leaves | read |
| `git.listBranches` | `repo` | `{current, local, remote}` | read |
| `git.diff` | `repo`, `scope`, `file`? | `{patch, cacheKey}` | read |
| `git.fileContents` | `repo`, `file`, `rev` (`HEAD` \| `INDEX` \| `WORKING`) | the text; `""` when it has none; `"\u0000HM_OVERSIZE:<bytes>"` past 1 500 000 bytes | read |
| `git.stage` | `repo`, `files` | `null` | target `repo`, detail `N files` |
| `git.unstage` | `repo`, `files` | `null` | target `repo`, detail `N files` |
| `git.discard` | `repo`, `files` | `null` (a tracked file goes back to HEAD, an untracked one is removed) | target `repo`, detail `N files` |
| `git.commit` | `repo`, `message`, `allowEmpty`? | `{sha}` | target `repo` |
| `git.push` | `repo`, `setUpstream`? | `null` | target `repo`, detail `set upstream` when asked |
| `git.pull` | `repo` | `null` (fast-forward only) | target `repo` |
| `git.conflictedFile` | `repo`, `file` | `{raw, conflicts}` | read |
| `git.writeResolved` | `repo`, `file`, `contents` | `null` | target the file |
| `worktree.list` | `repo` | `[{path, branch, head, locked, prunable, bare}]` | read |
| `worktree.create` | `repo`, `{branch, path?, sparse?, partial?, includeFiles?}` | `{path, branch}` | target `repo`, detail the branch |
| `worktree.remove` | `repo`, `worktree`, `force`? | `null` | target the worktree |
| `worktree.prune` | `repo` | `{removed}` | target `repo` |

| `file.read` | `repo`, `file` | the file's text | read |
| `file.write` | `repo`, `file`, `contents` | `null` | target the file |
| `issue.list` | `root` | `[{id, title, state, parent, labels, assignee, github, created, updated, path}]` | read |
| `issue.read` | `root`, `id` | the issue, with its `sections` (`description`, `acceptanceCriteria`, `activity`, `extra`) | read |
| `issue.create` | `root`, `{title, state?, parent?, labels?, assignee?, description?, acceptanceCriteria?, github?}` | the issue | target its id |
| `issue.update` | `root`, `id`, a patch of `title`, `state`, `parent`, `labels`, `assignee`, `github`, `description`, `acceptanceCriteria`, `extra` | the issue | target `id` |
| `issue.setState` | `root`, `id`, `state`, `note`? | the issue | target `id`, detail the state |
| `issue.comment` | `root`, `id`, `message` | the issue | target `id` |
| `issue.delete` | `root`, `id` | `null` | target `id` |
| `issue.link` | `root`, `id`, `other`, `type` | `{from, to, type, reciprocal}` | target `id->other`, detail the type |
| `issue.unlink` | `root`, `id`, `other` | `{removed}` | target `id->other` |
| `issue.move` | `root`, `id`, `prefix`, `mode` (`move` \| `copy`) | `{newId, newIssue, mode, from}` | target `id`, detail `move to PREFIX` |
| `review.list` | `repo` | `[{id, file, startLine, endLine, side, body, author, at, resolved?, summary?, replies?}]` | read |
| `review.save` | `repo`, `comments` | `null` (the list replaces the repo's comments) | target `repo` |

`root` is a workspace's `.hivemind` directory. An issue's `state` is one of `backlog`, `todo`,
`in_progress`, `in_review`, `done`, `cancelled`; a link's `type` one of `relates`, `blocks`,
`blocked-by`, `duplicates`, `parent-of`, `child-of`, `moved-to`, `moved-from` (the other issue is
given the reciprocal). `other` and `prefix` may name another workspace of the
host's. A change is signed `ui` in the issue's activity, whoever calls: who asked is in the audit
log.

| `status.all` | | `[{tileId, status}]`, every agent session's status (`spec/status.md`) | read |
| `link.list` | | `{pipes: [{src, dst}], spawns: [{parent, child}]}` | read |
| `terminal.open` | `{tileId, cwd, cmd, args?, cols, rows, env?, initialPrompt?, attachOnly?, liveOnly?}` | `{pid, joined}`: the first client to open a session starts it; one that opens it after joins it (`joined`), sent the host's screen of it first | target the tile, detail the program, when it starts a session the host did not ask for itself and the client did not only attach to |

| `store.open` | `repo` | `{core, views: {[viewId]: layout}, objects}`: a workspace's layouts, for a client that holds them | read |
| `store.core` | `repo` | the core layout (frames, tiles, their names), or null | read |
| `store.view` | `repo`, `viewId` | `{v, data}`, or null | read |
| `store.objects` | `repo` | the board's objects | read |
| `store.setCore` | `repo`, `core`, `base`? | `null` | not an intent: the document's own edit, by its writer |
| `store.setView` | `repo`, `viewId`, `{v, data}`, `base`? | `null` | likewise |
| `store.setObjects` | `repo`, `objects`, `base`? | `null` | likewise |
| `store.import` | `repo`, `{core?, views?}` | `null`: what the client kept before the store; the host keeps only what it lacks | likewise |
| `store.undo` | `repo` | whether the client's last board edit was taken back | likewise |
| `store.redo` | `repo` | whether it was made again | likewise |

A terminal is named by its session id, `hm:<tile>`; the audit log names it by its tile. `pid` is -1
when `attachOnly` finds no session.

Each client writes the store as a writer of its own, one per connection: a write names the layout
it was made from (`base`; null: none was read), so the host writes only what that client changed
and keeps another writer's change; `store.undo` takes back that client's own board edits only. A
layout the store cannot hold is `BAD_REQUEST`.

## Notices

| Notice | Params | What it does |
|---|---|---|
| `terminal.write` | `tile`, `data`, `paste`? | types `data` (`paste`: hands it over as one block) |
| `terminal.show` | `tile`, `shown` | whether any of the client's views shows it: it is sent the output only while one does, and the screen again when one shows it after none did |
| `terminal.resize` | `tile`, `cols`, `rows` | sizes it; while several clients show it, only the one that typed last may |
| `terminal.flow` | `tile`, `paused` | stops reading its output while the client catches up; a pause ends on its own after 120 ms unless asked for again |
| `terminal.close` | `tile` | ends the session for good; recorded (target the tile) unless it had already ended |
| `terminal.detach` | `tile` | the client shows it no more; a session no client shows is let go of (a daemon keeps it running, one the host runs itself ends) |
| `terminal.watchActivity` | `tiles` | the terminals whose activity the client is sent (`terminal.activity`), at most 1024 |
| `store.shown` | `repo` or null, `frame` or null | the workspace the client shows now, and the frame its user is in there (the control plane opens a tile there) |
| `presence.set` | `repo`, `{name, color, cursor, selection}` or null | where the client's person is in the workspace: `cursor` `{x, y}` in board coordinates (null: off the board), `selection` the ids they have selected (at most 100); null: they left it. Never stored: it lasts until the connection closes, they leave, or a minute passes without another |

A diff's `scope` is one of `{"kind": "working", "staged"?}`, `{"kind": "branch", "base"?,
"head"?}` (what `head`, HEAD by default, adds since it left `base`), `{"kind": "unpushed",
"base"?}` and `{"kind": "commit", "sha"}`, each with `ignoreWhitespace`?.

## Events

| Event | Params | Sent |
|---|---|---|
| `status.changed` | `{seq, tileId, status}` | to every client, on each change to an agent session's status |
| `link.pipe` | `{src, dst, connected}` (`dst` null: every pipe from `src`) | to every client, as a pipe between agents is connected or cut |
| `link.spawn` | `{child, parent, connected}` (`parent` null: every wire touching `child`) | to every client, as an agent spawns another, or the tile goes |
| `tile.opened` | `{tileId, repo, prompt?, background}` | to every client, as the control plane opens a tile, before it reaches the layout: a client showing `repo` starts it |
| `terminal.data` | `tile`, `data` | to each client that shows the terminal, its output in batches; a screen the host sends in place of what the client shows starts with `ESC c` |
| `terminal.exit` | `tile`, `{code, signal?}` | to each client that showed it, as its session ends |
| `terminal.activity` | `{[tile]: 0..3}` | to every client, as watched terminals' output gets busier or quieter |
| `file.changed` | `repo`, `{paths}` | to each client watching the repo (the app's window watches the one it opens), at most one every 300 ms |
| `store.changed` | `{repo, part}` (`core`, `board` or `view:<id>`) | to every client but the one whose write it was, on each change to a workspace's layouts |
| `presence.changed` | `repo`, `[{id, person, name, color, cursor, selection}]` | to every client, as someone in the workspace moves, selects, arrives or leaves: everyone there now, one per connection (`id`), `person` their key |

## A client that holds the layouts

A window over Electron reads and writes the store synchronously, on `sendSync` channels
(`workspace:core-sync`, `workspace:set-core-sync`, …) that answer what `store.*` answers. A client
over anything slower holds the layouts of each workspace it opens (`store.open`) and answers its
own reads from them, so it never waits on the network to draw:

- A write changes what it holds at once, and goes to the host after every earlier one, with its
  `base`.
- On `store.changed` it reads that part again once its own earlier writes have landed, so what it
  holds has both; and if it writes that part again while the reading is on its way, the reading is
  thrown away and made again after the write. It tells its window of the change only once it holds
  it.
- An undo or redo answers false at once; when the host took something back, the board is read
  again and arrives as a change.
- A read of a workspace it has not opened answers nothing and opens it; its parts then arrive as
  changes.

TypeScript: `StoreReplica` (`packages/workspace-api/src/store-replica.ts`).

## Implementations

TypeScript: `packages/workspace-api` (the methods' types, a client over any transport, and the
server that answers them, and a replica of the store for a client over a stream); the host's
domains in `apps/desktop/src/main/workspace/` (git and worktrees, files, issues, reviews, agents,
terminals, the store), which the app's main process and the dev-bridge both serve, each over its
own way of running a session and its own store.
