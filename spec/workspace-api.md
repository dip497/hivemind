# Workspace API (0.1)

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

Over Electron only the main frame of an app window is heard; anything else is rejected. Over HTTP
every request carries the token (`x-hive-token`, or `token` on the stream) and a call or notice
names its connection (`x-hive-connection`): 401 without the token, 400 without a connection.

## Who asks, and the audit log

Each call is some actor's: over both transports above, the person at the host's machine. A
method with an effect is carried out through the host's intents and recorded in its audit log
(`audit.jsonl`, one JSON line each), its verb the method's name: who asked, what it acted on
(`target`), a `detail`, and how it ended (`ok`, `error` with the code it failed with). A read is
not recorded. What someone wrote (a commit message, a file's contents) is never recorded.

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

A terminal is named by its session id, `hm:<tile>`; the audit log names it by its tile. `pid` is -1
when `attachOnly` finds no session.

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

## Implementations

TypeScript: `packages/workspace-api` (the methods' types, a client over any transport, and the
server that answers them); the host's domains in `apps/desktop/src/main/workspace/` (git and
worktrees, files, issues, reviews, agents, terminals), which the app's main process and the
dev-bridge both serve, each over its own way of running a session.
