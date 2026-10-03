---
title: CLI reference
description: Commands, options, and exit codes.
---

`hive` has two vocabularies: issue verbs (file operations, work without the app) and
`hive ctl` (drives the running app over a local socket). Agents use the same CLI from
Bash; there is no MCP server. Conventions:

- `--json` prints one line of machine-readable output; errors are
  `{"ok":false,"code":"…","message":"…"}`.
- Issue ids accept `MYP-1` or `@MYP-1`; `hive @MYP-1` is `hive show`. Ids from
  registered repos resolve automatically.

In the syntax below, brackets mark optional arguments and angle brackets mark values
you supply. See [Getting started](../getting-started/) for runnable examples.

## Exit codes

| Exit | Meaning |
|---:|---|
| 0 | ok |
| 2 | usage — the error lists valid values |
| 3 | app not running (canvas verbs) |
| 4 | timeout (`hive ctl read`) |
| 5 | not found |
| 6 | unauthorized |
| 7 | refused/unsupported — the runtime cannot do this |
| 1 | other |

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
hive close MYP-1 [--reason "…"]         # --reason → cancelled, else done
hive reopen MYP-1 [--state todo]

hive task MYP-3 add "Subtask" [--assignee id]   # sub-issues: MYP-3.1, …
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
hive agent context                    # regenerate .agent.md
hive resolve "text"                     # expand @ID mentions to markdown links
```

## `hive ctl` — canvas

```text
hive ctl list [--frame f]               # tiles grouped by frame, with status; exit 5 if no frame answers to f
hive ctl frames                         # frames: id, title, repo, branch, tiles
hive ctl spawn [--agent claude] [--prompt "…"] [--name "title"]
               [--frame id|repo|title] [--mode plan] [--model sonnet]
               [--no-report] [--supervise all|Bash,Edit]
                                        # → {"tileId":…}; workers auto-report by default
hive ctl send <tileId> "text"
hive ctl keys <tileId> Down,Enter       # Esc, Tab, digits, …
hive ctl read <tileId> [--timeout 90s] [--poll]   # default wait 100 s; --poll: no wait
hive ctl stream <tileId> [--lines 40] [--since <offset>] [--timeout 30s]
                       [--snapshot] [--json]        # NDJSON tail with byte offsets
hive ctl focus <tileId>
hive ctl close <tileId>                 # ends what runs in it; exit 5 if it is not open
hive ctl rename <tileId> ["name"]       # no name: back to what its agent says it is doing
hive ctl connect <src> <dst>
hive ctl disconnect <src> [<dst>]
```

Run inside an agent's tile, `list` and `frames` answer for that tile's workspace; anywhere
else, for the one the app's window shows (on a machine running `hive host`, the one it serves,
when it serves one). Neither needs the window: the app answers them itself.

## `hive ctl` — workflows, supervision, review

```text
hive ctl workflow --shape fanout|pipeline|mapreduce
                  [--items "a || b"] [--prompt "Review {item}"]
                  [--stages "draft || critique || rewrite"] [--input "seed"]
                  [--reduce-prompt "Merge {results}"]
                  [--agent claude] [--model m] [--frame f] [--supervise all]
                  [--max-concurrent 6] [--timeout 10m] [--close]
                                        # per-worker timeout; blocks until all replies
hive ctl approve <reqId> allow|deny|always|never [--reason "…"]
hive ctl report "summary"               # to the tile that spawned you ($HIVEMIND_TILE)
hive ctl open-review --file plan.md [--cwd dir] [--timeout 30m]   # default ceiling 24 h
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
hive views install <dir>                # dir with hivemind-view.json; asks the app to rescan
hive views remove <id>

hive agents list                        # every agent, its source, on/off, and why any failed
hive agents list --found                # only agents whose CLI is on this machine
hive agents install <dir>               # dir with agent.yaml; checked before it is copied
hive agents remove <id>                 # removes the agent from this machine; a catalog agent stays removed

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
reload; themes cover ubuntu, dracula, nord, solarized-dark, one-dark.

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
hive host pair <code> # or enter the words (quoted) or the link your app shows
                      #   (Settings → Devices → Or show a code)
hive host add <dir>   # serve a folder on this machine as one of its workspaces
hive host install     # run it as a service of yours (systemd): at boot, and again if it stops
hive host uninstall   # stop running it as a service; its terminals keep running
```

The host is the same device the app would be on that machine (it uses the app's keys), so it
does not run while the app does. Pairing makes it you: in the app, **Settings → Devices → Pair
with a device** takes the six words `hive host pair` prints, which find the host on your network, or
its link, which finds it from anywhere; from then on **Open recent → On your devices** lists the
workspaces it serves. A workspace opened from there is yours; its terminals and
agents run on the host and keep running whatever your computer does.

A workspace on your computer moves to the host from **Share → Move there**, so it stays open
while your computer sleeps: the board, notes, the people in it and their invite links go to the
host, whoever is in it follows by themselves, and your computer opens it from the host from then
on. Terminals and agents in frames on your computer keep running there, reached through the host.
**Move here**, on the workspace's banner, brings it back to your computer the same way. If the
host is gone, **Host it here** carries on from the board as your computer last saw it; on a
network with a lookup server the people in it find it there, and the host, back, hands over what
changed on it meanwhile.

While the host has it, you manage who is in it from your computer as before: **Share** makes a
link that brings people to the host, **People** changes roles and takes people off there, and
someone asking to join is asked about in each of your windows with it open, or, with none open,
on your phone. Your computer keeps the list as the host has it, so **Host it here** carries it on
with whoever was let in or taken off meanwhile. A link made there names you as the host's profile
does (`hive config set profile.name '"Your Name"'` on the host), or by the machine's name.

### Sharing from the host itself

With no window anywhere, share straight from the host's command line. These ask the running
`hive host`, act as you, and are written to its audit log like the app's **Share** and **People**:

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
hive join <link>                 # join a workspace someone shared, waiting while they decide
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

## Optional tools

Browser is an optional bundled tool. Switch it on in **Settings > Tools**, or set
the enabled plugin list through the CLI. These commands replace the complete list;
read `hive config get tools.enabledPlugins` first if you have other plugins enabled.

```sh
hive config set tools.enabledPlugins '["hivemind/web"]'
hive ctl open-tool hivemind/web/browser --url https://example.com --json
hive config set tools.enabledPlugins '[]'
```

`open-tool` accepts `--frame <frame-id>`. Browser URLs must use HTTP/HTTPS or
`about:blank`. A disabled Browser returns `UNAUTHORIZED`; disabling does not close
existing browser panels. Fresh profiles start with Browser disabled, while older
version-1 settings preserve its availability during migration.
