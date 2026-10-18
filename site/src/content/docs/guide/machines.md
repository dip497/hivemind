---
title: Machines
description: Add a computer over ssh and run terminals and agents on it.
---

A **machine** is another computer you can reach with `ssh`: a server, a VM, a second laptop.
Add it once, open one of its folders as a frame, and every terminal and agent in that frame runs
on that machine, in that folder, with its files and its tools.

Hivemind uses your own OpenSSH: your keys, your ssh agent and `~/.ssh/config` work as they do in
a terminal. It keeps no keys of its own. A password, if you choose one, goes in the OS keychain.

## What the machine needs

- An ssh server you can log in to with a plain `ssh user@host`. Answer the host-key question
  once in a terminal first; Hivemind never prompts for it.
- Linux on x86_64 or arm64. The `hive` binary for both is published with every release.
- `hive` on the machine, so its terminals keep running when the connection drops. Adding a
  machine can install it for you (see below).
- The agent CLIs you want to run there (`claude`, `codex`, …), installed on that machine. An
  agent runs where its frame is, not on your computer. Its Hivemind wiring (what it reports, how
  it is driven) comes with it the first time you start it there, from the agents your app has; an
  agent the machine already has (`hive agents install` there) is kept as it is.

Not supported as a machine: Windows. On a Mac, `hive daemon start` refuses with "the compiled
hive cannot host a daemon on macOS yet".

## Add a machine in the app

1. Open the Layers panel (⌘B, or Ctrl+B outside a terminal) and pick **Machines** on its rail.
2. Press **New machine**. The **Manage machines** dialog opens on its add form.
3. **Host**: `user@host`, or an alias from `~/.ssh/config`. **Name**: what the panel calls it.
   **Use a password instead** if the machine has no key for you.
4. Leave **Install hive if missing** on. If the machine has no `hive`, Hivemind copies its own
   (same platform) or has the machine download the same version from GitHub releases into
   `~/.local/bin/hive`.
5. Press **Add**. It connects and checks the machine before it saves it.

If ssh fails on a host key or a login, the dialog shows the command to run once in a terminal
(`ssh user@host`, or `ssh-copy-id user@host` when it wants a password).

## Add a machine from a terminal

`hive machine` edits the same list the app shows (`~/.config/hivemind/machines.json`):

```bash
hive machine add dev@build-box --label build --install
hive machine list
hive machine check build        # reachable, platform, hive path and version
hive machine rename build ci
hive machine disable ci         # kept, not connected
hive machine enable ci
hive machine remove ci          # its sessions there keep running
```

The target is an ssh alias, `user@host`, or `ssh://user@host:2222`. Without `--install`,
`hive machine add` stops when the machine has no `hive` and tells you to rerun with it.

## Open a folder on it

- In the **Machines** pane, press **+** on the machine's heading, or **⋯ → Open folder here…**.
  Pick a folder; it opens as a new frame.
- Or on an existing frame without a folder: its **⋯** menu → **Run on a machine…**.

The frame's folder is `machine://<machine id>/srv/web`. It names the machine, not its address,
so editing the machine's address later moves its frames with it.

Inside that frame, everything is remote:

- Terminals (`1`) and agents (`2`, or the frame's **New agent ▸**) start in that folder on the
  machine.
- The Code tile (`3`) reads, edits and diffs files there over the same connection.
- An agent's status and its waits for you come back through the machine's terminal daemon.

From a terminal or an agent, start an agent there by naming the frame:

```bash
hive ctl frames                       # id, name and machine of each frame
hive ctl frame add --machine build --folder /srv/web --name web   # one there, made if missing
hive ctl spawn --frame web --agent claude --prompt "Run the tests and fix what fails"
hive ctl agents                       # it is listed with the workspace's other agents, on its machine
```

`--repo` names a workspace on a machine by its address (`ssh://build/srv/web`, `machine://…`) or
its name, as it names one here.

`hive ctl frame add` opens the same kind of frame as **Open folder here…**. `--machine` takes a saved
machine or one of your other devices, by its id or its name; a name two of them share is refused
with each one's id. Adding the same folder again gives the frame it already has.

## Sessions that outlive the connection

With `hive` on the machine, its terminals run in that machine's own terminal daemon. They keep
running when the network drops, when your laptop sleeps and when Hivemind quits. When the
connection comes back, the tiles reattach and catch up.

You can reach the same sessions from any terminal, without the app:

```bash
hive ps --machine build                        # sessions running on build
hive attach run-3f2a --machine build           # type into one; ctrl-b d detaches
hive attach run-3f2a --machine build --read-only
hive run --machine build --cwd /srv/web -- npm test
hive kill run-3f2a --machine build
```

`hive run` starts a session that keeps running after you detach. On the machine itself, the same
commands work without `--machine`, and `hive daemon status` says whether its daemon is up.

## The Machines pane

Each machine has a heading with its link (round trip, or why it is down), how many agents there
need you, and its frames under it.

- **Retry now** (the refresh button) skips the reconnect wait while it is down.
- **⋯ → Check now** checks it again.
- **⋯ → Pause** stops this app connecting to it. Nothing on the machine stops; **Resume**
  reconnects.
- **⋯ → Manage machines…** adds, edits and removes. **Edit…** changes its name or host; a new
  address is reached before it is saved. **Install hive** or **Update hive** puts the matching
  `hive` there. **Remove…** says what on this canvas uses it, and leaves its terminals running
  unless you tick **Also end its terminals**. Its frames go back to `ssh://user@host/path`, where
  they still run.

A machine you have paused or cannot reach is grey. One that needs a sign-in says **Sign in**.

## Without `hive` on the machine

If you add a machine without installing `hive`, its terminals are plain `ssh -tt` sessions run
from your computer. They end when the connection drops or the app closes. **Manage machines →
Install hive** fixes that.

## Phone notifications from the machine

The machine's daemon can push to a URL when an agent there needs you, even with your laptop
closed. On the machine:

```bash
hive push set https://ntfy.sh/your-topic
hive push test
```

## Limits

- Issues (`.hivemind/`) are read on your computer only, not in the machine's folder.
- A machine with no `hive` has no persistent sessions (see above).
- Linux only, as listed under [What the machine needs](#what-the-machine-needs).

## Other ways to run work elsewhere

- **`hive host`** turns a machine into an always-on host of its workspaces, with no desktop,
  reached through your network (`hive-net`) instead of ssh. `hive host pair` makes it one of
  your devices; frames can then run on it. See [Self-hosting](../self-hosting/).
- **Your other devices**, with the app or `hive host` on them, run the terminals of frames in
  their folders. An agent there reports to that device's terminal daemon, which passes what it
  says on to the app that started it: its status, `hive ctl read`, and its reply in the starter's
  `hive ctl inbox`, as for an agent on your own computer.
- **Sharing a workspace** lets another person join with their own computer. See
  [Multiplayer](../multiplayer/).
