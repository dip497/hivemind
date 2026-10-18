---
title: Share a workspace
description: Let other people into a workspace on your computer or a host, see who is there, and run the network server it goes through.
---

A workspace stays on the computer that hosts it. Other people join it from their own hivemind
app: they see its board, its tiles and its terminals, at the role you give them. Nothing is
copied to a server. What passes between you goes directly, or through a relay that cannot read
it.

## Who can do what

Each person in a workspace has one role.

| Role | In the app | They can |
|---|---|---|
| `view` | **Can view** | see the board and the terminals |
| `edit` | **Can edit board** | also move, add and close tiles, and press widgets |
| `terminals` | **Can use terminals** | also type into terminals, once they have the keyboard |
| `agents` | **Can drive agents** | also start and answer agents. It is given only to someone here now, and the app asks first: they can run commands on your machine through your agents. |

## Let someone in from the app

1. Open the workspace's window, then **Settings → Connect → Connect**. An offer made from Home
   pairs your own devices only.
2. Send the other person **Copy the link**. On the same network the six words are enough.
3. They paste it under **Join** (**Have a code? Join** on Home, or **Join a shared workspace…** in
   the Layers panel's title menu) and press **Connect**.
4. Both screens show three words. If they match, pick a role and press **Someone else**.

The steps, and what each answer does, are in [Connect devices and people](../connect/).

## Invite links from the command line

`hive share` makes an invite link for a workspace on this computer. The app or `hive host` must
be running here.

```bash
hive share ~/work/api --role edit --uses 3 --expires 2d
```

`--role` is `view`, `edit` or `terminals` (default `edit`). `--uses` is how many people the
link lets in (default 1). `--expires` takes `30m`, `12h`, `7d` (default `7d`). The link starts
with `hivemind://join/`.

The other person pastes it under **Join** in the app, or runs:

```bash
hive join 'hivemind://join/…'
```

`hive join` waits while the owner decides, up to about three minutes.

Joining is the person's, at their own machine: an agent's tile, a program and your other devices
are refused (*joining a workspace is the person's, at this machine: run `hive join <link>` in a
terminal of your own…*). Your own devices need no link at all: a workspace on another of your
devices opens from **Open recent → On your devices** in the app.

## Answer someone asking to join

In the app, a notice reads *⟨name⟩ wants to join ⟨workspace⟩ as ⟨role⟩*, with **Allow** and
**Deny**. Closing it is **Deny**.

From the command line:

```bash
hive people requests            # who is asking now, numbered
hive people allow 1             # or: hive people allow 1 --role view
hive people deny 1
```

To let in anyone with a valid link without being asked, `hive people rule invite`.
`hive people rule ask` goes back to the default.

## Who is in it

```bash
hive people list                     # everyone on the list, their role, who is here now
hive people role ana terminals       # view, edit, terminals, or agents (only while here)
hive people remove ana               # disconnects them; their link stops working
```

Each takes `-w <workspace>` when the folder you are in does not say which one. In the app, the
same list is **People in this workspace** on Settings → Connect, with **Remove**.

While you are in someone else's workspace, a banner reads *You're in ⟨workspace⟩ on ⟨host⟩'s
machine · ⟨role⟩*, with **Leave**. Faces at the top right show who else is there, and named
pointers show where each person points. Each terminal has one keyboard: **Ask for keyboard**,
**Give**, **Take back**. More in [Connect devices and people](../connect/#people-in-a-workspace).

## Keep a workspace up while your computer sleeps

A workspace on your laptop goes offline when the laptop sleeps. A host is a machine that runs
`hive host` with no desktop and keeps workspaces up.

```bash
hive host install          # runs hive host at boot (systemd, Linux); or: hive host run
hive host pair             # prints words: enter them under Join in your app
hive host add ~/work/api   # serve a folder as a workspace
```

Once the host is paired, **Move there** under **People in this workspace** hands a workspace to
it. **Move here**, on the workspace's banner, brings it back. Every option is in the
[CLI guide](../cli/).

## Let programs drive a workspace

A grant lets a script or tool drive a workspace here, at a role, with a token printed once.

```bash
hive grant create ci-bot --workspace ~/work/api --role terminals --expires 30d
hive grant list
hive grant revoke <id>
```

The role defaults to `agents`. **Settings → API access** makes the same tokens for the workspace
in the window.

## The network: hive-net

`install.sh` puts `hive-net` beside `hive`. It is what carries connections between devices.

On the default *Local network* there are no servers: devices on the same network find each
other, and nothing leaves it. Someone on another network needs a server that both of you use, a
relay and a lookup server, which you run yourself. There is no hosted one.

The short version, on a machine both of you can reach (a public address, a forwarded port, or a
VPN such as Tailscale):

```bash
hive-net serve --all --url https://hive.example.com --data ~/hive-network
hive network enrol-link --data ~/hive-network --uses 5
```

Paste the enrolment link on each of your devices under **Settings → Servers → Change…**, then
**Use** (or `hive network use <link>`). A guest does not need it: your offer or invite link
carries their way in. `hive network doctor` checks that the servers answer.

In the app, **Reach devices elsewhere…** on Settings → Connect offers **Serve from one of my
devices → Set it up with an agent**: an agent on your computer sets the server up and asks you for
what only you can do. Certificates, ports, Docker and a Tailscale setup are in
[Self-hosting](../self-hosting/).

## In a browser

- **Phone:** the phone page answers and drives your own agents. It comes from your `hive-net`
  server and does not work without one. See [Phone and browser](../phone/).
- **This computer:** **Settings → In a browser → Serve the app to a browser** serves the whole
  app to a tab on this computer. See [Phone and browser](../phone/#the-whole-app-in-a-browser-tab).
