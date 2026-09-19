---
title: Add your own agent
description: Describe a CLI coding agent in one YAML file, and turn any agent on or off.
---

An agent is configuration. Nothing agent-specific ships in the app: every agent — claude,
codex, pi and the rest — comes from the HiveHub registry and is added automatically when
its CLI is found on your machine. You can add another by writing one file — no rebuild, no
code — and switch any agent off, including the ones HiveHub added for you.

## What an agent file can and cannot do

A manifest describes everything Hivemind *reads* about an agent: its name and binary,
what it can do, its icon, how to start it, and how to tell from its screen whether it
is working, idle, or waiting for you.

Most of what needs code — resuming a session, reporting that a turn ended — a manifest
can *declare*, if it also says how it is done:

- **resuming** needs a `session.resume` block naming where the CLI keeps its sessions;
  the daemon does the reading
- **a turn signal** and **brokering permission prompts** need the manifest to wire the
  agent to the control plane: `launch.hcp` plus the hook file it ships beside it

A manifest that claims one of those without saying how is refused when Hivemind reads it.
A capability that is claimed but never delivered is worse than one that is missing: the
control plane would wait forever for a signal nothing sends.

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
  turnSignal: false      # true only with `launch.hcp` + the hook file that reports turns
  resume: none           # or "cwd"/"tile" once `session.resume` says where sessions live
  supervise: human       # human or none — "broker" needs the `launch.hcp` pre-tool hook
  blockedDetection: true

spawn:
  args: ["--no-color"]           # always passed
  label: "acme #{n}"             # tile name; {n} is the tile number
  labelMode: " · {mode}"         # appended when a mode is set
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

A manifest named `claude` stays attached to the command claude has always launched: an id
Hivemind has shipped is reserved, and a manifest that takes the name but points it at a
different program is refused when the manifest is read. A repository can only **add**
agents. Its manifest for an id you already have is refused and listed with the reason, so
cloning a repository can never change what the Claude button runs.

The folder name must match the `id` inside the file.

## Agents added for you

The app ships with no agents. They come from the plugin catalog on
[HiveHub](https://hivehub.griiken.workers.dev): when a listed agent's CLI is on your PATH,
Hivemind adds it at startup and says so — no questions. The notice says what the agent can
do, with a Remove button. It only adds when the files match their checksums, the manifest
names the CLI that was found, and that CLI answers `--version` like one; and it can never
replace an agent you already have. Remove one and it stays removed. Switch this off under
**Settings ▸ Agents ▸ Add agents found on this machine**. Adding the listing itself is a
pull request to [dip497/hivemind-plugins](https://github.com/dip497/hivemind-plugins).

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
every picker and from `hive ctl spawn`; turning it back on restores it. Agents HiveHub
added can be turned off too, or removed for good.

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
