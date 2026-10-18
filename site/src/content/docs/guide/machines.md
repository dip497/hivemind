---
title: Machines
description: Add a computer over ssh and run terminals and agents on it.
---

A machine is another computer you reach with `ssh`: a server, a VM, a second laptop. Open one of
its folders as a frame, and every terminal and agent in that frame runs there.

<figure class="diagram" style="--min:600px">
  <div><img src="../../diagrams/machines-ssh.svg" width="760" height="260" alt="Your computer reaches the machine over ssh. On the machine, the hive daemon runs the frame's terminals and agents in its folder, and keeps them running when the connection drops or the app quits." /></div>
  <figcaption>A frame on a machine</figcaption>
</figure>

## What the machine needs

- Linux, x86_64 or arm64, with an ssh server you can log in to. Answer its host-key question once
  in a terminal first (`ssh user@host`).
- `hive` on it. Adding the machine installs it for you.
- The agent CLIs you want to run there, installed on that machine.

Hivemind uses your own OpenSSH: keys, ssh agent and `~/.ssh/config`. A password, if you use one,
goes in the system keychain.

## Add one

**In the app**: Layers panel (⌘B) → **Machines** → **New machine**. Fill **Host** (`user@host` or
an ssh alias) and **Name**, leave **Install hive if missing** on, press **Add**.

**In a terminal**:

```bash
hive machine add dev@build-box --label build --install
hive machine check build          # reachable, platform, hive version
hive machine list
```

## Open a folder on it

In the **Machines** pane, press **+** on the machine (or ⋯ → **Open folder here…**) and pick a
folder. It opens as a new frame. Terminals (`1`), agents (`2`) and the Code tile (`3`) in it all
work on the machine.

From a terminal or an agent:

```bash
hive ctl frame add --machine build --folder /srv/web --name web
hive ctl spawn --frame web --agent claude --prompt "Run the tests and fix what fails"
```

## Sessions that outlive the connection

Terminals on the machine run in its own `hive` daemon. They keep running when the network drops,
your laptop sleeps or the app quits, and reattach when you are back. Reach them without the app:

```bash
hive ps --machine build
hive attach <session> --machine build     # ctrl-b d detaches
hive run --machine build --cwd /srv/web -- npm test
hive kill <session> --machine build
```

## Manage it

In the Machines pane, a machine's ⋯ menu has **Check now**, **Pause** (stop connecting; nothing
on the machine stops), **Resume** and **Manage machines…** (edit, **Install hive**,
**Update hive**, **Remove…**). A grey machine is paused or unreachable; **Sign in** means it wants
a password.

To be told when an agent there needs you, even with your laptop closed, run on the machine:

```bash
hive push set https://ntfy.sh/your-topic
hive push test
```

## Limits

- Issues are read from your computer only, not from the machine's folder.
- A machine without `hive` runs plain ssh terminals that end when the connection drops.
- Windows and macOS cannot be machines.

For a machine that keeps whole workspaces up with no desktop, see [Always-on host](../host/).
