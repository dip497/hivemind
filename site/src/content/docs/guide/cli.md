---
title: CLI reference
description: Every hive command, grouped, with its exit codes.
---

`hive` does three things: issue commands that edit files and work without the app, `hive ctl`
that drives the running app or `hive host`, and commands that manage this machine.
`hive <command> --help` lists every option.

- `--json` prints one line of machine-readable output; errors are
  `{"ok":false,"code":"…","message":"…"}`.
- In an agent's terminal, `hive ctl` acts as that agent in its workspace. Elsewhere it acts as you,
  in the workspace `--repo` names, else the open one your folder is in, else the only one open.
  With `HIVE_DRIVE_TOKEN` set, it acts as that program ([API](../api/)).
- A workspace is named by its folder, its folder's name, its id (four characters or more) or its
  issue prefix. A name two workspaces share is refused with both listed.

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

Guide: [Issues](../issues/).

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

```text
hive ctl set-state MYP-1 in_progress [--note "…"]
hive ctl add-comment MYP-1 "root cause found in …"
hive ctl mark-acceptance MYP-1 0 [--undone]   # 0-based index from hive show --json
hive ctl delete-issue MYP-1                   # irreversible
hive ctl list-workspaces
```

## `hive ctl`: agents and tiles

Guide: [Coordinate agents](../agent-workflows/).

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

## `hive ctl`: plugins

Guide: [Plugins](../plugins/#commands-agents-can-run).

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
hive ctl plugin close <instance | record> [--plugin p] [--json]
                                           # close its tile, take the widget off the board,
                                           # leave the view for the canvas
```

## Plugins

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
```

## API tokens

Guide: [Tokens and roles](../api-tokens/).

```text
hive grant create <name> -w <folder> [--role agents] [--expires 30d]
                                        # a token for one program to drive these workspaces
hive grant list
hive grant revoke <id>
```

## Settings and upgrade

Guide: [Settings and appearance](../appearance/).

```text
hive config path
hive config get [dotted.path]
hive config set <path> '<json>'
hive theme list
hive theme use nord
hive theme export f.json
hive theme import f.json
hive upgrade [--dev]
```

## Host

Guide: [Always-on host](../host/).

```text
hive host run         # serve until stopped (what a service runs); one host per machine
hive host status      # whether it runs, as which device, where it is reached, its workspaces
hive host stop        # stop serving; the terminals keep running in the daemon
hive host pair        # print six words, a link and a QR code for your app to enter
hive host add <dir>   # serve a folder on this machine as one of its workspaces (through the app when it runs)
hive host install     # run it as a service of yours (systemd): at boot, and again if it stops
hive host uninstall   # stop running it as a service; its terminals keep running
```

## Sharing and people

Guide: [Share a workspace](../multiplayer/).

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

## Review comments

Guide: [Review changes](../review/).

```text
hive review list [--file src/x.ts] [--status open|resolved|all]
hive review show <id>                   # one comment with its replies
hive review reply <id> "fixed in 3f2c1a"
hive review resolve <id> [--summary "how it was addressed"]
hive review reopen <id>
hive review watch [--timeout 300] [--file f]   # wait for the next comment; exit 4 on timeout
```

## Terminals that outlive the app

Add `--machine <name>` to reach a saved machine.

```text
hive daemon start|status|stop           # stop: sessions are kept as snapshots and restored on start
hive ps [--machine build-box]           # the sessions running
hive run [--attach] [--cwd dir] [--id name] -- npm run dev
                                        # start one; with --attach, ctrl-b d detaches
hive attach <session> [--read-only]     # view and type into one; a unique prefix of its id is enough
hive kill <session>                     # end it and its process
```

## Machines

Guide: [Machines](../machines/).

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

## Network and notifications

Guide: [Your own network server](../self-hosting/).

```text
hive network show                       # which network, who signed it, its servers
hive network use local                  # or a network link, or a signed profile's file
hive network doctor                     # whether its relays answer this computer
hive push set https://ntfy.sh/<your-topic> [--events input.requested,turn.ended]
                                        # a plain-text POST when an agent on this machine needs you
hive push status | test | off
```

## Packages (preview)

```text
hive packages inspect <dir>             # check a bundle and show what it would start, running nothing
```
