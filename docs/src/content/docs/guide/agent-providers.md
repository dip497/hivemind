---
title: Add your own agent
description: Describe a CLI coding agent in one YAML file, and turn any agent on or off.
---

An agent is configuration. Hivemind ships sixteen of them, and you can add another by
writing one file — no rebuild, no code. You can also switch any agent off, including
the ones that ship with Hivemind.

## What an agent file can and cannot do

A manifest describes everything Hivemind *reads* about an agent: its name and binary,
what it can do, its icon, how to start it, and how to tell from its screen whether it
is working, idle, or waiting for you.

It cannot describe what needs code: **resuming a session after a restart**, and
**reporting when a turn ends**. Those read or write the agent's own files, and a file
in your config directory is not allowed to do that.

So an agent you add yourself can be launched and its status read, but:

- it starts fresh after a restart instead of resuming
- `hive ctl read` and `hive ctl workflow` cannot collect its replies
- its permission prompts stay with you rather than going to a supervising agent

If your manifest claims any of those, Hivemind refuses to load it and says why. A
capability that is claimed but never delivered is worse than one that is missing:
the control plane would wait forever for a signal nothing sends.

## Write one

Create a folder named after the agent's id, holding `agent.yaml`:

```yaml
# ~/.config/hivemind/agents/acme/agent.yaml
manifestVersion: 1
id: acme                 # lowercase letters, digits and dashes
label: Acme Coder
bin: acme-coder          # the binary name on your PATH — never a path
aliases: [acme]          # other names that identify it when you run it yourself
enabled: true            # false = recognised for status, not offered to spawn

caps:
  promptDelivery: typed  # typed: keyed into its TUI · argv: passed as an argument
  turnSignal: false      # must be false for a file you write yourself
  resume: none           # must be none for a file you write yourself
  supervise: human       # human or none — never broker for a file you write
  blockedDetection: true

spawn:
  args: ["--no-color"]           # always passed
  label: "acme #{n}"             # tile name; {n} is the tile number
  labelMode: " · {mode}"         # appended when a mode is set

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

Every capability field is required. Leaving one out is refused, because an absence
must be a decision.

## Launch options

You name the flag; the values come from the agent itself. When Settings shows an
agent, Hivemind runs `<bin> --help` and reads the values listed for each flag, in the
forms argument parsers print: `(choices: "a", "b")`, `[possible values: a, b]`,
`a|b|c`. A flag whose help lists nothing becomes a text field. Nothing is chosen
until you choose it, so by default the agent decides.

## Where Hivemind looks

| Folder | Used for |
|---|---|
| `~/.config/hivemind/agents/<id>/agent.yaml` | Agents you installed, for all your workspaces |
| `<repo>/.hivemind/agents/<id>/agent.yaml` | Agents a repository ships for everyone who works in it |

An agent you install replaces a built-in of the same id — deliberately, and at the cost of
what its code provides: a manifest named `claude` is a plain agent without resume or turn
reporting. A repository can only **add** agents. Its manifest for an id you already have
(built-in or yours) is refused and listed with the reason, so cloning a repository can never
change what the Claude button runs.

The folder name must match the `id` inside the file.

## Agents added for you

The [plugin catalog](https://github.com/dip497/hivemind/tree/main/plugins) also lists agents
that are not built in. When one's CLI is on your PATH, Hivemind adds it at startup and says
so — no questions. It only does this when the files match their checksums, the manifest
names the CLI that was found, and that CLI answers `--version` like one; and it can never
replace an agent you already have. Remove one and it stays removed. Switch this off under
**Settings ▸ Agents ▸ Add agents found on this machine**.

## Install, list and remove

```bash
hive agents install ./acme     # checks the file, then copies the folder
hive agents list               # every agent, where it came from, where its CLI is, and why any is unavailable
hive agents list --found       # only the agents whose CLI is on this machine
hive agents remove acme        # only agents you installed; switch the others off instead
```

`install` checks the manifest **before** copying, so a broken one never lands on disk.
If Hivemind is running it picks the change up immediately; otherwise it does so at the
next start.

## Turn agents on and off

**Settings ▸ Agents** lists every agent Hivemind found, grouped into the ones this
machine has, the ones it does not (each saying which command it needs), and the ones you
switched off. The control on a row makes that agent the default; open a row for its
launch options, or to switch it off. Turning one off removes it from
every picker and from `hive ctl spawn`; turning it back on restores it. Built-in agents
can be turned off too.

Anything that failed to load stays in the list with the reason, so you can see why it
did not appear rather than wondering.

## Reading status from the screen

`detect` is an ordered list of rules. The first rule that matches decides the status;
if none match, `default` is used. Statuses are `idle`, `working` and `blocked`
(needs you).

**Tests on the whole screen:**

| Rule | Matches when |
|---|---|
| `contains: "text"` | the text appears anywhere, ignoring case |
| `containsCS: "Text"` | the text appears anywhere, exact case |
| `helper: hasConfirmationPrompt` | "do you want" or "would you like", followed by yes or ❯ |
| `helper: hasInterruptPattern` | an "esc to interrupt" style hint |
| `helper: hasBrailleSpinner` | a line starts with a braille spinner glyph |

**Tests on a single line** — `line: [...]` matches when one line passes *every* test in
the list:

| Test | Passes when the line |
|---|---|
| `contains` / `containsCS` / `startsWith` | holds or starts with the text |
| `startsWithAny: ["•", "braille"]` | starts with one of these characters |
| `gerundAfterPrefix: ["⬡", "braille"]` | starts with one of these, then a word ending in "-ing" |
| `letterAfterPrefix: ["◔", "●"]` | starts with one of these, then a letter |
| `numBeforeWord: task, op: gt, value: 0` | has a number before "task" that is greater than 0 |
| `anyOf: [...]` | passes any one of the tests listed |

Combine tests with `all: [...]`, `any: [...]` and `not: {...}`. Limit a rule to the end
of the screen with `scope: { kind: tail, n: 20 }`.

**Regular expressions are not allowed** in an agent you add yourself. A badly written
pattern can freeze the window: `(a+)+$` against 41 characters takes about a second, and
Hivemind checks every agent's screen every 1.2 seconds. Every test above runs in time
proportional to the line it reads.

## Icons

Draw the icon with shapes rather than SVG markup. Hivemind builds the markup from your
values, so nothing in the file can become an element or an event handler.

```yaml
icon:
  viewBox: "0 0 24 24"
  attrs: { fill: currentColor }
  shapes:
    - path: { d: "M12 2 2 22h20L12 2z" }
    - circle: { cx: 12, cy: 16, r: 2 }
```

Shapes can be `path`, `rect`, `circle` or `ellipse`. Leave `icon` out and the generic
agent icon is used.

## Before you install someone else's agent

An agent file tells Hivemind which program to start in your terminal, with your
permissions, in your project. That is what an agent is for, so there is no sandbox that
could make it safe. Only install agents whose author you trust, and read the `bin` and
`spawn` fields first.
