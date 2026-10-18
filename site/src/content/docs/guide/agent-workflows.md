---
title: Coordinate agents
description: One agent starts others, sends them work, collects replies and answers their questions with hive ctl.
---

`hive ctl` drives the running app from a terminal. Run inside an agent's tile, it acts as that
agent; anywhere else, as you. That is how one agent runs a team of others.

<figure class="diagram" style="--min:560px">
  <div><img src="../../diagrams/workflows-loop.svg" width="700" height="232" alt="You or a lead agent start worker agents and send them work with hive ctl spawn and send. Each worker's reply comes back through hive ctl read or the inbox. A worker that asks something tells the inbox, and you answer or approve it." /></div>
  <figcaption>Start, send, collect, answer</figcaption>
</figure>

## Start and follow workers

```bash
hive ctl agents --watch                  # every agent, its state, what it waits on
hive ctl spawn --agent pi --prompt "Review the current diff and list concrete bugs."
hive ctl read <tile> --timeout 90s       # its reply when the turn ends
hive ctl send <tile> "Now fix the first one"
hive ctl inbox --wait 90s                # replies, reports and questions sent to you
```

| `hive ctl read` exits | Means |
|---|---|
| 0 | the reply |
| 4 | still working: call `read` again |
| 5 | the tile was closed |
| 7 | the agent is asleep: wake it first |
| 8 | it stopped to ask something; the question is in the output |

Durations take units (`90s`, `10m`). Keep `--timeout` below your own tool's time limit.

## Run many at once

```bash
hive ctl workflow --shape fanout --items "auth || billing || search" \
  --prompt "Review the {item} module and list concrete bugs." --close --json
```

| Shape | Does |
|---|---|
| `fanout` | one worker per item, same prompt |
| `pipeline` | each stage's output is the next stage's input (`--stages`) |
| `mapreduce` | fanout, then one worker merges the results (`--reduce-prompt`) |

A workflow refuses an agent that does not report turn ends before starting anything.

## Answer what workers ask

```bash
hive ctl spawn --agent claude --supervise all --prompt "…"
hive ctl approve <request id> allow      # or deny, always, never
```

With `--supervise`, a worker's permission prompts come to your inbox instead of its screen.
`always` and `never` are remembered for that worker and tool.

## The steps an agent follows on an issue

`hive init` installs skills that teach agents this contract:

1. `hive show MYP-42 --json`: read the issue and its acceptance criteria.
2. `hive ctl set-state MYP-42 in_progress` and assign itself.
3. `hive ctl add-comment MYP-42 "plan: …"`.
4. Work; after each criterion, `hive ctl mark-acceptance MYP-42 <n>` (counting from 0).
5. Check tests and build; commit with the id.
6. End every session with `hive ctl set-state`: `in_review`, `done`, `in_progress --note`, or
   `cancelled --note`.

## Let agents use a browser and plugins

- **Browser**: switch on the Browser tool, then **Agent browser control** on its page in
  Settings ▸ Plugins, and restart the app. Agents then drive the Browser tile you see.
- **Plugins**: an agent opens one and runs its commands:

```bash
hive ctl plugin open widget:@dip497/progress
hive ctl plugin commands
hive ctl plugin call @dip497/progress add '{"text":"Run the tests"}'
```

A program of your own can do all of this too, with a token: see the [API](../api/).
