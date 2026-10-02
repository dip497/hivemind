---
title: Self-hosting
description: Run your own network for hivemind — a relay, a lookup server, admission and push, on one machine.
---

A fresh install uses no servers at all: devices on the same network find each other there, and
nothing leaves it (**Settings → Network** reads *Local network*). To reach devices elsewhere —
a teammate at home, your laptop on the train, a server in the cloud — hivemind needs a way
through, and you choose it once: hivemind's servers, **your own**, or one of your devices serving
the rest. This page is about your own. Everything below is the `hive-net` binary that `install.sh`
puts beside `hive`, MIT-licensed; hivemind's own servers run exactly the same.

## What a network is

| Role | What it does |
|---|---|
| **Relay** | Carries traffic between devices that cannot reach each other directly (about one network in ten). Traffic through it is end-to-end encrypted: it sees which devices talk, not what they say. |
| **Lookup server** | Where each device says which relay it is on, signed by its key, so others find it by its id alone; and where each workspace says which device hosts it. |
| **Access** | Who may use the relay. On a *closed* network (the default), the devices you enrol, and guests your devices vouch for; on an *open-pow* one, any device that registers with a moment of work. |
| **Push** | Tells your phones what happens on your devices while you are away (an agent waiting on you, finished, failed). What it passes on is encrypted to the phone, so it reads none of it, and it passes on only what the devices the phone named have signed. |

`hive-net serve` runs any of them, on **one port**: the lookup server at `/pkarr`, access at
`/access`, push at `/push`, the relay on the rest. `--all` is all four. A network is described by a **profile**,
signed by the network's **admin key**, and handed around as a link (`hivemind://network/…`).

## On a server with a public name

You need a DNS name for the server (`hive.example.com`), and three ports open to the internet:
443/tcp (HTTPS for every role; Let's Encrypt checks the name on it), 80/tcp (the captive-portal
check) and 7842/udp (QUIC address discovery, which helps devices connect directly).

With Docker:

```bash
git clone https://github.com/dip497/hivemind && cd hivemind
HIVE_DOMAIN=hive.example.com HIVE_CONTACT=you@example.com \
  docker compose -f infra/compose.yml -f infra/compose.public.yml up -d
docker compose -f infra/compose.yml logs hive-net
```

Or with the binary, under systemd:

```ini
# /etc/systemd/system/hive-net.service
[Unit]
Description=hivemind network (relay, lookup, access)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/hive-net serve --all --domain hive.example.com --contact you@example.com --data /var/lib/hive-net
DynamicUser=yes
StateDirectory=hive-net
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

The first start makes the network's admin key (`admin.key` in the data folder) and prints:

```
made the network's admin key, /var/lib/hive-net/admin.key: back it up; whoever holds it runs the network
relay serving on https://hive.example.com
lookup serving on https://hive.example.com/pkarr
access serving on https://hive.example.com/access
network link: hivemind://network/eyJwcm9…
```

The link stays the same from one start to the next; `network.json` in the data folder is the
signed profile it carries.

## Inside a building

A network that never leaves an office needs no certificate: serve plain HTTP and say how the
devices reach the server.

```bash
HIVE_URL=http://192.168.1.10:3340 docker compose -f infra/compose.yml up -d
# or
hive-net serve --all --data ~/hive-net --url http://192.168.1.10:3340
```

What goes through the relay is end-to-end encrypted either way, and every change to who may use
it is signed. Devices on the same network keep finding each other directly; the server only helps
those that cannot.

## Using it

On each computer: **Settings → Network → Change…**, paste the link, **Use** (or `hive network use
<link>` in a terminal). On a closed network the device must also be enrolled. As the admin, make
an enrolment link — the network's link with a one-time voucher in it — and give it to the person:

```bash
hive-net access enrol-link /var/lib/hive-net/network.json --admin /var/lib/hive-net/admin.key
# in Docker:
docker compose -f infra/compose.yml exec hive-net /usr/local/bin/hive-net \
  access enrol-link /data/network.json --admin /data/admin.key
```

It enrols one device and lasts seven days (`--uses <n>`, `--expires-in <seconds>`). Once a device
is on the network, people it invites get in through the invite itself: your device vouches for
theirs, for as long as their invite lasts.

**Check** under Settings → Network (or `hive network doctor`) says whether the relay, the lookup
server and the access service answer, and when the relay turns this computer away, why.

To take a device off: `hive-net access revoke https://hive.example.com/access <device id> --admin
admin.key`. To leave the network: **Settings → Network → Change… → Local network**.

## Who may use it

- **closed** (the default): devices enrolled by the admin's links, or by a device already
  enrolled (pairing your own devices), and guests vouched for by an invite, until it expires.
- **open-pow**: `--policy open-pow` lets any device in that registers its key with a little work
  (`--pow-bits`, default 20, about a second). Choosing the network registers the device.

## Certificates

- `--domain` alone: Let's Encrypt, over port 443 (TLS-ALPN-01), kept in `acme/` in the data
  folder and renewed by itself.
- Your own: `--cert fullchain.pem --key privkey.pem` (with `--domain` naming the server). The
  files are read again every hour, so a renewal by certbot or your CA is picked up.
- A company CA: devices trust what their system trusts (and `SSL_CERT_FILE`), as well as the
  web's public authorities.
- Behind a proxy that ends TLS: serve plain HTTP and give `--url https://hive.example.com`. The
  proxy must pass WebSocket upgrades through (the relay uses them); QUIC address discovery is then
  not available, and devices still connect.

## Several relays

The hosted network runs a relay per region and one access service: relays on other machines ask
it about each device that connects.

```bash
# on access.example.com
hive-net serve --access --data /var/lib/hive-net --domain access.example.com
# on each relay
hive-net serve --relay --access-url https://access.example.com/access --domain eu.relay.example.com
```

A relay keeps the service's yes for five minutes (`--access-cache`), so a short outage locks
nobody out, and a no for ten seconds. Write a profile naming every relay and sign it: `hive-net
profile sign profile.json --admin admin.key`, then `hive-net profile link` on the signed file.

## Push

A phone registers with the network's push server as it starts, naming your devices, and they tell
it through the server from then on. The server reaches the phone where the phone says:

- **UnifiedPush** (Android, with a distributor app such as ntfy): always, over https. The notice
  goes on as it came, with a VAPID token of the server's own key, which the network's profile names
  for the phone to give its distributor. A distributor on the server's own network — inside a
  building, say — is reached only on the networks you name, `--push-allow 192.168.1.0/24`
  (repeatable; `HIVE_PUSH_ALLOW=192.168.1.0/24` with `infra/compose.yml`); otherwise the server posts
  to addresses on the internet alone, so it cannot be made to post into your network.
- **Apple** (iPhone): with an APNs key from the Apple Developer team that signed the iPhone app
  (`--apns-key AuthKey_….p8 --apns-key-id … --apns-team … --apns-topic <the app's bundle id>`).
  Apple's keys reach only their own team's apps: hivemind's App Store app is told through
  hivemind's push server, which sees only ciphertext, unless you build and sign the app yourself.
  Make the key for *Sandbox & Production*: one server tells both kinds of build.
- **Google** (Android through Firebase): with a service account of the Firebase project the
  Android build was made with (`--fcm service-account.json`).

Beside the access role (`--all`), a phone registers only once it is on the network. The network's
profile says where the push server is, which of these it does, and its VAPID key. It counts
requests by the address it sees: behind a proxy that ends TLS, every device is the proxy, so run
it where it sees the devices' own addresses.

## Ports

| Port | For |
|---|---|
| 443/tcp (or `--bind`) | HTTPS: relay, lookup, access, push. 3340 without a certificate. |
| 80/tcp (`--http-bind`) | The captive-portal check, with HTTPS. |
| 7842/udp (`--quic-bind`) | QUIC address discovery, with HTTPS. |
| 53 (`--dns-bind`, off) | The lookup server's DNS side, answering for `--domain` once you delegate it there. hivemind's apps do not need it. |

## Back up

- `admin.key` — the network's admin key. Whoever holds it can sign the network's profile and
  enrol devices; lose it and you can do neither. Keep a copy somewhere safe.
- `access.json` — who may use the relays.
- `lookup/` — devices' and workspaces' records; devices publish theirs again, so losing it costs
  a few minutes, not data.
- `network.json` — the signed profile; made again from the admin key.
- `push.json` — the phones registered for push; each registers again as it starts, so losing it
  costs little. `push-vapid.key` — the VAPID key the profile names: lose it and every phone has to
  register with its distributor again.

## Not yet

The phone apps themselves (iPhone, Android) are not out yet; the push server is ready for them.
