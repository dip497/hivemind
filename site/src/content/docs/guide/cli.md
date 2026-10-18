---
title: CLI reference
description: Commands, options, and exit codes.
---

`hive` has three kinds of command: issue verbs (file operations, work without the app),
`hive ctl` (drives the running app or `hive host` over a local socket, its drive socket), and
commands that manage this machine: plugins, terminals, machines, sharing and the network. Agents
use the same CLI from Bash; there is no MCP server. `hive <command> --help` lists every option. In an agent's terminal `hive ctl` is that agent, driving its own
workspace; anywhere else it is you, in the workspace open there whose folder you are in, the only
one open, or the one `--repo` names. Conventions:

- `--json` prints one line of machine-readable output; errors are
  `{"ok":false,"code":"…","message":"…"}`.
- Issue ids accept `MYP-1` or `@MYP-1`; `hive @MYP-1` is `hive show`. Ids from
  registered repos resolve automatically.

In the syntax below, brackets mark optional arguments and angle brackets mark values
you supply. See [Getting started](../getting-started/) for runnable examples.

## Exit codes

| Exit | `code` in `--json` | Meaning |
|---:|---|---|
| 0 | | ok |
| 2 | `BAD_REQUEST`, `UNKNOWN_METHOD` | usage — the error lists valid values |
| 3 | `UNAVAILABLE` | neither the app nor `hive host` is running |
| 4 | `TIMEOUT` | a wait ran out (`read`, `open-review`, `workflow`) |
| 5 | `NOT_FOUND` | no such tile, frame, issue or workspace |
| 6 | `FORBIDDEN` | a bad or missing token, or a call the caller may not make |
| 7 | `UNSUPPORTED`, `RATE_LIMITED`, `DEPTH_EXCEEDED` | refused — the runtime cannot do this, or not now; `read` of an agent that is asleep; `sleep` or `wake` that did nothing |
| 8 | | `read` only: the agent stopped to wait on an answer (a question, a permission) |
| 1 | `FAILED` | other |

## Issues

```text
hive init --prefix MYP [--no-agentic]   # create tracker (+ agentic stack by default)
hive init                               # refresh the agentic stack
hive add skill                          # refresh the skills only

hive new "Title" [--label l …] [--parent ID] [--state backlog] [--github N]
          [--assignee claude --assignee-type agent] [--assignee-model m]
          [--description d] [--ac "criterion one || criterion two"]
hive list [--state todo] [--assignee id] [--label l] [--parent none|ID]
hive show MYP-1
hive update MYP-1 [--state s] [--title t] [--assignee id|none]
                 [--add-label l] [--rm-label l] [--github N|none] [--note "…"]
hive close MYP-1 [--reason "…"] [--note "…"]   # --reason → cancelled, else done
hive reopen MYP-1 [--state todo] [--note "…"]

hive task MYP-3 add "Subtask" [--assignee id] [--state todo]   # sub-issues: MYP-3.1, …
hive task MYP-3 done 2                          # tail number or full id
hive task MYP-3 list
```

States: `backlog · todo · in_progress · in_review · done · cancelled`.

## Structure and registries

```text
hive link MYP-4 --parent MYP-1          # re-parent, or --parent none
hive relate MYP-4 OPS-7 [--type blocks] [--remove]
                                        # relates | blocks | blocked-by | duplicates |
                                        # parent-of | child-of | moved-to | moved-from
hive move MYP-4 OPS [--copy]            # move refuses issues with sub-issues
hive workspace list
hive workspace register
hive agent detect                     # detect agent CLIs
hive agent context [--state todo]     # regenerate .agent.md
hive resolve "text"                     # expand @ID mentions to markdown links
```

## `hive ctl` — canvas

```text
hive ctl agents [--watch]               # the workspace's agents, their state and what each waits on
hive ctl frames                         # frames an agent may start in: id, name, machine
hive ctl frame add --folder /srv/web [--machine build] [--name web]
                                        # a frame on that folder, on a saved machine or one of
                                        # your devices by id or name; → {"frame","path","opened"}
hive ctl spawn [--agent claude] [--prompt "…"] [--name "title"]
               [--frame <id or name>] [--mode plan] [--model sonnet]
               [--no-report] [--supervise all|Bash,Edit] [--resume <session>]
                                        # → {"tile":…}; workers auto-report by default;
                                        # --mode yolo: the agent asks nothing
hive ctl sessions [agent] [--cwd dir] [--limit 100]
                                        # past sessions in a folder, to --resume
hive ctl send <tileId> "text" [--interrupt]   # after its turn; --interrupt: stop the turn first
hive ctl keys <tileId> Down,Enter       # Esc, Tab, digits, …
hive ctl read <tileId> [--timeout 90s] [--poll]   # default wait 100 s; --poll: no wait
                                        # exit 4 timeout, 5 closed, 7 asleep, 8 waits on an answer
hive ctl inbox [--wait 90s] [--tile id] # what other agents sent you, each once (--wait at most 10m)
hive ctl stream <tileId> [--lines 40] [--timeout 30s]
                       [--snapshot] [--json]        # what it prints, live; --lines: the last N first
hive ctl focus <tileId>
hive ctl close <tileId>                 # ends what runs in it; exit 5 if it is not open
hive ctl sleep [tile|frame] [--force]   # its process ends, its screen and conversation kept; none: every agent
hive ctl wake [tile|frame]              # back in its conversation; exit 7 if nothing woke
hive ctl rename <tileId> ["name"]       # no name: back to what its agent says it is doing
hive ctl connect <src> <dst>            # pipe src's replies into dst's input
hive ctl disconnect <src> [<dst>]
hive ctl open-tool <owner/name/tool> [--frame f] [--url https://…]
                                        # open a tile of a tool that is switched on
hive ctl view emit <name> ['{"json":1}' | -] [--view id]
                                        # a named event to the view shown
```

Run inside an agent's tile, these act on that agent's workspace, as that agent. Anywhere else
they act as you, on the workspace `--repo` names, else the open one your folder is in, else the
only one open. `send` and `close` to a tile no agent runs exit 5.

`--repo` here, `hive share <workspace>`, `hive people -w` and `hive grant create -w` all name a
workspace the same way: by its folder, its folder's name, or its id (the first four characters or
more). A name two workspaces answer to is refused, with each one's id and folder, so you can name
the one you mean; nothing is guessed.

## `hive ctl` — plugins

```text
hive ctl plugin list [--json]              # every plugin running, each starting, ready or failed,
                                           # with its commands; and the views there are
hive ctl plugin open <record> [--frame f] [--json]
                                           # get it running: a tool's tile opened, a widget added
                                           # to the board, a view switched to; answers once it
                                           # can be called
hive ctl plugin commands [--json]          # what the ready plugins let you run, with what each takes
hive ctl plugin call <plugin> <command> ['{"json":"argument"}' | -] [--tile id] [--json]
                                           # runs it and prints what the plugin answered
hive ctl plugin close <instance> [--plugin p] [--json]
                                           # close its tile, take the widget off the board,
                                           # leave the view for the canvas
```

A view, a tool or a widget declares commands in its manifest and answers them in its code. They
can be run while the plugin runs: the view shown, a tool's open tile, a widget on the board.
`plugin open` gets one there, named as `hive plugins list` names it (`tool:owner/name` opens its
first tool, `tool:owner/name/tool` another; `widget:@owner/name`; `view:id`), and answers when
its code has connected, so a `call` right after it runs.

Each running plugin is `starting` until its code connects, then `ready`. One that does not
connect in 15 s, or that the app stops for misbehaving, is `failed`, and `plugin list` says why.
A call to one still starting waits for it; the whole call has 30 s. `--tile` picks one when the
same plugin runs more than once (two tiles of one tool). The exit code says what went wrong:
5 when it is not running or has no such command, 4 when it was still starting or did not answer
in time, 2 when it runs twice and no `--tile` says which, 1 when it failed or refused (what it
threw is the message).

```sh
hive ctl plugin open widget:@dip497/progress                           # → added widget widget-…: ready (set-title, add, …)
hive ctl plugin call @dip497/progress add '{"text":"Run the tests"}'   # → {"index": 0}
hive ctl plugin call agent-board post '{"text":"Tests pass","kind":"done"}'   # the example view in examples/views/agent-board
hive ctl plugin call dip497/worktrees list
hive ctl plugin close widget-…                                         # the widget leaves the board
```

## `hive ctl` — workflows, supervision, review

```text
hive ctl workflow --shape fanout|pipeline|mapreduce
                  [--items "a || b"] [--prompt "Review {item}"]
                  [--stages "draft || critique || rewrite"] [--input "seed"]
                  [--reduce-prompt "Merge {results}"]
                  [--agent claude] [--model m] [--frame f] [--supervise all]
                  [--max-concurrent 6] [--timeout 10m] [--close] [--repo dir]
                                        # per-worker timeout; blocks until all replies
hive ctl approve <reqId> allow|deny|always|never [--reason "…"]
hive ctl report "summary" [--tile id]   # to the inbox of the tile that spawned you ($HIVEMIND_TILE)
hive ctl open-review --file plan.md|--plan "…" [--cwd dir] [--timeout 30m] [--tile id]
                                        # default ceiling 24 h; --tile from a terminal
```

## `hive ctl` — issue verbs

```text
hive ctl set-state MYP-1 in_progress [--note "…"]
hive ctl add-comment MYP-1 "root cause found in …"
hive ctl mark-acceptance MYP-1 0 [--undone]   # 0-based index from hive show --json
hive ctl delete-issue MYP-1                   # irreversible
hive ctl list-workspaces
```

## Views, agents, config, theme, upgrade

```text
hive views list                         # installed view plugins + load errors
hive views install <dir>|@owner/name    # a folder with hivemind-view.json, or from HiveHub
hive views new <name> [--owner login]   # a starter view in ./<name>, with PROMPT.md
hive views remove <id>

hive agents list                        # every agent, its source, on/off, and why any failed
hive agents list --found                # only agents whose CLI is on this machine
hive agents install amp                 # by its name on HiveHub; every file checked against its hash
hive agents install <dir>               # a folder with agent.yaml; checked before it is copied
hive agents install owner/repo[/dir] [--ref tag]   # from a GitHub repository
                                        # downloaded ones print what they run first: re-run with --yes
hive agents validate <dir>              # check a manifest the way an install would
hive agents remove <id>                 # removes the agent from this machine; it stays removed

hive widgets list                       # the app's own widgets and the ones you added
hive widgets install <dir>|@owner/name  # from a folder, or from HiveHub
hive widgets new <name> [--owner login] # a starter widget in ./<name>, with PROMPT.md
hive widgets remove <id>

hive tools list                         # what each tool contributes: tiles and commands, yours included
hive tools new <name> [--owner login]   # a starter tool plugin in ./<name>, with PROMPT.md
hive tools install <dir>|owner/name     # a folder, or from HiveHub (dip497/worktrees)
                                        # added off: hive plugins enable tool:<owner>/<name>
hive tools remove <owner>/<name>

hive plugins list [--kind agent|view|widget|tool]   # every plugin on this machine, on or off
hive plugins show agent:claude          # its settings: each one's value and what it takes
hive plugins enable tool:hivemind/web   # or disable
hive plugins set view:@you/board columns all   # checked against what the setting takes
hive plugins reset view:@you/board [columns]   # back to its default
hive plugins workspaces tool:<id> <folder>…    # the workspaces a tool's service drives (hive host)
hive plugins workspaces tool:<id> --none       # it drives none: its service stops

hive grant create <name> -w <folder> [--role agents] [--expires 30d]
                                        # a token for one program to drive these workspaces
hive grant list
hive grant revoke <id>

hive config path
hive config get [dotted.path]
hive config set <path> '<json>'
hive theme list
hive theme use nord
hive theme export f.json
hive theme import f.json
hive upgrade [--dev]
```

`hive config set` takes a JSON value (`'"nord"'` for strings) and asks a running app to
reload. `hive theme list` names the presets: signal (the default), ubuntu, dracula, nord,
solarized-dark and one-dark.

`hive plugins` writes the same record Settings ▸ Plugins does, one per plugin under
`plugins.state["<kind>:<id>"]` in settings.json: whether it is on, and the values set for the
settings it declares. A value that does not fit is refused with what does
(`columns is one of: todo, all`); a number is kept within its range.

`hive agents install` and `remove` ask a running app to rescan, so the change shows up
without a restart. `hive ctl spawn --agent` and `hive ctl workflow` accept agents added
this way, and refuse any agent switched off in Settings. See
[Add your own agent](../agent-providers/) for the file format.

## `hive host` — an always-on host

A machine with no desktop (a server, a VPS, a box in the office) can host its workspaces for
your other devices, and keep their agents running while your laptop sleeps. `hive host` serves
the workspaces in this machine's app data folder, runs their terminals in the machine's PTY
daemon, and reaches the network through hive-net (installed beside `hive`).

```text
hive host run         # serve until stopped (what a service runs); one host per machine
hive host status      # whether it runs, as which device, where it is reached, its workspaces
hive host stop        # stop serving; the terminals keep running in the daemon
hive host pair        # print six words, a link and a QR code for your app to enter
hive host add <dir>   # serve a folder on this machine as one of its workspaces
hive host install     # run it as a service of yours (systemd): at boot, and again if it stops
hive host uninstall   # stop running it as a service; its terminals keep running
```

The host is the same device the app would be on that machine (it uses the app's keys), so it
does not run while the app does. Pairing makes it you: in the app, **Settings → Connect → Have a code?
Join** takes the six words `hive host pair` prints, which find the host on your network, or
its link, which finds it from anywhere; from then on **Open recent → On your devices** lists the
workspaces it serves. A workspace opened from there is yours; its terminals and
agents run on the host and keep running whatever your computer does.

A workspace on your computer moves to the host with **Move there** on Settings → Connect, so it stays open
while your computer sleeps: the board, notes, the people in it and their invite links go to the
host, whoever is in it follows by themselves, and your computer opens it from the host from then
on. Terminals and agents in frames on your computer keep running there, reached through the host.
**Move here**, on the workspace's banner, brings it back to your computer the same way. If the
host is gone, **Host it here** carries on from the board as your computer last saw it; on a
network with a lookup server the people in it find it there, and the host, back, hands over what
changed on it meanwhile.

While the host has it, **Settings → Connect** on your computer lists the people in it, changes
roles and takes people off there. An offer made there lets nobody into it: new people come with
an invite link from `hive share` on the host. Someone asking to join is asked about in each of
your windows with it open, or, with none open, on your phone. Your computer keeps the list as the host has it, so **Host it here** carries it on
with whoever was let in or taken off meanwhile. A link made there names you as the host's profile
does (`hive config set profile.name '"Your Name"'` on the host), or by the machine's name.

### Sharing from the host itself

With no window anywhere, share straight from the host's command line. These ask the running
`hive host`, act as you, and are written to its audit log like the app's Settings → Connect:

```text
hive share <workspace> [--role view|edit|terminals] [--uses n] [--expires 7d]
                                 # print an invite link (default: edit, one person, 7 days)
hive people requests             # who is asking to join now, by number
hive people allow <n> [--role view|edit|terminals]   # let them in, at their link's role or this one
hive people deny <n>             # turn them away
hive people list                 # who is on the list, their roles, who is here now
hive people role <person> <role> # view, edit, terminals, or agents (only while they are here)
hive people remove <person>      # take them off; their link stops working
hive people rule [ask|invite]    # ask (default): you answer each request;
                                 #   invite: anyone with a valid link is let in at once
hive join <link>                 # join a workspace someone shared, waiting while they decide;
                                 #   yours to run in a terminal of your own, not from an agent's tile
hive network enrol-link [--data <dir>] [--uses n] [--expires 7d]
                                 # on your network's server: a link that puts a device on it
```

`<workspace>` (or `--workspace` / `-w`) is a folder the host serves or its name; leave it out
inside that folder, or when the host serves only one. `<person>` is their name or the start of
their id from `hive people list`. A link never lets someone drive agents: give that with `hive
people role` once they are here. Someone asking to join waits up to three minutes for your
answer: run `hive people requests`, or answer from the notification on your paired phone. Every
command takes `--json`. With no `hive host` but the app running, they ask the app instead.

On the host, `hive ctl` drives its agents as it does the app's. Run on that machine, by you or by
an agent in one of its terminals, `hive ctl spawn` starts an agent there with no window, in the
caller's workspace or the one the host serves, and gives it its task: on its command line where
the agent takes one, else typed once it is ready, a startup screen its launch flags already
answered skipped. `read`, `send`, `stream`, `report`, `workflow`, `close`, pipes and supervision
work as with the app; a verb that needs a window (`focus`, `open-review`, views) is refused (exit 3).

`hive host install` writes a systemd user unit (`~/.config/systemd/user/hive-host.service`) and
enables it. To start it with the machine, before anyone logs in, it turns lingering on
(`loginctl enable-linger`); whatever it cannot do itself, it prints the command for. Restarting
or upgrading the host leaves its terminals and agents running.

## Review comments

Comments left on a diff in the Code tile's Changes are kept in `.hivemind/review.json`. These
commands read it directly, so they work with or without the app:

```text
hive review list [--file src/x.ts] [--status open|resolved|all]
hive review show <id>                   # one comment with its replies
hive review reply <id> "fixed in 3f2c1a"
hive review resolve <id> [--summary "how it was addressed"]
hive review reopen <id>
hive review watch [--timeout 300] [--file f]   # wait for the next comment; exit 4 on timeout
```

## Terminals that outlive the app

Every terminal runs in this machine's PTY daemon, so it keeps running when the app quits.
The same commands reach a saved ssh machine with `--machine <id or label>`.

```text
hive daemon start|status|stop           # stop: sessions are kept as snapshots and restored on start
hive ps [--machine build-box]           # the sessions running
hive run [--attach] [--cwd dir] [--id name] -- npm run dev
                                        # start one; with --attach, ctrl-b d detaches
hive attach <session> [--read-only]     # view and type into one; a unique prefix of its id is enough
hive kill <session>                     # end it and its process
```

## Machines

A machine is an ssh destination the app and the CLI can run terminals and agents on.
Logins stay with OpenSSH (`~/.ssh/config`, your keys, your agent). A machine is saved only
when the probe reaches it.

```text
hive machine add me@build-box [--label build] [--install]
                                        # also an ssh alias or ssh://me@build-box:2222;
                                        # --install puts hive in ~/.local/bin there when it is missing
hive machine list
hive machine check build                # reachable, platform, hive path and version
hive machine rename build gpu-box
hive machine disable build              # kept, not connected; enable turns it back on
hive machine remove build               # forgotten; its sessions there keep running
```

See [Machines](../machines/).

## Network and notifications

```text
hive network show                       # which network, who signed it, its servers
hive network use local                  # or a network link, or a signed profile's file
hive network doctor                     # whether its relays answer this computer
hive push set https://ntfy.sh/<your-topic> [--events input.requested,turn.ended]
                                        # a plain-text POST when an agent on this machine needs you
hive push status | test | off
```

`hive network` changes what **Settings → Servers** shows; a running app starts its network
again. It needs `hive-net`, which the installer puts beside `hive`.

## Workspace bundles

```text
hive packages inspect <dir>             # check a bundle and show its startup plan, running nothing
```

This is a development preview.

## Optional tools

Browser is a tool that ships with the app, switched off. Switch it on in **Settings ▸ Plugins**
(under Tools), or from the CLI:

```sh
hive plugins enable tool:hivemind/web
hive ctl open-tool hivemind/web/browser --url https://example.com --json
hive plugins disable tool:hivemind/web
```

`open-tool` accepts `--frame <frame id or name>` and opens any tool that is switched on, ones
you added included. Browser URLs must use http or https, or be `about:blank`. A tool that is
switched off returns `FORBIDDEN` (exit 6). For agents to drive Browser tiles, also turn on
**Agent browser control** on Browser's page in Settings and relaunch the app.
