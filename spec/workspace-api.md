# Workspace API (0.33)

What a workspace's host is asked for, and what it answers. The host is the machine the
workspace's repo is on; today its callers are the app's windows (in the app, or in a browser tab it serves), peers on
other devices and programs on this machine. What only the machine at hand is asked for (a folder picker, the list of
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
| `FORBIDDEN` | The caller may not do this: a peer's role on the workspace does not allow it (below), or no token says who it is. It never ran. |
| `NOT_FOUND` | What it names is not there: a tile, a frame, a workspace (0.23). |
| `ASLEEP` | The agent it names is asleep: `agent.send`, `agent.keys`, `agent.read` and `link.connect` at either end. `hive ctl wake` it first (0.33). An agent's report to its starter asleep is kept in that one's inbox, the answer saying `asleep` (0.33). |
| `NO_AGENT` | The tile is there but runs no agent (a tool, a browser, a shell), and the method asks an agent's reply (0.33). |
| `UNSUPPORTED` | The agent cannot do what it asks: it says no turn end to read a reply by, has no permission system to supervise, or keeps no sessions to resume (0.23). |
| `RATE_LIMITED`, `DEPTH_EXCEEDED` | Too many started at once, or one started too far below the person: ask again later, or from higher up (0.23). It never ran. The limit is 16 agents, tools or widgets a minute for each tree of callers (a grant, an agent the person started, or the person, with every agent started under it), and 64 for the machine; a start refused for anything else uses none of it. |
| `TIMEOUT` | What it waited on did not come in time (0.23). |
| `UNAVAILABLE` | It needs one of the person's windows, and none is open here (0.23). |
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
| WebSocket | the app's window in a browser tab, served by the app on 127.0.0.1 (`docs/design/browser-app-2026-10-13.md`) | the socket, from its `{"t": "auth", "token"}` frame until it closes | a frame `{"t": "invoke", "id", "ch": "workspace", "args": [method, params]}` → `{"t": "result", "id", "value"}` with the answer | `{"t": "send", "ch": "workspace:notice", "args": [method, params]}` | frames `{"t": "event", "ch": "workspace:event", "args": [{event, params}]}` |

| hive-net | a peer on another device, reaching a workspace shared from here (M1) | an `api` stream of its `hive/ws/1` connection: a connection may carry several, each a connection of its own (0.13) | a frame on that stream, `{"id", "method", "params"}` → a frame `{"id", "result"}` or `{"id", "error"}` on it | a frame without `id` | frames `{event, params}` on the same stream |
| Drive socket (0.20) | a program on this machine, `hive grant` among them, or an agent in a tile (0.23; below) | the socket connection, from its `hello` until it closes | a line `{"id", "method", "params"}` → a line `{"id", "result"}` or `{"id", "error"}` | a line without `id` | lines `{event, params}`; for a program, one line may be a list of them |

Over Electron only the main frame of an app window is heard; anything else is rejected. Over the
WebSocket the upgrade carries the launch's cookie, a loopback or configured Host and an Origin of
that Host, and the first frame the launch's token; else it is refused (401, 403) or closed (4401).

## Drive socket

Programs on this machine reach the workspace API on `drive.sock` in the app's data folder (0600;
a named pipe on Windows, named as `hcp.sock`'s is). The app and `hive host` both serve it;
whichever starts first does, and the other says so. Lines of JSON both ways, 1 MiB each at most.
A connection that says nothing in 10 s is told so and closed; one with more than 16 MiB sent it
and not read (a program that stopped reading) is closed.

The first line says who connects: `{"hello": {"token", "workspace"?}}`.

- **The install's token** (`hcp.token`) is the person at this machine. The host answers
  `{"hello": {"api": "0.33", "as": "person"}}` and serves every method, as to a window of theirs.
- **A grant's token** is a program the person let drive workspaces (`grant.create`), or a tool
  plugin's service, whose grant is made when it starts and taken back when it stops (`plugin` in
  `grant.list` names the plugin). It names one of the grant's workspaces by its folder, which may
  be left out when the grant reaches only one; the host answers
  `{"hello": {"api", "as": {"client", "role", "workspace"}}}` and serves that workspace as it does
  a guest at the grant's role (Peers, below): what the role does not name is `FORBIDDEN`, and it
  hears the events of that workspace's tiles alone. Unlike a guest's, its calls and answers name
  the workspace and its files by their paths here. It is recorded in the audit log as a peer whose
  `person` and `device` are `client:<grant id>` and whose `client` is the grant's name.
- **An agent's tile token** (`HCP_TOKEN`) is that agent (0.23), given the socket's path as
  `HIVE_DRIVE_SOCK`. It drives the workspace its tile is in, and names no other: the host answers `{"hello": {"api", "as": {"agent", "role":
  "agents", "workspace"}}}` and serves it as a program at the role `agents`, while its tile is
  there. What it starts is its own (`parent` in `agents.md`, its tile): a level below it, and
  reporting to it; a tool use it supervises is its to answer. It is recorded as a peer whose
  `person` and `device` are its tile and whose `client` is what the control plane calls it.
- **Anything else** is answered `{"error": {"code", "message"}}` and the connection closes. So
  does a grant reaching several workspaces that does not name one, or one that ran out.

Taking a grant back closes its connections; one that runs out closes them then. The host keeps
grants in `grants.json` beside `hcp.token`, 0600, each token only as its sha256. Only the
process serving the socket keeps them: `grant.*` asked of the other (the app opened beside a
running `hive host`) is answered by the one serving, and `UNAVAILABLE` when none does. A service's
grant found as a process begins serving was left behind by the one before, and is taken back.

## Who asks, and the audit log

Each call is some actor's: over both transports above, the person at the host's machine. A
method with an effect is carried out through the host's intents and recorded in its audit log
(`audit.jsonl`, one JSON line each), its verb the method's name: who asked, what it acted on
(`target`), a `detail`, and how it ended (`ok`, `error` with the code it failed with). A read is
not recorded. What someone wrote (a commit message, a file's contents) is never recorded. A
keystroke is not a method; a guest's typing into a terminal (a peer whose role is not the
owner's) is marked once a burst, `terminal.write` with the terminal's tile as its target, again
after a minute without it, and never what was typed.

## Peers

A peer names the workspace by its id, `hive://<workspaceId>`, wherever a call takes a repo (or a
`cwd` inside it); the host reads that as its repo. A guest's call or notice about a workspace
(`store.*`, `git.*`, `worktree.*`, `file.*`, `issue.*`, `review.*`, `people.*`,
`presence.set`, `agent.startable`, `agent.start`, `agent.sessions`, `tool.open`, `frame.*`, and `view.open`, whose second param names it) names this one, or a place in it, and nothing else on the host: another folder, a
path out of it (`..`), another workspace or a machine is `FORBIDDEN` (a notice is dropped). A
place in it is its repo or the worktree of one of its frames, wherever git put it (0.20). The
person's own devices are the owner, there as here. What the host answers of every agent it runs
(`status.all`, `link.list`) a peer is answered for the workspace's own agents alone, as it hears
only their events. A computer's app opens an `api` stream of
its own for each workspace it joined, and one more for each of its windows that shows the
workspace's terminals, on its one connection: each is a connection of its own, and its first frame
says what it is for (0.28): `{"terminals": true}`, a window's, is sent the events of terminals
(`terminal.*`) alone, and its terminal calls and notices come on it; `{"terminals": false}`, the
app's, is sent every other event, once for all its windows. One whose first frame is a call is
sent every event. The app ends a window's stream when the window closes or shows another
workspace. One of the owner's phones (`pairing.md` 0.3) opens a workspace's API on an `api`
stream of its own connection, the stream's first frame naming it (`{ "t": "open", "workspace":
"<id>" }`; any other first frame, or a workspace not held there, closes the connection), as the
owner. Its first frame may offer `"z": "deflate"` (0.27): the host then sends each frame of over
16 KB on that stream deflated, as `z:` and the frame's UTF-8 as raw DEFLATE (RFC 1951) in base64,
each frame alone and in the order sent; a frame of JSON never starts so (`conformance/squeeze.json`).
A host that does not know `z` sends every frame as it is. It opens one for each thing it does at once (a terminal watched, a conversation followed, a
call), on that one connection: each is a connection of its own, for the workspace it names, its
answers and events on it alone, until it ends (0.13). It may
call nothing there but `terminal.open` with `attachOnly` (it watches a terminal, its screen and
then its output, paced by its `terminal.ack`s, 0.24), `terminal.write` and `terminal.keyboard.ask` (it types into one as the owner,
and asks for its keyboard while someone else holds it, 0.10), `terminal.fit` (it sizes one to its
screen until it goes, 0.24), `agent.answer` (it answers what an
agent waits on the person for), `agent.send` (it sends one a message, 0.10), and `agent.startable`,
`agent.start`, `agent.interrupt`, `agent.close` and `agent.diff` (it starts an agent, interrupts its
turn, closes it and reads what it changed, `agents.md`, 0.11), and the `view.*` calls (it shows the
community views here that work on a phone, 0.12), and `people.answer` (it answers someone asking
to join, from the notice that told it, `push.md` "Join", 0.16): it never starts a terminal but by
starting an agent, never sizes one but by fitting it, nor gives or takes a keyboard (M5). Each call and notice is checked against the
peer's role on the workspace (design §6) before it runs, and one the role does not allow is
`FORBIDDEN` (a notice is dropped): reads, watching terminals and showing a community view are anyone's with access; typing
into, resizing and fitting a terminal, and asking for its keyboard or handing it on, *Can use terminals*;
handing a branch of one's own to the host (`git.handOff`, M4), and opening a tool's tile (`tool.open`, 0.23), *Can edit board*;
answering an agent's plan or what it waits on (`agent.answer`), sending one a message
(`agent.send`), starting one, interrupting its turn and closing it (`agent.start`,
`agent.interrupt`, `agent.close`, 0.11), naming one, typing keys to it and piping one's replies to another (`agent.rename`, `agent.keys`, `link.*`, 0.23; both ends of a pipe its workspace's), and opening and closing tiles, *Can drive agents*; anything else is the
owner's (taking a keyboard back among them, and the `store.*` writes). A peer edits the board
through the workspace document's own sync (the connection's `sync` stream), where the host takes
only what the peer's role allows, and drops a change that does more, whole: moving, sizing,
naming and grouping what is on the board, *Can edit board*; placing, taking away or changing what
a tile that runs something on the host runs (a terminal's, an agent's or a browser page's: its
kind, command, arguments, session or page), or moving it to another frame, *Can drive agents*;
and where a frame's tiles run (its folder, its worktree and branch, the frame it nests in), and
taking away a frame that says so, the owner's. But anyone who may edit the board may put a frame
of their own on their own device (`machine://<their device id>/path`, and nothing else said of
where it runs), and place, change or take away the tiles in it: those run on their machine, as
they placed them there, never on the host's (M4). Their app shows those sessions to the host
over its own connection, and every client watches them through the host: a terminal on a
participant's machine is sized there, and typed into there, by them, and by no client of the
host's (`terminal.keyboard` names its machine's person) until they let the others type there;
then its keyboard goes as the host's own terminals' do, until they take that back. When they let
the others run terminals and agents there too, a terminal or agent tile someone else places in a
frame of theirs on their machine is started there by the `terminal.open` that would start it on
the host (not `attachOnly`), in that frame's folder, running what the workspace's document says,
with the opener's environment (never the host's control-plane credentials) and task, and ended
there by `terminal.close`; their machine decides, and starts or ends nothing more once they take
that back. What they placed there themselves is theirs alone to start and end. A peer's
`terminal.open` of a
session already running shows it (`attachOnly`), whatever its role. A peer is sent only the
events about its workspace's tiles, and a tile outside the workspace is refused to it. A
terminal is named by its session, `hm:<tile>`; the tile is the workspace's. Events reach a peer
in frames of one event, or of a list of the events of one moment; while they stream, a frame at
most every 25 ms, the first after a quiet spell at once. An answer comes after the events sent
before it. The host takes a peer's calls and notices in the order it sent them; a call's answer
may still come before an earlier call's. A
peer's `presence.set` is its person's (the device's certificate names them), whatever name it
sends, and one participant per device.

## Params a host refuses

- A file is relative to the repo and stays inside it: an absolute path, or one whose `..` leaves
  the repo, is `BAD_REQUEST`. In a remote repo (`machine://` or `ssh://`) a file is a POSIX path with no `..` at all.
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

`repo` is the repo's path on the host, or a remote one: `machine://<machine id>/path` on a saved machine, `ssh://` on a host none is saved for.

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
| `git.handOff` | `repo`, `branch`, `bundle` (a git bundle of it, base64, 32 MB at most) | `{branch, base}`: the branch it landed as, `handoff/<who>/<branch>` (`who` the caller's name, made plain), and the branch checked out here that a Diff tile on the board now shows it against. The bundle is checked against the repo first (`FAILED`, saying the repo lacks commits it builds on, when it does: send its whole history); the repo's working tree, index and own branches are untouched, and a branch lands only over a hand-off of the same person's | target `repo`, detail the branch |
| `worktree.list` | `repo` | `[{path, branch, head, locked, prunable, bare}]` | read |
| `worktree.create` | `repo`, `{branch, base?, path?, sparse?, partial?, includeFiles?}` (`base`, 0.20: where a new branch starts; an existing branch is checked out as it is) | `{path, branch}` | target `repo`, detail the branch |
| `frame.open` | `repo`, `{path, machine?}` or `{worktree: {branch, base?}}`, with `title?`, `parent?` | `{frame, path, opened, created}` (0.20): the frame bound to that folder, made when there is none (`opened`), on a worktree made when the branch has none (`created`); a worktree frame nests in the workspace's own frame unless `parent` says another. A guest or a program names only the workspace's folders. `machine` (0.30): `path` is on that machine, a saved machine or another of the person's devices, named by its id or, in any case, its name; `path` is then `machine://<id><path>`. A name two machines share is `BAD_REQUEST` listing each with its id, one no machine has `NOT_FOUND`; only the person, the owner's devices and an agent on this machine name one (else `FORBIDDEN`). A window shows a frame it is handed with no place in the next free slot | target `repo`, detail the branch or folder |
| `frame.close` | `repo`, `frame`, `{closeTiles?, removeWorktree?, force?}`? | `{closed, tilesClosed, worktreeRemoved}` (0.20): the frame and those nested in it go; one holding tiles only with `closeTiles`, which ends them; its worktree only with `removeWorktree`, removed first, so git refusing one with changes (without `force`) closes nothing | target the frame |
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
| `link.connect` | `src`, `dst` | `null`: each reply of the agent in `src` is handed to the one in `dst` as its next prompt, as `hive ctl connect` (0.23) | target `src->dst` |
| `link.disconnect` | `src`, `dst`? | `null`: that pipe gone, or every pipe out of `src` (0.23) | target `src` |
| `agent.list` | `repo` | `{seq, agents}`: the workspace's agents as they are now, and the number of the last change (0.18), counted on from when the host began, in ms, so `agent.since` with a number from before it started again is null; a plan an agent waits on a review of is in its `waiting` (`plan`), answered with `agent.answer` (0.21: `plan.list`, `plan.decide` and the `plan.*` events are gone); each with the session it is in, `session`, when its agent has said (0.22, `agents.md` 0.6) | read |
| `agent.since` | `repo`, `seq` | `{seq, changes, events}`: each change and event after `seq`, or null when the host no longer has them all: list again (0.18) | read |
| `widget.all` | `repo` | what each widget in the workspace last drew, by its id: never stored, drawn again when its code next runs (0.18) | read |
| `widget.run` | `repo` | whether the caller runs the workspace's widgets: a window of the person's, on the host's machine or on another of their devices with it open, the first to ask, until it lets go (`widget.release`) or goes; someone else's device never does (0.19) | — |
| `widget.packages` | `repo` | the widgets installed on the host, `[{id, name, version?, options, chrome, permissions, placement, size, assets, code, draw?, icon?}]`: what a window showing it offers, draws and runs; `code` is empty for anyone but the person (0.19) | read |
| `widget.asset` | `repo`, `widget`, `name` | an image of an installed widget, as a data URL, or null (0.18) | read |
| `appearance.get` | | the host's look as its guests show its workspaces (0.17): its settings' `appearance`, checked, with nothing that names a file on its disk (a picture or video wallpaper is the default one, no overlays) and the default fonts (a guest reads in its own). A `view` peer may ask | read |
| `terminal.open` | `{tileId, tile?, cwd, cmd, args?, cols, rows, env?, initialPrompt?, attachOnly?, liveOnly?, acks?, history?}` (`tile`: the tile it is the session of, when `tileId` is not `hm:<tile>`; `cwd` and `cmd` need not be said with `attachOnly`, 0.23; `acks`: the client acknowledges what it takes, `terminal.ack`, 0.24; `history`: at most this many lines of its scrollback in each screen the client is sent, all the host keeps when not said) | `{pid, joined, asleep?}`: the first client to open a session starts it; one that opens it after joins it (`joined`), sent the host's screen of it first; one put to sleep is started by no client (`asleep`, `pid` -1), nor is a start that would resume a conversation another tile sleeps in (0.29) | target the tile, detail the program, when it starts a session the host did not ask for itself and the client did not only attach to |
| `terminal.saved` | `tile`, `lines`? | what the agent in `tile`, put to sleep, last showed, with its newest 1000 lines when `lines` asks for no more (none: all it saved); null when it does not sleep. Read from where it slept, as its workspace says (0.29) | — |
| `agent.answer` | `tile`, `since`, `{text}` or `{decision, feedback?, always?}` | `{answered, by?}`: what the agent waits on the person for is answered, a plan decided, a permission allowed or denied with the agent's own keys, a supervised tool use allowed or denied (0.20), and with `always` every later use of that tool by that agent too, until it closes (0.23), or a line typed into its terminal, only while it still waits on that wait (`since`) and once (`needs.md`, "Answering"); a plan or supervised tool use answered already says who answered first (`by`: `{person, name}`, 0.21) | target the agent's tile |
| `agent.approval` | `tile` | `{request, since, tool, summary, input, expiresAt, truncated?}` (0.31): the supervised tool use the agent waits on, `summary` as its supervisor is told it (a command cut to 300 characters, an edit's file alone) and `input` whole, as the agent's hook gave it (text as it is, else JSON, two spaces a level), cut to 262,144 characters, `truncated` then. `NOT_FOUND` when it waits on none. `hive ctl approval <request>` | read |
| `agent.transcript` | `tile` | `{session, path}` (0.32): the session the agent is in and its file, for a program reading the agent's own records, as its hooks are handed `transcript_path`. Answered only to a caller on this machine (the person, a program or agent on the drive socket) about an agent running on it: else `UNSUPPORTED` (a phone or guest reads it with `agent.conversation`). `NOT_FOUND` when it keeps no session file yet | read |
| `agent.send` | `tile`, `text` | `{sent}`: a message for the agent, whatever it is doing, a prompt of up to 32768 characters (0.23) typed in as its next prompt once it is at its prompt, Enter after it; the `agent.read` after it waits for the turn it starts; `sent` false: no agent runs there (`needs.md`, "Sending", 0.10) | target the agent's tile |
| `agent.startable` | `repo` | `{programs, frames}`: the agents this device starts, with their model and mode choices, and the workspace's frames, each on the machine its folder is on (`agents.md`, "Starting", 0.11) | — |
| `agent.start` | `repo`, `{program, frame?, prompt?, model?, mode?, name?, resume?, supervise?, report?}` | `{tile}`: an agent started as the person launches one at their desktop, their saved options with these on top, never in its unattended mode unless `mode` says so (`agents.md`, 0.11); `supervise` makes its caller its supervisor, and a program or an agent its parent (0.20; an agent, 0.23) | target the new tile |
| `agent.interrupt` | `tile` | `{interrupted}`: the keys its manifest says interrupt its turn, typed a moment apart, while it works or waits (`agents.md`, "Stopping", 0.11) | target the agent's tile |
| `agent.close` | `tile` | `{closed}`: its session ended and its tile taken off its board, as `hive ctl close` (`agents.md`, 0.11) | target the agent's tile |
| `agent.sleep` | `repo`, `target`? (a tile or a frame, by id or name; none: every agent of the workspace but the agent asking, 0.33), `force`? | `{slept, skipped: [{tile, why, already?}]}` (`already`: asleep already, 0.33): each agent's process ended, its tile kept with its last screen and its conversation to wake to; one working or waiting on someone is skipped unless `force`, as one that cannot resume its conversation, a shell and a session started elsewhere are; a name two tiles share is `BAD_REQUEST` (`agents.md`, "Sleep", 0.29) | target the workspace, detail the target |
| `agent.wake` | `repo`, `target`? | `{woke, skipped: [{tile, why, already?}]}` (`already`: awake already, 0.33): each sleeping agent started again in its conversation, where it slept; skipped when another tile runs that conversation, or what it saved is gone, which also stops it being kept asleep (0.29) | target the workspace, detail the target |
| `agent.diff` | `tile` | `{files, patch, truncated}`: what it changed in the folder it runs in, against its last commit (`agents.md`, "Changes", 0.11) | — |
| `agent.rename` | `tile`, `name` | `{name}`: what it is called now, on its tile and to the agents it talks to; an empty `name` takes it away, so it is called what its agent says again (0.23) | target the agent's tile |
| `agent.keys` | `tile`, `keys` | `{keys}`: each key name (`Enter`, `Escape`, `Up`, `C-c`, …) or text typed into its terminal a moment after the last, how many there were (0.23) | target the agent's tile |
| `agent.read` | `tile`, `timeoutMs`? (0: without waiting) | `{text, finalStatus, truncated, note?, waiting?}`: its reply at the end of its next turn (`finalStatus` `turn`), or what it shows when it closes (`closed`) or `timeoutMs` passes (`timeout`), as `hive ctl read` (0.23; a `timeoutMs` past 2³¹−1 ms, about 24.8 days, waits that long); `waiting` at once when it stops to wait on an answer, with what on (0.26); `ASLEEP` at once when it is asleep or is put to sleep (0.33; was `finalStatus` `asleep`, 0.29); `idle` at once when it was sent nothing since its last reply was read, ended no turn since and is not working, and `working` for one still working read with `timeoutMs` 0 (0.33). `NO_AGENT` for a tile that runs no agent (0.33) | — |
| `agent.output` | `tile`, `lines`? | `{text}`: the last `lines` lines (40) of what it printed, its terminal's escapes taken out, as much as the host keeps; following its output as it comes is `terminal.open` with `attachOnly` (0.23) | — |
| `agent.sessions` | `place`, `program`, `limit`? | `{agent, resumable, sessions}`: the sessions `program` keeps for that folder, newest first, each one `agent.start`'s `resume` takes; `resumable` false when it says none (0.23) | read |
| `tool.open` | `repo`, `{tool, frame?, url?}` | `{tile}`: an installed tool's tile (`tool` its id) placed on the board, in `frame` or the one in view (0.23) | target the new tile |
| `view.list` | | `[{id, name, version, entry, page}]`: the community views installed on this device whose manifest says `"phone": true` (below, 0.12), and the page a screen loads to show each (0.14) | read |
| `view.file` | `id`, `path` | `{data, type, csp}`: one of the view's files as the app serves its windows (below), `path` inside its package (a link out of it, or `..`, is `BAD_REQUEST`), its bytes base64, its type, and the policy to serve it under (0.14); 4 MiB at most | read |
| `view.open` | `id`, `repo`, `screen`?, `surfaces`? | `{session}`: the view opened on the workspace for this caller, on its screen (below; `screen` 0.14); `surfaces`: the screen places live surfaces itself (0.15) | — |
| `view.close` | `session` | `{closed}`: the caller's session ended; false: it has none of that name | — |

| `people.list` | `repo` | who is on the workspace's access list: `[{person, name, color, role, grantedAt, expires, devices, present}]`, `present` whether they are connected now; `[]` for a workspace that does not say whose it is yet | read |
| `people.role` | `repo`, `person`, `role` | `null`: their connections close, so they work under the new role at once; *Can drive agents* is given only to someone connected now | target `repo`, detail the person and the role |
| `people.remove` | `repo`, `person` | `null`: off the list, their connections closed, and the link they came in by lets nobody in again | target `repo`, detail the person |
| `people.invite` | `repo`, `role` (`view`, `edit` or `terminals`), `expiresIn` (ms), `reusable`?, `uses`? | a join link, `hivemind://join/<host's device id>#…`: where the host is, the workspace's name and its owner's, its key and the network's lookup server, and on a network whose relays admit only whom they are told to a voucher for the guest's device; used once unless `reusable`, then by `uses` people at most when given (0.16) | target `repo`, detail the role |
| `people.admit` | `repo`, `certificate`, `profile`, `role` (`view`, `edit` or `terminals`) | where the device finds the workspace, `{workspace, host, addrs, relay, role, names, hosting}` (0.25): the device whose `certificate` asked to connect to the owner's app and was answered someone else (`pairing.md` 0.10) is let in as a join lets someone in, its person granted `role` and remembered by `profile` | target `repo`, detail the person and the role |
| `people.answer` | `repo`, `req`, `allow`, `role`? | `{answered}`: whether this answer to the question `req` (`people.asked`) counted, the first one does; `role` (`view`, `edit` or `terminals`, 0.16) lets them in at it in place of their link's | target `repo`, detail `allow` (`allow as <role>`) or `deny` |
| `people.requests` | `repo` | `{answering, asking}` (0.16): how the workspace lets in someone with a valid invite (`ask` or `invite`), and the questions about it waiting on its owner now, each `{req, workspace, profile, role}` as `people.asked` tells it | read |
| `people.answering` | `repo`, `rule` (`ask` or `invite`) | `null` (0.16): `ask`, the default, asks the owner about each person with a valid invite; `invite` lets them in at once at the invite's role | target `repo`, detail the rule |
| `grant.list` | | `[{id, name, repos, role, createdAt, expires, lastUsed}]`: the programs let drive workspaces here (0.20); the person's alone | read |
| `grant.create` | `{name, repos, role, expires?}` (`repos`: folders, in full; `expires`: ms since the epoch, or null for never) | `{grant, token}`: the token is shown this once | target the name, detail the role |
| `grant.revoke` | `id` | `{revoked}`: false when there was none of that id; its connections close | target `id` |

Only the workspace's owner asks the `people.*` methods: at a window of the host's own, or from
another of their devices while the workspace is hosted on one they moved it to (a peer whose role
is the owner's). Someone asking to join with a link (`spec/pairing.md`'s `hive/pair/1`, with the
link's secret) is asked about at each of the owner's clients connected then (`people.asked`): the
first answer counts, the others are told it came (`people.answered`). With none of them connected,
the owner's phones are told (`push.md`, "Join"); with no phone either, the host declines at once,
unless it has no window and its person answers at its command line (`hive people allow`, 0.16).
Nobody answering within 170 s is a no. A workspace whose rule is `invite` asks nobody.

| `store.open` | `repo` | `{core, views: {[viewId]: layout}, objects}`: a workspace's layouts, for a client that holds them | read |
| `store.core` | `repo` | the core layout (frames, tiles, their names), or null | read |
| `store.view` | `repo`, `viewId` | `{v, data}`, or null | read |
| `store.objects` | `repo` | the board's objects | read |
| `store.objectsWithIds` | `repo`, `ids` | `{[id]: object or null}`: the board's objects with these ids, null for one not there; what a client reads when `store.changed` names them (0.28) | read |
| `store.setCore` | `repo`, `core`, `base`? | `null` | not an intent: the document's own edit, by its writer |
| `store.setView` | `repo`, `viewId`, `{v, data}`, `base`? | `null` | likewise |
| `store.editObjects` | `repo`, `{objects: {[id]: object or null}, base?: {[id]: object or null}}` | `null`: writes the objects the client changed (null: took it away), each merged with what others changed in it since the one in `base` it changed it from (null: it was not there); the rest of the board is not touched, so an edit costs what it changed. Replaces `store.setObjects` (0.28) | likewise |
| `store.import` | `repo`, `{core?, views?}` | `null`: what the client kept before the store; the host keeps only what it lacks | likewise |
| `store.undo` | `repo` | whether the client's last board edit was taken back | likewise |
| `store.redo` | `repo` | whether it was made again | likewise |

The machine's own methods (0.23): the person's, at a window or on the drive socket, and an agent's
on this machine, as on the control plane, but `host.join` and `host.add` (an agent is kept to its
workspace; serving another folder, or joining one, is the person's). No peer asks them, the person's own
other devices included, nor a program. Refused, `host.join` says who may join and how (the person, with
`hive join <link>` in a terminal of their own; their own devices need no link), `host.add` that the
person runs `hive host add <folder>` in a terminal of their own, and another of these
says it is asked at the machine itself.

| Method | Params | Result | Recorded as |
|---|---|---|---|
| `host.status` | | `{workspaces: [{repo, workspace}]}`: what this host serves, each by its folder and its id | read |
| `host.add` | `folder` | `{repo, workspace}` (0.30): the folder, absolute and on this machine, served as one of its workspaces, with no window, as Open folder does; one served already is answered as it is. `BAD_REQUEST` when it is not a folder here | target the folder |
| `host.join` | `link` | what joining a workspace by its link answers, as `hive join` | target the link's workspace |
| `tile.focus` | `tile` | `null`: the tile brought forward in the window showing it | — |
| `plugin.list` | | `{plugins: [{plugin, kind, instance, label, state, reason?, since, commands}], views: [{id, label, active}]}`: every plugin running in a window (a tool's tile, a widget with code, a community view), `state` `starting` until its code connects, then `ready`; `failed` with its `reason` when it did not start in 15 s or was disabled; and the views the window can show (0.27) | read |
| `plugin.commands` | | the commands each ready plugin running in a window offers | read |
| `plugin.open` | `plugin` (`tool:<owner>/<name>[/<tool>]`, `widget:@<owner>/<name>` or `view:<id>`), `frame`? (a tool's tile's) | what opening it answers: a tool's tile placed (`{tile}`), a widget added to the board (`{widget}`), a view switched to (`{view}`); for one with code, once it can be called or 10 s pass, with its `instance`, `state`, `reason`? and `commands` (0.27) | target the plugin |
| `plugin.call` | `plugin`, `command`, `args`?, `tile`? | `{result}`: what the plugin's command answers, run in a window. One still starting is waited for; the whole call has 30 s in the window. Refused `NOT_FOUND` (not running, no such copy or command), `BAD_REQUEST` (two copies and no `tile`, an argument over 64 KB), `TIMEOUT` (still starting, or no answer in time), `FAILED` (the plugin failed, or refused: its own words) | target the plugin |
| `plugin.close` | `instance` (a running plugin's instance, a widget's id on the board, or the plugin as `plugin.open` takes it), `plugin`? | `{closed, plugin, kind}` once it stopped: a tool's tile closed, a widget taken off the board (one drawn without code too), a view left for the canvas (0.27). A plugin named as `plugin.open` takes it must have one copy open: two are `BAD_REQUEST`, naming their instances; none is `NOT_FOUND` | target the instance |
| `view.emit` | `name`, `data`?, `view`? | `{id, delivered, view, reason?, buffered?}`: the event sent to the view open in the window, or kept for it until it listens (`view`: only while that one is open) | — |
| `views.rescan`, `agents.rescan`, `widgets.rescan`, `tools.rescan` | | `null`: those installed read again from disk | — |
| `settings.reload` | | `null`: `settings.json` read again | — |

A terminal is named by its session id, `hm:<tile>`; the audit log names it by its tile. `pid` is -1
when `attachOnly` finds no session.

Each client writes the store as a writer of its own, one per connection: a write names the layout
it was made from (`base`; null: none was read), so the host writes only what that client changed
and keeps another writer's change; `store.undo` takes back that client's own board edits only. A
layout the store cannot hold is `BAD_REQUEST`.

## Notices

| Notice | Params | What it does |
|---|---|---|
| `terminal.write` | `tile`, `data`, `paste`? | types `data` (`paste`: hands it over as one block), when the client has the terminal's keyboard: the host's own clients until it is given away, and then its holder alone. One of the host's own clients that types sizes it at once to the size it last said (`terminal.resize`); an answer (`agent.answer`) is no typing |
| `terminal.keyboard.ask` | `tile` | asks for the terminal's keyboard: its holder is sent `terminal.keyboard.asked` (the host's clients showing it, while the host holds it) |
| `terminal.keyboard.give` | `tile`, `to` | hands the keyboard the client holds (or the host's, from a host's client) to `to`, the id of one who asked; everyone is told (`terminal.keyboard`). It comes back to the host when the host takes it, when its holder goes, and after five minutes without their typing |
| `terminal.keyboard.take` | `tile` | the host takes the keyboard back |
| `terminal.show` | `tile`, `shown` | whether any of the client's views shows it: it is sent the output only while one does, and the screen again when one shows it after none did |
| `terminal.resize` | `tile`, `cols`, `rows` | the client's own size of it, kept; it sizes it when the client may: the keyboard's holder, while a guest holds it; otherwise, among the host's own clients showing it, the one that typed last, and a window here also before anyone typed. A device of the person's (a phone) sizes it only by typing. When the one that typed last goes, it takes the size of the one that typed before it, as tmux's `window-size latest` does |
| `terminal.flow` | `tile`, `paused` | stops reading its output while the client catches up; a pause ends on its own after 120 ms unless asked for again |
| `terminal.ack` | `tile`, `taken` | a client that opened it with `acks` has taken `taken` of its output (`terminal.data`'s text, in UTF-16 units, all it was sent on that connection told). It is sent at most 128 K units ahead of that, the screen sent in place of output not counted; past it, nothing, until it has taken all it was sent, and then the host's screen in place of what it missed. Nothing queues for it, and the session is not held back for it. A client acknowledges each frame of output it takes (0.24) |
| `terminal.fit` | `tile`, `cols`?, `rows`? | sizes it to the client's screen until the client lets go (no size), goes, or another client types; it then takes back the size it had, unless a client here sized it meanwhile. The fit is also the client's own size (`terminal.resize`) until it lets go: its own typing keeps the fit, and once another client typed, its next key sizes it again (0.25). Where a client may type into it; not a session sized on its machine (0.24) |
| `terminal.history` | `tile`, `lines` | sends the client the host's screen again, in place of what it shows, with at most `lines` of its scrollback, as each screen it is sent from now on. A phone asks for 200 lines as it opens a terminal and for more as the person scrolls to the oldest it holds |
| `terminal.close` | `tile` | ends the session for good; recorded (target the tile) unless it had already ended |
| `terminal.detach` | `tile` | the client shows it no more; a session no client shows is let go of (a daemon keeps it running, one the host runs itself ends) |
| `terminal.watchActivity` | `tiles` | the terminals whose activity the client is sent (`terminal.activity`), at most 1024 |
| `store.shown` | `repo` or null, `frame` or null | the workspace the client shows now, and the frame its user is in there (the control plane opens a tile there) |
| `view.post` | `session`, `message` | what the view of the caller's session posts to its host, a view protocol message (below) |
| `view.screen` | `session`, `screen` | the screen the view of the caller's session is shown on now, its size and look: its host tells the view what of them changed (below, 0.14) |
| `widget.draw` | `repo`, `id`, `tree` or null | what the widget `id` draws now, from the window that runs the workspace's widgets alone; told to every client at most every 250 ms, the latest winning; null: it draws nothing (0.18) |
| `widget.release` | `repo` | the caller no longer runs the workspace's widgets: the others are sent `widget.runner` (0.18) |
| `widget.press` | `repo`, `id`, `{action}` or `{click: true}` | a press on the widget `id` where its code does not run (a guest's window, a view on a phone): passed to the window that runs it as `widget.pressed`; an `action` over 1 KB is dropped. Needs `edit` (0.19) |
| `presence.set` | `repo`, `{name, color, cursor, over, selection}` or null | where the client's person is in the workspace: `cursor` `{x, y}` in board coordinates (null: off the board), `over` the id of the tile, frame or board object under it (null: none), `selection` the ids they have selected (at most 100); null: they left it. Never stored: it lasts until the connection closes, they leave, or a minute passes without another |

A diff's `scope` is one of `{"kind": "working", "staged"?}`, `{"kind": "branch", "base"?,
"head"?}` (what `head`, HEAD by default, adds since it left `base`), `{"kind": "unpushed",
"base"?}` and `{"kind": "commit", "sha"}`, each with `ignoreWhitespace`?.

## Events

| Event | Params | Sent |
|---|---|---|
| `status.changed` | `{seq, tileId, status}` | to every client, on each change to an agent session's status |
| `agent.changed` | `repo`, `{seq, agent}` or `{seq, gone}` | to every client, an agent of the workspace as it is now, or its going (0.18); a new session is a change (0.22) |
| `agent.event` | `repo`, `{seq, at, kind, tile, detail?}` | to every client, what happened to an agent: `came`, `went`, `turnEnded`, `waiting`, `answered` (0.18); `reported`, an agent a program started reporting to it, `detail` what it said (0.20); `answered` for a plan or supervised tool use: `detail` the decision and `by` who gave it, `{person, name}`, when a person did (0.21) |
| `widget.drawn` | `repo`, `id`, `tree` or null | to every client, what a widget draws now (0.18) |
| `widget.runner` | `repo` | to every client of the workspace, a peer of the person's included, when no window runs its widgets: the first to ask (`widget.run`) does (0.19) |
| `widget.pressed` | `repo`, `id`, `{action}` or `{click: true}` | to the window that runs the workspace's widgets, a press made elsewhere (0.19) |
| `link.pipe` | `{src, dst, connected}` (`dst` null: every pipe from `src`) | to every client, as a pipe between agents is connected or cut |
| `link.spawn` | `{child, parent, connected}` (`parent` null: every wire touching `child`) | to every client, as an agent spawns another, or the tile goes |
| `tile.opened` | `{tileId, repo, background, near?, by}` | to every client, as the control plane opens a tile, before it reaches the layout: its host starts it, with its first task; a client showing `repo` lays it out. `by` (0.33): `person`, `agent` or `program`, who opened it; a window goes to one the person opened, and to one an agent or program opened only when the person's `agents.whenAgentStartsAgent` is `go` |
| `terminal.data` | `tile`, `data` | to each client that shows the terminal, its output in batches; a screen the host sends in place of what the client shows starts with `ESC c` |
| `terminal.exit` | `tile`, `{code, signal?, slept?}` | to each client that showed it, as its session ends; `slept`: it was put to sleep, and is not gone (0.29) |
| `terminal.activity` | `{[tile]: 0..3}` | to every client, as watched terminals' output gets busier or quieter |
| `terminal.keyboard` | `tile`, `{id, person, name}` or null | to every client, as a terminal's keyboard changes hands (null: back with the host); to a client that opens the terminal while someone else holds it. A terminal on a participant's machine (M4) is held by that machine's person (`id` `peer:<their device id>`), and asking for it, giving it and taking it do nothing, until they let the others type there: then as any terminal of the host's, until they take that back, when whoever holds it gives it up |
| `terminal.keyboard.asked` | `tile`, `{id, person, name}` | to the keyboard's holder, as someone asks for it: `id` is who to give it to |
| `terminal.size` | `tile`, `cols`, `rows` | to every client, as a terminal's session takes a size (on a participant's machine, as that machine says it), and to one that opens it: a client whose own differs draws it at this size |
| `terminal.typing` | `tile`, `{id, person, name}` | to each client that opened the terminal but the one typing, as someone types into it: at most once a second while the same one types on. A client says so on the terminal for a moment, and does not draw that person's pointer meanwhile |
| `file.changed` | `repo`, `{paths}` | to each client watching the repo (the app's window watches the one it opens), at most one every 300 ms |
| `store.changed` | `{repo, part, objects?}` (`core`, `board` or `view:<id>`) | to every client but the one whose write it was, on each change to a workspace's layouts; for the board, `objects` names the objects that changed (0.28; none: any may have) |
| `presence.changed` | `repo`, `[{id, person, name, color, cursor, over, selection}]` | to every client, as someone in the workspace moves, selects, arrives or leaves (at once after a quiet spell, and at most every 50 ms): everyone there now, one per connection (`id`), `person` their key |
| `appearance.changed` | `appearance` | to every client, when what `appearance.get` answers changes (0.17); a client checks it as settings are, whoever sent it |
| `people.asked` | `repo`, `{req, workspace, profile, role}` | to the owner's clients, as someone asks to join with a link: `workspace` the workspace's name, `profile` `{name, color}` as they gave it, `role` the link's |
| `people.answered` | `repo`, `req` | to the owner's clients, as the question `req` is answered, or nobody answered it in time |
| `view.said` | `session`, `message` | to the caller of a view session alone, each view protocol message its host says to the view |
| `view.ended` | `session`, `why` | to the caller of a view session, as its host disables the view (it flooded, or sent what it may not, past the limits): the session is over |

## Views on a remote screen

A community view (`@hivemind/view-sdk`, view protocol 1.5) that says in its manifest it works on a
phone (`"phone": true`, laid out from `hello.device`) is shown on another device's screen, the
person's phone first, while its host runs here (0.12; design: `docs/design/phone-app-2026-10-02.md`
§6.1). The other device reads the views offered (`view.list`) and their files (`view.file`), and
opens one on a workspace here (`view.open`), on its screen. Its session is the caller's alone: what
the view posts goes in as `view.post`, checked here as the window checks a view in its iframe, and
what its host says comes back as `view.said`, until the caller closes it (`view.close`), the
caller's connection closes, or the host disables the view (`view.ended`, with why).

- **Its files** are served as the app serves them to its windows (`hm-view:`), from one place
  (`@hivemind/core/view-files`), 0.14: `page` is the file a screen loads to show the view, its
  `entry` when that is a page, else `__entry.html`, a page made for it that runs the entry as a
  module; `__sdk.js` is the view SDK this device serves its views, so a view never bundles its
  own; and a page of the view's is served with the SDK's import map first (`@hivemind/view-sdk`
  → `/__sdk.js`). Every file comes with `csp`, the Content-Security-Policy the screen serves it
  under, the window's: no network (`connect-src 'none'`), no frames, forms or objects, scripts
  only from the view's own origin (`'self'`, where the screen serves it, or `hm-view:`) or with
  the nonce that only the page made here carries, so the view's own inline scripts do not run.
  `__entry.html` of a view whose entry is a page is `BAD_REQUEST`.
- **Its screen** (0.14) is `{w, h, theme}`: its size in whole CSS pixels (0 to 100,000), and the
  look the app there gives views, as the view protocol's `theme` has it: `colors`, each `#rrggbb`
  by its token (`[a-z0-9-]`, at most 40), and as the app says them, `mode` (`dark` or `light`),
  `accent`, `radius` (0 to 100 pixels), `fonts` (`{ui, mono}`, font families), `surface`,
  `terminalBackground`, `glass` and `status` (a colour for each status tone). Anything else is
  `BAD_REQUEST`. A `view.open` that gives none shows it 0 by 0, with no colours. A screen given
  again (`view.screen`) is told to a ready view as the window tells its iframe: `resize` when its
  size changed, `theme` when its look did, nothing when neither did; a view not ready yet is told
  the newest in `hello`.
- **Its host says** what the window's says (`hello`, `structure`, `names`, `selection`, `status`),
  from what this device holds: the board from the store, statuses and links from the control
  plane, a selection of the session's own; and the screen as its caller says it (`viewport`,
  `theme`, then `resize` and `theme`). `hello.device` is `{touch: true, compact: true}`; no
  `visibility` follows, and no layout is kept. `features`: `agentStatus`, `sleep`, and `surfaces`
  for a screen that places its own (below).
- **What the view may do** is what its manifest asks and its caller may call, both: a view on a
  remote screen may start agents (`workspace:spawn`) when its caller may call `agent.start`, and
  wake them and put them to sleep (view protocol 1.14) when it may call `agent.wake` and `agent.sleep`; close
  tiles (`workspace:close`) when it may call `agent.close`, and rename them (`workspace:edit`) when
  it may write the board (`store.setCore`, the owner's: a phone may not). A prompt a view writes
  and a past session it continues ask the person at this computer, so neither is served. What it
  starts, wakes, puts to sleep and closes is recorded as the caller's, its detail `view <id>`.
- **A screen that places live surfaces itself** (0.15, `view.open`'s `surfaces`: a phone's app,
  which draws its own terminal over the view's web view where the view's `surfaceRects` ask) is
  said to in `hello.features` (`surfaces`, view protocol 1.6), and the rects are its own: nothing
  here draws them, and one that reaches here is not acted on. `surfaces` is `true` or `false`;
  anything else is `BAD_REQUEST`.
- **What a remote screen cannot do**: place a live surface (`surfaceRects`) unless it says it
  places its own (above), pick a folder (`openFolder`), share an image (`share` is not among its
  `features`), start any tile but an agent's, or add a frame. A request for one is answered `UNSUPPORTED`; anything else is not acted
  on, and not counted against the view, which could not have known.

## A client that holds the layouts

A window over Electron reads and writes the store synchronously, on `sendSync` channels
(`workspace:core-sync`, `workspace:set-core-sync`, …) that answer what `store.*` answers. A client
over anything slower holds the layouts of each workspace it opens (`store.open`) and answers its
own reads from them, so it never waits on the network to draw:

- A write changes what it holds at once, and goes to the host after every earlier one, with its
  `base`.
- On `store.changed` it reads that part again (of the board, the objects it names alone) once its own earlier writes have landed, so what it
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
domains in `packages/host` (git and worktrees, files, issues, reviews, agents and what they wait on, terminals,
presence, people, the store, community views on a remote screen), which the app's main process
and `hive host` serve, each over its own way of running a session and its own
store. A view's host is `packages/view-host`, the window's and a remote screen's both. Rust: the
phone's core, `crates/hive-phone` (`views.rs` for the views).

A program's client of the drive socket, in TypeScript (`packages/sdk`, the package `hivemind-api`,
which the `hive` CLI drives through) and Python (`packages/sdk-python`, `hivemind_api`), each in every release:
`connect`, any method by name, events heard singly whether they come one to a line or as a list,
and the common jobs (agents, frames, terminals) with the workspace's folder filled in. Both pass
`conformance/drive.json`, the drive socket message by message. Design:
`docs/design/api-sdks-2026-10-18.md`.
