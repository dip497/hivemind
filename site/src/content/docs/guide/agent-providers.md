---
title: Add your own agent
description: Describe an agent's CLI in one YAML file, saying how to start it, read its screen and answer it.
---

An agent is one file, `agent.yaml`. It tells Hivemind which program to start, what it can do, and
how to read its screen. No code and no rebuild.

## Write one

Make a folder named after the agent's id, with `agent.yaml` in it:

```yaml
# ~/.config/hivemind/agents/acme/agent.yaml
manifestVersion: 2
minAppVersion: "2026.9.6"   # optional: the catalog hides it from older Hivemind
id: acme                 # lowercase letters, digits and dashes
label: Acme Coder
bin: acme-coder          # the binary name on your PATH — never a path
aliases: [acme]          # other names that identify it when you run it yourself
enabled: true            # false (the default) = recognised for status, not offered to spawn

caps:
  promptDelivery: typed  # typed: keyed into its TUI · argv: passed as an argument
  turnSignal: false      # true only with `launch.hcp` + the hook file that reports turns
  resume: none           # or "cwd"/"tile" once `session.resume` says where sessions live
  supervise: human       # human or none — "broker" needs the `launch.hcp` pre-tool hook
  blockedDetection: true

spawn:
  args: ["--no-color"]           # always passed
  label: "acme #{n}"             # tile name; {n} is the tile number
  titles: ["acme — {task}", "acme"]  # window titles: {task} names the tile, a match without it is ignored

options:                         # what Settings lets you choose for this agent
  - id: model                    # `model` and `mode` are what `hive ctl spawn --model/--mode` set
    label: Model
    flag: --model                # a choice is passed as `--model <value>`
  - id: mode
    label: Approval
    flag: --approval
    values:                      # a value that needs other flags than `--approval <value>`
      yolo: ["--yes"]

detect:
  default: idle
  rules:
    - when: { contains: "approve this?" }
      then: blocked
    - when: { line: [{ gerundAfterPrefix: ["braille"] }] }   # "⠋ Reading files…"
      then: working
```

Every field under `caps` is required: leaving one out is refused, so each one is a decision.

| `caps` field | Means |
|---|---|
| `promptDelivery` | `argv`: the task is passed as an argument; `typed`: typed in once its screen reads idle |
| `turnSignal` | it reports when a turn ends, so other agents can collect its replies |
| `resume` | `none`, `cwd` (newest session in the folder) or `tile` (its own session) |
| `supervise` | `human`, `none`, or `broker` (its permission prompts can go to a supervising agent) |
| `blockedDetection` | its screen shows when it waits on you |

A claim that needs wiring must say how, or the file is refused: resuming needs `session.resume`
(where the CLI keeps sessions), listing past sessions needs `session.list`, and a turn signal or
`broker` needs a `launch.hcp` block plus a hook file shipped beside it, which reports back to Hivemind.

## Install and check it

```bash
hive agents validate ./acme     # check it without installing
hive agents install ./acme      # check, then copy
hive agents list                # every agent, where it came from, and why any is unavailable
hive agents remove acme
```

| Folder | Used for |
|---|---|
| `~/.config/hivemind/agents/<id>/agent.yaml` | your agents, in every workspace |
| `<repo>/.hivemind/agents/<id>/agent.yaml` | agents a repository ships for everyone in it |

A repository can only add agents: it can never change what an id you already have runs. The
folder name must match the `id`.

## Launch options

Under `options`, you name each flag; Hivemind runs `<bin> --help` and reads the allowed values
(`(choices: "a", "b")`, `[possible values: a, b]`, `a|b|c`). A flag with no listed values becomes a
text field in Settings. `model` and `mode` are what `hive ctl spawn --model` and `--mode` set.

## Read its screen

`detect.rules` are checked in order; the first match sets the status, else `default`. Statuses:
`idle`, `working`, and three that wait on you: `blocked`, `permission`, `question`.

| Whole-screen test | Matches when |
|---|---|
| `contains` / `containsCS` | the text appears (any case / exact case) |
| `helper: hasConfirmationPrompt` | "do you want" or "would you like" followed by yes or ❯ |
| `helper: hasInterruptPattern` | an "esc to interrupt" hint |
| `helper: hasBrailleSpinner` | a line starts with a braille spinner |

`line: [...]` matches when one line passes every test: `contains`, `startsWith`,
`startsWithAny`, `gerundAfterPrefix` (a mark, then a word ending in -ing), `letterAfterPrefix`,
`numBeforeWord`, `anyOf`, and `seq` for an exact sequence. Combine with `all`, `any`, `not`; limit
to the bottom with `scope: { kind: tail, n: 20 }`.

Regular expressions are not allowed: a bad one could stall status for every terminal. Every test
above runs in time proportional to the line.

## Answer it from your phone

Tell Hivemind which keys answer the agent, as `hive ctl keys` writes them (one to four keys; quote
digits). Read them from the real program: a wrong key answers the wrong way.

```yaml
answer:
  permission:
    allow: ['1']
    deny: [escape]
choose: ['{n}']        # pick option n of a question
interrupt: [escape]    # stop its turn (Stop on the phone)
```

A screen that asks something other than a tool's permission (a "trust this folder?" prompt) gets a
name with `says: trust` on its rule, and its own keys under `answer.trust`.

## Show its conversation on your phone

If the agent writes its session as JSON lines, `session.transcript` maps that file to messages,
tool uses and results, and the phone shows a chat instead of a terminal. Claude Code's mapping:

```yaml
session:
  resume:
    exists: '{home}/.claude/projects/*/{id}.jsonl'
  transcript:
    id: uuid
    at: timestamp
    skipWhen: { isSidechain: true, isMeta: true }
    said:
    - { require: { type: user }, text: message.content, who: person }
    - { require: { type: user }, each: message.content, item: { type: text }, text: text, who: person }
    - require: { type: user }
      each: message.content
      item: { type: tool_result }
      result: { of: tool_use_id, text: content, error: is_error }
    - { require: { type: assistant }, each: message.content, item: { type: text }, text: text, who: agent }
    - require: { type: assistant }
      each: message.content
      item: { type: tool_use }
      tool:
        id: id
        name: name
        about: [input.file_path, input.path, input.command, input.pattern, input.url, input.query, input.description]
        input: input
        asks: { list: input.questions, question: question, options: options, label: label, description: description, many: multiSelect }
```

`conformance/conversation.json` in the repository has cases to test a mapping against.

## Icon

Draw it with shapes; Hivemind builds the SVG, so nothing in the file becomes markup:

```yaml
icon:
  viewBox: "0 0 24 24"
  attrs: { fill: currentColor }
  shapes:
    - path: { d: "M12 2 2 22h20L12 2z" }
    - circle: { cx: 12, cy: 16, r: 2 }
```

## Before you install someone else's

An agent file starts a program in your terminal, with your permissions. There is no sandbox. Read
its `bin` and `spawn` first, and install only agents whose author you trust.
