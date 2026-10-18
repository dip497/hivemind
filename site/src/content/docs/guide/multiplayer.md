---
title: Share a workspace
description: Let other people into a workspace, give each a role, and see who is there.
---

A shared workspace stays on your computer (or your [host](../host/)). Guests join from their own
Hivemind app and see the board and terminals at the role you give them. Nothing is copied to a
server; traffic goes directly or through a relay that cannot read it.

## Roles

| Role | In the app | Can |
|---|---|---|
| `view` | **Can view** | see the board and terminals |
| `edit` | **Can edit board** | also move, add and close tiles, and press widgets |
| `terminals` | **Can use terminals** | also type into terminals, once given the keyboard |
| `agents` | **Can drive agents** | also start and answer agents, which means running commands on your machine. Given only to someone here now, after a warning. |

Programs get the same roles through [API tokens](../api-tokens/).

## Let someone in

**From the app**: in the workspace's window, Settings → Connect → **Connect**, send **Copy the
link**, and answer **Someone else** with a role when the words match. The steps:
[Connect devices](../connect/).

**From a terminal**: an invite link, for several people if you like:

```bash
hive share ~/work/api --role edit --uses 3 --expires 2d
```

They paste it under **Join**, or run `hive join '<link>'`. You answer each request in a notice
(**Allow** / **Deny**), or:

```bash
hive people requests
hive people allow 1             # --role view to lower it
hive people rule invite         # let anyone with a valid link in without asking; "ask" goes back
```

## Who is there

```bash
hive people list
hive people role ana terminals
hive people remove ana          # disconnects them; their link stops working
```

In the app, **People in this workspace** on Settings → Connect shows the same, with **Remove**.

| You see | Means |
|---|---|
| Faces, top right | who else is in. A guest clicks one to follow that person's view. |
| Named pointers | where each person points; their selection is ringed in their colour. |
| The banner (as a guest) | *You're in ⟨workspace⟩ on ⟨host⟩'s machine*, with **Leave**. |

## One keyboard per terminal

A terminal's title bar says who has its keyboard. Someone who **Can use terminals** presses
**Ask for keyboard**; the holder answers **Give** or **Not now**. The owner takes it back with
**Take back** or Ctrl+Shift+K (⌘⇧K).

## Keep it up while you sleep

Your laptop asleep means the workspace is offline. Move it to an [always-on host](../host/).
