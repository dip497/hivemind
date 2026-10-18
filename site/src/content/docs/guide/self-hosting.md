---
title: Your own network server
description: Run hive-net so your devices and guests reach each other across networks, and so your phone can connect.
---

On the same local network, devices find each other with no server (**Settings → Servers** reads
*Local network*). To reach devices elsewhere, or to use the phone page, you run a server of your
own with `hive-net`, which the installer puts beside `hive`. There is no hosted one.

<figure class="diagram" style="--min:600px">
  <div><img src="../../diagrams/home-yours.svg" width="940" height="200" alt="Your phone talks over https to your own hive-net server, which relays to your computer, which reaches your other machines over ssh. Traffic is encrypted end to end; the server passes it on but cannot read it." /></div>
  <figcaption>Everything runs on machines you own</figcaption>
</figure>

## Quick start

The easy way: **Settings → Connect** → **Reach devices elsewhere…** → **Serve from one of my
devices** → **Set it up with an agent**. An agent does the steps below and asks you what only you
can answer.

By hand, on a machine your devices can reach:

```bash
hive-net serve --all --url https://hive.example.com --data ~/hive-network
hive network enrol-link --data ~/hive-network --uses 5
```

Paste the enrolment link on each of your devices: **Settings → Servers → Change…** → **Use** (or
`hive network use <link>`). Guests need no link of their own: your invite carries it.
`hive network doctor` checks that the server answers.

## What the server does

`hive-net serve --all` runs four parts on one port:

| Part | Does |
|---|---|
| Relay | Carries traffic between devices that cannot reach each other directly. Encrypted end to end: it never reads it. |
| Lookup | Lets devices find each other, and each workspace's host, by id. |
| Access | Decides who may use the relay: only devices you enrol and guests they vouch for (the default), or anyone who does a little proof of work (`--policy open-pow`). |
| Push | Tells your phones when an agent needs you, encrypted so the server cannot read it. |

`--phone <folder>` also serves the [phone page](../phone/) (in each release as
`hive-phone-page.tar.gz`), and `--views <port>` its views.

## Pick a setup

**Public name, with Docker** (opens 443/tcp, 80/tcp, 7842/udp; Let's Encrypt certificate):

```bash
git clone https://github.com/dip497/hivemind && cd hivemind
HIVE_DOMAIN=hive.example.com HIVE_CONTACT=you@example.com \
  docker compose -f infra/compose.yml -f infra/compose.public.yml up -d
```

**Public name, as a service**: `hive-net serve --all --domain hive.example.com --contact
you@example.com --data /var/lib/hive-net`, under systemd with `CAP_NET_BIND_SERVICE`.

**Inside one building** (no certificate):

```bash
hive-net serve --all --data ~/hive-net --url http://192.168.1.10:3340
```

**Across networks over Tailscale**:

```bash
hive-net serve --all --data ~/hive-net --url http://<tailscale-ip>:3340 --bind <tailscale-ip>:3340
```

On first start it makes the network's **admin key** (`admin.key`) and prints the network's link
(`hivemind://network/…`). The link stays the same across restarts.

## Enrol and remove devices

```bash
hive network enrol-link --data /var/lib/hive-net --uses 3 --expires 12h
hive-net access revoke https://hive.example.com/access <device id> --admin admin.key
```

An enrolment link lets one device in (or `--uses n`) for seven days by default. To leave a
network: **Settings → Servers → Change… → Local network**.

## Certificates

| You have | Use |
|---|---|
| A domain name | `--domain` alone: Let's Encrypt, renewed by itself |
| Your own certificate | `--cert fullchain.pem --key privkey.pem` (read again every hour) |
| A proxy that ends TLS | serve plain HTTP with `--url https://…`; the proxy must pass WebSockets |

## Ports

| Port | For |
|---|---|
| 443/tcp (`--bind`) | relay, lookup, access, push (3340 without a certificate) |
| 80/tcp (`--http-bind`) | the captive-portal check, with HTTPS |
| 7842/udp (`--quic-bind`) | address discovery, helps direct connections |
| 3341 or 8443 (`--views`) | the phone page's views |

## Push to phones

The phone page registers for push by itself. For Android through UnifiedPush it works as is (add
`--push-allow 192.168.1.0/24` for a distributor on your own network). Apple needs an APNs key
(`--apns-key … --apns-key-id … --apns-team … --apns-topic …`), Google a Firebase service account
(`--fcm service-account.json`), both for app builds you sign yourself.

## Back up

| File | Why |
|---|---|
| `admin.key` | Whoever holds it runs the network. Lose it and you can no longer enrol devices. |
| `access.json` | who may use the relays |
| `push-vapid.key` | lose it and every phone registers again |

`lookup/`, `network.json` and `push.json` rebuild themselves.

Several relays in different regions can share one access service: `hive-net serve --relay
--access-url https://access.example.com/access`, then sign a profile listing them with
`hive-net profile sign`.
