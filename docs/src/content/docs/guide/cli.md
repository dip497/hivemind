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
hive ctl list [--frame f]               # tiles grouped by frame, with status
hive ctl frames                         # frames: id, title, repo, branch, tiles
hive ctl spawn [--agent claude] [--prompt "…"] [--name "title"]
               [--frame id|repo|title] [--mode plan] [--model sonnet]
               [--no-report] [--supervise all|Bash,Edit]
                                        # → {"tileId":…}; workers auto-report by default
hive ctl send <tileId> "text"
hive ctl keys <tileId> Down,Enter       # Esc, Tab, digits, …
hive ctl read <tileId> [--timeout 90000] [--poll]   # default wait 100 s; --poll: no wait
hive ctl stream <tileId> [--lines 40] [--since <offset>] [--timeout ms]
                       [--snapshot] [--json]        # NDJSON tail with byte offsets
hive ctl focus <tileId>
hive ctl close <tileId>
hive ctl connect <src> <dst>
hive ctl disconnect <src> [<dst>]
```

## `hive ctl` — workflows, supervision, review

```text
hive ctl workflow --shape fanout|pipeline|mapreduce
                  [--items "a || b"] [--prompt "Review {item}"]
                  [--stages "draft || critique || rewrite"] [--input "seed"]
                  [--reduce-prompt "Merge {results}"]
                  [--agent claude] [--model m] [--frame f] [--supervise all]
                  [--max-concurrent 6] [--timeout 600000] [--close]
                                        # per-worker timeout; blocks until all replies
hive ctl approve <reqId> allow|deny|always|never [--reason "…"]
hive ctl report "summary"               # to the tile that spawned you ($HIVEMIND_TILE)
hive ctl open-review --file plan.md [--cwd dir] [--timeout ms]   # default ceiling 24 h
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

Views, agent files and the settings file are on the unreleased development line — expect change.

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
