---
title: Always-on host
description: Keep workspaces and their agents running on a server while your computer sleeps.
---

A host is a machine running `hive host`, with no desktop. It keeps workspaces, their agents and
their people up while your laptop is off. You reach it through your [network](../self-hosting/),
not ssh.

<figure class="diagram" style="--min:600px">
  <div><img src="../../diagrams/host-move.svg" width="760" height="270" alt="Move there hands a workspace from your computer to a host running hive host; Move here brings it back. While the host has it, guests and your phone reach it there." /></div>
  <figcaption>Move a workspace to a host and back</figcaption>
</figure>

## Set it up

On the server:

```bash
hive network use <your network link>   # see Your own network server
hive host install                      # run at boot (systemd); or: hive host run
hive host pair                         # prints six words, a link and a QR code
```

On your computer: **Settings → Connect → Have a code? Join**, then enter the words (same network)
or the link (anywhere). The host is now one of your devices: **Open recent → On your devices**
lists its workspaces.

## Move a workspace there

| Do | Where |
|---|---|
| **Move there** | Settings → Connect, under **People in this workspace** |
| **Move here** | the workspace's banner, to bring it back |
| **Host it here** | if the host is gone: carry on from the board as your computer last saw it |

The board, notes, people and invite links move with it. Terminals in frames on your computer keep
running there, reached through the host.

## Serve and share from the host

```bash
hive host add ~/work/api               # serve a folder as a workspace
hive share api --role edit --expires 2d
hive people requests                   # then: hive people allow 1
hive host status
```

More on people and invites: [Share a workspace](../multiplayer/).

## Good to know

- One host per machine, and not while the app runs there: then the app serves the workspaces.
- `hive ctl` works on the host as with the app; commands that need a window (`focus`,
  `open-review`, views) are refused.
- Restarting or upgrading the host leaves its terminals and agents running.
- `hive host stop` stops serving; `hive host uninstall` removes the service.
